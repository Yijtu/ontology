-- 022_extraction_candidates.sql
--
-- Entity/relation extraction candidates (SPEC D4, US-012/US-015, FR-14). A candidate is
-- append-only production from the `parsed`/`extracted` job stages: it records the published
-- definition version it was validated against, the exact source spans it came from, the
-- input version it was produced under and the model usage. It is never published truth and
-- never mutates a definition version or a fact.
--
-- Design:
--  * `(tenant_id, space_id, idempotency_key)` is unique, so re-running an extraction stage
--    after a crash or a stage-precise retry inserts nothing and duplicates no candidate.
--    The key is derived from job + chunk + kind + canonical value, so an identical output is
--    the same candidate and a different model output is a new candidate version.
--  * `state` and `issues` are the only mutable projection; the payload is immutable. A
--    validation stage moves a candidate to `pending_review` (valid) or `failed`
--    (type/reference/span problem) — never silently accepted.
--  * every key and FK carries tenant_id/space_id, and RLS denies rows outside the session
--    scope. Appended after 003, so default privileges already grant the application role.
--
-- Forward-only: 001..021 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.extraction_candidates (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  candidate_id    uuid        NOT NULL,
  job_id          uuid        NOT NULL,
  kind            text        NOT NULL,
  state           text        NOT NULL,
  deterministic   boolean     NOT NULL,
  idempotency_key text        NOT NULL,
  definition_ref  jsonb       NOT NULL,
  input_version   jsonb       NOT NULL,
  parse_id        uuid        NOT NULL,
  source_spans    jsonb       NOT NULL,
  payload         jsonb       NOT NULL,
  issues          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  usage           jsonb,
  recorded_at     timestamptz NOT NULL,
  transitioned_at timestamptz,
  CONSTRAINT extraction_candidates_pkey PRIMARY KEY (tenant_id, space_id, candidate_id),
  CONSTRAINT extraction_candidates_idempotency_unique
    UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT extraction_candidates_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id) ON DELETE CASCADE,
  CONSTRAINT extraction_candidates_parse_fkey FOREIGN KEY (tenant_id, space_id, parse_id)
    REFERENCES agent_platform.document_parse_runs (tenant_id, space_id, parse_id),
  CONSTRAINT extraction_candidates_kind CHECK (kind IN ('entity', 'relation')),
  CONSTRAINT extraction_candidates_state
    CHECK (state IN ('produced', 'pending_review', 'failed', 'rejected')),
  CONSTRAINT extraction_candidates_idempotency_format
    CHECK (idempotency_key ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS extraction_candidates_job_idx
  ON agent_platform.extraction_candidates (tenant_id, space_id, job_id, state);

ALTER TABLE agent_platform.extraction_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.extraction_candidates;
CREATE POLICY scope_isolation ON agent_platform.extraction_candidates
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
