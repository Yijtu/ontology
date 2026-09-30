-- Immutable route/plan receipts are scoped to one canonical run and its locked profile/runtime.
-- The executable PlanSpec remains in JSONB here; no query is regenerated from a client ref.
CREATE TABLE agent_platform.core_plan_receipts (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  run_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  profile_ref jsonb NOT NULL,
  resolved_profile_hash text NOT NULL,
  runtime_ref jsonb NOT NULL,
  input_manifest_digest text NOT NULL,
  request_digest text NOT NULL,
  receipt_digest text NOT NULL,
  receipt_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT core_plan_receipts_pkey PRIMARY KEY (tenant_id, space_id, receipt_id),
  CONSTRAINT core_plan_receipts_request_unique UNIQUE (tenant_id, space_id, run_id, request_digest),
  CONSTRAINT core_plan_receipts_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT core_plan_receipts_profile_hash CHECK (resolved_profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT core_plan_receipts_profile_ref CHECK (
    COALESCE(
      jsonb_typeof(profile_ref) = 'object'
      AND jsonb_typeof(profile_ref->'id') = 'string'
      AND length(profile_ref->>'id') > 0
      AND jsonb_typeof(profile_ref->'version') = 'string'
      AND length(profile_ref->>'version') > 0,
      false
    )
  ),
  CONSTRAINT core_plan_receipts_input_digest CHECK (input_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT core_plan_receipts_request_digest CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT core_plan_receipts_digest CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT core_plan_receipts_runtime_ref CHECK (
    COALESCE(
      jsonb_typeof(runtime_ref) = 'object'
      AND jsonb_typeof(runtime_ref->'id') = 'string'
      AND length(runtime_ref->>'id') > 0
      AND jsonb_typeof(runtime_ref->'version') = 'string'
      AND length(runtime_ref->>'version') > 0
      AND jsonb_typeof(runtime_ref->'digest') = 'string'
      AND runtime_ref->>'digest' ~ '^sha256:[0-9a-f]{64}$',
      false
    )
  ),
  CONSTRAINT core_plan_receipts_payload CHECK (
    COALESCE(
      jsonb_typeof(receipt_payload) = 'object'
      AND receipt_payload->>'schemaVersion' = 'core-template-plan-receipt@1'
      AND receipt_payload->>'kind' IN ('plan', 'clarification'),
      false
    )
  )
);

CREATE INDEX core_plan_receipts_run_profile_idx
  ON agent_platform.core_plan_receipts (tenant_id, space_id, run_id, resolved_profile_hash);

ALTER TABLE agent_platform.core_plan_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON agent_platform.core_plan_receipts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
