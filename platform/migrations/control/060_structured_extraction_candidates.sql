-- 060_structured_extraction_candidates.sql
--
-- A structured ingestion job (V03-006) persists its parse in `document_structured_parses`,
-- not in the text/PDF `document_parse_runs` table, so a candidate produced by the structured
-- `parsed → extracted` stage (V03-007) carries a structured parse id. The original
-- single-column `extraction_candidates_parse_fkey` could only reference one family and would
-- reject every structured candidate.
--
-- The FK is therefore removed and the parse binding stays explicit through the candidate's
-- immutable `input_version.parseId` and its located source span; tenant/space scope is still
-- enforced by the RLS policy and every store predicate. The job FK and idempotency uniqueness
-- are unchanged, so a candidate still cannot reference a job outside its scope or duplicate.
--
-- Forward-only: 001..059 are never edited.

ALTER TABLE agent_platform.extraction_candidates
  DROP CONSTRAINT IF EXISTS extraction_candidates_parse_fkey;

CREATE INDEX IF NOT EXISTS extraction_candidates_parse_idx
  ON agent_platform.extraction_candidates (tenant_id, space_id, parse_id);
