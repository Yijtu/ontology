import { BudgetLedgerError, isToolContext } from '@ontology/contracts'
import type {
  AtomicReserveOutcome,
  AtomicReserveRequest,
  AtomicSettleOutcome,
  AtomicSettleRequest,
  BudgetConsumption,
  BudgetLedgerLimits,
  BudgetLedgerRecord,
  BudgetLedgerStore,
  BudgetReservationRecord,
  BudgetReservationStatus,
  IntentRecordResult,
  NewBudgetLedger,
  NewToolIntent,
  ResourceRef,
  ScopeRef,
  ToolContext,
  ToolIntentRecord,
  Uuid,
} from '@ontology/contracts'
import {
  addConsumption,
  deriveRemaining,
  planReservation,
  planSettlement,
} from '@ontology/core'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface LedgerRow extends QueryResultRow {
  ledger_id: string
  kind: BudgetLedgerRecord['kind']
  limits: BudgetLedgerLimits
  deadline: Date
  tool_calls_consumed: number
  repair_attempts_consumed: number
  rows_consumed: string
  bytes_consumed: string
  model_tokens_consumed: string
  run_id: string | null
  revision: string
  created_at: Date
  updated_at: Date
}

interface ReservationRow extends QueryResultRow {
  reservation_id: string
  ledger_id: string
  idempotency_key: string
  status: BudgetReservationStatus
  intent_required: boolean
  tool_calls: number
  repair_attempts: number
  parallel_tools: number
  reserved_rows: string
  reserved_bytes: string
  reserved_model_tokens: string
  actual_tool_calls: number | null
  actual_rows: string | null
  actual_bytes: string | null
  actual_model_tokens: string | null
  usage_unknown: boolean
  evidence_refs: ResourceRef[]
  deadline: Date
  granted_at: Date
  expires_at: Date
  settled_at: Date | null
  run_id: string | null
}

interface IntentRow extends QueryResultRow {
  intent_id: string
  ledger_id: string
  reservation_id: string
  call_id: string
  tool_id: string
  arguments_digest: string
  attempt: number
  retry_reason: string | null
  recorded_at: Date
}

interface ParallelRow extends QueryResultRow {
  active: string
  next_expiry: Date | null
}

const LEDGER_COLUMNS = `ledger_id, kind, limits, deadline, tool_calls_consumed, repair_attempts_consumed,
  rows_consumed, bytes_consumed, model_tokens_consumed, run_id, revision, created_at, updated_at`

const RESERVATION_COLUMNS = `reservation_id, ledger_id, idempotency_key, status, intent_required,
  tool_calls, repair_attempts, parallel_tools, reserved_rows, reserved_bytes, reserved_model_tokens,
  actual_tool_calls, actual_rows, actual_bytes, actual_model_tokens, usage_unknown, evidence_refs,
  run_id, deadline, granted_at, expires_at, settled_at`

const INTENT_COLUMNS = `intent_id, ledger_id, reservation_id, call_id, tool_id, arguments_digest,
  attempt, retry_reason, recorded_at`

const RESERVATION_FROM = 'agent_platform.budget_reservations r'

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function toLedgerRecord(row: LedgerRow): BudgetLedgerRecord {
  return {
    ledgerId: row.ledger_id,
    kind: row.kind,
    limits: row.limits,
    deadline: row.deadline.toISOString(),
    consumed: {
      toolCalls: row.tool_calls_consumed,
      repairAttempts: row.repair_attempts_consumed,
      rows: num(row.rows_consumed),
      bytes: num(row.bytes_consumed),
      modelTokens: num(row.model_tokens_consumed),
    },
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  }
}

function toReservationRecord(row: ReservationRow): BudgetReservationRecord {
  const reserved: BudgetConsumption = {
    toolCalls: row.tool_calls,
    repairAttempts: row.repair_attempts,
    rows: num(row.reserved_rows),
    bytes: num(row.reserved_bytes),
    modelTokens: num(row.reserved_model_tokens),
  }
  const actual: BudgetConsumption | undefined =
    row.actual_tool_calls === null
      ? undefined
      : {
          toolCalls: row.actual_tool_calls,
          repairAttempts: row.repair_attempts,
          rows: num(row.actual_rows),
          bytes: num(row.actual_bytes),
          modelTokens: num(row.actual_model_tokens),
        }
  return {
    reservationId: row.reservation_id,
    ledgerId: row.ledger_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    intentRequired: row.intent_required,
    reserved,
    parallelTools: row.parallel_tools,
    usageUnknown: row.usage_unknown,
    evidenceRefs: row.evidence_refs,
    deadline: row.deadline.toISOString(),
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at.toISOString() }),
    ...(actual === undefined ? {} : { actual }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  }
}

function toIntentRecord(row: IntentRow): ToolIntentRecord {
  return {
    intentId: row.intent_id,
    ledgerId: row.ledger_id,
    reservationId: row.reservation_id,
    callId: row.call_id,
    toolId: row.tool_id,
    argumentsDigest: row.arguments_digest,
    attempt: row.attempt,
    recordedAt: row.recorded_at.toISOString(),
    ...(row.retry_reason === null ? {} : { retryReason: row.retry_reason }),
  }
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new BudgetLedgerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new BudgetLedgerError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new BudgetLedgerError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

/**
 * Real PostgreSQL implementation of the shared budget ledger (D7.2, C4).
 *
 * `reserveAtomic` and `settleAtomic` run inside one transaction that locks the ledger
 * row `FOR UPDATE`. The decision is computed from the locked counters with the same
 * pure `@ontology/core` functions the unit suite tests, so parallel requests for the
 * last remaining allowance serialise and exactly the legal subset is granted. Every
 * statement runs as the non-owner `ontology_app` role with the trusted scope set via
 * `SET LOCAL`, so RLS applies to the whole call.
 */
export class PostgresBudgetLedgerStore implements BudgetLedgerStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async ensureLedger(
    scopeRef: ScopeRef,
    ledger: NewBudgetLedger,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<LedgerRow>(
        `INSERT INTO agent_platform.budget_ledgers
           (tenant_id, space_id, ledger_id, kind, limits, deadline, run_id, created_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3::jsonb, $4::timestamptz, $5, $6::timestamptz, $6::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, ledger_id) DO NOTHING
         RETURNING ${LEDGER_COLUMNS}`,
        [
          ledger.ledgerId,
          ledger.kind,
          JSON.stringify(ledger.limits),
          new Date(Date.parse(ledger.openedAt) + ledger.limits.deadlineMs).toISOString(),
          ledger.runId ?? null,
          ledger.openedAt,
        ],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow !== undefined) return toLedgerRecord(insertedRow)

      const existing = await query.query<LedgerRow>(
        `SELECT ${LEDGER_COLUMNS}
           FROM agent_platform.budget_ledgers
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1`,
        [ledger.ledgerId],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) {
        throw new BudgetLedgerError('LEDGER_NOT_FOUND', 'the budget ledger could not be stored')
      }
      return toLedgerRecord(existingRow)
    })
  }

  async getLedger(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord | undefined> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<LedgerRow>(
          `SELECT ${LEDGER_COLUMNS}
             FROM agent_platform.budget_ledgers
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND ledger_id = $1`,
          [ledgerId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toLedgerRecord(row)
      },
      { readOnly: true },
    )
  }

  async reserveAtomic(
    scopeRef: ScopeRef,
    request: AtomicReserveRequest,
    ctx: ToolContext,
  ): Promise<AtomicReserveOutcome> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<LedgerRow>(
        `SELECT ${LEDGER_COLUMNS}
           FROM agent_platform.budget_ledgers
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1
          FOR UPDATE`,
        [request.ledgerId],
      )
      const ledgerRow = locked.rows[0]
      if (ledgerRow === undefined) {
        throw new BudgetLedgerError(
          'LEDGER_NOT_FOUND',
          `ledger ${request.ledgerId} is not visible in this scope`,
        )
      }
      const ledger = toLedgerRecord(ledgerRow)

      const replay = await query.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS} FROM ${RESERVATION_FROM}
          WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
            AND r.space_id = current_setting('app.space_id')::uuid
            AND r.ledger_id = $1 AND r.idempotency_key = $2`,
        [request.ledgerId, request.idempotencyKey],
      )
      const replayRow = replay.rows[0]
      if (replayRow !== undefined) {
        const active = await this.#parallelState(query, request.ledgerId, request.now)
        return {
          granted: true,
          reservation: toReservationRecord(replayRow),
          remaining: deriveRemaining(ledger, active.active),
        }
      }

      const parallel = await this.#parallelState(query, request.ledgerId, request.now)
      const plan = planReservation({
        limits: ledger.limits,
        consumed: ledger.consumed,
        activeParallelTools: parallel.active,
        ledgerDeadline: ledger.deadline,
        now: request.now,
        request: {
          toolCalls: request.consumption.toolCalls,
          repairAttempts: request.consumption.repairAttempts,
          parallelTools: request.parallelTools,
          rows: request.consumption.rows,
          bytes: request.consumption.bytes,
          modelTokens: request.consumption.modelTokens,
        },
        ...(request.requestedDeadline === undefined
          ? {}
          : { requestedDeadline: request.requestedDeadline }),
        ...(parallel.nextExpiry === undefined ? {} : { nextParallelExpiry: parallel.nextExpiry }),
      })
      if (!plan.granted) {
        return {
          granted: false,
          denial: plan.denial,
          remaining: deriveRemaining(ledger, parallel.active),
        }
      }

      await query.query(
        `INSERT INTO agent_platform.budget_reservations
           (tenant_id, space_id, ledger_id, reservation_id, idempotency_key, status, intent_required,
            tool_calls, repair_attempts, parallel_tools, reserved_rows, reserved_bytes,
            reserved_model_tokens, run_id, deadline, granted_at, expires_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, 'reserved', $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz,
           $12::timestamptz
         )`,
        [
          request.ledgerId,
          request.reservationId,
          request.idempotencyKey,
          request.requiresIntent,
          plan.consumption.toolCalls,
          plan.consumption.repairAttempts,
          request.parallelTools,
          plan.consumption.rows,
          plan.consumption.bytes,
          plan.consumption.modelTokens,
          ledger.runId ?? null,
          plan.deadline,
          request.now,
        ],
      )

      const consumed = addConsumption(ledger.consumed, plan.consumption)
      const updatedLedger: BudgetLedgerRecord = {
        ...ledger,
        consumed,
        revision: String(Number(ledger.revision) + 1),
        updatedAt: request.now,
      }
      await query.query(
        `UPDATE agent_platform.budget_ledgers
            SET tool_calls_consumed = $2,
                repair_attempts_consumed = $3,
                rows_consumed = $4,
                bytes_consumed = $5,
                model_tokens_consumed = $6,
                revision = revision + 1,
                updated_at = $7::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1`,
        [
          request.ledgerId,
          consumed.toolCalls,
          consumed.repairAttempts,
          consumed.rows,
          consumed.bytes,
          consumed.modelTokens,
          request.now,
        ],
      )

      const reservation: BudgetReservationRecord = {
        reservationId: request.reservationId,
        ledgerId: request.ledgerId,
        idempotencyKey: request.idempotencyKey,
        status: 'reserved',
        intentRequired: request.requiresIntent,
        reserved: plan.consumption,
        parallelTools: request.parallelTools,
        usageUnknown: false,
        evidenceRefs: [],
        deadline: plan.deadline,
        grantedAt: request.now,
        expiresAt: plan.expiresAt,
        ...(ledger.runId === undefined ? {} : { runId: ledger.runId }),
      }
      return {
        granted: true,
        reservation,
        remaining: deriveRemaining(updatedLedger, parallel.active + request.parallelTools),
      }
    })
  }

  async recordIntent(
    scopeRef: ScopeRef,
    intent: NewToolIntent,
    ctx: ToolContext,
  ): Promise<IntentRecordResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      // Locking the ledger serialises duplicate-intent detection within a ledger, so
      // two concurrent intents for the same tool+arguments cannot both miss the other.
      const ledger = await query.query<{ ledger_id: string }>(
        `SELECT ledger_id
           FROM agent_platform.budget_ledgers
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1
          FOR UPDATE`,
        [intent.ledgerId],
      )
      if (ledger.rows[0] === undefined) {
        throw new BudgetLedgerError(
          'LEDGER_NOT_FOUND',
          `ledger ${intent.ledgerId} is not visible in this scope`,
        )
      }

      const reservation = await query.query<{ reservation_id: string }>(
        `SELECT reservation_id FROM ${RESERVATION_FROM}
          WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
            AND r.space_id = current_setting('app.space_id')::uuid
            AND r.ledger_id = $1 AND r.reservation_id = $2`,
        [intent.ledgerId, intent.reservationId],
      )
      if (reservation.rows[0] === undefined) {
        throw new BudgetLedgerError(
          'RESERVATION_NOT_FOUND',
          `reservation ${intent.reservationId} is not visible in this scope`,
        )
      }

      const duplicate = await query.query<{ reservation_id: string }>(
        `SELECT reservation_id
           FROM agent_platform.tool_intents
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1 AND tool_id = $2 AND arguments_digest = $3
            AND reservation_id <> $4
          ORDER BY recorded_at ASC
          LIMIT 1`,
        [intent.ledgerId, intent.toolId, intent.argumentsDigest, intent.reservationId],
      )

      await query.query(
        `INSERT INTO agent_platform.tool_intents
           (tenant_id, space_id, ledger_id, intent_id, reservation_id, call_id, tool_id,
            arguments_digest, attempt, retry_reason, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, ledger_id, reservation_id) DO NOTHING`,
        [
          intent.ledgerId,
          intent.intentId,
          intent.reservationId,
          intent.callId,
          intent.toolId,
          intent.argumentsDigest,
          intent.attempt,
          intent.retryReason ?? null,
          intent.recordedAt,
        ],
      )

      const stored = await query.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS}
           FROM agent_platform.tool_intents
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1 AND reservation_id = $2`,
        [intent.ledgerId, intent.reservationId],
      )
      const storedRow = stored.rows[0]
      if (storedRow === undefined) {
        throw new BudgetLedgerError('RESERVATION_NOT_FOUND', 'the tool intent could not be stored')
      }
      const duplicateOf = duplicate.rows[0]?.reservation_id
      return duplicateOf === undefined
        ? { intent: toIntentRecord(storedRow) }
        : { intent: toIntentRecord(storedRow), duplicateOf }
    })
  }

  async findIntent(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<ToolIntentRecord | undefined> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<IntentRow>(
          `SELECT ${INTENT_COLUMNS}
             FROM agent_platform.tool_intents
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND ledger_id = $1 AND reservation_id = $2`,
          [ledgerId, reservationId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toIntentRecord(row)
      },
      { readOnly: true },
    )
  }

  async settleAtomic(
    scopeRef: ScopeRef,
    request: AtomicSettleRequest,
    ctx: ToolContext,
  ): Promise<AtomicSettleOutcome> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const lockedLedger = await query.query<LedgerRow>(
        `SELECT ${LEDGER_COLUMNS}
           FROM agent_platform.budget_ledgers
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1
          FOR UPDATE`,
        [request.ledgerId],
      )
      const ledgerRow = lockedLedger.rows[0]
      if (ledgerRow === undefined) {
        throw new BudgetLedgerError(
          'LEDGER_NOT_FOUND',
          `ledger ${request.ledgerId} is not visible in this scope`,
        )
      }
      const ledger = toLedgerRecord(ledgerRow)

      const lockedReservation = await query.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS} FROM ${RESERVATION_FROM}
          WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
            AND r.space_id = current_setting('app.space_id')::uuid
            AND r.ledger_id = $1 AND r.reservation_id = $2
          FOR UPDATE`,
        [request.ledgerId, request.reservationId],
      )
      const reservationRow = lockedReservation.rows[0]
      if (reservationRow === undefined) {
        throw new BudgetLedgerError(
          'RESERVATION_NOT_FOUND',
          `reservation ${request.reservationId} is not visible in this scope`,
        )
      }
      const reservation = toReservationRecord(reservationRow)

      if (reservation.intentRequired) {
        const intent = await query.query<{ intent_id: string }>(
          `SELECT intent_id
             FROM agent_platform.tool_intents
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND ledger_id = $1 AND reservation_id = $2`,
          [request.ledgerId, request.reservationId],
        )
        if (intent.rows[0] === undefined) {
          throw new BudgetLedgerError(
            'INTENT_NOT_RECORDED',
            `reservation ${request.reservationId} has no persisted intent and cannot be settled`,
          )
        }
      }

      const parallel = await this.#parallelState(query, request.ledgerId, request.now)
      const plan = planSettlement({
        reservationStatus: reservation.status,
        reserved: reservation.reserved,
        consumed: ledger.consumed,
        status: request.status,
        usage: request.usage,
      })
      if (plan.kind === 'conflict') {
        throw new BudgetLedgerError('SETTLEMENT_CONFLICT', plan.message)
      }
      if (plan.kind === 'noop') {
        return {
          reservation,
          applied: false,
          remaining: deriveRemaining(ledger, parallel.active),
        }
      }

      const updatedLedger: BudgetLedgerRecord = {
        ...ledger,
        consumed: plan.consumed,
        revision: String(Number(ledger.revision) + 1),
        updatedAt: request.now,
      }
      await query.query(
        `UPDATE agent_platform.budget_ledgers
            SET tool_calls_consumed = $2,
                repair_attempts_consumed = $3,
                rows_consumed = $4,
                bytes_consumed = $5,
                model_tokens_consumed = $6,
                revision = revision + 1,
                updated_at = $7::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1`,
        [
          request.ledgerId,
          plan.consumed.toolCalls,
          plan.consumed.repairAttempts,
          plan.consumed.rows,
          plan.consumed.bytes,
          plan.consumed.modelTokens,
          request.now,
        ],
      )
      await query.query(
        `UPDATE agent_platform.budget_reservations
            SET status = $3,
                actual_tool_calls = $4,
                actual_rows = $5,
                actual_bytes = $6,
                actual_model_tokens = $7,
                usage_unknown = $8,
                evidence_refs = $9::jsonb,
                settled_at = $10::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ledger_id = $1 AND reservation_id = $2`,
        [
          request.ledgerId,
          request.reservationId,
          plan.status,
          plan.actual.toolCalls,
          plan.actual.rows,
          plan.actual.bytes,
          plan.actual.modelTokens,
          plan.usageUnknown,
          JSON.stringify(request.evidenceRefs),
          request.now,
        ],
      )

      const settled: BudgetReservationRecord = {
        ...reservation,
        status: plan.status,
        usageUnknown: plan.usageUnknown,
        actual: plan.actual,
        evidenceRefs: request.evidenceRefs,
        settledAt: request.now,
      }
      return {
        reservation: settled,
        applied: true,
        remaining: deriveRemaining(
          updatedLedger,
          Math.max(0, parallel.active - reservation.parallelTools),
        ),
      }
    })
  }

  async getReservation(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord | undefined> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<ReservationRow>(
          `SELECT ${RESERVATION_COLUMNS} FROM ${RESERVATION_FROM}
            WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
              AND r.space_id = current_setting('app.space_id')::uuid
              AND r.ledger_id = $1 AND r.reservation_id = $2`,
          [ledgerId, reservationId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toReservationRecord(row)
      },
      { readOnly: true },
    )
  }

  async listReservations(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord[]> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<ReservationRow>(
          `SELECT ${RESERVATION_COLUMNS} FROM ${RESERVATION_FROM}
            WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
              AND r.space_id = current_setting('app.space_id')::uuid
              AND r.ledger_id = $1
            ORDER BY r.granted_at ASC, r.reservation_id ASC`,
          [ledgerId],
        )
        return result.rows.map(toReservationRecord)
      },
      { readOnly: true },
    )
  }

  async listIntents(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<ToolIntentRecord[]> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<IntentRow>(
          `SELECT ${INTENT_COLUMNS}
             FROM agent_platform.tool_intents
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND ledger_id = $1
            ORDER BY recorded_at ASC, intent_id ASC`,
          [ledgerId],
        )
        return result.rows.map(toIntentRecord)
      },
      { readOnly: true },
    )
  }

  async countActiveParallelTools(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    now: string,
    ctx: ToolContext,
  ): Promise<number> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => (await this.#parallelState(query, ledgerId, now)).active,
      { readOnly: true },
    )
  }

  async #parallelState(
    query: ScopedQuery,
    ledgerId: Uuid,
    now: string,
  ): Promise<{ active: number; nextExpiry: string | undefined }> {
    const result = await query.query<ParallelRow>(
      `SELECT COALESCE(SUM(parallel_tools), 0)::text AS active, MIN(expires_at) AS next_expiry
         FROM agent_platform.budget_reservations
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND ledger_id = $1
          AND parallel_tools > 0
          AND status IN ('reserved', 'running')
          AND expires_at > $2::timestamptz`,
      [ledgerId, now],
    )
    const row = result.rows[0]
    return {
      active: num(row?.active),
      nextExpiry: row?.next_expiry === null || row?.next_expiry === undefined
        ? undefined
        : row.next_expiry.toISOString(),
    }
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    const scope = resolveScope(scopeRef, ctx)
    return this.#database.withIdentityScope(scope, async (client) =>
      run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }),
      options,
    )
  }
}
