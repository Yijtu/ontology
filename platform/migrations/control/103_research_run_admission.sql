-- 103_research_run_admission.sql
--
-- Research run admission: the durable "accept before schedule" barrier (design §4/§8, node S05).
--
-- A research run may only be scheduled once its acceptance is complete: the brief, the frozen
-- draft, the authorization receipt, the model/tool snapshots, the original deadline, the one shared
-- ledger and the input manifest are all persisted first. This migration makes two changes:
--
--  (1) It repairs the run binding for a workspace-research run. Migration 010's
--      `runs_resolved_profile_fkey` requires a `resolved_profiles` row (which itself requires a
--      `profile_versions` row), but S04 resolves a workspace-research config into
--      `workspace_research_run_configs` instead — so a research run could never satisfy that FK.
--      The FK is replaced by `assert_run_profile_binding`, an insert/update trigger that requires
--      *either* the exact scenario `resolved_profiles` row (unchanged for a normal run) *or* the
--      exact frozen workspace-research config row (for a research run). This keeps a run's binding
--      provably complete without inventing a fake profile version.
--
--  (2) It stores the accept/ready marker that gates dispatch. `state` is the dispatch-ready
--      barrier: a run whose admission is still `preparing` is never taken over by
--      `reconcileOpenRuns()` and is never normally dispatched, so a half-prepared admission can
--      never execute. `begin` is a write-once claim on `(tenant_id, space_id, idempotency_key)`, so
--      two concurrent submissions of one logical request resolve to exactly one run/research
--      identity; `mark_ready` flips the barrier and is idempotent.
--
-- The `model_snapshot_refs`/`tool_snapshot_refs` pin the model/tool config snapshots (S02) the run
-- was accepted against, and `config_snapshot_ref`/`config_snapshot_hash` pin the frozen
-- workspace-research config (S04) so a preflight change is detectable at accept time.
--
-- Forward-only: migrations 001..102 are never edited (this file only ALTERs tables they created).
-- Every key carries tenant_id/space_id, the run and workspace references are scoped foreign keys and
-- the table has a `scope_isolation` RLS policy.

-- (1) Repair the run→profile binding for a workspace-research run.
ALTER TABLE agent_platform.runs DROP CONSTRAINT IF EXISTS runs_resolved_profile_fkey;
ALTER TABLE agent_platform.runs DROP CONSTRAINT IF EXISTS runs_profile_binding_shape;
ALTER TABLE agent_platform.runs ADD CONSTRAINT runs_profile_binding_shape
  CHECK (
    (profile_id NOT LIKE 'workspace-research:%')
    OR (
      profile_id LIKE 'workspace-research:%'
      AND profile_version ~ '^(0|[1-9]\d*)\.0\.0$'
    )
  );

CREATE OR REPLACE FUNCTION agent_platform.assert_run_profile_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile_id LIKE 'workspace-research:%' THEN
    -- A research run must name the exact frozen workspace-research config it was resolved from; the
    -- config pins the workspace, the draft revision and the content hash the run locked.
    IF NOT EXISTS (
      SELECT 1 FROM agent_platform.workspace_research_run_configs AS config
       WHERE config.tenant_id = NEW.tenant_id AND config.space_id = NEW.space_id
         AND NEW.profile_id = 'workspace-research:' || config.workspace_id::text
         AND NEW.profile_version = config.draft_revision::text || '.0.0'
         AND config.snapshot_hash = NEW.resolved_profile_hash
    ) THEN
      RAISE EXCEPTION 'workspace-research run % has no exact frozen run config for %@%',
        NEW.run_id, NEW.profile_id, NEW.profile_version;
    END IF;
  ELSE
    -- A normal run keeps the original guarantee: a real resolved scenario profile must exist.
    IF NOT EXISTS (
      SELECT 1 FROM agent_platform.resolved_profiles AS profile
       WHERE profile.tenant_id = NEW.tenant_id AND profile.space_id = NEW.space_id
         AND profile.profile_id = NEW.profile_id AND profile.version = NEW.profile_version
         AND profile.snapshot_hash = NEW.resolved_profile_hash
    ) THEN
      RAISE EXCEPTION 'run % has no exact resolved profile for %@%',
        NEW.run_id, NEW.profile_id, NEW.profile_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runs_assert_profile_binding ON agent_platform.runs;
CREATE TRIGGER runs_assert_profile_binding
  BEFORE INSERT OR UPDATE OF profile_id, profile_version, resolved_profile_hash
  ON agent_platform.runs
  FOR EACH ROW EXECUTE FUNCTION agent_platform.assert_run_profile_binding();

-- (2) The research run admission (accept/ready) marker and its idempotent association.
CREATE TABLE IF NOT EXISTS agent_platform.research_run_admission (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  run_id                uuid        NOT NULL,
  research_id           uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  draft_revision        bigint      NOT NULL,
  idempotency_key       text        NOT NULL,
  request_digest        text        NOT NULL,
  state                 text        NOT NULL,
  goal                  jsonb       NOT NULL,
  brief_ref             jsonb       NOT NULL,
  authorization_receipt_ref jsonb   NOT NULL,
  config_snapshot_ref   jsonb       NOT NULL,
  model_snapshot_refs   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tool_snapshot_refs    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  config_snapshot_hash  text        NOT NULL,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  ready_at              timestamptz,
  CONSTRAINT research_run_admission_pkey PRIMARY KEY (tenant_id, space_id, run_id),
  CONSTRAINT research_run_admission_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT research_run_admission_research_unique UNIQUE (tenant_id, space_id, research_id),
  CONSTRAINT research_run_admission_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT research_run_admission_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT research_run_admission_state CHECK (state IN ('preparing', 'ready')),
  CONSTRAINT research_run_admission_ready_at CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CONSTRAINT research_run_admission_revision_nonnegative CHECK (draft_revision >= 0),
  CONSTRAINT research_run_admission_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_run_admission_config_hash_format CHECK (config_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_run_admission_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT research_run_admission_goal_object CHECK (jsonb_typeof(goal) = 'object'),
  CONSTRAINT research_run_admission_brief_object CHECK (jsonb_typeof(brief_ref) = 'object'),
  CONSTRAINT research_run_admission_authorization_object CHECK (jsonb_typeof(authorization_receipt_ref) = 'object'),
  CONSTRAINT research_run_admission_config_object CHECK (jsonb_typeof(config_snapshot_ref) = 'object'),
  CONSTRAINT research_run_admission_model_snapshots_array CHECK (jsonb_typeof(model_snapshot_refs) = 'array'),
  CONSTRAINT research_run_admission_tool_snapshots_array CHECK (jsonb_typeof(tool_snapshot_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS research_run_admission_scope_idx
  ON agent_platform.research_run_admission (tenant_id, space_id, state, updated_at, run_id);

ALTER TABLE agent_platform.research_run_admission ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.research_run_admission;
CREATE POLICY scope_isolation ON agent_platform.research_run_admission
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
