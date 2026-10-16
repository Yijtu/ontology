-- 098_research_run_goal_binding.sql
--
-- The research goal, authorization receipt and run link on durable storage (design §4/§8/§9/§10,
-- node R10b).
--
-- A research run is a run of the shared controller whose goal is `industry_workspace_research`
-- (not a published answer). Two storage additions make that goal and its authorization first-class
-- durable facts without rewriting any @1 record:
--
--  * `workflow_run_manifests.goal_kind` — a generated column projecting the run manifest's
--    `goal.kind`, so "which runs are research runs" is answerable from the manifest table alone
--    (the goal itself stays in the manifest jsonb, the one truth). Old manifests without a goal
--    project to NULL and stay valid.
--  * `workspace_research_runs` — a nullable `run_id` link to the controller run the projection
--    belongs to, plus the projection `schema_version`, the pinned `goal` and the
--    `authorization_receipt_ref`. Old @1 rows keep their values (schema_version defaults to @1,
--    run_id/goal/authorization are NULL), so a legacy run stays readable unchanged.
--
-- Forward-only: migrations 001..097 are never edited. Every key carries tenant_id/space_id; the
-- run link is a scoped foreign key and the goal/authorization are bounded jsonb objects.

ALTER TABLE agent_platform.workflow_run_manifests
  ADD COLUMN IF NOT EXISTS goal_kind text
  GENERATED ALWAYS AS (manifest -> 'goal' ->> 'kind') STORED;

CREATE INDEX IF NOT EXISTS workflow_run_manifests_goal_kind_idx
  ON agent_platform.workflow_run_manifests (tenant_id, space_id, goal_kind);

ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT 'research-execution@1';
ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS goal jsonb;
ALTER TABLE agent_platform.workspace_research_runs
  ADD COLUMN IF NOT EXISTS authorization_receipt_ref jsonb;

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_schema_version;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_schema_version
    CHECK (schema_version IN ('research-execution@1', 'research-execution@2'));

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_run_fkey;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_run_fkey
    FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE;

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_goal_object;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_goal_object
    CHECK (goal IS NULL OR jsonb_typeof(goal) = 'object');

ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_authorization_object;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_authorization_object
    CHECK (authorization_receipt_ref IS NULL OR jsonb_typeof(authorization_receipt_ref) = 'object');

-- A @2 row is an agent-run projection and must name the run it projects; a @1 row never links one.
ALTER TABLE agent_platform.workspace_research_runs
  DROP CONSTRAINT IF EXISTS workspace_research_runs_v2_requires_run;
ALTER TABLE agent_platform.workspace_research_runs
  ADD CONSTRAINT workspace_research_runs_v2_requires_run
    CHECK (schema_version = 'research-execution@1' OR run_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS workspace_research_runs_run_idx
  ON agent_platform.workspace_research_runs (tenant_id, space_id, run_id);
