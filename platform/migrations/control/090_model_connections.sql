-- 090_model_connections.sql
--
-- Multi-model catalogue, per-scope assignment and per-execution binding (design §5.3, A-R09/A-R10).
--
-- Design:
--  * `model_connections` is the current-row projection of a connection's non-secret metadata
--    (name, adapter family, protocol, declared capabilities, address, provider model name,
--    credential STATE). It never holds a credential value: `credential_ref` is an opaque
--    reference the host custodian resolves. `model_connection_revisions` is the immutable,
--    append-only history a reader can pin.
--  * `model_assignment_sets` is one versioned row per target scope; scope_id is the sentinel
--    `00000000-0000-0000-0000-000000000000` for the space default so the primary key stays a
--    plain (tenant, space, scope_kind, scope_id).
--  * `execution_model_bindings` pins the resolved connection/assignment revision to one
--    execution so a retry/resume reuses it instead of re-resolving (N16 consumes it).
--  * `model_connection_tests` is an append-only probe audit; the latest summary is also mirrored
--    onto the connection row for the catalogue view.
--
-- Every key carries tenant_id/space_id and every table has a `scope_isolation` RLS policy.
-- Appended after 003, so the schema default privileges grant the application role. Forward-only:
-- earlier migrations are never edited. No credential value is ever stored here or in a backup.
--
-- Migration note (design §5.3): the legacy local settings file is bridged in application code;
-- this table set is the single source of truth once bridged.

CREATE TABLE IF NOT EXISTS agent_platform.model_connections (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  connection_id        uuid        NOT NULL,
  revision             bigint      NOT NULL DEFAULT 1,
  name                 text        NOT NULL,
  adapter_type         text        NOT NULL,
  protocol             text        NOT NULL,
  capabilities         jsonb       NOT NULL,
  enabled              boolean     NOT NULL,
  base_url             text,
  endpoint             text,
  platform_model_id    text        NOT NULL,
  provider_model_name  text        NOT NULL,
  descriptor           jsonb       NOT NULL,
  credential_ref       jsonb,
  credential_state     text        NOT NULL DEFAULT 'missing',
  test_summary         jsonb,
  idempotency_key      text        NOT NULL,
  request_digest       text        NOT NULL,
  actor                text        NOT NULL,
  recorded_at          timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CONSTRAINT model_connections_pkey PRIMARY KEY (tenant_id, space_id, connection_id),
  CONSTRAINT model_connections_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT model_connections_revision_positive CHECK (revision >= 1),
  CONSTRAINT model_connections_adapter CHECK (adapter_type IN ('company_generation', 'jev')),
  CONSTRAINT model_connections_protocol CHECK (protocol IN ('openai_compatible', 'private', 'jev')),
  CONSTRAINT model_connections_credential_state CHECK (credential_state IN ('present', 'missing', 'revoked')),
  CONSTRAINT model_connections_capabilities_array CHECK (
    jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) BETWEEN 1 AND 3
  ),
  CONSTRAINT model_connections_descriptor_object CHECK (jsonb_typeof(descriptor) = 'object'),
  CONSTRAINT model_connections_test_object CHECK (test_summary IS NULL OR jsonb_typeof(test_summary) = 'object'),
  CONSTRAINT model_connections_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT model_connections_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT model_connections_request_digest_format CHECK (request_digest ~ '^[0-9a-f]{32}$')
);

CREATE INDEX IF NOT EXISTS model_connections_scope_idx
  ON agent_platform.model_connections (tenant_id, space_id, enabled, updated_at DESC, connection_id);

CREATE TABLE IF NOT EXISTS agent_platform.model_connection_revisions (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  connection_id uuid        NOT NULL,
  revision      bigint      NOT NULL,
  body          jsonb       NOT NULL,
  actor         text        NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CONSTRAINT model_connection_revisions_pkey PRIMARY KEY (tenant_id, space_id, connection_id, revision),
  CONSTRAINT model_connection_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT model_connection_revisions_body_object CHECK (jsonb_typeof(body) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.model_assignment_sets (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  scope_kind            text        NOT NULL,
  scope_id              uuid        NOT NULL,
  revision              bigint      NOT NULL DEFAULT 1,
  default_selection     jsonb       NOT NULL,
  capability_selections jsonb       NOT NULL,
  updated_at            timestamptz NOT NULL,
  CONSTRAINT model_assignment_sets_pkey PRIMARY KEY (tenant_id, space_id, scope_kind, scope_id),
  CONSTRAINT model_assignment_sets_revision_positive CHECK (revision >= 1),
  CONSTRAINT model_assignment_sets_scope_kind CHECK (scope_kind IN ('space', 'industry_workspace', 'project')),
  CONSTRAINT model_assignment_sets_default_object CHECK (jsonb_typeof(default_selection) = 'object'),
  CONSTRAINT model_assignment_sets_capabilities_array CHECK (jsonb_typeof(capability_selections) = 'array'),
  CONSTRAINT model_assignment_sets_scope_consistent CHECK (
    (scope_kind = 'space' AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid)
    OR (scope_kind <> 'space' AND scope_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

CREATE TABLE IF NOT EXISTS agent_platform.execution_model_bindings (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  execution_id         uuid        NOT NULL,
  capability           text        NOT NULL,
  connection_id        uuid,
  connection_revision  bigint,
  assignment_revision  bigint      NOT NULL DEFAULT 0,
  resolved_from        text        NOT NULL,
  binding              jsonb       NOT NULL,
  bound_at             timestamptz NOT NULL,
  CONSTRAINT execution_model_bindings_pkey PRIMARY KEY (tenant_id, space_id, execution_id, capability),
  CONSTRAINT execution_model_bindings_capability CHECK (capability IN ('generation', 'research', 'decision_jev')),
  CONSTRAINT execution_model_bindings_resolved_from CHECK (
    resolved_from IN ('object_capability', 'object_default', 'space_capability', 'space_default', 'unconfigured')
  ),
  CONSTRAINT execution_model_bindings_binding_object CHECK (jsonb_typeof(binding) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.model_connection_tests (
  test_id        bigint      GENERATED ALWAYS AS IDENTITY,
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  connection_id  uuid        NOT NULL,
  revision       bigint      NOT NULL,
  status         text        NOT NULL,
  reason         text,
  latency_ms     integer,
  tested_at      timestamptz NOT NULL,
  CONSTRAINT model_connection_tests_pkey PRIMARY KEY (test_id),
  CONSTRAINT model_connection_tests_status CHECK (status IN ('passed', 'failed')),
  CONSTRAINT model_connection_tests_reason CHECK (
    reason IS NULL OR reason IN ('authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable', 'invalid_response')
  ),
  CONSTRAINT model_connection_tests_latency CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS model_connection_tests_scope_idx
  ON agent_platform.model_connection_tests (tenant_id, space_id, connection_id, tested_at DESC);

ALTER TABLE agent_platform.model_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.model_connections;
CREATE POLICY scope_isolation ON agent_platform.model_connections
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.model_connection_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.model_connection_revisions;
CREATE POLICY scope_isolation ON agent_platform.model_connection_revisions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.model_assignment_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.model_assignment_sets;
CREATE POLICY scope_isolation ON agent_platform.model_assignment_sets
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.execution_model_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.execution_model_bindings;
CREATE POLICY scope_isolation ON agent_platform.execution_model_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.model_connection_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.model_connection_tests;
CREATE POLICY scope_isolation ON agent_platform.model_connection_tests
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
