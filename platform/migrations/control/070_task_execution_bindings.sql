-- 070_task_execution_bindings.sql
--
-- Versioned task execution binding, immutable input snapshots and archived run
-- execution bindings (SPEC v0.3a execution-evidence §EX-2.1, issue V03-023 / #194).
--
-- Why these tables exist on top of the existing run records (010), project
-- revisions/readiness (058/067) and project data materialisation:
--
--  * `published_task_bindings` stores one exact published task binding envelope per
--    (id, version, digest). A binding is a declarative record (required
--    capabilities/readiness, optional registered operation pin, parameter/result
--    schema refs) — never executable code. The store never rewrites a binding: a
--    re-publish is a new version/digest row.
--  * `task_input_snapshots` stores the immutable body of a trusted derived input
--    that a downstream task produces from an approved project revision. The body
--    pins the base project revision, the approved input it derives from and the
--    approved dependencies; it never carries its own digest, so the envelope can
--    hash the body before the referencing run exists.
--  * `run_execution_bindings` archives the server-verified execution binding for a
--    run: project/input/task refs, resolved profile/runtime, allowed task bindings,
--    input manifest digest at creation, effective limits and effective time. The run
--    row carries only the binding ref, so evidence append never rewrites the binding.
--  * `runs.execution_binding_ref` is the additive pointer the run read surface
--    returns; the binding body itself lives in `run_execution_bindings`.
--
-- Every table carries tenant_id/space_id, has RLS enabled and a `scope_isolation`
-- policy. Appended after 069, so the schema default privileges grant the application
-- role. Forward-only: migrations 001..069 are never edited.

ALTER TABLE agent_platform.runs
  ADD COLUMN IF NOT EXISTS execution_binding_ref jsonb;

CREATE TABLE IF NOT EXISTS agent_platform.published_task_bindings (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  task_binding_id text        NOT NULL,
  version         text        NOT NULL,
  digest          text        NOT NULL,
  binding         jsonb       NOT NULL,
  registered_at   timestamptz NOT NULL,
  CONSTRAINT published_task_bindings_pkey PRIMARY KEY
    (tenant_id, space_id, task_binding_id, version, digest),
  CONSTRAINT published_task_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT published_task_bindings_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT published_task_bindings_binding_object CHECK (jsonb_typeof(binding) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.task_input_snapshots (
  tenant_id         uuid        NOT NULL,
  space_id          uuid        NOT NULL,
  snapshot_id       uuid        NOT NULL,
  version           text        NOT NULL,
  digest            text        NOT NULL,
  project_id        uuid        NOT NULL,
  project_revision  bigint      NOT NULL,
  body              jsonb       NOT NULL,
  recorded_at       timestamptz NOT NULL,
  CONSTRAINT task_input_snapshots_pkey PRIMARY KEY
    (tenant_id, space_id, snapshot_id, version, digest),
  CONSTRAINT task_input_snapshots_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT task_input_snapshots_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT task_input_snapshots_revision_positive CHECK (project_revision > 0),
  CONSTRAINT task_input_snapshots_body_object CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX IF NOT EXISTS task_input_snapshots_project_idx
  ON agent_platform.task_input_snapshots (tenant_id, space_id, project_id, project_revision);

CREATE TABLE IF NOT EXISTS agent_platform.run_execution_bindings (
  tenant_id   uuid        NOT NULL,
  space_id    uuid        NOT NULL,
  run_id      uuid        NOT NULL,
  binding_id  uuid        NOT NULL,
  version     text        NOT NULL,
  digest      text        NOT NULL,
  binding     jsonb       NOT NULL,
  recorded_at timestamptz NOT NULL,
  -- The binding is archived *before* the run row in the admission sequence (the run then
  -- stores its ref), so it is keyed by run_id inside the trusted scope but does not carry a
  -- foreign key into `runs`; the scope FK is what guarantees tenant/space isolation.
  CONSTRAINT run_execution_bindings_pkey PRIMARY KEY (tenant_id, space_id, run_id),
  CONSTRAINT run_execution_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT run_execution_bindings_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT run_execution_bindings_binding_object CHECK (jsonb_typeof(binding) = 'object')
);

CREATE INDEX IF NOT EXISTS run_execution_bindings_ref_idx
  ON agent_platform.run_execution_bindings (tenant_id, space_id, binding_id, digest);

ALTER TABLE agent_platform.published_task_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.task_input_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.run_execution_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.published_task_bindings;
CREATE POLICY scope_isolation ON agent_platform.published_task_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.task_input_snapshots;
CREATE POLICY scope_isolation ON agent_platform.task_input_snapshots
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.run_execution_bindings;
CREATE POLICY scope_isolation ON agent_platform.run_execution_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
