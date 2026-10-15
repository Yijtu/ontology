-- 064_asset_rule_action_candidates.sql
--
-- Rule and action candidates with finite-grammar support validation and capability binding
-- (SPEC v0.3a asset-data-ui §3.1/§3.3, execution-evidence §4.1/§4.2/EX-6, issue V03-010 / #184;
-- A.US-003/005/010, P.US-006/007, P.FR-8/9/10).
--
-- Design:
--  * `asset_rule_action_candidates` is append-only. Every content-changing edit appends a NEW
--    candidate revision with a new candidate_id, so a review recorded against a previous id can
--    never carry over. The original condition/exceptions live verbatim inside `payload`, and a
--    form outside the frozen executable subset is stored `not_yet_executable` rather than being
--    deleted or weakened.
--  * `lifecycle` is separate from the content: a candidate may always be saved (`draft`), but
--    only a fully passing semantic + execution-capability validation may reach `enabled`.
--    `enabled_at` records the transition. `kind` separates rule candidates (payload.support)
--    from action candidates (payload.declaration + payload.binding).
--  * `(tenant_id, space_id, idempotency_key)` is the claim: replaying the same key returns the
--    stored candidate instead of appending a second revision.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session
-- scope and the table carries a `scope_isolation` policy. Forward-only: 001..063 are never
-- edited.

CREATE TABLE IF NOT EXISTS agent_platform.asset_rule_action_candidates (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  candidate_id         uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  logical_id           text        NOT NULL,
  domain               text        NOT NULL DEFAULT 'definition',
  kind                 text        NOT NULL,
  display_name         text        NOT NULL,
  business_meaning     text        NOT NULL,
  suggested_reason     text        NOT NULL,
  payload              jsonb       NOT NULL,
  source_refs          jsonb       NOT NULL,
  source_spans         jsonb       NOT NULL,
  lifecycle            text        NOT NULL DEFAULT 'draft',
  enabled_at           timestamptz,
  replaces_candidate_id uuid,
  generation_call_ref  jsonb,
  content_digest       text        NOT NULL,
  idempotency_key      text        NOT NULL,
  actor                text        NOT NULL,
  trace_id             text,
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT asset_rule_action_candidates_pkey PRIMARY KEY (tenant_id, space_id, candidate_id),
  CONSTRAINT asset_rule_action_candidates_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_rule_action_candidates_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_rule_action_candidates_domain CHECK (domain = 'definition'),
  CONSTRAINT asset_rule_action_candidates_kind CHECK (kind IN ('rule', 'action')),
  CONSTRAINT asset_rule_action_candidates_lifecycle CHECK (lifecycle IN ('draft', 'enabled', 'rejected')),
  CONSTRAINT asset_rule_action_candidates_logical_id_nonempty CHECK (char_length(logical_id) > 0),
  CONSTRAINT asset_rule_action_candidates_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_rule_action_candidates_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT asset_rule_action_candidates_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT asset_rule_action_candidates_sources_array CHECK (jsonb_typeof(source_refs) = 'array'),
  CONSTRAINT asset_rule_action_candidates_spans_array CHECK (jsonb_typeof(source_spans) = 'array'),
  CONSTRAINT asset_rule_action_candidates_generation_object CHECK (
    generation_call_ref IS NULL OR jsonb_typeof(generation_call_ref) = 'object'
  ),
  CONSTRAINT asset_rule_action_candidates_enabled_at_consistency CHECK (
    (lifecycle = 'enabled' AND enabled_at IS NOT NULL) OR (lifecycle <> 'enabled')
  )
);

CREATE INDEX IF NOT EXISTS asset_rule_action_candidates_workspace_idx
  ON agent_platform.asset_rule_action_candidates (tenant_id, space_id, workspace_id, kind, lifecycle);

CREATE INDEX IF NOT EXISTS asset_rule_action_candidates_logical_idx
  ON agent_platform.asset_rule_action_candidates (tenant_id, space_id, logical_id, recorded_at);

ALTER TABLE agent_platform.asset_rule_action_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_rule_action_candidates;
CREATE POLICY scope_isolation ON agent_platform.asset_rule_action_candidates
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
