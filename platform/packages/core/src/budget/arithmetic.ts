import type {
  BudgetConsumption,
  BudgetDenial,
  BudgetLedgerLimits,
  BudgetLedgerRecord,
  BudgetLedgerSnapshot,
  BudgetRemaining,
  BudgetReservationStatus,
  BudgetSettlementStatus,
  Rfc3339UtcTimestamp,
  ToolUsage,
} from '@ontology/contracts'

/**
 * Pure budget arithmetic and state transitions (SPEC D7.2, ADR-14).
 *
 * Everything here is deterministic and free of I/O so the same rules can be unit
 * tested and reused by every adapter. The PostgreSQL store computes its decision
 * from the locked ledger row with these functions, which is what makes a
 * contention-safe reservation possible.
 */

export const MIN_RATE_LIMIT_BACKOFF_MS = 1_000

export function emptyConsumption(): BudgetConsumption {
  return { toolCalls: 0, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0 }
}

export function addConsumption(
  left: BudgetConsumption,
  right: BudgetConsumption,
): BudgetConsumption {
  return {
    toolCalls: left.toolCalls + right.toolCalls,
    repairAttempts: left.repairAttempts + right.repairAttempts,
    rows: left.rows + right.rows,
    bytes: left.bytes + right.bytes,
    modelTokens: left.modelTokens + right.modelTokens,
  }
}

function nonNegative(value: number): number {
  return value < 0 ? 0 : value
}

/** The estimate charged up front for a reservation. */
export interface ReservationRequestAmounts {
  readonly toolCalls: number
  readonly repairAttempts: number
  readonly parallelTools: number
  readonly rows: number
  readonly bytes: number
  readonly modelTokens: number
}

export interface ReservationPlanInput {
  readonly limits: BudgetLedgerLimits
  readonly consumed: BudgetConsumption
  readonly activeParallelTools: number
  readonly ledgerDeadline: Rfc3339UtcTimestamp
  readonly now: Rfc3339UtcTimestamp
  readonly request: ReservationRequestAmounts
  readonly requestedDeadline?: Rfc3339UtcTimestamp
  readonly nextParallelExpiry?: Rfc3339UtcTimestamp
}

export type ReservationPlan =
  | {
      readonly granted: true
      readonly deadline: Rfc3339UtcTimestamp
      readonly expiresAt: Rfc3339UtcTimestamp
      readonly consumption: BudgetConsumption
    }
  | { readonly granted: false; readonly denial: BudgetDenial }

/**
 * A child call may never receive more remaining time than its parent has: the
 * reservation deadline is the earlier of the ledger deadline and the child's own
 * requested deadline. `remaining` therefore shrinks monotonically down the tree
 * instead of resetting to a fresh 120s at every network hop.
 */
export function propagateDeadline(
  parentDeadline: Rfc3339UtcTimestamp,
  requestedDeadline: Rfc3339UtcTimestamp | undefined,
): Rfc3339UtcTimestamp {
  if (requestedDeadline === undefined) return parentDeadline
  return Date.parse(requestedDeadline) < Date.parse(parentDeadline)
    ? requestedDeadline
    : parentDeadline
}

function retryAfterForParallelLimit(
  now: Rfc3339UtcTimestamp,
  nextParallelExpiry: Rfc3339UtcTimestamp | undefined,
): number {
  if (nextParallelExpiry === undefined) return MIN_RATE_LIMIT_BACKOFF_MS
  const remaining = Date.parse(nextParallelExpiry) - Date.parse(now)
  return remaining > MIN_RATE_LIMIT_BACKOFF_MS ? remaining : MIN_RATE_LIMIT_BACKOFF_MS
}

function denial(code: BudgetDenial['code'], message: string, retryAfterMs?: number): ReservationPlan {
  return {
    granted: false,
    denial: retryAfterMs === undefined ? { code, message } : { code, message, retryAfterMs },
  }
}

/**
 * Decide one reservation against the locked ledger. The deadline is checked before
 * the counters, so an expired call never consumes allowance.
 */
export function planReservation(input: ReservationPlanInput): ReservationPlan {
  const { limits, consumed, request } = input

  if (Date.parse(input.now) >= Date.parse(input.ledgerDeadline)) {
    return denial('DEADLINE_EXCEEDED', 'the run deadline has already passed')
  }
  if (consumed.toolCalls + request.toolCalls > limits.maxToolCalls) {
    return denial('BUDGET_EXHAUSTED', 'the data-tool call budget is exhausted')
  }
  if (consumed.repairAttempts + request.repairAttempts > limits.maxRepairAttempts) {
    return denial(
      'BUDGET_EXHAUSTED',
      'the shared re-collection/draft-repair budget is exhausted',
    )
  }
  if (consumed.rows + request.rows > limits.maxRows) {
    return denial('BUDGET_EXHAUSTED', 'the run row budget is exhausted')
  }
  if (consumed.bytes + request.bytes > limits.maxBytes) {
    return denial('BUDGET_EXHAUSTED', 'the run byte budget is exhausted')
  }
  if (
    limits.maxModelTokens !== undefined &&
    consumed.modelTokens + request.modelTokens > limits.maxModelTokens
  ) {
    return denial('BUDGET_EXHAUSTED', 'the run model-token budget is exhausted')
  }
  if (input.activeParallelTools + request.parallelTools > limits.maxParallelTools) {
    return denial(
      'RATE_LIMITED',
      'the parallel-tool limit is reached; retry once an in-flight call finishes',
      retryAfterForParallelLimit(input.now, input.nextParallelExpiry),
    )
  }

  const deadline = propagateDeadline(input.ledgerDeadline, input.requestedDeadline)
  return {
    granted: true,
    deadline,
    expiresAt: deadline,
    consumption: {
      toolCalls: request.toolCalls,
      repairAttempts: request.repairAttempts,
      rows: request.rows,
      bytes: request.bytes,
      modelTokens: request.modelTokens,
    },
  }
}

export interface SettlementPlanInput {
  readonly reservationStatus: BudgetReservationStatus
  readonly reserved: BudgetConsumption
  readonly consumed: BudgetConsumption
  readonly status: BudgetSettlementStatus
  readonly usage: ToolUsage
}

export type SettlementPlan =
  | {
      readonly kind: 'noop'
      readonly status: BudgetReservationStatus
      readonly usageUnknown: boolean
    }
  | {
      readonly kind: 'apply'
      readonly status: BudgetReservationStatus
      readonly usageUnknown: boolean
      readonly actual: BudgetConsumption
      readonly consumed: BudgetConsumption
    }
  | { readonly kind: 'conflict'; readonly message: string }

function reservationStatusFor(
  status: BudgetSettlementStatus,
  usageUnknown: boolean,
): BudgetReservationStatus {
  if (usageUnknown) return 'usage_unknown'
  switch (status) {
    case 'completed':
      return 'settled'
    case 'cancelled':
      return 'abandoned'
    case 'failed':
      return 'failed'
    case 'usage_unknown':
      return 'usage_unknown'
  }
}

function isDefinitiveTerminal(status: BudgetReservationStatus): boolean {
  return status === 'settled' || status === 'failed' || status === 'abandoned'
}

/**
 * Measured usage. Tool calls and repair attempts are never refunded: a failed or
 * cancelled call still consumed its slot. Rows/bytes/tokens are reconciled to what
 * was actually measured, so an over-estimate is released once and only once.
 */
export function consumptionFromUsage(
  usage: ToolUsage,
  reserved: BudgetConsumption,
): BudgetConsumption {
  return {
    toolCalls: usage.calls ?? reserved.toolCalls,
    repairAttempts: reserved.repairAttempts,
    rows: usage.rows ?? 0,
    bytes: usage.bytes ?? 0,
    modelTokens: usage.modelTokens ?? 0,
  }
}

export function reconcileConsumption(
  consumed: BudgetConsumption,
  reserved: BudgetConsumption,
  actual: BudgetConsumption,
): BudgetConsumption {
  return {
    toolCalls: consumed.toolCalls + Math.max(0, actual.toolCalls - reserved.toolCalls),
    repairAttempts:
      consumed.repairAttempts + Math.max(0, actual.repairAttempts - reserved.repairAttempts),
    rows: nonNegative(consumed.rows + (actual.rows - reserved.rows)),
    bytes: nonNegative(consumed.bytes + (actual.bytes - reserved.bytes)),
    modelTokens: nonNegative(consumed.modelTokens + (actual.modelTokens - reserved.modelTokens)),
  }
}

/**
 * Settlement is idempotent: a duplicate callback is a no-op. A `usage_unknown`
 * reservation is held until reconciliation; a later definitive settlement is the
 * only thing allowed to release the held allowance. Contradictory terminals are a
 * conflict, never a silent overwrite.
 */
export function planSettlement(input: SettlementPlanInput): SettlementPlan {
  const usageUnknown = input.status === 'usage_unknown' || input.usage.usageUnknown === true

  if (isDefinitiveTerminal(input.reservationStatus)) {
    if (usageUnknown) {
      return {
        kind: 'conflict',
        message: `reservation is already ${input.reservationStatus} and cannot become usage_unknown`,
      }
    }
    return { kind: 'noop', status: input.reservationStatus, usageUnknown: false }
  }

  if (input.reservationStatus === 'usage_unknown') {
    if (usageUnknown) {
      return { kind: 'noop', status: 'usage_unknown', usageUnknown: true }
    }
    const actual = consumptionFromUsage(input.usage, input.reserved)
    return {
      kind: 'apply',
      status: reservationStatusFor(input.status, false),
      usageUnknown: false,
      actual,
      consumed: reconcileConsumption(input.consumed, input.reserved, actual),
    }
  }

  if (usageUnknown) {
    // The remote may have been billed: conservatively hold the full estimate and
    // never release it as free allowance.
    return {
      kind: 'apply',
      status: 'usage_unknown',
      usageUnknown: true,
      actual: input.reserved,
      consumed: input.consumed,
    }
  }

  const actual = consumptionFromUsage(input.usage, input.reserved)
  return {
    kind: 'apply',
    status: reservationStatusFor(input.status, false),
    usageUnknown: false,
    actual,
    consumed: reconcileConsumption(input.consumed, input.reserved, actual),
  }
}

export function deriveRemaining(
  ledger: BudgetLedgerRecord,
  activeParallelTools: number,
): BudgetLedgerSnapshot {
  const { limits, consumed } = ledger
  const remaining: BudgetRemaining = {
    deadline: ledger.deadline,
    toolCallsRemaining: nonNegative(limits.maxToolCalls - consumed.toolCalls),
    repairAttemptsRemaining: nonNegative(limits.maxRepairAttempts - consumed.repairAttempts),
    parallelToolLimit: limits.maxParallelTools,
    ...(limits.maxModelTokens === undefined
      ? {}
      : { tokensRemaining: nonNegative(limits.maxModelTokens - consumed.modelTokens) }),
  }
  return {
    ledgerId: ledger.ledgerId,
    kind: ledger.kind,
    deadline: ledger.deadline,
    remaining,
    rowsRemaining: nonNegative(limits.maxRows - consumed.rows),
    bytesRemaining: nonNegative(limits.maxBytes - consumed.bytes),
    parallelToolsRemaining: nonNegative(limits.maxParallelTools - activeParallelTools),
  }
}
