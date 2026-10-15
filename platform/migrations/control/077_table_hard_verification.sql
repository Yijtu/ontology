-- 077_table_hard_verification.sql
--
-- Batched full-table hard-verification receipts and their recovery progress (SPEC v0.3a
-- execution-evidence §EX-7.1, §5.1 step 4, issue V03-033 / #204).
--
-- Why these tables exist on top of the table artifacts (076) and the policy reports (073):
--
--  * `table_verification_receipts` stores one immutable `table-verification-receipt@1` body
--    per exact ref digest. The receipt is produced only after every declared row of one table
--    passed the exact value/unit/currency/subject/row-binding checks, so the manifest's
--    `verification_receipt_ref` can only ever name a receipt that was actually earned. A
--    fail/incomplete verification writes no receipt row and the table cannot be rendered.
--  * `table_verification_progress` stores the manifest-digest-bound recovery progress for the
--    batched verifier: how many rows/cells were checked, which page the next batch starts at,
--    the row identities already bound and the per-batch records. A verification that runs out
--    of budget/deadline resumes from this row without skipping a row or weakening a later
--    check.
--
-- Both tables carry tenant_id/space_id, have RLS enabled and a `scope_isolation` policy.
-- Appended after 076, so the schema default privileges grant the application role.
-- Forward-only: migrations 001..076 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.table_verification_receipts (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  receipt_id         uuid        NOT NULL,
  version            text        NOT NULL,
  digest             text        NOT NULL,
  manifest_id        uuid        NOT NULL,
  manifest_version   text        NOT NULL,
  manifest_digest    text        NOT NULL,
  table_id           text        NOT NULL,
  draft_hash         text        NOT NULL,
  receipt            jsonb       NOT NULL,
  recorded_at        timestamptz NOT NULL,
  CONSTRAINT table_verification_receipts_pkey PRIMARY KEY
    (tenant_id, space_id, receipt_id, version, digest),
  CONSTRAINT table_verification_receipts_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT table_verification_receipts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_verification_receipts_manifest_format CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_verification_receipts_draft_format CHECK (draft_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_verification_receipts_receipt_object CHECK (jsonb_typeof(receipt) = 'object')
);

CREATE INDEX IF NOT EXISTS table_verification_receipts_manifest_idx
  ON agent_platform.table_verification_receipts (tenant_id, space_id, manifest_id, manifest_version, table_id);

CREATE TABLE IF NOT EXISTS agent_platform.table_verification_progress (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  manifest_id        uuid        NOT NULL,
  manifest_version   text        NOT NULL,
  manifest_digest    text        NOT NULL,
  table_id           text        NOT NULL,
  total_rows         integer     NOT NULL,
  checked_rows       integer     NOT NULL,
  checked_cells      integer     NOT NULL,
  next_page_index    integer     NOT NULL,
  next_row_in_page   integer     NOT NULL DEFAULT 0,
  bound_subjects     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  batches            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  checks_digest      text        NOT NULL,
  updated_at         timestamptz NOT NULL,
  CONSTRAINT table_verification_progress_pkey PRIMARY KEY
    (tenant_id, space_id, manifest_id, manifest_version, manifest_digest, table_id),
  CONSTRAINT table_verification_progress_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT table_verification_progress_manifest_format CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_verification_progress_checks_format CHECK (checks_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT table_verification_progress_counts CHECK
    (total_rows >= 0 AND checked_rows >= 0 AND checked_cells >= 0 AND next_page_index >= 0 AND next_row_in_page >= 0),
  CONSTRAINT table_verification_progress_subjects_array CHECK (jsonb_typeof(bound_subjects) = 'array'),
  CONSTRAINT table_verification_progress_batches_array CHECK (jsonb_typeof(batches) = 'array')
);

ALTER TABLE agent_platform.table_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.table_verification_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.table_verification_receipts;
CREATE POLICY scope_isolation ON agent_platform.table_verification_receipts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.table_verification_progress;
CREATE POLICY scope_isolation ON agent_platform.table_verification_progress
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
