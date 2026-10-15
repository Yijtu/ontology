-- 089_source_review_admissions.sql
--
-- Append-only source review history, a retraction visibility fence on candidate
-- sources, and the workspace source-admission records (design §2.2/§2.7, node N04).
--
-- Design:
--  * `candidate_source_review_events` is the append-only audit of reviews and
--    retractions. The mutable `candidate_sources.review_state`/`trust_tier` row is
--    only the *latest projection* of these events. `seq` gives a stable page order;
--    `idempotency_key` is unique per scope so a replayed review/retraction returns
--    the stored event instead of appending a second one.
--  * A retraction sets `candidate_sources.retracted_at`/`retracted_by` (the fence)
--    and appends a `retraction = true` event; the original snapshot and every prior
--    event stay readable.
--  * `workspace_source_admissions` binds one reviewed source revision to the parse
--    binding and the new immutable workspace document set it was admitted under. The
--    `(tenant, space, workspace_id, source_id, source_revision)` unique key admits one
--    reviewed version exactly once; every key/FK carries tenant_id/space_id.
--
-- Every key and foreign key carries tenant_id/space_id; RLS denies rows outside the
-- session scope and both tables carry a `scope_isolation` policy. Appended after 003,
-- so the schema default privileges grant the application role. Forward-only: earlier
-- migrations are never edited.

ALTER TABLE agent_platform.candidate_sources
  ADD COLUMN IF NOT EXISTS retracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS retracted_by text;

-- An explicit sequence so its usage can be granted to the application role; the schema default
-- privileges (from 003) cover tables, not sequences.
CREATE SEQUENCE IF NOT EXISTS agent_platform.candidate_source_review_events_seq;
GRANT USAGE, SELECT ON SEQUENCE agent_platform.candidate_source_review_events_seq TO ontology_app;

CREATE TABLE IF NOT EXISTS agent_platform.candidate_source_review_events (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  workspace_id        uuid        NOT NULL,
  source_id           uuid        NOT NULL,
  event_id            uuid        NOT NULL,
  seq                 bigint      NOT NULL DEFAULT nextval('agent_platform.candidate_source_review_events_seq'),
  previous_state      text        NOT NULL,
  next_state          text        NOT NULL,
  previous_trust_tier text,
  next_trust_tier     text,
  reason              text        NOT NULL,
  basis_refs          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  actor               text        NOT NULL,
  recorded_at         timestamptz NOT NULL,
  retraction          boolean     NOT NULL DEFAULT false,
  next_revision       bigint      NOT NULL,
  idempotency_key     text        NOT NULL,
  request_digest      text        NOT NULL,
  CONSTRAINT candidate_source_review_events_pkey PRIMARY KEY (tenant_id, space_id, event_id),
  CONSTRAINT candidate_source_review_events_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT candidate_source_review_events_source_fkey FOREIGN KEY (tenant_id, space_id, source_id)
    REFERENCES agent_platform.candidate_sources (tenant_id, space_id, source_id) ON DELETE CASCADE,
  CONSTRAINT candidate_source_review_events_state CHECK (previous_state IN ('proposed', 'approved', 'rejected') AND next_state IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT candidate_source_review_events_prev_tier CHECK (previous_trust_tier IS NULL OR previous_trust_tier IN ('customer_authoritative', 'public_standard', 'agent_researched', 'synthetic')),
  CONSTRAINT candidate_source_review_events_next_tier CHECK (next_trust_tier IS NULL OR next_trust_tier IN ('customer_authoritative', 'public_standard', 'agent_researched', 'synthetic')),
  CONSTRAINT candidate_source_review_events_next_revision CHECK (next_revision >= 1),
  CONSTRAINT candidate_source_review_events_reason_nonempty CHECK (char_length(reason) > 0),
  CONSTRAINT candidate_source_review_events_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT candidate_source_review_events_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT candidate_source_review_events_basis_array CHECK (jsonb_typeof(basis_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS candidate_source_review_events_scope_idx
  ON agent_platform.candidate_source_review_events (tenant_id, space_id, source_id, seq);

ALTER TABLE agent_platform.candidate_source_review_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.candidate_source_review_events;
CREATE POLICY scope_isolation ON agent_platform.candidate_source_review_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

CREATE TABLE IF NOT EXISTS agent_platform.workspace_source_admissions (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  workspace_id            uuid        NOT NULL,
  admission_id            uuid        NOT NULL,
  source_id               uuid        NOT NULL,
  source_revision         bigint      NOT NULL,
  source_review_event_id  uuid,
  trust_tier              text        NOT NULL,
  source_ref              jsonb       NOT NULL,
  parse_id                uuid        NOT NULL,
  parser_version          text        NOT NULL,
  kind                    text        NOT NULL,
  table_options           jsonb,
  document_set_ref        jsonb       NOT NULL,
  draft_revision          bigint      NOT NULL,
  draft_digest            text        NOT NULL,
  idempotency_key         text        NOT NULL,
  request_digest          text        NOT NULL,
  admitted_by             text        NOT NULL,
  admitted_at             timestamptz NOT NULL,
  CONSTRAINT workspace_source_admissions_pkey PRIMARY KEY (tenant_id, space_id, admission_id),
  CONSTRAINT workspace_source_admissions_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT workspace_source_admissions_reviewed_source_unique UNIQUE (tenant_id, space_id, workspace_id, source_id, source_revision),
  CONSTRAINT workspace_source_admissions_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_source_admissions_trust CHECK (trust_tier IN ('customer_authoritative', 'public_standard', 'agent_researched', 'synthetic')),
  CONSTRAINT workspace_source_admissions_kind CHECK (kind IN ('document', 'table')),
  CONSTRAINT workspace_source_admissions_source_revision CHECK (source_revision >= 1),
  CONSTRAINT workspace_source_admissions_draft_revision CHECK (draft_revision >= 1),
  CONSTRAINT workspace_source_admissions_digest_format CHECK (draft_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workspace_source_admissions_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workspace_source_admissions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT workspace_source_admissions_source_ref_object CHECK (jsonb_typeof(source_ref) = 'object'),
  CONSTRAINT workspace_source_admissions_document_set_ref_object CHECK (jsonb_typeof(document_set_ref) = 'object'),
  CONSTRAINT workspace_source_admissions_table_options_object CHECK (table_options IS NULL OR jsonb_typeof(table_options) = 'object')
);

CREATE INDEX IF NOT EXISTS workspace_source_admissions_scope_idx
  ON agent_platform.workspace_source_admissions (tenant_id, space_id, workspace_id, admitted_at, admission_id);

CREATE INDEX IF NOT EXISTS workspace_source_admissions_source_idx
  ON agent_platform.workspace_source_admissions (tenant_id, space_id, workspace_id, source_id, source_revision);

ALTER TABLE agent_platform.workspace_source_admissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.workspace_source_admissions;
CREATE POLICY scope_isolation ON agent_platform.workspace_source_admissions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
