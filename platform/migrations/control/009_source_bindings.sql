-- 009_source_bindings.sql
--
-- Source registration and capability probing (SPEC C1/C3/C6, D2; US-008/009). It keeps
-- the current source binding, immutable source versions, probe jobs and the source
-- fingerprints a resolved preflight observed.
--
-- A binding is refs-only: `adapter_id`/`adapter_version`/`adapter_digest` name a registered
-- component and `secret_ref` is an opaque, server-resolved reference. No URL, host,
-- physical table/column or credential value is stored here, so an export or a
-- model-visible payload cannot carry a secret.
--
-- `status` is `ready` only after a probe actually confirmed the scope; a failed probe
-- leaves `registered`/`failed`. A new mapping or capability version is a new
-- `source_versions` row, and `source_preflight_bindings` records the exact fingerprints a
-- preflight observed, so a later change invalidates that preflight instead of silently
-- reinterpreting it.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the
-- application role access without another explicit GRANT. Forward-only: 001..008 are never
-- edited.

CREATE TABLE IF NOT EXISTS agent_platform.source_bindings (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  source_id          uuid        NOT NULL,
  kind               text        NOT NULL,
  role               text        NOT NULL,
  adapter_id         text        NOT NULL,
  adapter_version    text        NOT NULL,
  adapter_digest     text        NOT NULL,
  secret_ref         text        NOT NULL,
  status             text        NOT NULL,
  current_version    text        NOT NULL,
  capability_version text,
  revision           bigint      NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL,
  created_by         text        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_bindings_pkey PRIMARY KEY (tenant_id, space_id, source_id),
  CONSTRAINT source_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT source_bindings_kind CHECK (kind IN ('read_only_origin', 'imported')),
  CONSTRAINT source_bindings_role CHECK (role IN ('telemetry', 'catalog', 'documents')),
  CONSTRAINT source_bindings_status
    CHECK (status IN ('registered', 'probing', 'ready', 'failed')),
  CONSTRAINT source_bindings_adapter_digest_format CHECK (adapter_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT source_bindings_secret_ref_nonempty CHECK (length(secret_ref) > 0),
  CONSTRAINT source_bindings_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS source_bindings_role_idx
  ON agent_platform.source_bindings (tenant_id, space_id, role);

-- Immutable source version. The digest pins exactly the adapter/mapping/capability
-- declaration; the same id+version with another digest is a conflict, never an overwrite.
CREATE TABLE IF NOT EXISTS agent_platform.source_versions (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  source_id          uuid        NOT NULL,
  version            text        NOT NULL,
  digest             text        NOT NULL,
  capability_version text        NOT NULL,
  mapping            jsonb,
  registered_at      timestamptz NOT NULL,
  registered_by      text        NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_versions_pkey PRIMARY KEY (tenant_id, space_id, source_id, version),
  CONSTRAINT source_versions_binding_fkey
    FOREIGN KEY (tenant_id, space_id, source_id)
    REFERENCES agent_platform.source_bindings (tenant_id, space_id, source_id) ON DELETE CASCADE,
  CONSTRAINT source_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$')
);

-- Probe jobs. A failed probe records a classified code and a secret-scrubbed message; the
-- binding is never marked ready by a failed job.
CREATE TABLE IF NOT EXISTS agent_platform.source_probe_jobs (
  tenant_id              uuid        NOT NULL,
  space_id               uuid        NOT NULL,
  job_id                 uuid        NOT NULL,
  source_id              uuid        NOT NULL,
  status                 text        NOT NULL,
  requested_capabilities jsonb       NOT NULL DEFAULT '[]'::jsonb,
  capabilities           jsonb,
  schema_revision        text,
  error_code             text,
  safe_message           text,
  created_at             timestamptz NOT NULL,
  completed_at           timestamptz,
  CONSTRAINT source_probe_jobs_pkey PRIMARY KEY (tenant_id, space_id, job_id),
  CONSTRAINT source_probe_jobs_binding_fkey
    FOREIGN KEY (tenant_id, space_id, source_id)
    REFERENCES agent_platform.source_bindings (tenant_id, space_id, source_id) ON DELETE CASCADE,
  CONSTRAINT source_probe_jobs_status CHECK (status IN ('pending', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS source_probe_jobs_source_idx
  ON agent_platform.source_probe_jobs (tenant_id, space_id, source_id, created_at DESC);

-- The exact source fingerprints a resolved preflight observed. Keyed by the preflight's
-- content hash, so a mapping/capability change makes the recorded fingerprint differ and
-- the preflight is reported stale.
CREATE TABLE IF NOT EXISTS agent_platform.source_preflight_bindings (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  profile_id    text        NOT NULL,
  version       text        NOT NULL,
  snapshot_hash text        NOT NULL,
  fingerprints  jsonb       NOT NULL,
  recorded_at   timestamptz NOT NULL,
  recorded_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_preflight_bindings_pkey
    PRIMARY KEY (tenant_id, space_id, profile_id, version, snapshot_hash),
  CONSTRAINT source_preflight_bindings_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT source_preflight_bindings_snapshot_format
    CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$')
);

ALTER TABLE agent_platform.source_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.source_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.source_probe_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.source_preflight_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.source_bindings;
CREATE POLICY scope_isolation ON agent_platform.source_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.source_versions;
CREATE POLICY scope_isolation ON agent_platform.source_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.source_probe_jobs;
CREATE POLICY scope_isolation ON agent_platform.source_probe_jobs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.source_preflight_bindings;
CREATE POLICY scope_isolation ON agent_platform.source_preflight_bindings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
