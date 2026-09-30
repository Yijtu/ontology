-- 063_definition_edit_adjudications.sql
--
-- Definition (TBox) editing, disambiguation and compatibility validation (SPEC v0.3a
-- asset-data-ui §3.1/§3.3/§4.1, issue V03-009 / #183; A.US-003, P.US-005, P.FR-6/FR-7).
--
-- Design:
--  * `asset_definition_adjudications` is the append-only human decision record for an edit,
--    reject, synonym merge, keep-separate or split. It is NOT a second approve decision: the
--    approve/reject truth stays in `candidate_review_heads`/`semantic_candidate_reviews`, and
--    an edit always appends a NEW `asset_candidate_versions` revision with a new candidate id,
--    so a review recorded against the previous candidate id can never carry over. This table
--    records *why* two terms were merged or kept apart and the revision diff (`findings`,
--    `compatibility`, `affected`) so the decision is auditable.
--    `(tenant_id, space_id, idempotency_key)` is the claim: replaying the same key returns the
--    stored adjudication instead of appending a second one.
--  * `asset_definition_unsupported_rules` preserves a rule the platform cannot execute
--    verbatim (`raw_form`) with `executable = false`. An unsupported rule is never silently
--    deleted or weakened into a looser executable rule (SPEC §5.2).
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session
-- scope and each table carries a `scope_isolation` policy. Appended after 003, so the schema
-- default privileges grant the application role. Forward-only: 001..062 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.asset_definition_adjudications (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  adjudication_id       uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  kind                  text        NOT NULL,
  candidate_ids         jsonb       NOT NULL,
  produced_candidate_ids jsonb      NOT NULL,
  reason                text        NOT NULL,
  affected              jsonb       NOT NULL,
  findings              jsonb       NOT NULL,
  compatibility         jsonb       NOT NULL,
  strategy              jsonb,
  request_digest        text        NOT NULL,
  idempotency_key       text        NOT NULL,
  actor                 text        NOT NULL,
  trace_id              text,
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT asset_definition_adjudications_pkey PRIMARY KEY (tenant_id, space_id, adjudication_id),
  CONSTRAINT asset_definition_adjudications_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_definition_adjudications_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_definition_adjudications_kind CHECK (
    kind IN ('edit', 'reject', 'merge', 'keep_separate', 'split')
  ),
  CONSTRAINT asset_definition_adjudications_reason_nonempty CHECK (char_length(reason) > 0),
  CONSTRAINT asset_definition_adjudications_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_definition_adjudications_idempotency_key_length CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 256
  ),
  CONSTRAINT asset_definition_adjudications_candidates_array CHECK (jsonb_typeof(candidate_ids) = 'array'),
  CONSTRAINT asset_definition_adjudications_produced_array CHECK (jsonb_typeof(produced_candidate_ids) = 'array'),
  CONSTRAINT asset_definition_adjudications_affected_array CHECK (jsonb_typeof(affected) = 'array'),
  CONSTRAINT asset_definition_adjudications_findings_array CHECK (jsonb_typeof(findings) = 'array'),
  CONSTRAINT asset_definition_adjudications_compatibility_object CHECK (jsonb_typeof(compatibility) = 'object'),
  CONSTRAINT asset_definition_adjudications_strategy_object CHECK (strategy IS NULL OR jsonb_typeof(strategy) = 'object')
);

CREATE INDEX IF NOT EXISTS asset_definition_adjudications_workspace_idx
  ON agent_platform.asset_definition_adjudications (tenant_id, space_id, workspace_id, recorded_at DESC, adjudication_id);

CREATE TABLE IF NOT EXISTS agent_platform.asset_definition_unsupported_rules (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  rule_id             text        NOT NULL,
  workspace_id        uuid        NOT NULL,
  source_candidate_id uuid,
  reason              text        NOT NULL,
  raw_form            jsonb       NOT NULL,
  executable          boolean     NOT NULL DEFAULT false,
  idempotency_key     text        NOT NULL,
  actor               text        NOT NULL,
  trace_id            text,
  recorded_at         timestamptz NOT NULL,
  CONSTRAINT asset_definition_unsupported_rules_pkey PRIMARY KEY (tenant_id, space_id, rule_id),
  CONSTRAINT asset_definition_unsupported_rules_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_definition_unsupported_rules_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_definition_unsupported_rules_executable_false CHECK (executable = false),
  CONSTRAINT asset_definition_unsupported_rules_rule_id_nonempty CHECK (char_length(rule_id) > 0),
  CONSTRAINT asset_definition_unsupported_rules_reason_nonempty CHECK (char_length(reason) > 0),
  CONSTRAINT asset_definition_unsupported_rules_idempotency_key_length CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 256
  )
);

CREATE INDEX IF NOT EXISTS asset_definition_unsupported_rules_workspace_idx
  ON agent_platform.asset_definition_unsupported_rules (tenant_id, space_id, workspace_id, recorded_at DESC, rule_id);

ALTER TABLE agent_platform.asset_definition_adjudications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.asset_definition_unsupported_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_definition_adjudications;
CREATE POLICY scope_isolation ON agent_platform.asset_definition_adjudications
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_definition_unsupported_rules;
CREATE POLICY scope_isolation ON agent_platform.asset_definition_unsupported_rules
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
