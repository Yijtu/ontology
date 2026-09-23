-- 051_run_question_rewrite.sql
--
-- Persist the bounded question-rewrite trace on the durable run record (LOCAL-080,
-- SPEC D7.1/ADR-14).
--
-- The controller records the exact original question, the rewritten question and the inputs
-- the rewrite read, once, during preflight and before any collection starts. The column is
-- written once and never overwritten, so the original -> rewrite -> generated-SQL chain is
-- replayable per run. It is nullable: absence means no rewrite step ran (or the rewrite
-- clarified/failed before producing a trace), never that a successful rewrite was dropped.
-- It carries no draft text and never enters the public event stream.
--
-- Forward-only: earlier migrations are never edited. This is metadata on the existing
-- `runs` table, so it does not touch the monotonic `revision` behind optimistic concurrency
-- and it inherits the existing `runs` scope_isolation RLS policy.

ALTER TABLE agent_platform.runs
  ADD COLUMN IF NOT EXISTS question_rewrite jsonb;
