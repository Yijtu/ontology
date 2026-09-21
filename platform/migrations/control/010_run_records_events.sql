-- 010_run_records_events.sql
--
-- Run records, the public event log and runtime-private checkpoints (SPEC C6/D7,
-- US-004/US-019/US-022/US-023).
--
-- Design:
--  * `runs` locks the exact resolved manifest at creation through a composite foreign key
--    into `resolved_profiles`, so a later profile or component version can never alter an
--    existing run. `revision` is the monotonic compare-and-set token behind If-Match, and
--    `(tenant_id, space_id, idempotency_key)` is the unique claim behind Idempotency-Key.
--  * `run_events` stores the queryable public SSE payload under the monotonic sequence
--    allocated by `ControlRepository.appendEvent` (the durable `semantic_events` ledger).
--    The SSE `id` is that sequence, so Last-Event-ID replay is ordered and de-duplicable.
--  * `runtime_checkpoints` keeps the runtime-private blob separately. It is never returned
--    by the public run surface; only the public handle is exposed, and a resume is refused
--    unless the runtime kind/version match.
--  * Clarification responses and abandoned (late) attempts are their own append-only tables.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the application
-- role access without another explicit GRANT. Forward-only: 001..009 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.runs (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  run_id                  uuid        NOT NULL,
  owner_subject_id        text        NOT NULL,
  profile_id              text        NOT NULL,
  profile_version         text        NOT NULL,
  resolved_profile_hash   text        NOT NULL,
  runtime_ref             jsonb       NOT NULL,
  question                text        NOT NULL,
  context                 jsonb       NOT NULL,
  preferences             jsonb       NOT NULL,
  state                   text        NOT NULL,
  revision                bigint      NOT NULL,
  idempotency_key         text        NOT NULL,
  request_digest          text        NOT NULL,
  cancel_reason           text,
  cancelled_at            timestamptz,
  pending_clarification_id uuid,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT runs_pkey PRIMARY KEY (tenant_id, space_id, run_id),
  CONSTRAINT runs_idempotency_key_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT runs_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT runs_resolved_profile_fkey
    FOREIGN KEY (tenant_id, space_id, profile_id, profile_version, resolved_profile_hash)
    REFERENCES agent_platform.resolved_profiles (tenant_id, space_id, profile_id, version, snapshot_hash)
    ON DELETE RESTRICT,
  CONSTRAINT runs_revision_positive CHECK (revision > 0),
  CONSTRAINT runs_resolved_profile_hash_format CHECK (resolved_profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT runs_state CHECK (state IN (
    'created', 'preflight', 'collecting', 'drafting', 'verifying', 'published',
    'awaiting_input', 'cancelling', 'cancelled', 'blocked', 'failed'
  )),
  CONSTRAINT runs_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS runs_state_idx
  ON agent_platform.runs (tenant_id, space_id, state, updated_at);

-- Public event log. `sequence` is allocated by the durable ledger (appendEvent) and is the
-- SSE id. `idempotency_key` is the stable identity of the logical event, so a retry that
-- generates a fresh event_id still cannot double-append.
CREATE TABLE IF NOT EXISTS agent_platform.run_events (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  run_id          uuid        NOT NULL,
  event_id        uuid        NOT NULL,
  sequence        bigint      NOT NULL,
  sse_type        text        NOT NULL,
  data            jsonb       NOT NULL,
  occurred_at     timestamptz NOT NULL,
  idempotency_key text        NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_events_pkey PRIMARY KEY (tenant_id, space_id, run_id, sequence),
  CONSTRAINT run_events_event_id_unique UNIQUE (tenant_id, space_id, run_id, event_id),
  CONSTRAINT run_events_idempotency_key_unique UNIQUE (tenant_id, space_id, run_id, idempotency_key),
  CONSTRAINT run_events_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT run_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT run_events_sse_type CHECK (sse_type IN (
    'run.state', 'plan.summary', 'tool.started', 'tool.completed',
    'evidence.available', 'clarification.required', 'answer.published', 'run.failed'
  ))
);

-- Runtime-private checkpoint blob. Never exposed by the public run surface; a resume only
-- restores it when the runtime kind and version match the run's locked runtime.
CREATE TABLE IF NOT EXISTS agent_platform.runtime_checkpoints (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  run_id          uuid        NOT NULL,
  checkpoint_id   uuid        NOT NULL,
  runtime_kind    text        NOT NULL,
  runtime_version text        NOT NULL,
  state_digest    text        NOT NULL,
  payload         bytea       NOT NULL,
  created_at      timestamptz NOT NULL,
  CONSTRAINT runtime_checkpoints_pkey PRIMARY KEY (tenant_id, space_id, run_id, checkpoint_id),
  CONSTRAINT runtime_checkpoints_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT runtime_checkpoints_state_digest_format CHECK (state_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS agent_platform.run_clarification_responses (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  run_id           uuid        NOT NULL,
  clarification_id uuid        NOT NULL,
  typed_response   jsonb       NOT NULL,
  responded_at     timestamptz NOT NULL,
  responded_by     text        NOT NULL,
  revision         bigint      NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_clarification_responses_pkey PRIMARY KEY (tenant_id, space_id, run_id, clarification_id),
  CONSTRAINT run_clarification_responses_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE
);

-- Late or uncancellable attempts. The late result is quarantined and can never revive or
-- publish a cancelled run.
CREATE TABLE IF NOT EXISTS agent_platform.run_abandoned_attempts (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  run_id           uuid        NOT NULL,
  attempt_id       uuid        NOT NULL,
  call_id          uuid,
  reason           text        NOT NULL,
  late_result_policy text      NOT NULL DEFAULT 'quarantined',
  abandoned_at     timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_abandoned_attempts_pkey PRIMARY KEY (tenant_id, space_id, run_id, attempt_id),
  CONSTRAINT run_abandoned_attempts_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT run_abandoned_attempts_policy CHECK (late_result_policy = 'quarantined')
);

ALTER TABLE agent_platform.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.runtime_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.run_clarification_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.run_abandoned_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.runs;
CREATE POLICY scope_isolation ON agent_platform.runs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.run_events;
CREATE POLICY scope_isolation ON agent_platform.run_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.runtime_checkpoints;
CREATE POLICY scope_isolation ON agent_platform.runtime_checkpoints
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.run_clarification_responses;
CREATE POLICY scope_isolation ON agent_platform.run_clarification_responses
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.run_abandoned_attempts;
CREATE POLICY scope_isolation ON agent_platform.run_abandoned_attempts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
