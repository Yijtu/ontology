-- 099_research_execution_projection.sql
--
-- The agentic research execution projection on durable storage (design §8/§10, node R10/R-S01).
--
-- `workspace_research_runs` already holds both projection versions since 098 (a `schema_version`
-- plus a nullable `run_id`/`goal`/`authorization_receipt_ref`). This migration adds the versioned
-- payload, its compare-and-swap counter and the scoped run association that keep a `@2` run
-- projection a first-class, queryable fact **without rewriting a legacy `@1` record**:
--
--  * `projection` — the `@2`-only projection groups (budget dimensions, coverage gaps, human todos,
--    evidence, candidate receipts, usage). The common fields stay in their columns, so the payload
--    is never a second copy of one truth; a legacy `@1` row keeps it NULL.
--  * `projection_revision` — a monotonic counter the store bumps on each `@2` projection update,
--    so a stale projection write can be compared and swapped instead of silently overwriting a
--    newer one. Legacy `@1` rows stay at 0.
--  * `workspace_research_runs_scope_run_unique` — a controller run projects at most one research
--    execution inside its tenant/space; the scoped unique index makes that an enforced fact, not a
--    convention.
--
-- Shape guards keep the two versions honest: a `@1` row must carry no projection/run/goal (it is
-- never rewritten into `@2`), and a `@2` row must carry its run link, goal and payload. The
-- continuation link (`continued_from`, added in 097) stays scoped by its foreign key for both
-- versions, so a `@2` continuation is validated exactly like a `@1` one.
--
-- Forward-only: migrations 001..098 are never edited. Every key carries tenant_id/space_id.

ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS projection jsonb;

ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS projection_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_projection_object;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_projection_object
    CHECK (projection IS NULL OR jsonb_typeof(projection) = 'object');

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_projection_revision_nonnegative;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_projection_revision_nonnegative
    CHECK (projection_revision >= 0);

-- A legacy @1 record is never rewritten into a projection: it carries no payload, run link or goal.
ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_legacy_shape;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_legacy_shape
    CHECK (schema_version <> 'research-execution@1'
      OR (projection IS NULL AND run_id IS NULL AND goal IS NULL AND authorization_receipt_ref IS NULL));

-- A @2 projection must carry the run it projects, its goal and its versioned payload.
ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_v2_shape;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_v2_shape
    CHECK (schema_version <> 'research-execution@2'
      OR (run_id IS NOT NULL AND goal IS NOT NULL AND projection IS NOT NULL));

-- One controller run projects at most one research execution inside its tenant/space.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_research_runs_scope_run_unique
  ON agent_platform.workspace_research_runs (tenant_id, space_id, run_id)
  WHERE run_id IS NOT NULL;
