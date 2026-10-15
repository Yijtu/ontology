-- 059_structured_ingestion.sql
--
-- Structured (UTF-8 text / JSON / CSV / XLSX) parse runs and their row reconciliation
-- (SPEC v0.3 A §5, A.US-002/A.US-006/P.US-003/P.US-013). The pure structured parser
-- (V03-005) produces `StructuredParseResult`; this family makes it durable through the
-- existing jobs/outbox pipeline.
--
--  * `document_structured_parses` is the parse identity: parser version, coverage and the
--    row reconciliation counters (total / succeeded / pending / failed / skipped). A parse
--    is unique per (tenant, space, original digest, parser version), so a duplicate upload of
--    identical bytes reuses one logical parse instead of creating a second one, and a partial
--    parse is stored with `parse_status = 'incomplete'`, never as complete (SPEC D4.1/§9).
--  * `document_structured_records` is one reconciled source row with a locator back to the
--    immutable original. `record_id` is derived from the trusted scope + original digest +
--    source row key, so a duplicate import reads back stable original-record identities while
--    two rows of the same entity stay two distinct records (SPEC A.US-006.AC-03).
--
-- Forward-only: 001..058 are never edited. Appended after 003, so the schema default
-- privileges already grant the application role access without another explicit GRANT.

CREATE TABLE IF NOT EXISTS agent_platform.document_structured_parses (
  tenant_id                 uuid        NOT NULL,
  space_id                  uuid        NOT NULL,
  parse_id                  uuid        NOT NULL,
  original_blob_ref_id      uuid        NOT NULL,
  original_content_digest   text        NOT NULL,
  original_media_type       text        NOT NULL,
  original_kind             text        NOT NULL,
  format                    text        NOT NULL,
  parser_id                 text        NOT NULL,
  parser_version            text        NOT NULL,
  parse_status              text        NOT NULL,
  coverage                  jsonb       NOT NULL,
  counts                    jsonb       NOT NULL,
  sheets                    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  diagnostics               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source_namespace          text,
  source_id                 text,
  document_version_ref      jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_structured_parses_pkey PRIMARY KEY (tenant_id, space_id, parse_id),
  CONSTRAINT document_structured_parses_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT document_structured_parses_dedup UNIQUE
    (tenant_id, space_id, original_content_digest, parser_version),
  CONSTRAINT document_structured_parses_format CHECK (format IN ('text', 'json', 'csv', 'xlsx')),
  -- A parse that is not complete is stored as incomplete/rejected; it can never be read as complete.
  CONSTRAINT document_structured_parses_status CHECK (parse_status IN ('complete', 'incomplete', 'rejected')),
  CONSTRAINT document_structured_parses_digest_format
    CHECK (original_content_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS agent_platform.document_structured_records (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  parse_id        uuid        NOT NULL,
  record_id       uuid        NOT NULL,
  source_row_key  text        NOT NULL,
  record_index    integer     NOT NULL,
  row_number      integer     NOT NULL,
  state           text        NOT NULL,
  locator         jsonb       NOT NULL,
  row_digest      text        NOT NULL,
  column_count    integer     NOT NULL,
  error           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_structured_records_pkey PRIMARY KEY (tenant_id, space_id, parse_id, record_id),
  CONSTRAINT document_structured_records_parse_fkey FOREIGN KEY (tenant_id, space_id, parse_id)
    REFERENCES agent_platform.document_structured_parses (tenant_id, space_id, parse_id)
    ON DELETE CASCADE,
  -- One row per source position per parse: a re-import of the same file revision never duplicates.
  CONSTRAINT document_structured_records_source_unique UNIQUE
    (tenant_id, space_id, parse_id, source_row_key),
  CONSTRAINT document_structured_records_state CHECK (state IN ('parsed', 'pending', 'failed', 'skipped')),
  CONSTRAINT document_structured_records_index_positive CHECK (record_index > 0 AND row_number > 0),
  CONSTRAINT document_structured_records_column_count CHECK (column_count >= 0),
  CONSTRAINT document_structured_records_digest_format CHECK (row_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS document_structured_records_cursor_idx
  ON agent_platform.document_structured_records (tenant_id, space_id, parse_id, record_index);

CREATE INDEX IF NOT EXISTS document_structured_records_state_idx
  ON agent_platform.document_structured_records (tenant_id, space_id, parse_id, state, record_index);

ALTER TABLE agent_platform.document_structured_parses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.document_structured_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.document_structured_parses;
CREATE POLICY scope_isolation ON agent_platform.document_structured_parses
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.document_structured_records;
CREATE POLICY scope_isolation ON agent_platform.document_structured_records
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
