-- 093_tool_connections.sql
--
-- Tool-connection catalogue, per-scope per-tool assignment and per-execution binding (design §9).
--
-- Design:
--  * `tool_connections` is the current-row projection of a tool connection's non-secret metadata
--    (name, adapter family, declared capabilities, address, credential STATE). It never holds a
--    credential value: `credential_ref` is an opaque reference the host custodian resolves.
--    `tool_connection_revisions` is the immutable, append-only history a reader can pin.
--  * `tool_assignment_sets` is one versioned row per target scope; scope_id is the sentinel
--    `00000000-0000-0000-0000-000000000000` for the space default so the primary key stays a plain
--    (tenant, space, scope_kind, scope_id). Assignment is per tool (`tool_selections`) with a
--    default fallback; a search service is never applied blindly to a tool it cannot serve.
--  * `execution_tool_bindings` pins the resolved connection/assignment revision to one execution so
--    a retry/resume reuses it instead of re-resolving.
--  * `tool_connection_tests` is an append-only probe audit whose two items (search, archive) are
--    recorded independently; the latest summary is also mirrored onto the connection row.
--
-- Every key carries tenant_id/space_id and every table has a `scope_isolation` RLS policy.
-- Appended after 092; the schema default privileges grant the application role. Forward-only:
-- earlier migrations are never edited. No credential value is ever stored here or in a backup.
--
-- Migration note (design §10): the legacy `CORE_WEB_SEARCH_*` environment is bridged into a
-- "compat gateway" connection in application code, once and idempotently, before UI edits own the
-- truth; this table set is the single source of truth once bridged.

CREATE TABLE IF NOT EXISTS agent_platform.tool_connections (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  connection_id        uuid        NOT NULL,
  revision             bigint      NOT NULL DEFAULT 1,
  name                 text        NOT NULL,
  adapter_type         text        NOT NULL,
  capabilities         jsonb       NOT NULL,
  enabled              boolean     NOT NULL,
  endpoint             text,
  descriptor           jsonb       NOT NULL,
  credential_ref       jsonb,
  credential_state     text        NOT NULL DEFAULT 'missing',
  probe_summary        jsonb,
  idempotency_key      text        NOT NULL,
  request_digest       text        NOT NULL,
  actor                text        NOT NULL,
  recorded_at          timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CONSTRAINT tool_connections_pkey PRIMARY KEY (tenant_id, space_id, connection_id),
  CONSTRAINT tool_connections_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT tool_connections_revision_positive CHECK (revision >= 1),
  CONSTRAINT tool_connections_adapter CHECK (adapter_type IN ('native_tavily', 'http_compat')),
  CONSTRAINT tool_connections_credential_state CHECK (credential_state IN ('present', 'missing', 'revoked')),
  CONSTRAINT tool_connections_capabilities_array CHECK (
    jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) BETWEEN 1 AND 4
  ),
  CONSTRAINT tool_connections_descriptor_object CHECK (jsonb_typeof(descriptor) = 'object'),
  CONSTRAINT tool_connections_probe_object CHECK (probe_summary IS NULL OR jsonb_typeof(probe_summary) = 'object'),
  CONSTRAINT tool_connections_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT tool_connections_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT tool_connections_request_digest_format CHECK (request_digest ~ '^[0-9a-f]{32}$')
);

CREATE INDEX IF NOT EXISTS tool_connections_scope_idx
  ON agent_platform.tool_connections (tenant_id, space_id, enabled, updated_at DESC, connection_id);

CREATE TABLE IF NOT EXISTS agent_platform.tool_connection_revisions (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  connection_id uuid        NOT NULL,
  revision      bigint      NOT NULL,
  body          jsonb       NOT NULL,
  actor         text        NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CONSTRAINT tool_connection_revisions_pkey PRIMARY KEY (tenant_id, space_id, connection_id, revision),
  CONSTRAINT tool_connection_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT tool_connection_revisions_body_object CHECK (jsonb_typeof(body) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.tool_assignment_sets (
  tenant_id         uuid        NOT NULL,
  space_id          uuid        NOT NULL,
  scope_kind        text        NOT NULL,
  scope_id          uuid        NOT NULL,
  revision          bigint      NOT NULL DEFAULT 1,
  default_selection jsonb       NOT NULL,
  tool_selections   jsonb       NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT tool_assignment_sets_pkey PRIMARY KEY (tenant_id, space_id, scope_kind, scope_id),
  CONSTRAINT tool_assignment_sets_revision_positive CHECK (revision >= 1),
  CONSTRAINT tool_assignment_sets_scope_kind CHECK (scope_kind IN ('space', 'industry_workspace', 'project')),
  CONSTRAINT tool_assignment_sets_default_object CHECK (jsonb_typeof(default_selection) = 'object'),
  CONSTRAINT tool_assignment_sets_tools_array CHECK (jsonb_typeof(tool_selections) = 'array'),
  CONSTRAINT tool_assignment_sets_scope_consistent CHECK (
    (scope_kind = 'space' AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid)
    OR (scope_kind <> 'space' AND scope_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

CREATE TABLE IF NOT EXISTS agent_platform.execution_tool_bindings (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  execution_id         uuid        NOT NULL,
  tool_id              text        NOT NULL,
  connection_id        uuid,
  connection_revision  bigint,
  assignment_revision  bigint      NOT NULL DEFAULT 0,
  resolved_from        text        NOT NULL,
  binding              jsonb       NOT NULL,
  bound_at             timestamptz NOT NULL,
  CONSTRAINT execution_tool_bindings_pkey PRIMARY KEY (tenant_id, space_id, execution_id, tool_id),
  CONSTRAINT execution_tool_bindings_tool CHECK (
    tool_id IN ('ontology_lookup', 'data_query', 'document_search', 'web_search')
  ),
  CONSTRAINT execution_tool_bindings_resolved_from CHECK (
    resolved_from IN ('object_tool', 'object_default', 'space_tool', 'space_default', 'unconfigured')
  ),
  CONSTRAINT execution_tool_bindings_binding_object CHECK (jsonb_typeof(binding) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_platform.tool_connection_tests (
  test_id               bigint      GENERATED ALWAYS AS IDENTITY,
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  connection_id         uuid        NOT NULL,
  revision              bigint      NOT NULL,
  draft                 boolean     NOT NULL,
  credential_configured boolean     NOT NULL,
  search_status         text        NOT NULL,
  search_reason         text,
  search_latency_ms     integer,
  archive_status        text        NOT NULL,
  archive_reason        text,
  archive_latency_ms    integer,
  tested_at             timestamptz NOT NULL,
  CONSTRAINT tool_connection_tests_pkey PRIMARY KEY (test_id),
  CONSTRAINT tool_connection_tests_search_status CHECK (search_status IN ('passed', 'failed', 'skipped')),
  CONSTRAINT tool_connection_tests_archive_status CHECK (archive_status IN ('passed', 'failed', 'skipped')),
  CONSTRAINT tool_connection_tests_search_reason CHECK (
    search_reason IS NULL OR search_reason IN (
      'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable',
      'invalid_response', 'page_not_readable', 'digest_mismatch', 'not_configured'
    )
  ),
  CONSTRAINT tool_connection_tests_archive_reason CHECK (
    archive_reason IS NULL OR archive_reason IN (
      'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable',
      'invalid_response', 'page_not_readable', 'digest_mismatch', 'not_configured'
    )
  ),
  CONSTRAINT tool_connection_tests_latency CHECK (
    (search_latency_ms IS NULL OR search_latency_ms >= 0)
    AND (archive_latency_ms IS NULL OR archive_latency_ms >= 0)
  )
);

CREATE INDEX IF NOT EXISTS tool_connection_tests_scope_idx
  ON agent_platform.tool_connection_tests (tenant_id, space_id, connection_id, tested_at DESC);

ALTER TABLE agent_platform.tool_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.tool_connections;
CREATE POLICY scope_isolation ON agent_platform.tool_connections
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.tool_connection_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.tool_connection_revisions;
CREATE POLICY scope_isolation ON agent_platform.tool_connection_revisions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.tool_assignment_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.tool_assignment_sets;
CREATE POLICY scope_isolation ON agent_platform.tool_assignment_sets
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.execution_tool_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.execution_tool_bindings;
CREATE POLICY scope_isolation ON agent_platform.execution_tool_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.tool_connection_tests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.tool_connection_tests;
CREATE POLICY scope_isolation ON agent_platform.tool_connection_tests
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
