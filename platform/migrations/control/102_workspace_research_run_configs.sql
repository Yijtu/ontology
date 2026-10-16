-- 102_workspace_research_run_configs.sql
--
-- Immutable workspace-research run configs (design §8, node S04).
--
-- An agentic research run against an industry workspace has no project, no scenario and no
-- published industry pack, so it cannot resolve a scenario `ResolvedProfile`. It binds a separate,
-- versioned **workspace-research profile** that fixes the real workspace and the exact draft
-- revision it models. This table stores the resolved config once per (workspace_id, draft_revision):
-- editing the workspace draft later appends a newer revision and can never rewrite the row an
-- in-flight run is pinned to.
--
-- The stored `config` is the `ResolvedWorkspaceResearchProfile` (public execution config: enabled
-- public data tools + registered compute, plus the runtime ref, policy ref and resolved versions).
-- It carries no credential, no service address and no industry mapping. `draft_ref` pins the exact
-- draft (workspace id + revision + digest) the config was resolved against, and `snapshot_hash`
-- is the deterministic content hash, so a replaced row is detectable.
--
-- Forward-only: migrations 001..101 are never edited. Every key carries tenant_id/space_id and the
-- table has a `scope_isolation` RLS policy.

CREATE TABLE IF NOT EXISTS agent_platform.workspace_research_run_configs (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  draft_revision  bigint      NOT NULL,
  draft_ref       jsonb       NOT NULL,
  snapshot_hash   text        NOT NULL,
  config          jsonb       NOT NULL,
  resolved_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT workspace_research_run_configs_pkey
    PRIMARY KEY (tenant_id, space_id, workspace_id, draft_revision),
  CONSTRAINT workspace_research_run_configs_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_research_run_configs_revision_nonnegative CHECK (draft_revision >= 0),
  CONSTRAINT workspace_research_run_configs_draft_object CHECK (jsonb_typeof(draft_ref) = 'object'),
  CONSTRAINT workspace_research_run_configs_config_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT workspace_research_run_configs_hash_format CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS workspace_research_run_configs_workspace_idx
  ON agent_platform.workspace_research_run_configs (tenant_id, space_id, workspace_id, draft_revision DESC);

ALTER TABLE agent_platform.workspace_research_run_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.workspace_research_run_configs;
CREATE POLICY scope_isolation ON agent_platform.workspace_research_run_configs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
