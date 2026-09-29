-- 054_workflow_dispatch.sql
--
-- Durable delivery for one logical controller drive (C3). The run remains the source of
-- execution input; this row stores only its run id and an integrity digest. A logical run may
-- have multiple drives after clarification/resume, distinguished by logical_action_id.

CREATE TABLE IF NOT EXISTS agent_platform.workflow_dispatches (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  dispatch_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  run_id             uuid        NOT NULL,
  action_kind        text        NOT NULL,
  logical_action_id  text        NOT NULL,
  payload            jsonb       NOT NULL,
  payload_digest     text        NOT NULL,
  state              text        NOT NULL DEFAULT 'pending',
  attempt            bigint      NOT NULL DEFAULT 0,
  revision           bigint      NOT NULL DEFAULT 1,
  available_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner_id     uuid,
  lease_expires_at   timestamptz,
  failure_code       text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_dispatches_pkey PRIMARY KEY (tenant_id, space_id, dispatch_id),
  CONSTRAINT workflow_dispatches_logical_action_unique
    UNIQUE (tenant_id, space_id, run_id, action_kind, logical_action_id),
  CONSTRAINT workflow_dispatches_run_fkey
    FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT workflow_dispatches_action_kind CHECK (action_kind = 'drive_run'),
  CONSTRAINT workflow_dispatches_action_id_length CHECK (char_length(logical_action_id) BETWEEN 1 AND 256),
  CONSTRAINT workflow_dispatches_payload CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload = jsonb_build_object('runId', run_id::text)
  ),
  CONSTRAINT workflow_dispatches_payload_digest_format CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workflow_dispatches_state CHECK (state IN ('pending', 'leased', 'completed', 'failed', 'cancelled')),
  CONSTRAINT workflow_dispatches_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT workflow_dispatches_revision_positive CHECK (revision > 0),
  CONSTRAINT workflow_dispatches_lease_fields CHECK (
    (state = 'leased' AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT workflow_dispatches_failure_code CHECK (
    (state = 'failed' AND failure_code IS NOT NULL AND failure_code ~ '^[a-z][a-z0-9_.-]{0,63}$')
    OR (state <> 'failed' AND failure_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS workflow_dispatches_pending_claim_idx
  ON agent_platform.workflow_dispatches (tenant_id, space_id, available_at, created_at, dispatch_id)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS workflow_dispatches_expired_claim_idx
  ON agent_platform.workflow_dispatches (tenant_id, space_id, lease_expires_at, created_at, dispatch_id)
  WHERE state = 'leased';

ALTER TABLE agent_platform.workflow_dispatches ENABLE ROW LEVEL SECURITY;

CREATE POLICY scope_isolation ON agent_platform.workflow_dispatches
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
