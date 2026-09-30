-- 073_task_validation_policies.sql
--
-- Registered task validation policy reports and the independent finalization
-- receipt (SPEC v0.3a execution-evidence §EX-6.1, issue V03-030 / #198).
--
-- Why these tables exist on top of the existing task/run tables (070) and the
-- evidence archive (013):
--
--  * `task_policy_reports` stores one immutable `task-policy-report@1` per exact
--    ref digest. A report is the runtime-validated output of a trusted registered
--    policy for one stage; a result report points at the exact output artifact and
--    typed result manifest it validated. It never carries a finalization-receipt
--    ref, so a report cannot reference the receipt that references it.
--  * `task_finalization_receipts` stores one immutable
--    `task-finalization-receipt@1`: the required policy bindings, their archived
--    report refs and the exact result manifest/digests. The receipt references the
--    reports and the result; the result manifest and reports never reference the
--    receipt, so the artifact graph stays acyclic.
--
-- A required policy that is missing, failed, unknown or incomplete never produces a
-- receipt row. Every table carries tenant_id/space_id, has RLS enabled and a
-- `scope_isolation` policy. Appended after 070 (071/072 reserved for parallel
-- nodes), so the schema default privileges grant the application role.
-- Forward-only: migrations 001..072 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.task_policy_reports (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  report_id       uuid        NOT NULL,
  version         text        NOT NULL,
  digest          text        NOT NULL,
  policy_id       text        NOT NULL,
  policy_version  text        NOT NULL,
  policy_digest   text        NOT NULL,
  stage           text        NOT NULL,
  status          text        NOT NULL,
  report          jsonb       NOT NULL,
  evidence_ref    jsonb,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT task_policy_reports_pkey PRIMARY KEY
    (tenant_id, space_id, report_id, version, digest),
  CONSTRAINT task_policy_reports_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT task_policy_reports_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT task_policy_reports_stage_domain CHECK (stage IN ('input', 'result')),
  CONSTRAINT task_policy_reports_status_domain CHECK (status IN ('pass', 'fail', 'unknown', 'incomplete')),
  CONSTRAINT task_policy_reports_report_object CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX IF NOT EXISTS task_policy_reports_policy_idx
  ON agent_platform.task_policy_reports (tenant_id, space_id, policy_id, policy_version, stage);

CREATE TABLE IF NOT EXISTS agent_platform.task_finalization_receipts (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  receipt_id            uuid        NOT NULL,
  version               text        NOT NULL,
  digest                text        NOT NULL,
  task_binding_id       text        NOT NULL,
  task_binding_version  text        NOT NULL,
  task_binding_digest   text        NOT NULL,
  manifest_digest       text        NOT NULL,
  receipt               jsonb       NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT task_finalization_receipts_pkey PRIMARY KEY
    (tenant_id, space_id, receipt_id, version, digest),
  CONSTRAINT task_finalization_receipts_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT task_finalization_receipts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT task_finalization_receipts_manifest_format CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT task_finalization_receipts_receipt_object CHECK (jsonb_typeof(receipt) = 'object')
);

CREATE INDEX IF NOT EXISTS task_finalization_receipts_binding_idx
  ON agent_platform.task_finalization_receipts (tenant_id, space_id, task_binding_id, task_binding_version);

ALTER TABLE agent_platform.task_policy_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.task_finalization_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.task_policy_reports;
CREATE POLICY scope_isolation ON agent_platform.task_policy_reports
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.task_finalization_receipts;
CREATE POLICY scope_isolation ON agent_platform.task_finalization_receipts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
