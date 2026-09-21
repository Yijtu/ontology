-- 011_budget_ledger.sql
--
-- Shared budget ledger, atomic reservations and tool intents (SPEC D7.2, ADR-14,
-- C4/C6.2; US-006/018/019).
--
-- Design:
--  * `budget_ledgers` is one row per run (kind='run') or per background/import job
--    (kind='background'). The two kinds are limited independently, so an ingestion
--    backlog can never starve an online question or borrow from its quota.
--    Counters are monotonic apart from settlement reconciliation of an over-estimate.
--  * `budget_reservations` is written before a call executes. `reserveAtomic` locks the
--    ledger row `FOR UPDATE`, computes the decision from the locked counters and inserts
--    the reservation in the same transaction, so parallel requests for the last
--    allowance can never oversubscribe. `idempotency_key` makes a replayed reserve
--    return the original reservation.
--  * `tool_intents` records the intent before execution (SPEC §8). A settlement of a
--    reservation that required an intent is refused unless the intent row exists, so a
--    success can never be reported without the call having been declared first.
--  * Terminal reservation statuses are idempotent: a duplicate settlement is a no-op.
--    `usage_unknown` holds the reserved amount until a later definitive reconciliation
--    instead of releasing it as free allowance.
--
-- Every key and foreign key carries tenant_id/space_id, and RLS denies rows outside the
-- session scope. Appended after 003, so the schema default privileges grant the
-- application role access without another explicit GRANT. Forward-only: 001..010 are
-- never edited.

CREATE TABLE IF NOT EXISTS agent_platform.budget_ledgers (
  tenant_id                uuid        NOT NULL,
  space_id                 uuid        NOT NULL,
  ledger_id                uuid        NOT NULL,
  kind                     text        NOT NULL,
  limits                   jsonb       NOT NULL,
  deadline                 timestamptz NOT NULL,
  tool_calls_consumed      integer     NOT NULL DEFAULT 0,
  repair_attempts_consumed integer     NOT NULL DEFAULT 0,
  rows_consumed            bigint      NOT NULL DEFAULT 0,
  bytes_consumed           bigint      NOT NULL DEFAULT 0,
  model_tokens_consumed    bigint      NOT NULL DEFAULT 0,
  run_id                   uuid,
  revision                 bigint      NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  CONSTRAINT budget_ledgers_pkey PRIMARY KEY (tenant_id, space_id, ledger_id),
  CONSTRAINT budget_ledgers_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT budget_ledgers_kind CHECK (kind IN ('run', 'background')),
  CONSTRAINT budget_ledgers_tool_calls_nonnegative CHECK (tool_calls_consumed >= 0),
  CONSTRAINT budget_ledgers_repair_attempts_nonnegative CHECK (repair_attempts_consumed >= 0),
  CONSTRAINT budget_ledgers_rows_nonnegative CHECK (rows_consumed >= 0),
  CONSTRAINT budget_ledgers_bytes_nonnegative CHECK (bytes_consumed >= 0),
  CONSTRAINT budget_ledgers_model_tokens_nonnegative CHECK (model_tokens_consumed >= 0),
  CONSTRAINT budget_ledgers_revision_positive CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS budget_ledgers_run_idx
  ON agent_platform.budget_ledgers (tenant_id, space_id, run_id)
  WHERE run_id IS NOT NULL;

-- One atomic reservation. The requested estimate is charged up front; `actual_*` is
-- filled in at settlement. `usage_unknown` is true when the remote may have been billed.
CREATE TABLE IF NOT EXISTS agent_platform.budget_reservations (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  ledger_id             uuid        NOT NULL,
  reservation_id        uuid        NOT NULL,
  idempotency_key       text        NOT NULL,
  status                text        NOT NULL,
  intent_required       boolean     NOT NULL DEFAULT false,
  tool_calls            integer     NOT NULL DEFAULT 0,
  repair_attempts       integer     NOT NULL DEFAULT 0,
  parallel_tools        integer     NOT NULL DEFAULT 0,
  reserved_rows         bigint      NOT NULL DEFAULT 0,
  reserved_bytes        bigint      NOT NULL DEFAULT 0,
  reserved_model_tokens bigint      NOT NULL DEFAULT 0,
  actual_tool_calls     integer,
  actual_rows           bigint,
  actual_bytes          bigint,
  actual_model_tokens   bigint,
  usage_unknown         boolean     NOT NULL DEFAULT false,
  evidence_refs         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  run_id                uuid,
  deadline              timestamptz NOT NULL,
  granted_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  settled_at            timestamptz,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_reservations_pkey
    PRIMARY KEY (tenant_id, space_id, ledger_id, reservation_id),
  CONSTRAINT budget_reservations_idempotency_key_unique
    UNIQUE (tenant_id, space_id, ledger_id, idempotency_key),
  CONSTRAINT budget_reservations_ledger_fkey
    FOREIGN KEY (tenant_id, space_id, ledger_id)
    REFERENCES agent_platform.budget_ledgers (tenant_id, space_id, ledger_id) ON DELETE CASCADE,
  CONSTRAINT budget_reservations_status CHECK (status IN (
    'reserved', 'running', 'settled', 'failed', 'abandoned', 'usage_unknown'
  )),
  CONSTRAINT budget_reservations_amounts_nonnegative CHECK (
    tool_calls >= 0 AND repair_attempts >= 0 AND parallel_tools >= 0
    AND reserved_rows >= 0 AND reserved_bytes >= 0 AND reserved_model_tokens >= 0
  ),
  CONSTRAINT budget_reservations_idempotency_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

-- In-flight parallel tools are counted from non-terminal, non-expired reservations.
CREATE INDEX IF NOT EXISTS budget_reservations_active_parallel_idx
  ON agent_platform.budget_reservations (tenant_id, space_id, ledger_id, expires_at)
  WHERE status IN ('reserved', 'running') AND parallel_tools > 0;

CREATE INDEX IF NOT EXISTS budget_reservations_ledger_status_idx
  ON agent_platform.budget_reservations (tenant_id, space_id, ledger_id, status);

-- Intent persisted before the call executes (SPEC §8). One intent per reservation.
CREATE TABLE IF NOT EXISTS agent_platform.tool_intents (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  ledger_id        uuid        NOT NULL,
  intent_id        uuid        NOT NULL,
  reservation_id   uuid        NOT NULL,
  call_id          uuid        NOT NULL,
  tool_id          text        NOT NULL,
  arguments_digest text        NOT NULL,
  attempt          integer     NOT NULL,
  retry_reason     text,
  recorded_at      timestamptz NOT NULL,
  CONSTRAINT tool_intents_pkey PRIMARY KEY (tenant_id, space_id, ledger_id, intent_id),
  CONSTRAINT tool_intents_reservation_unique
    UNIQUE (tenant_id, space_id, ledger_id, reservation_id),
  CONSTRAINT tool_intents_reservation_fkey
    FOREIGN KEY (tenant_id, space_id, ledger_id, reservation_id)
    REFERENCES agent_platform.budget_reservations (tenant_id, space_id, ledger_id, reservation_id)
    ON DELETE CASCADE,
  CONSTRAINT tool_intents_arguments_digest_format CHECK (arguments_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT tool_intents_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT tool_intents_tool_id_nonempty CHECK (char_length(tool_id) > 0)
);

-- Duplicate detection for D7.3 no-progress: same tool + normalized arguments in one ledger.
CREATE INDEX IF NOT EXISTS tool_intents_dedupe_idx
  ON agent_platform.tool_intents (tenant_id, space_id, ledger_id, tool_id, arguments_digest);

ALTER TABLE agent_platform.budget_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.tool_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.budget_ledgers;
CREATE POLICY scope_isolation ON agent_platform.budget_ledgers
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.budget_reservations;
CREATE POLICY scope_isolation ON agent_platform.budget_reservations
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.tool_intents;
CREATE POLICY scope_isolation ON agent_platform.tool_intents
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
