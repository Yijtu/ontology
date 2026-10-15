-- 091_workspace_research_runs.sql
--
-- Bounded AI-research orchestration (design §2.3/§2.4, §3 N08, A-R02).
--
-- A research run is a durable, workspace-scoped execution that pins the brief/policy/budget it
-- ran under and references the job that owns its progress and cancellation. It is NOT an
-- approval: the run only proposes `agent_researched` candidate sources (the candidate_sources
-- table) and a human still reviews them. The record carries the honest coverage statistics
-- (including pages seen without a snapshot, excluded and failed counts and truncation) plus a
-- classified stop reason, so a reader never re-derives them from a page list.
--
-- `jobs_kind` is widened to admit the new `research` job kind. The run key is
-- `(tenant_id, space_id, research_id)`; the run references its logical job by
-- `(tenant_id, space_id, job_id)` so progress and cancellation reuse the durable job store.
-- Every key, unique constraint and foreign key carries tenant_id/space_id, RLS denies rows
-- outside the session scope and the table carries a `scope_isolation` policy. Forward-only:
-- earlier migrations are never edited.

ALTER TABLE agent_platform.jobs DROP CONSTRAINT IF EXISTS jobs_kind;
ALTER TABLE agent_platform.jobs ADD CONSTRAINT jobs_kind
  CHECK (kind IN ('ingestion', 'simulation', 'dataset_materialization', 'asset_publication', 'research'));

CREATE TABLE IF NOT EXISTS agent_platform.workspace_research_runs (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  workspace_id            uuid        NOT NULL,
  research_id             uuid        NOT NULL,
  job_id                  uuid        NOT NULL,
  status                  text        NOT NULL,
  stage                   text        NOT NULL,
  brief_ref               jsonb       NOT NULL,
  policy_ref              jsonb       NOT NULL,
  budget_ref              jsonb       NOT NULL,
  limits                  jsonb       NOT NULL,
  coverage                jsonb       NOT NULL,
  source_count            integer     NOT NULL DEFAULT 0,
  candidate_count         integer     NOT NULL DEFAULT 0,
  sources                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  stop_reason             text,
  request_idempotency_key text        NOT NULL,
  request_digest          text        NOT NULL,
  recorded_at             timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT workspace_research_runs_pkey PRIMARY KEY (tenant_id, space_id, research_id),
  CONSTRAINT workspace_research_runs_idempotency_unique UNIQUE (tenant_id, space_id, request_idempotency_key),
  CONSTRAINT workspace_research_runs_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_research_runs_job_fkey FOREIGN KEY (tenant_id, space_id, job_id)
    REFERENCES agent_platform.jobs (tenant_id, space_id, job_id),
  CONSTRAINT workspace_research_runs_status CHECK (status IN ('queued', 'running', 'awaiting_confirmation', 'completed', 'cancelled', 'failed')),
  CONSTRAINT workspace_research_runs_stage CHECK (stage IN ('planning', 'searching', 'archiving', 'awaiting_source_review', 'generating_candidates', 'completed')),
  CONSTRAINT workspace_research_runs_stop_reason CHECK (stop_reason IS NULL OR stop_reason IN ('completed', 'partial_results', 'cancelled', 'deadline_exceeded', 'budget_exhausted', 'no_results', 'provider_failed')),
  CONSTRAINT workspace_research_runs_counts_nonnegative CHECK (source_count >= 0 AND candidate_count >= 0),
  CONSTRAINT workspace_research_runs_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workspace_research_runs_idempotency_key_length CHECK (char_length(request_idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT workspace_research_runs_brief_object CHECK (jsonb_typeof(brief_ref) = 'object'),
  CONSTRAINT workspace_research_runs_policy_object CHECK (jsonb_typeof(policy_ref) = 'object'),
  CONSTRAINT workspace_research_runs_budget_object CHECK (jsonb_typeof(budget_ref) = 'object'),
  CONSTRAINT workspace_research_runs_limits_object CHECK (jsonb_typeof(limits) = 'object'),
  CONSTRAINT workspace_research_runs_coverage_object CHECK (jsonb_typeof(coverage) = 'object'),
  CONSTRAINT workspace_research_runs_sources_array CHECK (jsonb_typeof(sources) = 'array')
);

CREATE INDEX IF NOT EXISTS workspace_research_runs_scope_idx
  ON agent_platform.workspace_research_runs (tenant_id, space_id, workspace_id, recorded_at, research_id);

ALTER TABLE agent_platform.workspace_research_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.workspace_research_runs;
CREATE POLICY scope_isolation ON agent_platform.workspace_research_runs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
