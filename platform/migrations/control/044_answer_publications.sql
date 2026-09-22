-- 044_answer_publications.sql
--
-- Final verified answer versions (SPEC D7.4, C6, INV-09; US-021/US-022).
--
-- Design:
--  * One immutable row per run: the final answer version is published at most once, and its
--    `answer_id` binds `draft_hash`, `evidence_manifest_hash`, `verification_id` and the
--    scenario version manifest hash, so a mismatched binding is detectable rather than trusted.
--  * `publication_kind` is `verified` for a current result and `history_limited` for the same
--    verified content published with an explicit `as_of` because the world moved on after
--    verification. The check constraint keeps an as-of point and the history-limited kind in
--    lockstep, so an older result can never be presented as current.
--  * `limitations` carries the explicit gaps/limitations the verified content declares; it is
--    never dropped by rendering.
--  * The row is written in the same transaction that re-reads the run state/revision, so a run
--    cancelled between verification and publication cannot leave an answer behind.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the session
-- scope. Appended after 003, so the schema default privileges grant the application role access.
-- Forward-only: 001..038 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.answer_publications (
  tenant_id              uuid        NOT NULL,
  space_id               uuid        NOT NULL,
  run_id                 uuid        NOT NULL,
  answer_id              uuid        NOT NULL,
  draft_id               uuid        NOT NULL,
  verification_id        uuid        NOT NULL,
  content_hash           text        NOT NULL,
  evidence_manifest_hash text        NOT NULL,
  scenario_manifest_hash text        NOT NULL,
  publication_kind       text        NOT NULL,
  as_of                  timestamptz,
  limitations            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  published_at           timestamptz NOT NULL,
  CONSTRAINT answer_publications_pkey PRIMARY KEY (tenant_id, space_id, run_id),
  CONSTRAINT answer_publications_answer_id_unique UNIQUE (tenant_id, space_id, answer_id),
  CONSTRAINT answer_publications_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT answer_publications_kind CHECK (publication_kind IN ('verified', 'history_limited')),
  CONSTRAINT answer_publications_content_hash_format CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT answer_publications_evidence_hash_format CHECK (evidence_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT answer_publications_scenario_hash_format CHECK (scenario_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT answer_publications_history_limit CHECK (
    (publication_kind = 'history_limited' AND as_of IS NOT NULL) OR
    (publication_kind = 'verified' AND as_of IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS answer_publications_published_idx
  ON agent_platform.answer_publications (tenant_id, space_id, published_at DESC);

ALTER TABLE agent_platform.answer_publications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.answer_publications;
CREATE POLICY scope_isolation ON agent_platform.answer_publications
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
