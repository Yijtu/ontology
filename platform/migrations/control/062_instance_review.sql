-- 062_instance_review.sql
--
-- Public instance record review: append-only record revisions and key-field confirmation
-- events (SPEC v0.3a asset-data-ui §3.3/§3.4/§4.1, issue V03-013 / #182, A.US-004,
-- P.US-008/010/014).
--
-- Design:
--  * `instance_review_records` is append-only. `(tenant_id, space_id, project_id, record_id,
--    revision)` is the primary key, so a field edit, an identity adjudication or an
--    approve/publish is a NEW immutable revision and the earlier one stays readable. The
--    stable `record_id` is what a duplicate entity must not delete: a `match` changes only
--    the recorded identity state, never the row count of independent business records.
--    `body` carries the reviewer-facing projection (fields with raw/normalized/source/status,
--    relation endpoints and the identity adjudication history). `content_digest` pins the
--    body; `idempotency_key` is unique per scope so a replayed write returns the original
--    revision instead of appending a second one.
--  * `instance_review_confirmations` is the append-only input-governance history.
--    `(tenant_id, space_id, project_id, record_id, field_id, revision)` is the key, so a
--    correction never rewrites the earlier decision. An unknown field enters `pending` and is
--    recorded here rather than being silently confirmed or published.
--  * `publication_state` is `draft` → `approved` → `published`; approval and publication are
--    distinct transitions and `published_revision` pins what a read-back returns.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session
-- scope and each table carries a `scope_isolation` policy. Appended after 003, so the schema
-- default privileges grant the application role. Forward-only: 001..061 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.instance_review_records (
  tenant_id                  uuid        NOT NULL,
  space_id                   uuid        NOT NULL,
  project_id                 uuid        NOT NULL,
  record_id                  uuid        NOT NULL,
  revision                   bigint      NOT NULL,
  object_type_ref            text        NOT NULL,
  identity_state             text        NOT NULL,
  identity_confidence        text        NOT NULL,
  same_name_different_meaning boolean    NOT NULL DEFAULT false,
  matched_entity_id          text,
  publication_state          text        NOT NULL,
  published_revision         bigint,
  body                       jsonb       NOT NULL,
  content_digest             text        NOT NULL,
  idempotency_key            text        NOT NULL,
  actor                      text        NOT NULL,
  trace_id                   text,
  recorded_at                timestamptz NOT NULL,
  CONSTRAINT instance_review_records_pkey PRIMARY KEY (tenant_id, space_id, project_id, record_id, revision),
  CONSTRAINT instance_review_records_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT instance_review_records_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT instance_review_records_revision_positive CHECK (revision > 0),
  CONSTRAINT instance_review_records_object_type_nonempty CHECK (char_length(object_type_ref) > 0),
  CONSTRAINT instance_review_records_identity_state CHECK (
    identity_state IN ('unresolved', 'matched', 'created', 'rejected', 'split')
  ),
  CONSTRAINT instance_review_records_identity_confidence CHECK (
    identity_confidence IN ('exact', 'candidate', 'none')
  ),
  CONSTRAINT instance_review_records_publication_state CHECK (
    publication_state IN ('draft', 'approved', 'published')
  ),
  CONSTRAINT instance_review_records_published_revision_positive CHECK (
    published_revision IS NULL OR published_revision > 0
  ),
  CONSTRAINT instance_review_records_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT instance_review_records_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT instance_review_records_body_object CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX IF NOT EXISTS instance_review_records_project_idx
  ON agent_platform.instance_review_records (tenant_id, space_id, project_id, record_id, revision DESC);

CREATE INDEX IF NOT EXISTS instance_review_records_state_idx
  ON agent_platform.instance_review_records (tenant_id, space_id, project_id, publication_state, recorded_at DESC);

CREATE TABLE IF NOT EXISTS agent_platform.instance_review_confirmations (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  project_id      uuid        NOT NULL,
  record_id       uuid        NOT NULL,
  field_id        text        NOT NULL,
  revision        bigint      NOT NULL,
  record_revision bigint      NOT NULL,
  status          text        NOT NULL,
  reason          text,
  source_ref      jsonb       NOT NULL,
  content_digest  text        NOT NULL,
  idempotency_key text        NOT NULL,
  actor           text        NOT NULL,
  trace_id        text,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT instance_review_confirmations_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, record_id, field_id, revision),
  CONSTRAINT instance_review_confirmations_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT instance_review_confirmations_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT instance_review_confirmations_revision_positive CHECK (revision > 0),
  CONSTRAINT instance_review_confirmations_record_revision_non_negative CHECK (record_revision >= 0),
  CONSTRAINT instance_review_confirmations_status CHECK (status IN ('pending', 'confirmed', 'conflict')),
  CONSTRAINT instance_review_confirmations_field_nonempty CHECK (char_length(field_id) > 0),
  CONSTRAINT instance_review_confirmations_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT instance_review_confirmations_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT instance_review_confirmations_source_object CHECK (jsonb_typeof(source_ref) = 'object')
);

CREATE INDEX IF NOT EXISTS instance_review_confirmations_record_idx
  ON agent_platform.instance_review_confirmations (tenant_id, space_id, project_id, record_id, field_id, revision);

CREATE INDEX IF NOT EXISTS instance_review_confirmations_status_idx
  ON agent_platform.instance_review_confirmations (tenant_id, space_id, project_id, status, record_id);

ALTER TABLE agent_platform.instance_review_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.instance_review_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.instance_review_records;
CREATE POLICY scope_isolation ON agent_platform.instance_review_records
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.instance_review_confirmations;
CREATE POLICY scope_isolation ON agent_platform.instance_review_confirmations
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
