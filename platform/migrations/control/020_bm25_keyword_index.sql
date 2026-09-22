-- 020_bm25_keyword_index.sql
--
-- Versioned keyword (BM25) index per authorized collection (SPEC ADR-07, C3/C4,
-- D3.2). An index generation is immutable and identified by a monotonic
-- generation number plus a content digest of the indexed corpus. A query binds to
-- one generation, so a rebuild cannot change the results served for the version a
-- caller is already reading.
--
-- A generation is written in one transaction together with all of its documents
-- and postings, so a crash mid-build leaves no generation to publish. The active
-- pointer is a separate row, so activating a new generation is an explicit step.
--
-- Documents carry the LOCAL-023 span locator and the source document digest. The
-- digest is the lineage key: duplicate copies of identical content collapse to one
-- independent evidence span instead of inflating the result count.
--
-- Forward-only: 001..014 are never edited. Appended after 003, so the schema
-- default privileges already grant the application role access.

CREATE TABLE IF NOT EXISTS agent_platform.keyword_index_generations (
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  collection_ref text        NOT NULL,
  generation     text        NOT NULL,
  index_digest   text        NOT NULL,
  index_ref      jsonb       NOT NULL,
  doc_count      integer     NOT NULL,
  avg_doc_length double precision NOT NULL,
  completeness   text        NOT NULL,
  state          text        NOT NULL DEFAULT 'staged',
  built_at       timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_index_generations_pkey
    PRIMARY KEY (tenant_id, space_id, collection_ref, generation),
  -- Re-indexing an unchanged corpus reuses this row instead of minting a version.
  CONSTRAINT keyword_index_generations_dedup
    UNIQUE (tenant_id, space_id, collection_ref, index_digest),
  CONSTRAINT keyword_index_generations_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT keyword_index_generations_digest_format
    CHECK (index_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT keyword_index_generations_generation_format
    CHECK (generation ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT keyword_index_generations_state
    CHECK (state IN ('staged', 'active', 'superseded')),
  CONSTRAINT keyword_index_generations_completeness
    CHECK (completeness IN ('complete', 'partial', 'truncated', 'unknown')),
  CONSTRAINT keyword_index_generations_doc_count CHECK (doc_count >= 0),
  CONSTRAINT keyword_index_generations_avg_doc_length CHECK (avg_doc_length >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.keyword_index_documents (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  collection_ref        text        NOT NULL,
  generation            text        NOT NULL,
  chunk_id              uuid        NOT NULL,
  parse_id              uuid        NOT NULL,
  document_ref_id       uuid        NOT NULL,
  document_ref_version  text        NOT NULL,
  document_digest       text        NOT NULL,
  source_namespace      text,
  source_id             text,
  media_type            text        NOT NULL,
  chunk_text            text        NOT NULL,
  text_digest           text        NOT NULL,
  locator               jsonb       NOT NULL,
  span_kind             text        NOT NULL,
  precision             text        NOT NULL,
  quote_digest          text        NOT NULL,
  ordinal               integer     NOT NULL,
  doc_length            integer     NOT NULL,
  recorded_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_index_documents_pkey
    PRIMARY KEY (tenant_id, space_id, collection_ref, generation, chunk_id),
  CONSTRAINT keyword_index_documents_generation_fkey
    FOREIGN KEY (tenant_id, space_id, collection_ref, generation)
    REFERENCES agent_platform.keyword_index_generations
      (tenant_id, space_id, collection_ref, generation) ON DELETE CASCADE,
  CONSTRAINT keyword_index_documents_document_digest_format
    CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT keyword_index_documents_text_digest_format
    CHECK (text_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT keyword_index_documents_span_kind
    CHECK (span_kind IN ('verbatim', 'normalized', 'approximate')),
  CONSTRAINT keyword_index_documents_precision
    CHECK (precision IN ('exact', 'approximate')),
  CONSTRAINT keyword_index_documents_doc_length CHECK (doc_length >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.keyword_index_postings (
  tenant_id       uuid    NOT NULL,
  space_id        uuid    NOT NULL,
  collection_ref  text    NOT NULL,
  generation      text    NOT NULL,
  term            text    NOT NULL,
  chunk_id        uuid    NOT NULL,
  term_frequency  integer NOT NULL,
  CONSTRAINT keyword_index_postings_pkey
    PRIMARY KEY (tenant_id, space_id, collection_ref, generation, term, chunk_id),
  CONSTRAINT keyword_index_postings_document_fkey
    FOREIGN KEY (tenant_id, space_id, collection_ref, generation, chunk_id)
    REFERENCES agent_platform.keyword_index_documents
      (tenant_id, space_id, collection_ref, generation, chunk_id) ON DELETE CASCADE,
  CONSTRAINT keyword_index_postings_term_frequency CHECK (term_frequency >= 1)
);

CREATE INDEX IF NOT EXISTS keyword_index_postings_term_idx
  ON agent_platform.keyword_index_postings
    (tenant_id, space_id, collection_ref, generation, term);

CREATE INDEX IF NOT EXISTS keyword_index_documents_lineage_idx
  ON agent_platform.keyword_index_documents
    (tenant_id, space_id, collection_ref, generation, document_digest);

CREATE TABLE IF NOT EXISTS agent_platform.keyword_index_active (
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  collection_ref text        NOT NULL,
  generation     text        NOT NULL,
  activated_at   timestamptz NOT NULL,
  CONSTRAINT keyword_index_active_pkey PRIMARY KEY (tenant_id, space_id, collection_ref),
  CONSTRAINT keyword_index_active_generation_fkey
    FOREIGN KEY (tenant_id, space_id, collection_ref, generation)
    REFERENCES agent_platform.keyword_index_generations
      (tenant_id, space_id, collection_ref, generation) ON DELETE CASCADE
);

ALTER TABLE agent_platform.keyword_index_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.keyword_index_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.keyword_index_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.keyword_index_active ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.keyword_index_generations;
CREATE POLICY scope_isolation ON agent_platform.keyword_index_generations
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.keyword_index_documents;
CREATE POLICY scope_isolation ON agent_platform.keyword_index_documents
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.keyword_index_postings;
CREATE POLICY scope_isolation ON agent_platform.keyword_index_postings
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.keyword_index_active;
CREATE POLICY scope_isolation ON agent_platform.keyword_index_active
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
