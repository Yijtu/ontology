-- 106_research_dispatch_delivery.sql
--
-- The explicit scheduling-handoff terminal for a research job (design §8, node S09).
--
-- S09 turns the research job into a pure scheduler: an accepted workspace-research run is handed to
-- the durable dispatch queue by the research job handler, and the job is then finished. That handoff
-- needs its own terminal stage, distinct from the ingestion stages:
--
--   * `dispatched` is a **stop** stage. It records "the scheduling handoff completed" — it is never
--     the ingestion `parsed`/`extracted` progress of a document job and never means the research run
--     itself is complete. The run is tracked by its own run record, dispatch and `@2` projection; the
--     job never doubles as research progress.
--   * The stage vocabulary of `jobs`, `job_attempts` and `job_stage_checkpoints` is widened to admit
--     it. The runnable stages are unchanged (`received/parsed/extracted/validated`); a `dispatched`
--     job is not re-claimable, so a scheduling handoff can never loop.
--
-- Forward-only: migrations 001..105 are never edited (this file only tightens the stage CHECKs they
-- created). No new table is introduced; the handoff reuses the existing durable job store.

ALTER TABLE agent_platform.jobs DROP CONSTRAINT IF EXISTS jobs_stage;
ALTER TABLE agent_platform.jobs ADD CONSTRAINT jobs_stage CHECK (stage IN (
  'received', 'parsed', 'extracted', 'validated', 'awaiting_review',
  'published', 'dispatched', 'failed', 'cancelled', 'rejected'
));

-- `dispatched` is only ever the terminal stage of the agentic research scheduler job: no ingestion
-- or simulation job may claim it, so the handoff can never be mistaken for document progress.
ALTER TABLE agent_platform.jobs DROP CONSTRAINT IF EXISTS jobs_dispatched_kind;
ALTER TABLE agent_platform.jobs ADD CONSTRAINT jobs_dispatched_kind CHECK (
  stage <> 'dispatched' OR (kind = 'research' AND pipeline_version = '2.0.0')
);

ALTER TABLE agent_platform.job_attempts DROP CONSTRAINT IF EXISTS job_attempts_stage;
ALTER TABLE agent_platform.job_attempts ADD CONSTRAINT job_attempts_stage CHECK (stage IN (
  'received', 'parsed', 'extracted', 'validated', 'awaiting_review',
  'published', 'dispatched', 'failed', 'cancelled', 'rejected'
));

ALTER TABLE agent_platform.job_stage_checkpoints DROP CONSTRAINT IF EXISTS job_stage_checkpoints_stage;
ALTER TABLE agent_platform.job_stage_checkpoints ADD CONSTRAINT job_stage_checkpoints_stage CHECK (stage IN (
  'received', 'parsed', 'extracted', 'validated', 'awaiting_review',
  'published', 'dispatched'
));

-- A `@2` run projection is keyed by its controller run, not by a legacy research job, so the job
-- association becomes optional for `@2` while a legacy `@1` record still requires it. The scoped
-- foreign key already tolerates a NULL `job_id`.
ALTER TABLE agent_platform.workspace_research_runs ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE agent_platform.workspace_research_runs DROP CONSTRAINT IF EXISTS workspace_research_runs_legacy_requires_job;
ALTER TABLE agent_platform.workspace_research_runs ADD CONSTRAINT workspace_research_runs_legacy_requires_job
  CHECK (schema_version <> 'research-execution@1' OR job_id IS NOT NULL);
