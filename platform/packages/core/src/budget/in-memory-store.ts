import {
  BudgetLedgerError,
  isToolContext,
} from '@ontology/contracts'
import type {
  AtomicReserveOutcome,
  AtomicReserveRequest,
  AtomicSettleOutcome,
  AtomicSettleRequest,
  BudgetLedgerRecord,
  BudgetLedgerStore,
  BudgetReservationRecord,
  IntentRecordResult,
  NewBudgetLedger,
  NewToolIntent,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ToolContext,
  ToolIntentRecord,
  Uuid,
} from '@ontology/contracts'
import { addConsumption, deriveRemaining, emptyConsumption, planReservation, planSettlement } from './arithmetic'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function ledgerKey(scopeRef: ScopeRef, ledgerId: Uuid): string {
  return `${scopeKey(scopeRef)}\u0000${ledgerId}`
}

function reservationKey(scopeRef: ScopeRef, ledgerId: Uuid, reservationId: Uuid): string {
  return `${ledgerKey(scopeRef, ledgerId)}\u0000${reservationId}`
}

function idempotencyKey(scopeRef: ScopeRef, ledgerId: Uuid, key: string): string {
  return `${ledgerKey(scopeRef, ledgerId)}\u0000${key}`
}

function dedupeKey(scopeRef: ScopeRef, ledgerId: Uuid, toolId: string, digest: string): string {
  return `${ledgerKey(scopeRef, ledgerId)}\u0000${toolId}\u0000${digest}`
}

/**
 * In-process budget ledger with the same atomic semantics as the PostgreSQL store.
 *
 * Every method computes its decision and applies the counter change synchronously
 * before any await, so two overlapping `reserveAtomic` calls cannot both read the
 * same remaining allowance. This is the controlled test adapter used by the unit
 * suite; the real-DB suite proves the same contract under true concurrency.
 */
export class InMemoryBudgetLedgerStore implements BudgetLedgerStore {
  readonly #ledgers = new Map<string, BudgetLedgerRecord>()
  readonly #reservations = new Map<string, BudgetReservationRecord>()
  readonly #reservationByIdempotency = new Map<string, Uuid>()
  readonly #intents = new Map<string, ToolIntentRecord>()
  readonly #intentIds = new Map<string, ToolIntentRecord>()
  readonly #dedupe = new Map<string, Uuid[]>()

  ensureLedger(
    scopeRef: ScopeRef,
    ledger: NewBudgetLedger,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord> {
    assertScope(scopeRef, ctx)
    const key = ledgerKey(scopeRef, ledger.ledgerId)
    const existing = this.#ledgers.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const record: BudgetLedgerRecord = {
      ledgerId: ledger.ledgerId,
      kind: ledger.kind,
      limits: ledger.limits,
      deadline: new Date(
        Date.parse(ledger.openedAt) + ledger.limits.deadlineMs,
      ).toISOString(),
      consumed: emptyConsumption(),
      revision: '1',
      createdAt: ledger.openedAt,
      updatedAt: ledger.openedAt,
      ...(ledger.runId === undefined ? {} : { runId: ledger.runId }),
    }
    this.#ledgers.set(key, record)
    return Promise.resolve(record)
  }

  getLedger(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord | undefined> {
    assertScope(scopeRef, ctx)
    return Promise.resolve(this.#ledgers.get(ledgerKey(scopeRef, ledgerId)))
  }

  reserveAtomic(
    scopeRef: ScopeRef,
    request: AtomicReserveRequest,
    ctx: ToolContext,
  ): Promise<AtomicReserveOutcome> {
    assertScope(scopeRef, ctx)
    const ledger = this.#requireLedger(scopeRef, request.ledgerId)

    const claimed = this.#reservationByIdempotency.get(
      idempotencyKey(scopeRef, request.ledgerId, request.idempotencyKey),
    )
    if (claimed !== undefined) {
      const existing = this.#requireReservation(scopeRef, request.ledgerId, claimed)
      return Promise.resolve({
        granted: true,
        reservation: existing,
        remaining: deriveRemaining(ledger, this.#activeParallel(scopeRef, ledger.ledgerId, request.now)),
      })
    }

    const active = this.#activeParallel(scopeRef, ledger.ledgerId, request.now)
    const nextParallelExpiry = this.#nextParallelExpiry(scopeRef, ledger.ledgerId, request.now)
    const plan = planReservation({
      limits: ledger.limits,
      consumed: ledger.consumed,
      activeParallelTools: active,
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
      ...(nextParallelExpiry === undefined ? {} : { nextParallelExpiry }),
    })
    if (!plan.granted) {
      return Promise.resolve({
        granted: false,
        denial: plan.denial,
        remaining: deriveRemaining(ledger, active),
      })
    }

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
    const updatedLedger: BudgetLedgerRecord = {
      ...ledger,
      consumed: addConsumption(ledger.consumed, plan.consumption),
      revision: String(Number(ledger.revision) + 1),
      updatedAt: request.now,
    }
    this.#ledgers.set(ledgerKey(scopeRef, request.ledgerId), updatedLedger)
    this.#reservations.set(
      reservationKey(scopeRef, request.ledgerId, request.reservationId),
      reservation,
    )
    this.#reservationByIdempotency.set(
      idempotencyKey(scopeRef, request.ledgerId, request.idempotencyKey),
      request.reservationId,
    )
    return Promise.resolve({
      granted: true,
      reservation,
      remaining: deriveRemaining(updatedLedger, active + request.parallelTools),
    })
  }

  recordIntent(
    scopeRef: ScopeRef,
    intent: NewToolIntent,
    ctx: ToolContext,
  ): Promise<IntentRecordResult> {
    assertScope(scopeRef, ctx)
    this.#requireReservation(scopeRef, intent.ledgerId, intent.reservationId)
    const existing = this.#intents.get(
      reservationKey(scopeRef, intent.ledgerId, intent.reservationId),
    )
    if (existing !== undefined) return Promise.resolve({ intent: existing })

    const key = dedupeKey(scopeRef, intent.ledgerId, intent.toolId, intent.argumentsDigest)
    const previous = this.#dedupe.get(key) ?? []
    const duplicateOf = previous[0]

    this.#intents.set(reservationKey(scopeRef, intent.ledgerId, intent.reservationId), intent)
    this.#intentIds.set(
      `${ledgerKey(scopeRef, intent.ledgerId)}\u0000${intent.intentId}`,
      intent,
    )
    this.#dedupe.set(key, [...previous, intent.reservationId])
    return Promise.resolve(
      duplicateOf === undefined ? { intent } : { intent, duplicateOf },
    )
  }

  findIntent(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<ToolIntentRecord | undefined> {
    assertScope(scopeRef, ctx)
    return Promise.resolve(this.#intents.get(reservationKey(scopeRef, ledgerId, reservationId)))
  }

  settleAtomic(
    scopeRef: ScopeRef,
    request: AtomicSettleRequest,
    ctx: ToolContext,
  ): Promise<AtomicSettleOutcome> {
    assertScope(scopeRef, ctx)
    const ledger = this.#requireLedger(scopeRef, request.ledgerId)
    const reservation = this.#requireReservation(
      scopeRef,
      request.ledgerId,
      request.reservationId,
    )
    if (
      reservation.intentRequired &&
      this.#intents.get(reservationKey(scopeRef, request.ledgerId, request.reservationId)) ===
        undefined
    ) {
      throw new BudgetLedgerError(
        'INTENT_NOT_RECORDED',
        `reservation ${request.reservationId} has no persisted intent and cannot be settled`,
      )
    }

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
    const active = this.#activeParallel(scopeRef, request.ledgerId, request.now)
    if (plan.kind === 'noop') {
      return Promise.resolve({
        reservation,
        applied: false,
        remaining: deriveRemaining(ledger, active),
      })
    }

    const settled: BudgetReservationRecord = {
      ...reservation,
      status: plan.status,
      usageUnknown: plan.usageUnknown,
      actual: plan.actual,
      evidenceRefs: request.evidenceRefs,
      settledAt: request.now,
    }
    const updatedLedger: BudgetLedgerRecord = {
      ...ledger,
      consumed: plan.consumed,
      revision: String(Number(ledger.revision) + 1),
      updatedAt: request.now,
    }
    this.#ledgers.set(ledgerKey(scopeRef, request.ledgerId), updatedLedger)
    this.#reservations.set(
      reservationKey(scopeRef, request.ledgerId, request.reservationId),
      settled,
    )
    return Promise.resolve({
      reservation: settled,
      applied: true,
      remaining: deriveRemaining(
        updatedLedger,
        active - (settled.parallelTools > 0 ? settled.parallelTools : 0),
      ),
    })
  }

  getReservation(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord | undefined> {
    assertScope(scopeRef, ctx)
    return Promise.resolve(
      this.#reservations.get(reservationKey(scopeRef, ledgerId, reservationId)),
    )
  }

  listReservations(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord[]> {
    assertScope(scopeRef, ctx)
    const prefix = `${ledgerKey(scopeRef, ledgerId)}\u0000`
    const records = [...this.#reservations.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
    return Promise.resolve(records)
  }

  listIntents(scopeRef: ScopeRef, ledgerId: Uuid, ctx: ToolContext): Promise<ToolIntentRecord[]> {
    assertScope(scopeRef, ctx)
    const prefix = `${ledgerKey(scopeRef, ledgerId)}\u0000`
    const records = [...this.#intents.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
    return Promise.resolve(records)
  }

  countActiveParallelTools(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    now: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<number> {
    assertScope(scopeRef, ctx)
    return Promise.resolve(this.#activeParallel(scopeRef, ledgerId, now))
  }

  #activeParallel(scopeRef: ScopeRef, ledgerId: Uuid, now: Rfc3339UtcTimestamp): number {
    const prefix = `${ledgerKey(scopeRef, ledgerId)}\u0000`
    let active = 0
    for (const [key, record] of this.#reservations) {
      if (!key.startsWith(prefix)) continue
      if (record.parallelTools <= 0) continue
      if (record.status !== 'reserved' && record.status !== 'running') continue
      if (Date.parse(record.expiresAt) <= Date.parse(now)) continue
      active += record.parallelTools
    }
    return active
  }

  #nextParallelExpiry(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    now: Rfc3339UtcTimestamp,
  ): Rfc3339UtcTimestamp | undefined {
    const prefix = `${ledgerKey(scopeRef, ledgerId)}\u0000`
    let earliest: Rfc3339UtcTimestamp | undefined
    for (const [key, record] of this.#reservations) {
      if (!key.startsWith(prefix)) continue
      if (record.parallelTools <= 0) continue
      if (record.status !== 'reserved' && record.status !== 'running') continue
      if (Date.parse(record.expiresAt) <= Date.parse(now)) continue
      if (earliest === undefined || Date.parse(record.expiresAt) < Date.parse(earliest)) {
        earliest = record.expiresAt
      }
    }
    return earliest
  }

  #requireLedger(scopeRef: ScopeRef, ledgerId: Uuid): BudgetLedgerRecord {
    const ledger = this.#ledgers.get(ledgerKey(scopeRef, ledgerId))
    if (ledger === undefined) {
      throw new BudgetLedgerError('LEDGER_NOT_FOUND', `ledger ${ledgerId} is not visible in this scope`)
    }
    return ledger
  }

  #requireReservation(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
  ): BudgetReservationRecord {
    const reservation = this.#reservations.get(
      reservationKey(scopeRef, ledgerId, reservationId),
    )
    if (reservation === undefined) {
      throw new BudgetLedgerError(
        'RESERVATION_NOT_FOUND',
        `reservation ${reservationId} is not visible in this scope`,
      )
    }
    return reservation
  }
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new BudgetLedgerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (
    ctx.allowedResources.tenantId !== tenantId ||
    scopeRef.tenantId !== tenantId ||
    scopeRef.spaceId !== spaceId
  ) {
    throw new BudgetLedgerError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}
