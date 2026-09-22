-- 025_rule_candidates.sql
--
-- Rule candidate extraction (SPEC D4.3/D5, US-013/US-015, FR-14/FR-15). LOCAL-028 extends the
-- LOCAL-027 extraction-candidate table with two new candidate families:
--
--  * `rule`            — a representable bounded rule AST whose every element is span-linked;
--                        exceptions stay attached, the applicability scope is `objectId`, and
--                        `review_requirement` records whether a human review is required.
--  * `rule_unhandled`  — an expression the extractor could not represent faithfully (a cycle,
--                        an unsupported operator/quantifier or an unrepresentable exception).
--                        It carries the reason and the raw expression; it is never loosened
--                        into a rule that could be published.
--
-- The payload of a `rule` lives in the existing `payload` jsonb column, so no new column is
-- needed. This migration only widens the `kind` check constraint. It is forward-only: the
-- earlier migrations 001..024 are never edited.
--
-- Both new kinds share the same append-only, tenant/space-scoped, idempotency-keyed row as
-- entity/relation candidates, so a stage-precise retry inserts nothing new and a candidate is
-- never auto-published.

ALTER TABLE agent_platform.extraction_candidates
  DROP CONSTRAINT IF EXISTS extraction_candidates_kind;

ALTER TABLE agent_platform.extraction_candidates
  ADD CONSTRAINT extraction_candidates_kind
    CHECK (kind IN ('entity', 'relation', 'rule', 'rule_unhandled'));
