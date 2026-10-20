-- 108_research_acceptance_journal.sql
--
-- The research acceptance journal (design ��10, S10/S11 follow-up).
--
-- A research request is accepted by exactly one engine: the agentic V2 run for a new request, or the
-- retained facade for a replay of an already-accepted `@1` record. Before this migration that fact was
-- only *inferred* from whether an `@1` execution projection happened to exist, which means two
-- concurrent submissions racing across a restart could each believe they were the first to accept the
-- request, and a reader had no durable record of which engine owns a run.
--
-- This table is that record: one row per accepted research request, written once with the engine that
-- accepted it. `(tenant_id, space_id, research_id)` is the primary key, so the loser of a race inserts
-- nothing and reads back the winner's row instead of starting a second run. The journal is
-- append-only: a row is never rewritten, so the engine that owns a run cannot silently change after
-- the fact (which is exactly what a switch flip must not do to an in-flight run).
--
-- Forward-only: migrations 001..107 are never edited (this file only creates a new table). Every key
-- carries tenant_id/space_id and the table has a `scope_isolation` RLS policy.

CREATE TABLE IF NOT EXISTS agent_platform.research_acceptance_journal (
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  research_id    uuid        NOT NULL,
  run_id         uuid,
  engine         text        NOT NULL,
  request_digest text        NOT NULL,
  idempotency_key text       NOT NULL,
  accepted_at    timestamptz NOT NULL,
  CONSTRAINT research_acceptance_journal_pkey
    PRIMARY KEY (tenant_id, space_id, research_id),
  CONSTRAINT research_acceptance_journal_engine CHECK (engine IN ('agentic', 'legacy')),
  CONSTRAINT research_acceptance_journal_request_digest_format
    CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_acceptance_journal_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT research_acceptance_journal_run_shape
    CHECK ((engine = 'legacy') = (run_id IS NULL))
);

CREATE INDEX IF NOT EXISTS research_acceptance_journal_key_idx
ON agent_platform.research_acceptance_journal (tenant_id, space_id, idempotency_key);

ALTER TABLE agent_platform.research_acceptance_journal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.research_acceptance_journal;
CREATE POLICY scope_isolation ON agent_platform.research_acceptance_journal
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND space_id = current_setting('app.space_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    AND space_id = current_setting('app.space_id', true)::uuid
  );
