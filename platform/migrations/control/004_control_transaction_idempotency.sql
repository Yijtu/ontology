-- 004_control_transaction_idempotency.sql
--
-- One row per idempotent control transaction, so a retried request with the same
-- Idempotency-Key applies its operations exactly once (SPEC C6). The row is
-- written inside the same transaction as the operations, so a failed transaction
-- also releases the key for a legitimate retry.
--
-- Created after 003, so the schema default privileges grant the application role
-- access without another explicit GRANT.

CREATE TABLE IF NOT EXISTS agent_platform.control_transactions (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  idempotency_key text        NOT NULL,
  request_digest  text        NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_transactions_pkey PRIMARY KEY (tenant_id, space_id, idempotency_key),
  CONSTRAINT control_transactions_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE
);

ALTER TABLE agent_platform.control_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.control_transactions;
CREATE POLICY scope_isolation ON agent_platform.control_transactions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
