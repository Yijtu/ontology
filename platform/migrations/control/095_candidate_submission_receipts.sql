-- 095_candidate_submission_receipts.sql
--
-- Controlled candidate submission: the idempotent command receipt and the candidate↔source links
-- (design §5/§7, node R05).
--
-- A `submit_candidates` command is a workspace write command routed through the authoring-command
-- gateway. Two things must be durable together so a crash between "candidate written" and
-- "checkpoint saved" is recoverable:
--
--  * `candidate_submission_receipts` — the host idempotency key (derived from run + logical action +
--    command content digest) and the recorded receipt. Replaying the key returns the stored receipt
--    instead of writing a second candidate. `(tenant, space, run_id, idempotency_key)` is unique.
--  * `candidate_source_links` — one row per (candidate, evidence item), each carrying the source
--    reference, the located span (when any), the server-assigned trust tier and the parser version.
--    A candidate may cite several sources and a source may back several candidates, so a later
--    source review can re-ground exactly the candidates that cited it. `pending_confirmation` marks
--    a link whose source is not yet confirmed; a review must not erase it in place (re-grounding
--    appends a new candidate version instead).
--
-- Every key carries tenant_id/space_id and the workspace binding; RLS denies rows outside the
-- session scope and each table carries a `scope_isolation` policy. Forward-only: migrations
-- 001..094 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.candidate_submission_receipts (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  run_id          uuid        NOT NULL,
  idempotency_key text        NOT NULL,
  command_digest  text        NOT NULL,
  receipt         jsonb       NOT NULL,
  created_by      text        NOT NULL,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT candidate_submission_receipts_pkey PRIMARY KEY (tenant_id, space_id, run_id, idempotency_key),
  CONSTRAINT candidate_submission_receipts_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT candidate_submission_receipts_command_digest_format CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT candidate_submission_receipts_receipt_object CHECK (jsonb_typeof(receipt) = 'object'),
  CONSTRAINT candidate_submission_receipts_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT candidate_submission_receipts_created_by_nonempty CHECK (char_length(created_by) > 0)
);

CREATE INDEX IF NOT EXISTS candidate_submission_receipts_workspace_idx
  ON agent_platform.candidate_submission_receipts (tenant_id, space_id, workspace_id, recorded_at, run_id);

CREATE TABLE IF NOT EXISTS agent_platform.candidate_source_links (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  workspace_id        uuid        NOT NULL,
  candidate_id        uuid        NOT NULL,
  candidate_kind      text        NOT NULL,
  submission_index    integer     NOT NULL,
  evidence_index      integer     NOT NULL,
  source_ref          jsonb       NOT NULL,
  source_span         jsonb,
  trust_tier          text        NOT NULL,
  parser_version      text        NOT NULL,
  pending_confirmation boolean    NOT NULL DEFAULT true,
  recorded_at         timestamptz NOT NULL,
  CONSTRAINT candidate_source_links_pkey PRIMARY KEY (tenant_id, space_id, candidate_id, evidence_index),
  CONSTRAINT candidate_source_links_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT candidate_source_links_kind CHECK (candidate_kind IN ('source', 'definition', 'rule', 'action')),
  CONSTRAINT candidate_source_links_trust CHECK (trust_tier IN ('customer_authoritative', 'public_standard', 'agent_researched', 'synthetic')),
  CONSTRAINT candidate_source_links_indices_nonnegative CHECK (submission_index >= 0 AND evidence_index >= 0),
  CONSTRAINT candidate_source_links_source_ref_object CHECK (jsonb_typeof(source_ref) = 'object'),
  CONSTRAINT candidate_source_links_source_span_object CHECK (source_span IS NULL OR jsonb_typeof(source_span) = 'object'),
  CONSTRAINT candidate_source_links_parser_version_nonempty CHECK (char_length(parser_version) > 0)
);

CREATE INDEX IF NOT EXISTS candidate_source_links_candidate_idx
  ON agent_platform.candidate_source_links (tenant_id, space_id, workspace_id, candidate_id);
CREATE INDEX IF NOT EXISTS candidate_source_links_pending_idx
  ON agent_platform.candidate_source_links (tenant_id, space_id, workspace_id, pending_confirmation);

ALTER TABLE agent_platform.candidate_submission_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.candidate_submission_receipts;
CREATE POLICY scope_isolation ON agent_platform.candidate_submission_receipts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

ALTER TABLE agent_platform.candidate_source_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.candidate_source_links;
CREATE POLICY scope_isolation ON agent_platform.candidate_source_links
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
