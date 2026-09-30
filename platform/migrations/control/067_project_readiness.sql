-- 067_project_readiness.sql
--
-- Independent per-revision project readiness projections (SPEC v0.3a
-- asset-data-ui §3.2/§4.1, issue V03-016 / #189).
--
-- Design:
--  * One row per (project, project_revision, kind). A projection is deliberately NOT part of
--    the project revision digest: the immutable `project_revisions` row says what was pinned,
--    this table says whether the semantic/dataset/document-index projection is actually built.
--  * `fence_revision` is the compare-and-swap counter. A worker that finished a late build
--    after the source visibility epoch advanced carries an older fence; the store refuses to
--    lower the stored fence, so a revoked source can never be re-activated by a stale build.
--  * `target_digest` is the digest of the exact target the projection points at. A reader
--    re-checks it before trusting `ready`, and a differing target with the same fence is a
--    distinct build that must not silently replace the active one.
--  * `state` is only set to `ready` by a CAS upsert after the target digest and coverage were
--    verified; a project that is not synced therefore stays `pending`/`building` and can never
--    claim to be queryable.
--  * The `idempotency_key` is unique per scope so an at-least-once worker delivery replays the
--    same projection instead of writing a second one; `request_digest` distinguishes a retry
--    from IDEMPOTENCY_CONFLICT.
--
-- Every key carries tenant_id/space_id, RLS denies rows outside the session scope and the
-- table carries a `scope_isolation` policy. Appended after 066, so the schema default
-- privileges grant the application role. Forward-only: migrations 001..066 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.project_readiness (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  project_id       uuid        NOT NULL,
  project_revision bigint      NOT NULL,
  kind             text        NOT NULL,
  target_ref       jsonb       NOT NULL,
  state            text        NOT NULL,
  completeness     text        NOT NULL,
  expected_count   bigint      NOT NULL DEFAULT 0,
  processed_count  bigint      NOT NULL DEFAULT 0,
  failed_count     bigint      NOT NULL DEFAULT 0,
  target_digest    text        NOT NULL,
  receipt_ref      jsonb,
  fence_revision   bigint      NOT NULL,
  job_id           uuid,
  error            jsonb,
  idempotency_key  text        NOT NULL,
  request_digest   text        NOT NULL,
  actor            text        NOT NULL,
  trace_id         text,
  recorded_at      timestamptz NOT NULL,
  available_at     timestamptz NOT NULL,
  CONSTRAINT project_readiness_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, project_revision, kind),
  CONSTRAINT project_readiness_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT project_readiness_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_readiness_revision_positive CHECK (project_revision > 0),
  CONSTRAINT project_readiness_kind CHECK (kind IN ('published_semantics', 'dataset', 'document_index')),
  CONSTRAINT project_readiness_state CHECK (state IN ('pending', 'building', 'ready', 'failed', 'revoked')),
  CONSTRAINT project_readiness_completeness CHECK (completeness IN ('complete', 'partial', 'truncated', 'unknown')),
  CONSTRAINT project_readiness_counts_non_negative CHECK
    (expected_count >= 0 AND processed_count >= 0 AND failed_count >= 0),
  CONSTRAINT project_readiness_target_digest_format CHECK (target_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_readiness_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_readiness_fence_non_negative CHECK (fence_revision >= 0),
  CONSTRAINT project_readiness_target_object CHECK (jsonb_typeof(target_ref) = 'object'),
  CONSTRAINT project_readiness_receipt_object CHECK (receipt_ref IS NULL OR jsonb_typeof(receipt_ref) = 'object'),
  CONSTRAINT project_readiness_error_object CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT project_readiness_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS project_readiness_revision_idx
  ON agent_platform.project_readiness (tenant_id, space_id, project_id, project_revision);

-- Authorized scheduling reads the state and the earliest availability in one scan.
CREATE INDEX IF NOT EXISTS project_readiness_schedule_idx
  ON agent_platform.project_readiness (state, available_at);

CREATE INDEX IF NOT EXISTS project_readiness_target_digest_idx
  ON agent_platform.project_readiness (tenant_id, space_id, kind, target_digest);

ALTER TABLE agent_platform.project_readiness ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_readiness;
CREATE POLICY scope_isolation ON agent_platform.project_readiness
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
