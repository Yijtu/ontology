-- 006_component_registry.sql
--
-- Component registry (SPEC C1 / D2, ADR-02/ADR-10). Immutable component versions,
-- the active-run reference set that freezes a version against retirement, and the
-- append-only lifecycle history.
--
-- The unique key is (kind, component_id, version): the digest is the frozen value, so
-- the same id+version with a different digest is a constraint violation rather than an
-- overwrite. Every key and foreign key carries tenant_id/space_id, and RLS denies rows
-- outside the session scope.
--
-- Appended after 003, so the schema default privileges grant the application role
-- access without another explicit GRANT. Forward-only: 001..005 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.component_versions (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  kind            text        NOT NULL,
  component_id    text        NOT NULL,
  version         text        NOT NULL,
  digest          text        NOT NULL,
  manifest        jsonb       NOT NULL,
  artifact_ref    jsonb       NOT NULL,
  trust_status    text        NOT NULL,
  lifecycle_state text        NOT NULL,
  registered_at   timestamptz NOT NULL,
  validated_at    timestamptz,
  activated_at    timestamptz,
  deprecated_at   timestamptz,
  retired_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT component_versions_pkey PRIMARY KEY (tenant_id, space_id, kind, component_id, version),
  CONSTRAINT component_versions_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT component_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT component_versions_kind CHECK (kind IN (
    'runtime', 'generation', 'decision', 'data_backend', 'document_backend',
    'blob_backend', 'compute_extension', 'industry_pack', 'transport', 'control_store'
  )),
  CONSTRAINT component_versions_trust_status
    CHECK (trust_status IN ('untrusted', 'local_dev', 'verified', 'revoked')),
  CONSTRAINT component_versions_lifecycle_state
    CHECK (lifecycle_state IN ('registered', 'validated', 'active', 'deprecated', 'retired'))
);

-- One row per run that pins a version. A retired version can never be referenced; the
-- FK is RESTRICT so a version with references cannot be deleted either.
CREATE TABLE IF NOT EXISTS agent_platform.component_active_references (
  tenant_id    uuid        NOT NULL,
  space_id     uuid        NOT NULL,
  kind         text        NOT NULL,
  component_id text        NOT NULL,
  version      text        NOT NULL,
  run_id       uuid        NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT component_active_references_pkey
    PRIMARY KEY (tenant_id, space_id, kind, component_id, version, run_id),
  CONSTRAINT component_active_references_version_fkey
    FOREIGN KEY (tenant_id, space_id, kind, component_id, version)
    REFERENCES agent_platform.component_versions (tenant_id, space_id, kind, component_id, version)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS component_active_references_run_idx
  ON agent_platform.component_active_references (tenant_id, space_id, run_id);

-- Append-only lifecycle history. seq is monotonic per component version; the
-- idempotency key makes a retried transition a no-op. payload_digest and
-- idempotency_key also exist in the control event ledger, so the reconstructable
-- history can be checked against a stream that cannot be rewritten.
CREATE TABLE IF NOT EXISTS agent_platform.component_lifecycle_events (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  kind            text        NOT NULL,
  component_id    text        NOT NULL,
  version         text        NOT NULL,
  seq             bigint      NOT NULL,
  from_state      text,
  to_state        text        NOT NULL,
  digest          text        NOT NULL,
  payload_digest  text        NOT NULL,
  idempotency_key text        NOT NULL,
  actor           text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT component_lifecycle_events_pkey
    PRIMARY KEY (tenant_id, space_id, kind, component_id, version, seq),
  CONSTRAINT component_lifecycle_events_version_fkey
    FOREIGN KEY (tenant_id, space_id, kind, component_id, version)
    REFERENCES agent_platform.component_versions (tenant_id, space_id, kind, component_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT component_lifecycle_events_idempotency_key
    UNIQUE (tenant_id, space_id, kind, component_id, version, idempotency_key),
  CONSTRAINT component_lifecycle_events_seq_positive CHECK (seq > 0),
  CONSTRAINT component_lifecycle_events_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT component_lifecycle_events_payload_digest_format
    CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT component_lifecycle_events_to_state
    CHECK (to_state IN ('registered', 'validated', 'active', 'deprecated', 'retired')),
  CONSTRAINT component_lifecycle_events_from_state
    CHECK (from_state IS NULL OR from_state IN ('registered', 'validated', 'active', 'deprecated', 'retired'))
);

ALTER TABLE agent_platform.component_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.component_active_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.component_lifecycle_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.component_versions;
CREATE POLICY scope_isolation ON agent_platform.component_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.component_active_references;
CREATE POLICY scope_isolation ON agent_platform.component_active_references
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.component_lifecycle_events;
CREATE POLICY scope_isolation ON agent_platform.component_lifecycle_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
