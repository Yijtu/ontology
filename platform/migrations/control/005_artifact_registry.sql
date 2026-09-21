-- 005_artifact_registry.sql
--
-- Immutable artifact registry (SPEC D2/D3.2, ADR-08, §6). `blob-local` owns the
-- content-addressed bytes; this table family records the tenant/space-scoped
-- authorization reference, media type and the shared content lineage, so a
-- duplicate upload reuses the same bytes and stays traceable to its origins.
--
-- Content hashing/dedup runs inside the customer domain: every lookup below is
-- keyed by (tenant_id, space_id) and RLS denies rows outside the session scope,
-- so a cross-tenant probe cannot observe whether content exists.
--
-- Appended after 003, so the schema default privileges grant the application
-- role access without another explicit GRANT. Forward-only: 001..004 are never
-- edited.

CREATE TABLE IF NOT EXISTS agent_platform.artifact_blobs (
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  content_digest text        NOT NULL,
  media_type     text        NOT NULL,
  byte_size      bigint      NOT NULL,
  object_key     text        NOT NULL,
  lineage_id     uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_blobs_pkey PRIMARY KEY (tenant_id, space_id, content_digest),
  CONSTRAINT artifact_blobs_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT artifact_blobs_byte_size_nonnegative CHECK (byte_size >= 0),
  CONSTRAINT artifact_blobs_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS agent_platform.artifact_references (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  blob_ref_id           uuid        NOT NULL,
  content_digest        text        NOT NULL,
  purpose               text        NOT NULL,
  run_id                uuid,
  tenant_authorized_ref text,
  origin                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_references_pkey PRIMARY KEY (tenant_id, space_id, blob_ref_id),
  CONSTRAINT artifact_references_blob_fkey FOREIGN KEY (tenant_id, space_id, content_digest)
    REFERENCES agent_platform.artifact_blobs (tenant_id, space_id, content_digest) ON DELETE CASCADE,
  CONSTRAINT artifact_references_purpose
    CHECK (purpose IN ('document', 'large_result', 'checkpoint', 'artifact')),
  -- A private checkpoint is only meaningful inside a run; a non-checkpoint
  -- artifact must not smuggle a run scope it does not have.
  CONSTRAINT artifact_references_checkpoint_run
    CHECK ((purpose = 'checkpoint') = (run_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS artifact_references_digest_idx
  ON agent_platform.artifact_references (tenant_id, space_id, content_digest);

ALTER TABLE agent_platform.artifact_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.artifact_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.artifact_blobs;
CREATE POLICY scope_isolation ON agent_platform.artifact_blobs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.artifact_references;
CREATE POLICY scope_isolation ON agent_platform.artifact_references
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
