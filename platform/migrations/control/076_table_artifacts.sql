-- 076_table_artifacts.sql
--
-- Typed result table manifests, immutable page artifacts and the fixed-revision page-tab
-- progress (SPEC v0.3a execution-evidence §EX-7.1, §EX-9, issue V03-032 / #203).
--
-- Why these tables exist on top of answer_publications (044), compute result artifacts (075)
-- and the task finalization receipts (073):
--
--  * `table_result_manifests` is the immutable description of one table of one fixed result
--    revision. It stores only refs/counts/digests: the column descriptors, the page refs and
--    the completion flag, plus the ref/digest of the table-verification receipt. One verified
--    manifest per (answer, table) so a reader never picks up a different generation.
--  * `table_artifact_pages` stores only page metadata (ref id/version/digest, index, row
--    count, boundary row keys, coverage digest and the artifact-store ref that holds the
--    bytes). The row values and cell bindings live in the immutable artifact store, never in
--    a control row, so a large table cannot be smuggled into the control database.
--  * `table_read_progress` is the persisted page tab per (answer, table) scope. It records
--    the highest page index served and the consumed cursor digests, which is what lets the
--    reader refuse a duplicate or backward cursor instead of silently concatenating pages.
--
-- Every table carries tenant_id/space_id, has RLS enabled and a `scope_isolation` policy.
-- Appended after 075, so the schema default privileges grant the application role.
-- Forward-only: migrations 001..075 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.table_result_manifests (
  tenant_id                      uuid        NOT NULL,
  space_id                       uuid        NOT NULL,
  manifest_id                    uuid        NOT NULL,
  version                        text        NOT NULL,
  digest                         text        NOT NULL,
  answer_id                      uuid        NOT NULL,
  table_id                       text        NOT NULL,
  output_schema_ref              jsonb       NOT NULL,
  total_rows                     integer     NOT NULL,
  page_count                     integer     NOT NULL,
  complete                       boolean     NOT NULL,
  verification_receipt_id        uuid        NOT NULL,
  verification_receipt_version    text        NOT NULL,
  verification_receipt_digest    text        NOT NULL,
  manifest                       jsonb       NOT NULL,
  recorded_at                    timestamptz NOT NULL,
  CONSTRAINT table_result_manifests_pkey PRIMARY KEY (tenant_id, space_id, manifest_id, version, digest),
  CONSTRAINT table_result_manifests_answer_table_unique UNIQUE (tenant_id, space_id, answer_id, table_id),
  CONSTRAINT table_result_manifests_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT table_result_manifests_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_result_manifests_receipt_digest_format CHECK (verification_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_result_manifests_counts CHECK (total_rows >= 0 AND page_count >= 0),
  CONSTRAINT table_result_manifests_manifest_object CHECK (jsonb_typeof(manifest) = 'object')
);

CREATE INDEX IF NOT EXISTS table_result_manifests_answer_idx
  ON agent_platform.table_result_manifests (tenant_id, space_id, answer_id);

CREATE TABLE IF NOT EXISTS agent_platform.table_artifact_pages (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  page_id         uuid        NOT NULL,
  version         text        NOT NULL,
  digest          text        NOT NULL,
  table_id        text        NOT NULL,
  page_index      integer     NOT NULL,
  row_count       integer     NOT NULL,
  first_row_key   text        NOT NULL,
  last_row_key    text        NOT NULL,
  coverage_digest text        NOT NULL,
  content_ref     jsonb       NOT NULL,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT table_artifact_pages_pkey PRIMARY KEY (tenant_id, space_id, page_id, version, digest),
  CONSTRAINT table_artifact_pages_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT table_artifact_pages_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_artifact_pages_coverage_format CHECK (coverage_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_artifact_pages_rows CHECK (row_count >= 0),
  CONSTRAINT table_artifact_pages_content_ref_object CHECK (jsonb_typeof(content_ref) = 'object')
);

CREATE INDEX IF NOT EXISTS table_artifact_pages_table_idx
  ON agent_platform.table_artifact_pages (tenant_id, space_id, table_id, page_index);

CREATE TABLE IF NOT EXISTS agent_platform.table_read_progress (
  tenant_id                 uuid        NOT NULL,
  space_id                  uuid        NOT NULL,
  answer_id                 uuid        NOT NULL,
  table_id                  text        NOT NULL,
  highest_served_page_index integer     NOT NULL,
  consumed_cursor_digests   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at                timestamptz NOT NULL,
  CONSTRAINT table_read_progress_pkey PRIMARY KEY (tenant_id, space_id, answer_id, table_id),
  CONSTRAINT table_read_progress_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT table_read_progress_highest CHECK (highest_served_page_index >= 0),
  CONSTRAINT table_read_progress_digests_array CHECK (jsonb_typeof(consumed_cursor_digests) = 'array')
);

ALTER TABLE agent_platform.table_result_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.table_artifact_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.table_read_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.table_result_manifests;
CREATE POLICY scope_isolation ON agent_platform.table_result_manifests
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.table_artifact_pages;
CREATE POLICY scope_isolation ON agent_platform.table_artifact_pages
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.table_read_progress;
CREATE POLICY scope_isolation ON agent_platform.table_read_progress
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
