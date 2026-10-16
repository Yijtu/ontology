-- 105_research_candidate_commit_fence.sql
--
-- Candidate commit intent / execution fence association (design §7, node S08).
--
-- A controlled `submit_candidates` write is committed atomically: in the *same* PostgreSQL
-- transaction the platform re-checks the run cancel state, the durable dispatch owner/attempt
-- fence, the authorization admission and the frozen draft, and only then writes the candidate,
-- its candidate↔source links and the idempotent receipt. This migration adds the durable record of
-- that commit — the intent and the exact execution fence (dispatch / lease owner / attempt) and
-- frozen draft (workspace / revision / digest) it was accepted under.
--
-- The row is written by the same transaction that writes the receipt, so it can never describe a
-- candidate that was not committed, and a candidate can never be committed without it. Its unique
-- key `(tenant_id, space_id, run_id, idempotency_key)` is a second, independent guard behind the
-- receipt's own idempotency: a replay returns the stored receipt, and a reused key under a moved
-- fence cannot silently write a second candidate.
--
-- Forward-only: migrations 001..104 are never edited (this file only creates a new table). Every
-- key carries tenant_id/space_id, the run/workspace references are scoped foreign keys and the
-- table has a `scope_isolation` RLS policy.

CREATE TABLE IF NOT EXISTS agent_platform.research_candidate_commit_fences (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  run_id             uuid        NOT NULL,
  idempotency_key    text        NOT NULL,
  command_digest     text        NOT NULL,
  workspace_id       uuid        NOT NULL,
  draft_revision     bigint      NOT NULL,
  draft_digest       text        NOT NULL,
  ledger_id          uuid,
  reservation_id     uuid,
  dispatch_id        uuid,
  lease_owner_id     uuid,
  attempt            bigint,
  candidate_ids      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  recorded_at        timestamptz NOT NULL,
  CONSTRAINT research_candidate_commit_fences_pkey
    PRIMARY KEY (tenant_id, space_id, run_id, idempotency_key),
  CONSTRAINT research_candidate_commit_fences_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT research_candidate_commit_fences_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT research_candidate_commit_fences_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT research_candidate_commit_fences_command_digest_format
    CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_candidate_commit_fences_draft_digest_format
    CHECK (draft_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_candidate_commit_fences_revision_nonnegative CHECK (draft_revision >= 0),
  CONSTRAINT research_candidate_commit_fences_attempt_positive CHECK (attempt IS NULL OR attempt >= 1),
  -- The execution fence is all-or-nothing: either no lease (a host-only commit) or a complete one.
  CONSTRAINT research_candidate_commit_fences_fence_shape CHECK (
    (dispatch_id IS NULL AND lease_owner_id IS NULL AND attempt IS NULL)
    OR (dispatch_id IS NOT NULL AND lease_owner_id IS NOT NULL AND attempt IS NOT NULL)
  ),
  CONSTRAINT research_candidate_commit_fences_candidates_array CHECK (jsonb_typeof(candidate_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS research_candidate_commit_fences_dispatch_idx
  ON agent_platform.research_candidate_commit_fences (tenant_id, space_id, run_id, dispatch_id);

ALTER TABLE agent_platform.research_candidate_commit_fences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.research_candidate_commit_fences;
CREATE POLICY scope_isolation ON agent_platform.research_candidate_commit_fences
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
