-- 068_project_mapping_records.sql
--
-- Import-mapping versions and immutable project-record versions (SPEC v0.3a
-- asset-data-ui §3.3/§4.1/§6.2, issue V03-017 / #190).
--
-- Design:
--  * `project_mapping_versions` is an append-only import mapping: the chosen representation of
--    the customer file (selection + header digests + field-to-column correspondence + canonical
--    unit + exact conversion). A changed column or unit factor is a new `(mapping_id, version)`
--    row; the mapping is keyed per project so one project's layout can never overwrite another's.
--    The `definition_ref`/`source_object_ref` and `digest` pin exactly what the mapping asserts.
--  * `project_record_versions` binds a reconciled source row to a stable project-record identity.
--    `record_id` is the identity derived by the ingestion layer (scope + original digest + source
--    row key), so identical bytes resolve to the same record while two rows of one entity stay two
--    records. A re-bind with an unchanged `content_digest` reuses the stored revision; a changed
--    one appends the next revision, so a correction never rewrites history.
--  * The per-row idempotency key is `(call key, record id)`, so an at-least-once retry of a bind
--    replays instead of duplicating, while a different payload under the same call key is refused.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session scope
-- and each table carries a `scope_isolation` policy. Appended after 067, so the schema default
-- privileges grant the application role. Forward-only: migrations 001..067 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.project_mapping_versions (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  project_id       uuid        NOT NULL,
  mapping_id       uuid        NOT NULL,
  version          text        NOT NULL,
  digest           text        NOT NULL,
  definition_ref   jsonb       NOT NULL,
  source_object_ref jsonb      NOT NULL,
  body             jsonb       NOT NULL,
  idempotency_key  text        NOT NULL,
  request_digest   text        NOT NULL,
  actor            text        NOT NULL,
  trace_id         text,
  recorded_at      timestamptz NOT NULL,
  CONSTRAINT project_mapping_versions_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, mapping_id, version),
  CONSTRAINT project_mapping_versions_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT project_mapping_versions_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_mapping_versions_version_nonempty CHECK (char_length(version) > 0),
  CONSTRAINT project_mapping_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_mapping_versions_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_mapping_versions_definition_object CHECK (jsonb_typeof(definition_ref) = 'object'),
  CONSTRAINT project_mapping_versions_source_object CHECK (jsonb_typeof(source_object_ref) = 'object'),
  CONSTRAINT project_mapping_versions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT project_mapping_versions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS project_mapping_versions_definition_idx
  ON agent_platform.project_mapping_versions (tenant_id, space_id, (definition_ref ->> 'id'), (definition_ref ->> 'version'));

CREATE INDEX IF NOT EXISTS project_mapping_versions_mapping_idx
  ON agent_platform.project_mapping_versions (tenant_id, space_id, project_id, mapping_id, version DESC);

CREATE TABLE IF NOT EXISTS agent_platform.project_record_versions (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  project_id       uuid        NOT NULL,
  record_id        uuid        NOT NULL,
  revision         bigint      NOT NULL,
  mapping_id       uuid        NOT NULL,
  mapping_version  text        NOT NULL,
  object_id        text        NOT NULL,
  source_row_key   text        NOT NULL,
  source_digest    text        NOT NULL,
  content_digest   text        NOT NULL,
  body             jsonb       NOT NULL,
  status           text        NOT NULL,
  idempotency_key  text        NOT NULL,
  request_digest   text        NOT NULL,
  actor            text        NOT NULL,
  trace_id         text,
  recorded_at      timestamptz NOT NULL,
  CONSTRAINT project_record_versions_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, record_id, revision),
  CONSTRAINT project_record_versions_idempotency_unique UNIQUE (tenant_id, space_id, project_id, idempotency_key),
  CONSTRAINT project_record_versions_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_record_versions_revision_positive CHECK (revision > 0),
  CONSTRAINT project_record_versions_object_nonempty CHECK (char_length(object_id) > 0),
  CONSTRAINT project_record_versions_source_key_nonempty CHECK (char_length(source_row_key) > 0),
  CONSTRAINT project_record_versions_source_digest_format CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_record_versions_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_record_versions_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_record_versions_status CHECK (status IN ('confirmed', 'pending', 'conflict')),
  CONSTRAINT project_record_versions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT project_record_versions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS project_record_versions_source_idx
  ON agent_platform.project_record_versions (tenant_id, space_id, project_id, source_row_key);

CREATE INDEX IF NOT EXISTS project_record_versions_status_idx
  ON agent_platform.project_record_versions (tenant_id, space_id, project_id, status, record_id);

ALTER TABLE agent_platform.project_mapping_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.project_record_versions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_mapping_versions;
CREATE POLICY scope_isolation ON agent_platform.project_mapping_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_record_versions;
CREATE POLICY scope_isolation ON agent_platform.project_record_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
