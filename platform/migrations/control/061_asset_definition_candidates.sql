-- 061_asset_definition_candidates.sql
--
-- Ontology **definition** (TBox) candidate batches and candidate versions (SPEC v0.3a
-- asset-data-ui §3.1/§3.3/§4.1/§4.3, issue V03-008 / #181).
--
-- Design:
--  * `asset_candidate_batches` is one immutable generation result. It records the exact input
--    draft revision, the model ref, the response schema ref, the source document set, the
--    generation policy and (on failure) the classified, retryable error, so a failed
--    generation is auditable and can be retried with a fresh Idempotency-Key.
--    `(tenant_id, space_id, idempotency_key)` is the claim: replaying the same key reads the
--    stored batch instead of invoking the model again; the same key with a different
--    `request_digest` is an IDEMPOTENCY_CONFLICT.
--  * `asset_candidate_versions` is append-only. `domain` is fixed to `definition` by a CHECK,
--    which keeps TBox candidates physically separate from the instance candidates in
--    `extraction_candidates` (they can never be mixed). `pending_confirmation` marks a
--    suggestion that cites no source locator (P.US-004.AC-03). The payload is never updated;
--    only the review `state`/`issues` transition.
--  * Candidates are written in the same transaction as their batch, so a committed batch always
--    has its complete candidate set and a crash never leaves a half-written batch.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session
-- scope and each table carries a `scope_isolation` policy. Appended after 003, so the schema
-- default privileges grant the application role. Forward-only: 001..060 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.asset_candidate_batches (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  batch_id              uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  domain                text        NOT NULL DEFAULT 'definition',
  input_draft_ref       jsonb       NOT NULL,
  model_ref             jsonb       NOT NULL,
  response_schema_ref   jsonb       NOT NULL,
  schema_digest         text,
  document_set_ref      jsonb       NOT NULL,
  generation_policy_ref jsonb       NOT NULL,
  state                 text        NOT NULL,
  counts                jsonb       NOT NULL,
  error                 jsonb,
  idempotency_key       text        NOT NULL,
  request_digest        text        NOT NULL,
  created_by            text        NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT asset_candidate_batches_pkey PRIMARY KEY (tenant_id, space_id, batch_id),
  CONSTRAINT asset_candidate_batches_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_candidate_batches_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_candidate_batches_domain CHECK (domain = 'definition'),
  CONSTRAINT asset_candidate_batches_state CHECK (state IN ('completed', 'pending_confirmation', 'failed')),
  CONSTRAINT asset_candidate_batches_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_candidate_batches_schema_digest_format CHECK (
    schema_digest IS NULL OR schema_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT asset_candidate_batches_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT asset_candidate_batches_counts_object CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT asset_candidate_batches_error_object CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT asset_candidate_batches_draft_object CHECK (jsonb_typeof(input_draft_ref) = 'object'),
  CONSTRAINT asset_candidate_batches_document_set_object CHECK (jsonb_typeof(document_set_ref) = 'object')
);

CREATE INDEX IF NOT EXISTS asset_candidate_batches_workspace_idx
  ON agent_platform.asset_candidate_batches (tenant_id, space_id, workspace_id, recorded_at DESC, batch_id);

CREATE TABLE IF NOT EXISTS agent_platform.asset_candidate_versions (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  candidate_id          uuid        NOT NULL,
  batch_id              uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  logical_id            text        NOT NULL,
  domain                text        NOT NULL DEFAULT 'definition',
  kind                  text        NOT NULL,
  payload               jsonb       NOT NULL,
  input_draft_ref       jsonb       NOT NULL,
  source_refs           jsonb       NOT NULL,
  source_spans          jsonb       NOT NULL,
  state                 text        NOT NULL,
  issues                jsonb       NOT NULL,
  pending_confirmation  boolean     NOT NULL,
  replaces_candidate_id uuid,
  generation_call_ref   jsonb,
  content_digest        text        NOT NULL,
  idempotency_key       text        NOT NULL,
  recorded_at           timestamptz NOT NULL,
  transitioned_at       timestamptz,
  CONSTRAINT asset_candidate_versions_pkey PRIMARY KEY (tenant_id, space_id, candidate_id),
  CONSTRAINT asset_candidate_versions_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_candidate_versions_batch_fkey FOREIGN KEY (tenant_id, space_id, batch_id)
    REFERENCES agent_platform.asset_candidate_batches (tenant_id, space_id, batch_id) ON DELETE CASCADE,
  CONSTRAINT asset_candidate_versions_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_candidate_versions_domain CHECK (domain = 'definition'),
  CONSTRAINT asset_candidate_versions_kind CHECK (kind IN ('object', 'attribute', 'relation')),
  CONSTRAINT asset_candidate_versions_state CHECK (
    state IN ('produced', 'pending_review', 'pending_confirmation', 'failed', 'rejected')
  ),
  CONSTRAINT asset_candidate_versions_logical_id_nonempty CHECK (char_length(logical_id) > 0),
  CONSTRAINT asset_candidate_versions_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_candidate_versions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT asset_candidate_versions_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT asset_candidate_versions_draft_object CHECK (jsonb_typeof(input_draft_ref) = 'object'),
  CONSTRAINT asset_candidate_versions_sources_array CHECK (jsonb_typeof(source_refs) = 'array'),
  CONSTRAINT asset_candidate_versions_spans_array CHECK (jsonb_typeof(source_spans) = 'array'),
  CONSTRAINT asset_candidate_versions_issues_array CHECK (jsonb_typeof(issues) = 'array')
);

CREATE INDEX IF NOT EXISTS asset_candidate_versions_workspace_kind_idx
  ON agent_platform.asset_candidate_versions (tenant_id, space_id, workspace_id, kind, state);

CREATE INDEX IF NOT EXISTS asset_candidate_versions_logical_idx
  ON agent_platform.asset_candidate_versions (tenant_id, space_id, logical_id, recorded_at);

ALTER TABLE agent_platform.asset_candidate_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.asset_candidate_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_candidate_batches;
CREATE POLICY scope_isolation ON agent_platform.asset_candidate_batches
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_candidate_versions;
CREATE POLICY scope_isolation ON agent_platform.asset_candidate_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
