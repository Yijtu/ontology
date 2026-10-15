-- 088_candidate_sources.sql
--
-- Proposed authoring sources with a provenance trust tier (design proposal
-- "AI-native sources": CandidateSource, P1).
--
-- Design:
--  * A `candidate_source` is a proposed source that is NOT yet part of an
--    approved workspace corpus. It carries where it came from (`origin`), an
--    immutable content reference plus its digest, an optional freshness window
--    and the provenance `trust_tier` the grounding gate reads. A human review
--    (`review_state` proposed -> approved | rejected) decides whether it may
--    ground a publishable candidate.
--  * `(tenant_id, space_id, source_id)` is the durable identity; `revision` is
--    the compare-and-swap counter behind `expectedRevision` on a review.
--  * `idempotency_key` is unique per scope so a replayed propose/review returns
--    the original row instead of writing a second one; `request_digest`
--    distinguishes a retry from IDEMPOTENCY_CONFLICT.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside
-- the session scope and the table carries a `scope_isolation` policy. Appended
-- after 003, so the schema default privileges grant the application role.
-- Forward-only: earlier migrations are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.candidate_sources (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  source_id       uuid        NOT NULL,
  revision        bigint      NOT NULL DEFAULT 1,
  kind            text        NOT NULL,
  trust_tier      text        NOT NULL,
  review_state    text        NOT NULL DEFAULT 'proposed',
  origin          jsonb       NOT NULL,
  content_ref     jsonb       NOT NULL,
  content_digest  text        NOT NULL,
  freshness       jsonb,
  proposed_by     text        NOT NULL,
  reviewed_by     text,
  idempotency_key text        NOT NULL,
  request_digest  text        NOT NULL,
  recorded_at     timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  CONSTRAINT candidate_sources_pkey PRIMARY KEY (tenant_id, space_id, source_id),
  CONSTRAINT candidate_sources_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT candidate_sources_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT candidate_sources_revision_positive CHECK (revision >= 1),
  CONSTRAINT candidate_sources_kind CHECK (kind IN ('upload', 'web_fetch', 'standard_ref')),
  CONSTRAINT candidate_sources_trust CHECK (trust_tier IN ('customer_authoritative', 'public_standard', 'agent_researched', 'synthetic')),
  CONSTRAINT candidate_sources_review CHECK (review_state IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT candidate_sources_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT candidate_sources_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT candidate_sources_origin_object CHECK (jsonb_typeof(origin) = 'object'),
  CONSTRAINT candidate_sources_content_ref_object CHECK (jsonb_typeof(content_ref) = 'object'),
  CONSTRAINT candidate_sources_freshness_object CHECK (freshness IS NULL OR jsonb_typeof(freshness) = 'object'),
  CONSTRAINT candidate_sources_proposed_by_nonempty CHECK (char_length(proposed_by) > 0),
  CONSTRAINT candidate_sources_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS candidate_sources_scope_idx
  ON agent_platform.candidate_sources (tenant_id, space_id, workspace_id, review_state, trust_tier, updated_at, source_id);

ALTER TABLE agent_platform.candidate_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.candidate_sources;
CREATE POLICY scope_isolation ON agent_platform.candidate_sources
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
