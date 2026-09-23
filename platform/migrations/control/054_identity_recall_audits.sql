-- 054_identity_recall_audits.sql
-- Append-only audit of bounded identity recall against an authorized structured source.

CREATE TABLE IF NOT EXISTS agent_platform.identity_recall_audits (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  definition_ref jsonb NOT NULL,
  query_digest text NOT NULL,
  result jsonb NOT NULL,
  actor text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT identity_recall_audits_pkey PRIMARY KEY (tenant_id, space_id, audit_id),
  CONSTRAINT identity_recall_audits_digest_format CHECK (query_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT identity_recall_audits_candidate_fkey FOREIGN KEY (tenant_id, space_id, candidate_id)
    REFERENCES agent_platform.extraction_candidates (tenant_id, space_id, candidate_id) ON DELETE CASCADE,
  CONSTRAINT identity_recall_audits_idempotent UNIQUE (tenant_id, space_id, candidate_id, query_digest)
);

CREATE INDEX IF NOT EXISTS identity_recall_audits_candidate_idx
  ON agent_platform.identity_recall_audits (tenant_id, space_id, candidate_id, recorded_at DESC);

ALTER TABLE agent_platform.identity_recall_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_recall_audits;
CREATE POLICY scope_isolation ON agent_platform.identity_recall_audits
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
