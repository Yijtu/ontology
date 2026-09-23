-- 049_feedback_entries.sql
--
-- Append-only user/execution feedback (US-022, FR-30; SPEC D2/D7.4, INV-09).
--
-- Design:
--  * Feedback is data only. It records what a user or an operator said about a run/answer
--    (usefulness, SQL correctness, gap, conflict); it never changes a run's state, publishes
--    an answer, widens a permission or consumes a budget. INV-09 still holds: only the
--    controller can sign a final answer version, and feedback has no path to it.
--  * The table is append-only by construction: a BEFORE UPDATE OR DELETE trigger raises, so
--    history can be read back but never rewritten, not even by a later migration-time actor.
--  * `(tenant_id, space_id, idempotency_key)` is the unique claim; `request_digest` lets the
--    store return the stored entry for a replayed payload and reject a different one.
--  * `sequence` is the durable ledger sequence allocated by `ControlRepository.appendEvent`
--    (stream `feedback:<runId>`), so a feedback append is ordered and idempotent alongside the
--    run event ledger.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the application
-- role access. Forward-only: 001..044 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.feedback_entries (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  feedback_id     uuid        NOT NULL,
  run_id          uuid        NOT NULL,
  answer_id       uuid,
  kind            text        NOT NULL,
  rating          smallint,
  comment         text,
  submitted_by    text        NOT NULL,
  sequence        bigint      NOT NULL,
  idempotency_key text        NOT NULL,
  request_digest  text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_entries_pkey PRIMARY KEY (tenant_id, space_id, feedback_id),
  CONSTRAINT feedback_entries_idempotency_key_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT feedback_entries_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT feedback_entries_kind CHECK (kind IN (
    'answer_usefulness', 'sql_correctness', 'gap', 'conflict'
  )),
  CONSTRAINT feedback_entries_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT feedback_entries_comment_length CHECK (comment IS NULL OR char_length(comment) <= 4000),
  CONSTRAINT feedback_entries_sequence_positive CHECK (sequence > 0),
  CONSTRAINT feedback_entries_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT feedback_entries_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS feedback_entries_run_idx
  ON agent_platform.feedback_entries (tenant_id, space_id, run_id, sequence);

CREATE INDEX IF NOT EXISTS feedback_entries_answer_idx
  ON agent_platform.feedback_entries (tenant_id, space_id, run_id, answer_id, sequence)
  WHERE answer_id IS NOT NULL;

-- Append-only enforcement: a rewrite of history is a hard error, not a silent update.
CREATE OR REPLACE FUNCTION agent_platform.feedback_entries_reject_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'feedback_entries is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS feedback_entries_no_mutation ON agent_platform.feedback_entries;
CREATE TRIGGER feedback_entries_no_mutation
  BEFORE UPDATE OR DELETE ON agent_platform.feedback_entries
  FOR EACH ROW EXECUTE FUNCTION agent_platform.feedback_entries_reject_mutation();

ALTER TABLE agent_platform.feedback_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.feedback_entries;
CREATE POLICY scope_isolation ON agent_platform.feedback_entries
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
