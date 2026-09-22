-- 035_semantic_publications.sql
--
-- Semantic publication, candidate review and published fact/rule read view (SPEC D4.6/D5/D6,
-- C6, US-011/US-012/US-015, FR-13/FR-14).
--
-- Design:
--  * `semantic_publications` is the append-only publication record. The unique
--    `(tenant_id, space_id, idempotency_key)` makes a replay of the same Idempotency-Key
--    return the existing publication; `request_digest` distinguishes a different payload
--    (IDEMPOTENCY_CONFLICT) from a retry. `(tenant_id, space_id, revision)` is the monotonic
--    publication head behind If-Match.
--  * `semantic_publication_heads` is the scope publication counter. It is locked `FOR UPDATE`
--    while a publication is written, so two concurrent publications cannot both pass the same
--    `expectedRevision`; the loser is a VERSION_CONFLICT.
--  * `semantic_candidate_reviews` is append-only: every review is a distinct immutable row and
--    `(candidate_id, revision)` is unique. `candidate_review_heads` is the compare-and-swap
--    counter behind the review If-Match, so an approve/reject decision can be read back with
--    its reason and actor.
--  * `published_statements` / `published_rule_versions` are the official read view. They are
--    written only by the publication transaction; no query reads a candidate together with a
--    published fact, so an unapproved, failed or conflicted candidate is structurally
--    unreachable from computation.
--  * `statement_revisions` is append-only history. A correction/retraction appends a new
--    revision and advances the statement head; it never deletes the earlier version, and a
--    conclusion still supported by another active statement stays in the current view
--    (INV-06).
--  * a revision writes its downstream invalidation message to the real transactional
--    `job_outbox` in the same transaction.
--
-- Every key carries tenant_id/space_id and RLS denies rows outside the session scope.
-- Appended after 003, so default privileges grant the application role. Forward-only:
-- 001..034 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.semantic_publication_heads (
  tenant_id uuid   NOT NULL,
  space_id  uuid   NOT NULL,
  revision  bigint NOT NULL DEFAULT 0,
  CONSTRAINT semantic_publication_heads_pkey PRIMARY KEY (tenant_id, space_id),
  CONSTRAINT semantic_publication_heads_revision_non_negative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.semantic_publications (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  publication_id          uuid        NOT NULL,
  idempotency_key         text        NOT NULL,
  request_digest          text        NOT NULL,
  revision                bigint      NOT NULL,
  version                 text        NOT NULL,
  version_digest          text        NOT NULL,
  schema_ref              jsonb       NOT NULL,
  approved_candidate_refs jsonb       NOT NULL,
  statement_ids           jsonb       NOT NULL,
  rule_version_ids        jsonb       NOT NULL,
  payload                 jsonb       NOT NULL,
  outbox_id               uuid        NOT NULL,
  published_at            timestamptz NOT NULL,
  actor                   text        NOT NULL,
  CONSTRAINT semantic_publications_pkey PRIMARY KEY (tenant_id, space_id, publication_id),
  CONSTRAINT semantic_publications_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT semantic_publications_revision_unique UNIQUE (tenant_id, space_id, revision),
  CONSTRAINT semantic_publications_revision_positive CHECK (revision > 0),
  CONSTRAINT semantic_publications_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT semantic_publications_version_digest_format CHECK (version_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT semantic_publications_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS semantic_publications_published_idx
  ON agent_platform.semantic_publications (tenant_id, space_id, published_at, publication_id);

CREATE TABLE IF NOT EXISTS agent_platform.candidate_review_heads (
  tenant_id    uuid   NOT NULL,
  space_id     uuid   NOT NULL,
  candidate_id uuid   NOT NULL,
  revision     bigint NOT NULL DEFAULT 0,
  CONSTRAINT candidate_review_heads_pkey PRIMARY KEY (tenant_id, space_id, candidate_id),
  CONSTRAINT candidate_review_heads_revision_non_negative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.semantic_candidate_reviews (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  review_id           uuid        NOT NULL,
  candidate_id        uuid        NOT NULL,
  revision            bigint      NOT NULL,
  decision            text        NOT NULL,
  reason              text        NOT NULL,
  evidence_refs       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  recorded_at         timestamptz NOT NULL,
  actor               text        NOT NULL,
  supersedes_revision bigint,
  CONSTRAINT semantic_candidate_reviews_pkey PRIMARY KEY (tenant_id, space_id, review_id),
  CONSTRAINT semantic_candidate_reviews_revision_unique UNIQUE (tenant_id, space_id, candidate_id, revision),
  CONSTRAINT semantic_candidate_reviews_decision CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT semantic_candidate_reviews_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS semantic_candidate_reviews_candidate_idx
  ON agent_platform.semantic_candidate_reviews (tenant_id, space_id, candidate_id, revision);

CREATE TABLE IF NOT EXISTS agent_platform.published_statements (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  statement_id        uuid        NOT NULL,
  proposition_key     text        NOT NULL,
  kind                text        NOT NULL,
  object_id           text,
  relation_id         text,
  subject_entity_id   text,
  predicate           text        NOT NULL,
  value               jsonb       NOT NULL,
  unit_code           text,
  valid_from          timestamptz,
  valid_to            timestamptz,
  recorded_at         timestamptz NOT NULL,
  source_candidate_id uuid        NOT NULL,
  source_job_id       uuid        NOT NULL,
  source_refs         jsonb       NOT NULL,
  publication_id      uuid        NOT NULL,
  version             bigint      NOT NULL DEFAULT 1,
  status              text        NOT NULL DEFAULT 'active',
  supersedes_version  bigint,
  CONSTRAINT published_statements_pkey PRIMARY KEY (tenant_id, space_id, statement_id),
  CONSTRAINT published_statements_kind CHECK (kind IN ('entity', 'relation')),
  CONSTRAINT published_statements_status CHECK (status IN ('active', 'retracted')),
  CONSTRAINT published_statements_version_positive CHECK (version > 0),
  CONSTRAINT published_statements_valid_range CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS published_statements_proposition_idx
  ON agent_platform.published_statements (tenant_id, space_id, proposition_key, status);

CREATE INDEX IF NOT EXISTS published_statements_publication_idx
  ON agent_platform.published_statements (tenant_id, space_id, publication_id);

CREATE TABLE IF NOT EXISTS agent_platform.statement_revisions (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  revision_id             uuid        NOT NULL,
  statement_id            uuid        NOT NULL,
  version                 bigint      NOT NULL,
  kind                    text        NOT NULL,
  reason                  text        NOT NULL,
  corrected_value         jsonb,
  valid_from              timestamptz,
  valid_to                timestamptz,
  recorded_at             timestamptz NOT NULL,
  actor                   text        NOT NULL,
  supersedes_version      bigint,
  invalidation_outbox_id  uuid        NOT NULL,
  CONSTRAINT statement_revisions_pkey PRIMARY KEY (tenant_id, space_id, revision_id),
  CONSTRAINT statement_revisions_version_unique UNIQUE (tenant_id, space_id, statement_id, version),
  CONSTRAINT statement_revisions_kind CHECK (kind IN ('correction', 'retraction')),
  CONSTRAINT statement_revisions_version_positive CHECK (version > 0),
  CONSTRAINT statement_revisions_valid_range CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS statement_revisions_statement_idx
  ON agent_platform.statement_revisions (tenant_id, space_id, statement_id, version);

CREATE TABLE IF NOT EXISTS agent_platform.published_rule_versions (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  rule_version_id     uuid        NOT NULL,
  rule_id             text        NOT NULL,
  version             bigint      NOT NULL,
  object_id           text        NOT NULL,
  severity            text        NOT NULL,
  impact              text        NOT NULL,
  expression          jsonb       NOT NULL,
  exceptions          jsonb       NOT NULL,
  valid_from          timestamptz,
  valid_to            timestamptz,
  recorded_at         timestamptz NOT NULL,
  source_candidate_id uuid        NOT NULL,
  publication_id      uuid        NOT NULL,
  CONSTRAINT published_rule_versions_pkey PRIMARY KEY (tenant_id, space_id, rule_version_id),
  CONSTRAINT published_rule_versions_version_unique UNIQUE (tenant_id, space_id, rule_id, version),
  CONSTRAINT published_rule_versions_severity CHECK (severity IN ('hard', 'soft')),
  CONSTRAINT published_rule_versions_impact CHECK (impact IN ('high', 'low')),
  CONSTRAINT published_rule_versions_version_positive CHECK (version > 0),
  CONSTRAINT published_rule_versions_valid_range CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS published_rule_versions_publication_idx
  ON agent_platform.published_rule_versions (tenant_id, space_id, publication_id);

ALTER TABLE agent_platform.semantic_publication_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.semantic_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.candidate_review_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.semantic_candidate_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.published_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.statement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.published_rule_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_publication_heads;
CREATE POLICY scope_isolation ON agent_platform.semantic_publication_heads
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_publications;
CREATE POLICY scope_isolation ON agent_platform.semantic_publications
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.candidate_review_heads;
CREATE POLICY scope_isolation ON agent_platform.candidate_review_heads
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_candidate_reviews;
CREATE POLICY scope_isolation ON agent_platform.semantic_candidate_reviews
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.published_statements;
CREATE POLICY scope_isolation ON agent_platform.published_statements
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.statement_revisions;
CREATE POLICY scope_isolation ON agent_platform.statement_revisions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.published_rule_versions;
CREATE POLICY scope_isolation ON agent_platform.published_rule_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
