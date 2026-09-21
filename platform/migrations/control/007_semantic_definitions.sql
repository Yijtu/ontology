-- 007_semantic_definitions.sql
--
-- Industry model and semantic definition version store (SPEC D2–D4, C1/C3; ADR-10/13,
-- INV-03). A published definition version is immutable and append-only: object,
-- attribute, relation, identity-scope and rule-constraint declarations are stored once
-- and a new version is a new row. The digest pins exactly the declaration content.
--
-- The persisted `definition` JSONB is the declaration without the trusted tenant/space
-- scope, so a shared industry core carries no customer instance data, and no SDK,
-- connection address, credential or physical column name (validated before publication).
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope.
--
-- `semantic_definition_bindings` pins a data set to the exact definition version it was
-- created under, so publishing a newer version never silently reinterprets older data.
--
-- Appended after 003, so the schema default privileges grant the application role access
-- without another explicit GRANT. Forward-only: 001..006 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.semantic_definition_versions (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  namespace     text        NOT NULL,
  definition_id text        NOT NULL,
  version       text        NOT NULL,
  digest        text        NOT NULL,
  layer         text        NOT NULL,
  definition    jsonb       NOT NULL,
  published_at  timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_definition_versions_pkey
    PRIMARY KEY (tenant_id, space_id, namespace, definition_id, version),
  CONSTRAINT semantic_definition_versions_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT semantic_definition_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT semantic_definition_versions_namespace CHECK (namespace ~ '^[a-z][a-z0-9-]*$'),
  CONSTRAINT semantic_definition_versions_layer
    CHECK (layer IN ('industry_core', 'customer_extension'))
);

-- Append-only publication history. seq is monotonic per definition version; the
-- idempotency key makes a retried publication a no-op. payload_digest and idempotency_key
-- also exist in the control event ledger, so the reconstructable history can be checked
-- against a stream that cannot be rewritten.
CREATE TABLE IF NOT EXISTS agent_platform.semantic_definition_events (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  namespace       text        NOT NULL,
  definition_id   text        NOT NULL,
  version         text        NOT NULL,
  seq             bigint      NOT NULL,
  digest          text        NOT NULL,
  payload_digest  text        NOT NULL,
  idempotency_key text        NOT NULL,
  actor           text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_definition_events_pkey
    PRIMARY KEY (tenant_id, space_id, namespace, definition_id, version, seq),
  CONSTRAINT semantic_definition_events_version_fkey
    FOREIGN KEY (tenant_id, space_id, namespace, definition_id, version)
    REFERENCES agent_platform.semantic_definition_versions
      (tenant_id, space_id, namespace, definition_id, version) ON DELETE RESTRICT,
  CONSTRAINT semantic_definition_events_idempotency_key
    UNIQUE (tenant_id, space_id, namespace, definition_id, version, idempotency_key),
  CONSTRAINT semantic_definition_events_seq_positive CHECK (seq > 0),
  CONSTRAINT semantic_definition_events_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT semantic_definition_events_payload_digest_format
    CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$')
);

-- One binding per data set. The FK is RESTRICT so a bound definition version cannot be
-- deleted out from under historical data.
CREATE TABLE IF NOT EXISTS agent_platform.semantic_definition_bindings (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  data_ref_id        uuid        NOT NULL,
  data_ref           jsonb       NOT NULL,
  namespace          text        NOT NULL,
  definition_id      text        NOT NULL,
  definition_version text        NOT NULL,
  definition_digest  text        NOT NULL,
  bound_at           timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_definition_bindings_pkey PRIMARY KEY (tenant_id, space_id, data_ref_id),
  CONSTRAINT semantic_definition_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT semantic_definition_bindings_version_fkey
    FOREIGN KEY (tenant_id, space_id, namespace, definition_id, definition_version)
    REFERENCES agent_platform.semantic_definition_versions
      (tenant_id, space_id, namespace, definition_id, version) ON DELETE RESTRICT,
  CONSTRAINT semantic_definition_bindings_digest_format
    CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS semantic_definition_bindings_version_idx
  ON agent_platform.semantic_definition_bindings
    (tenant_id, space_id, namespace, definition_id, definition_version);

ALTER TABLE agent_platform.semantic_definition_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.semantic_definition_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.semantic_definition_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_definition_versions;
CREATE POLICY scope_isolation ON agent_platform.semantic_definition_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_definition_events;
CREATE POLICY scope_isolation ON agent_platform.semantic_definition_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_definition_bindings;
CREATE POLICY scope_isolation ON agent_platform.semantic_definition_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
