-- 065_synthetic_validation.sql
--
-- Isolated synthetic instances and the industry validation service (SPEC v0.3a asset-data-ui
-- §3.4, §4.1; execution-evidence EX-05/EX-16; issue V03-014 / #186; A.US-005, A.US-008/010/015,
-- P.US-009/011, P.FR-5/7/16).
--
-- Design:
--  * `synthetic_example_sets` is the synthetic sandbox. Every row is fixed
--    source_kind='synthetic', data_mode='synthetic', isolation_label='synthetic test' by
--    CHECK constraints, so a sample can never masquerade as real project data even through a
--    direct write. It is a different asset from `PackAsset.exampleSet` (few-shot question/query
--    shapes); no column is shared. `body` holds the immutable version, `case_kinds` is indexed
--    for the coverage a workbench lists.
--  * `industry_validation_reports` is the only output of running a synthetic set against a
--    draft. It records the two surfaces separately (`semantic_published`,
--    `deployment_executable`) plus the overall `publishable` gate, and never writes a real
--    published fact or a business approval. `report` holds the full immutable report.
--  * `(tenant_id, space_id, idempotency_key)` is the claim on both tables: replaying the same
--    key returns the stored row instead of appending a second one.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session
-- scope and each table carries a `scope_isolation` policy. Forward-only: 001..064 are never
-- edited.

CREATE TABLE IF NOT EXISTS agent_platform.synthetic_example_sets (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  example_set_id       uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  source_kind          text        NOT NULL DEFAULT 'synthetic',
  data_mode            text        NOT NULL DEFAULT 'synthetic',
  isolation_label      text        NOT NULL DEFAULT 'synthetic test',
  case_kinds           jsonb       NOT NULL,
  body                 jsonb       NOT NULL,
  content_digest       text        NOT NULL,
  idempotency_key      text        NOT NULL,
  actor                text        NOT NULL,
  trace_id             text,
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT synthetic_example_sets_pkey PRIMARY KEY (tenant_id, space_id, example_set_id),
  CONSTRAINT synthetic_example_sets_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT synthetic_example_sets_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT synthetic_example_sets_source_kind CHECK (source_kind = 'synthetic'),
  CONSTRAINT synthetic_example_sets_data_mode CHECK (data_mode = 'synthetic'),
  CONSTRAINT synthetic_example_sets_isolation_label CHECK (isolation_label = 'synthetic test'),
  CONSTRAINT synthetic_example_sets_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT synthetic_example_sets_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT synthetic_example_sets_case_kinds_array CHECK (jsonb_typeof(case_kinds) = 'array'),
  CONSTRAINT synthetic_example_sets_body_object CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX IF NOT EXISTS synthetic_example_sets_workspace_idx
  ON agent_platform.synthetic_example_sets (tenant_id, space_id, workspace_id, recorded_at DESC);

ALTER TABLE agent_platform.synthetic_example_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.synthetic_example_sets;
CREATE POLICY scope_isolation ON agent_platform.synthetic_example_sets
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

CREATE TABLE IF NOT EXISTS agent_platform.industry_validation_reports (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  validation_id         uuid        NOT NULL,
  workspace_id          uuid        NOT NULL,
  example_set_id        uuid        NOT NULL,
  revision              text        NOT NULL,
  data_mode             text        NOT NULL DEFAULT 'synthetic',
  isolation_label       text        NOT NULL DEFAULT 'synthetic test',
  semantic_published    boolean     NOT NULL,
  deployment_executable boolean     NOT NULL,
  publishable           boolean     NOT NULL,
  report                jsonb       NOT NULL,
  content_digest        text        NOT NULL,
  idempotency_key       text        NOT NULL,
  actor                 text        NOT NULL,
  trace_id              text,
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT industry_validation_reports_pkey PRIMARY KEY (tenant_id, space_id, validation_id),
  CONSTRAINT industry_validation_reports_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT industry_validation_reports_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT industry_validation_reports_example_set_fkey FOREIGN KEY (tenant_id, space_id, example_set_id)
    REFERENCES agent_platform.synthetic_example_sets (tenant_id, space_id, example_set_id) ON DELETE CASCADE,
  CONSTRAINT industry_validation_reports_data_mode CHECK (data_mode = 'synthetic'),
  CONSTRAINT industry_validation_reports_isolation_label CHECK (isolation_label = 'synthetic test'),
  CONSTRAINT industry_validation_reports_revision_format CHECK (revision ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT industry_validation_reports_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT industry_validation_reports_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT industry_validation_reports_report_object CHECK (jsonb_typeof(report) = 'object'),
  CONSTRAINT industry_validation_reports_gate_consistency CHECK (
    publishable = (semantic_published AND deployment_executable)
  )
);

CREATE INDEX IF NOT EXISTS industry_validation_reports_workspace_idx
  ON agent_platform.industry_validation_reports (tenant_id, space_id, workspace_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS industry_validation_reports_example_set_idx
  ON agent_platform.industry_validation_reports (tenant_id, space_id, example_set_id);

ALTER TABLE agent_platform.industry_validation_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.industry_validation_reports;
CREATE POLICY scope_isolation ON agent_platform.industry_validation_reports
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
