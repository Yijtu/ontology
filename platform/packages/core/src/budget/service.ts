import { BudgetLedgerError, isToolContext } from '@ontology/contracts'
import type {
  AtomicReserveOutcome,
  AtomicReserveRequest,
  AtomicSettleOutcome,
  AtomicSettleRequest,
  BudgetLedgerPort,
  BudgetLedgerRecord,
  BudgetLedgerSnapshot,
  BudgetLedgerStore,
  BudgetReserveInput,
  BudgetReservationRecord,
  BudgetSettlementInput,
  ControlAppendEventRequest,
  ControlRepository,
  OpenBudgetLedgerInput,
  RecordIntentInput,
  ScopeRef,
  ToolContext,
  ToolIntentRecord,
  Uuid,
} from '@ontology/contracts'
import { deriveRemaining } from './arithmetic'
import { sha256DigestOf } from './digest'
import { defaultBudgetLimits, tightenBudgetLimits } from './limits'

export interface BudgetServiceDependencies {
  /** Durable ledger + reservations + intents; the atomicity boundary lives here. */
  readonly store: BudgetLedgerStore
  /** Existing durable, monotonic event ledger reused for the budget audit trail. */
  readonly control: ControlRepository
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new BudgetLedgerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new BudgetLedgerError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/**
 * Classify invalid input before it reaches a persistence CHECK constraint, so the
 * caller receives `INVALID_BUDGET_REQUEST` (400) instead of an opaque driver error.
 */
function validateReserveInput(input: BudgetReserveInput): void {
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 256) {
    throw new BudgetLedgerError(
      'INVALID_BUDGET_REQUEST',
      'Idempotency-Key must be between 8 and 256 characters',
    )
  }
  const amounts = [input.toolCalls ?? 1, input.rows ?? 0, input.bytes ?? 0, input.modelTokens ?? 0]
  if (!amounts.every(isNonNegativeInteger)) {
    throw new BudgetLedgerError(
      'INVALID_BUDGET_REQUEST',
      'reservation amounts must be non-negative integers',
    )
  }
  if (input.requestedDeadline !== undefined && Number.isNaN(Date.parse(input.requestedDeadline))) {
    throw new BudgetLedgerError(
      'INVALID_BUDGET_REQUEST',
      'requestedDeadline must be an RFC 3339 timestamp',
    )
  }
}

/**
 * Shared budget ledger service (SPEC D7.2, ADR-14).
 *
 * The service owns the policy: it tightens deployment limits, maps requests onto the
 * pure reservation/settlement plans, refuses a completed settlement that has no
 * persisted evidence, and records reservations/settlements on the existing
 * `ControlRepository` audit ledger. All persistence — and therefore all atomicity
 * under contention — is behind the injected `BudgetLedgerStore` port, so this class
 * never touches a driver.
 */
export class BudgetService implements BudgetLedgerPort {
  readonly #store: BudgetLedgerStore
  readonly #control: ControlRepository
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: BudgetServiceDependencies) {
    this.#store = dependencies.store
    this.#control = dependencies.control
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** One ledger per run or background job. An override may only tighten the base. */
  async openLedger(input: OpenBudgetLedgerInput, ctx: ToolContext): Promise<BudgetLedgerRecord> {
    const scopeRef = scopeOf(ctx)
    const limits = tightenBudgetLimits(defaultBudgetLimits(input.kind), input.overrideLimits ?? {})
    return this.#store.ensureLedger(
      scopeRef,
      {
        ledgerId: input.ledgerId,
        kind: input.kind,
        limits,
        openedAt: this.#now(),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      },
      ctx,
    )
  }

  async reserve(input: BudgetReserveInput, ctx: ToolContext): Promise<AtomicReserveOutcome> {
    const scopeRef = scopeOf(ctx)
    validateReserveInput(input)
    const request: AtomicReserveRequest = {
      ledgerId: input.ledgerId,
      reservationId: this.#newId(),
      idempotencyKey: input.idempotencyKey,
      now: this.#now(),
      consumption: {
        toolCalls: input.toolCalls ?? 1,
        repairAttempts: input.repair === true ? 1 : 0,
        rows: input.rows ?? 0,
        bytes: input.bytes ?? 0,
        modelTokens: input.modelTokens ?? 0,
      },
      parallelTools: input.parallel === true ? 1 : 0,
      requiresIntent: input.requiresIntent === true,
      ...(input.requestedDeadline === undefined
        ? {}
        : { requestedDeadline: input.requestedDeadline }),
    }
    const outcome = await this.#store.reserveAtomic(scopeRef, request, ctx)
    if (outcome.granted && outcome.reservation !== undefined) {
      try {
        await this.#appendAudit(scopeRef, outcome.reservation, 'reserved', ctx)
      } catch (error) {
        await this.#releaseAfterAuditFailure(
          scopeRef,
          outcome.reservation.ledgerId,
          outcome.reservation.reservationId,
          ctx,
        )
        throw error
      }
    }
    return outcome
  }

  async recordIntent(input: RecordIntentInput, ctx: ToolContext): Promise<ToolIntentRecord> {
    const scopeRef = scopeOf(ctx)
    if (input.descriptor.attempt < 1 || input.descriptor.toolId.length === 0) {
      throw new BudgetLedgerError(
        'INVALID_BUDGET_REQUEST',
        'a tool intent requires a tool id and a positive attempt number',
      )
    }
    const result = await this.#store.recordIntent(
      scopeRef,
      {
        intentId: input.intentId,
        ledgerId: input.ledgerId,
        reservationId: input.reservationId,
        callId: input.descriptor.callId,
        toolId: input.descriptor.toolId,
        argumentsDigest: input.descriptor.argumentsDigest,
        attempt: input.descriptor.attempt,
        recordedAt: this.#now(),
        ...(input.retryReason === undefined ? {} : { retryReason: input.retryReason }),
      },
      ctx,
    )
    if (result.duplicateOf !== undefined && (input.retryReason ?? '').length === 0) {
      throw new BudgetLedgerError(
        'NO_PROGRESS',
        'the same tool call with the same normalized arguments already ran; a retry needs an explicit reason',
      )
    }
    return result.intent
  }

  /**
   * Idempotent settlement. A duplicate callback is a no-op and cannot double-count
   * or free allowance twice; a `usage_unknown` hold is only released by a later
   * definitive settlement. A completed result with no persisted evidence is refused
   * and recorded as failed, so it can never be reported as a traceable success.
   */
  async settle(input: BudgetSettlementInput, ctx: ToolContext): Promise<AtomicSettleOutcome> {
    const scopeRef = scopeOf(ctx)
    const now = this.#now()
    if (input.status === 'completed' && input.evidenceRefs.length === 0) {
      const refused: AtomicSettleRequest = {
        ledgerId: input.ledgerId,
        reservationId: input.reservationId,
        now,
        status: 'failed',
        usage: input.usage,
        evidenceRefs: [],
      }
      const outcome = await this.#store.settleAtomic(scopeRef, refused, ctx)
      await this.#appendAudit(scopeRef, outcome.reservation, 'settled', ctx)
      throw new BudgetLedgerError(
        'EVIDENCE_PERSIST_FAILED',
        'a completed call without a persisted evidence reference is not a traceable success',
      )
    }
    const outcome = await this.#store.settleAtomic(
      scopeRef,
      {
        ledgerId: input.ledgerId,
        reservationId: input.reservationId,
        now,
        status: input.status,
        usage: input.usage,
        evidenceRefs: input.evidenceRefs,
      },
      ctx,
    )
    await this.#appendAudit(scopeRef, outcome.reservation, 'settled', ctx)
    return outcome
  }

  async remaining(ledgerId: Uuid, ctx: ToolContext): Promise<BudgetLedgerSnapshot> {
    const scopeRef = scopeOf(ctx)
    const ledger = await this.#store.getLedger(scopeRef, ledgerId, ctx)
    if (ledger === undefined) {
      throw new BudgetLedgerError(
        'LEDGER_NOT_FOUND',
        `ledger ${ledgerId} is not visible in this scope`,
      )
    }
    const active = await this.#store.countActiveParallelTools(scopeRef, ledgerId, this.#now(), ctx)
    return deriveRemaining(ledger, active)
  }

  async #appendAudit(
    scopeRef: ScopeRef,
    reservation: BudgetReservationRecord,
    phase: 'reserved' | 'settled',
    ctx: ToolContext,
  ): Promise<void> {
    const payload = {
      ledgerId: reservation.ledgerId,
      reservationId: reservation.reservationId,
      status: reservation.status,
      toolCalls: reservation.reserved.toolCalls,
      repairAttempts: reservation.reserved.repairAttempts,
      rows: reservation.reserved.rows,
      bytes: reservation.reserved.bytes,
      modelTokens: reservation.reserved.modelTokens,
      usageUnknown: reservation.usageUnknown,
      deadline: reservation.deadline,
    }
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: `budget:${reservation.ledgerId}`,
      payloadDigest: sha256DigestOf(JSON.stringify(payload)),
      idempotencyKey: `budget-${phase}:${reservation.reservationId}:${reservation.status}`,
    }
    try {
      await this.#control.appendEvent(request, ctx)
    } catch (error) {
      throw new BudgetLedgerError(
        'EVIDENCE_PERSIST_FAILED',
        `could not append the budget ${phase} audit event for reservation ${reservation.reservationId}`,
        { cause: error },
      )
    }
  }

  /**
   * Best-effort compensation when the audit append failed after a reservation was
   * granted. The primary audit failure is rethrown by the caller; the reservation is
   * already durable and expires with the ledger deadline even if this also fails.
   */
  async #releaseAfterAuditFailure(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<void> {
    try {
      await this.#store.settleAtomic(
        scopeRef,
        {
          ledgerId,
          reservationId,
          now: this.#now(),
          status: 'failed',
          usage: { durationMs: 0 },
          evidenceRefs: [],
        },
        ctx,
      )
    } catch {
      // keep the primary audit failure
    }
  }
}
