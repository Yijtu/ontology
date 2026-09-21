-- 013_evidence_records.sql
--
-- Durable evidence archive for tool executions (C4, C3.1, D7; US-006/020/021).
--
-- Design:
--  * One row per archived `EvidenceEnvelope`. The gateway writes it before it settles
--    the budget reservation, so a traceable success can never be returned when the
--    evidence was not persisted.
--  * The row is append-only: the primary key includes tenant_id/space_id and an
--    already-recorded evidence id is returned unchanged instead of overwritten.
--  * `envelope` is the exact canonical envelope; the extracted columns (kind, run_id,
--    data_mode, result_digest, envelope_digest, payload_ref, source_snapshots) exist
--    only so the evidence can be listed by run and audited without re-parsing it.
--  * `envelope_digest` equals `envelope.integrity.digest`, so the evidence reference
--    and the integrity proof cannot drift.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the
-- application role access without another explicit GRANT. Forward-only: 001..012 are
-- never edited.

CREATE TABLE IF NOT EXISTS agent_platform.evidence_records (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  evidence_id      uuid        NOT NULL,
  kind             text        NOT NULL,
  run_id           uuid,
  data_mode        text        NOT NULL,
  result_digest    text        NOT NULL,
  envelope_digest  text        NOT NULL,
  payload_ref      jsonb,
  source_snapshots jsonb       NOT NULL DEFAULT '[]'::jsonb,
  envelope         jsonb       NOT NULL,
  revision         bigint      NOT NULL DEFAULT 1,
  recorded_at      timestamptz NOT NULL,
  CONSTRAINT evidence_records_pkey PRIMARY KEY (tenant_id, space_id, evidence_id),
  CONSTRAINT evidence_records_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT evidence_records_kind CHECK (kind IN (
    'observation', 'document_span', 'computation', 'rule_derivation',
    'identity_decision', 'model_output', 'web_page'
  )),
  CONSTRAINT evidence_records_data_mode CHECK (data_mode IN (
    'synthetic', 'observed', 'forecast', 'simulation', 'live'
  )),
  CONSTRAINT evidence_records_result_digest_format CHECK (result_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT evidence_records_envelope_digest_format CHECK (envelope_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT evidence_records_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS evidence_records_run_idx
  ON agent_platform.evidence_records (tenant_id, space_id, run_id, recorded_at)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_records_kind_idx
  ON agent_platform.evidence_records (tenant_id, space_id, kind, recorded_at);

ALTER TABLE agent_platform.evidence_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.evidence_records;
CREATE POLICY scope_isolation ON agent_platform.evidence_records
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
