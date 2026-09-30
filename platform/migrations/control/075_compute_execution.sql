-- 075_compute_execution.sql
--
-- Registered compute invocation records and immutable result artifacts
-- (SPEC v0.3a execution-evidence §EX-6, issue V03-031 / #201).
--
-- Why these tables exist on top of the existing registered-operation registry, task
-- bindings (070) and task policy reports (073):
--
--  * `compute_invocations` is the idempotency ledger for one logical compute action. Its
--    logical key is scope + taskBindingRef + inputSnapshotDigest + parametersDigest +
--    registeredOperationDigest (stored as `logical_key_digest`); the primary key on
--    (tenant_id, space_id, logical_key_digest) is what makes retrying the same logical
--    action converge on the one effective output instead of running the handler again.
--    The record body carries state (prepared/executing/completed/failed/cancelled), the
--    appended failure attempts and the terminal result ref/digest. A second concurrent
--    submission is blocked by a single owner lease, never by a second handler run.
--  * `compute_output_bindings` stores the raw `typed-output-bindings@1` produced before the
--    gateway envelope exists: the domain output ref/digest, the registered output schema and
--    one field binding per computed metric (unit and currency kept separate). It carries no
--    gateway evidenceRef; the Core typed manifest (V03-032) binds real evidence later.
--  * `compute_result_artifacts` stores the generic `compute-result-artifact@1` wrapper that
--    pins the invocation, the operation/handler/schema digests, the fixed input snapshot and
--    parameters, the archived domain output and its raw output bindings.
--
-- Every table carries tenant_id/space_id, has RLS enabled and a `scope_isolation` policy.
-- Appended after 073 (074 reserved for parallel nodes), so the schema default privileges
-- grant the application role. Forward-only: migrations 001..073 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.compute_invocations (
  tenant_id                 uuid        NOT NULL,
  space_id                  uuid        NOT NULL,
  logical_key_digest        text        NOT NULL,
  invocation_id             uuid        NOT NULL,
  state                     text        NOT NULL,
  attempt                   integer     NOT NULL,
  result_ref                jsonb,
  result_digest             text,
  owner_id                  uuid,
  lease_expires_at          timestamptz,
  record                    jsonb       NOT NULL,
  recorded_at               timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  CONSTRAINT compute_invocations_pkey PRIMARY KEY (tenant_id, space_id, logical_key_digest),
  CONSTRAINT compute_invocations_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT compute_invocations_key_format CHECK (logical_key_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_invocations_result_format CHECK (result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_invocations_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT compute_invocations_state_domain CHECK
    (state IN ('prepared', 'executing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT compute_invocations_record_object CHECK (jsonb_typeof(record) = 'object')
);

CREATE INDEX IF NOT EXISTS compute_invocations_state_idx
  ON agent_platform.compute_invocations (tenant_id, space_id, state);

CREATE TABLE IF NOT EXISTS agent_platform.compute_output_bindings (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  bindings_id   uuid        NOT NULL,
  version       text        NOT NULL,
  digest        text        NOT NULL,
  output_digest text        NOT NULL,
  bindings      jsonb       NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CONSTRAINT compute_output_bindings_pkey PRIMARY KEY
    (tenant_id, space_id, bindings_id, version, digest),
  CONSTRAINT compute_output_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT compute_output_bindings_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_output_bindings_output_format CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_output_bindings_body_object CHECK (jsonb_typeof(bindings) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.compute_result_artifacts (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  artifact_id   uuid        NOT NULL,
  version       text        NOT NULL,
  digest        text        NOT NULL,
  invocation_id uuid        NOT NULL,
  output_digest text        NOT NULL,
  artifact      jsonb       NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CONSTRAINT compute_result_artifacts_pkey PRIMARY KEY
    (tenant_id, space_id, artifact_id, version, digest),
  CONSTRAINT compute_result_artifacts_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT compute_result_artifacts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_result_artifacts_output_format CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_result_artifacts_body_object CHECK (jsonb_typeof(artifact) = 'object')
);

CREATE INDEX IF NOT EXISTS compute_result_artifacts_invocation_idx
  ON agent_platform.compute_result_artifacts (tenant_id, space_id, invocation_id);

ALTER TABLE agent_platform.compute_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.compute_output_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.compute_result_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.compute_invocations;
CREATE POLICY scope_isolation ON agent_platform.compute_invocations
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.compute_output_bindings;
CREATE POLICY scope_isolation ON agent_platform.compute_output_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.compute_result_artifacts;
CREATE POLICY scope_isolation ON agent_platform.compute_result_artifacts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
