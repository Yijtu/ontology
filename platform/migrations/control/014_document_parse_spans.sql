-- 014_document_parse_spans.sql
--
-- Traceable document parse runs and chunks (SPEC D3.2/D4.1, C3). The original
-- bytes and the derived artifacts live in the blob registry (005); this table
-- family records the parse identity (parser id + version), the coverage that was
-- actually achieved, the locator that maps a chunk back to the original version,
-- and the context the chunker kept attached to a clause or table.
--
-- A parse run is unique per (tenant, space, original digest, parser version), so
-- a duplicate upload of identical bytes reuses one logical parse instead of
-- creating a second one. Every lookup is keyed by (tenant_id, space_id) and RLS
-- denies rows outside the session scope, so cross-tenant existence is not
-- disclosed.
--
-- Forward-only: 001..013 are never edited. Appended after 003, so the schema
-- default privileges already grant the application role access.

CREATE TABLE IF NOT EXISTS agent_platform.document_parse_runs (
  tenant_id                uuid        NOT NULL,
  space_id                 uuid        NOT NULL,
  parse_id                 uuid        NOT NULL,
  original_blob_ref_id     uuid        NOT NULL,
  original_content_digest  text        NOT NULL,
  original_media_type      text        NOT NULL,
  original_kind            text        NOT NULL,
  media_kind               text        NOT NULL,
  parser_id                text        NOT NULL,
  parser_version           text        NOT NULL,
  offset_unit              text        NOT NULL,
  parse_status             text        NOT NULL,
  completeness             text        NOT NULL,
  coverage                 jsonb       NOT NULL,
  pages                    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  normalized_blob_ref_id   uuid        NOT NULL,
  normalized_content_digest text       NOT NULL,
  normalized_media_type    text        NOT NULL,
  normalized_byte_size     bigint      NOT NULL,
  span_map_blob_ref_id     uuid        NOT NULL,
  span_map_content_digest  text        NOT NULL,
  span_map_media_type      text        NOT NULL,
  source_namespace         text,
  source_id                text,
  document_version_ref     jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_parse_runs_pkey PRIMARY KEY (tenant_id, space_id, parse_id),
  CONSTRAINT document_parse_runs_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT document_parse_runs_dedup UNIQUE
    (tenant_id, space_id, original_content_digest, parser_version),
  CONSTRAINT document_parse_runs_media_kind CHECK (media_kind IN ('pdf', 'text')),
  CONSTRAINT document_parse_runs_offset_unit CHECK (offset_unit IN ('byte', 'character')),
  -- A parse that is not complete is recorded as partial; it must not be reported
  -- as complete (SPEC D4.1/§9).
  CONSTRAINT document_parse_runs_status CHECK (parse_status IN ('complete', 'partial')),
  CONSTRAINT document_parse_runs_completeness
    CHECK (completeness IN ('complete', 'partial', 'truncated', 'unknown')),
  CONSTRAINT document_parse_runs_digest_format
    CHECK (original_content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT document_parse_runs_normalized_byte_size_nonnegative
    CHECK (normalized_byte_size >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.document_chunks (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  parse_id        uuid        NOT NULL,
  chunk_id        uuid        NOT NULL,
  ordinal         integer     NOT NULL,
  chunk_kind      text        NOT NULL,
  heading         text,
  chunk_text      text        NOT NULL,
  text_digest     text        NOT NULL,
  locator         jsonb       NOT NULL,
  span_kind       text        NOT NULL,
  precision       text        NOT NULL,
  quote_digest    text        NOT NULL,
  conditions      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  exceptions      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  caption         text,
  table_header    text,
  parent_chunk_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_pkey PRIMARY KEY (tenant_id, space_id, parse_id, chunk_id),
  CONSTRAINT document_chunks_parse_fkey FOREIGN KEY (tenant_id, space_id, parse_id)
    REFERENCES agent_platform.document_parse_runs (tenant_id, space_id, parse_id)
    ON DELETE CASCADE,
  CONSTRAINT document_chunks_ordinal_unique UNIQUE (tenant_id, space_id, parse_id, ordinal),
  CONSTRAINT document_chunks_kind CHECK (chunk_kind IN ('section', 'clause', 'table', 'paragraph', 'page')),
  CONSTRAINT document_chunks_span_kind CHECK (span_kind IN ('verbatim', 'normalized', 'approximate')),
  -- An approximate locator (OCR) is a distinct value, so it can never be read as
  -- exact in-page evidence.
  CONSTRAINT document_chunks_precision CHECK (precision IN ('exact', 'approximate')),
  CONSTRAINT document_chunks_text_digest_format CHECK (text_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT document_chunks_ordinal_nonnegative CHECK (ordinal >= 0)
);

CREATE INDEX IF NOT EXISTS document_chunks_scope_idx
  ON agent_platform.document_chunks (tenant_id, space_id, parse_id, ordinal);

ALTER TABLE agent_platform.document_parse_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.document_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.document_parse_runs;
CREATE POLICY scope_isolation ON agent_platform.document_parse_runs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.document_chunks;
CREATE POLICY scope_isolation ON agent_platform.document_chunks
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
