import type {
  BudgetConsumption,
  BudgetDenial,
  BudgetLedgerLimits,
  BudgetLedgerRecord,
  BudgetLedgerSnapshot,
  BudgetRemaining,
  BudgetReservationStatus,
  BudgetSettlementStatus,
  ResearchUsageDimensions,
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

/** The research dimensions a consumption record always carries, at zero when unused. */
export const ZERO_RESEARCH_DIMENSIONS: ResearchUsageDimensions = {
  searches: 0,
  modelRounds: 0,
  sources: 0,
  candidates: 0,
  downloadBytes: 0,
  readBytes: 0,
}

/**
 * Dimensions whose consumption is never refunded: a search/model round/source/candidate
 * that happened stays charged even if the call is reconciled to a smaller measured value.
 * The byte dimensions reconcile (an over-estimate is released once) like rows/bytes.
 */
export const MONOTONIC_RESEARCH_DIMENSIONS: readonly (keyof ResearchUsageDimensions)[] = [
  'searches',
  'modelRounds',
  'sources',
  'candidates',
]

export function emptyConsumption(): BudgetConsumption {
  return { toolCalls: 0, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0, ...ZERO_RESEARCH_DIMENSIONS }
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
    searches: left.searches + right.searches,
    modelRounds: left.modelRounds + right.modelRounds,
    sources: left.sources + right.sources,
    candidates: left.candidates + right.candidates,
    downloadBytes: left.downloadBytes + right.downloadBytes,
    readBytes: left.readBytes + right.readBytes,
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
  readonly searches: number
  readonly modelRounds: number
  readonly sources: number
  readonly candidates: number
  readonly downloadBytes: number
  readonly readBytes: number
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
  if (limits.maxSearches !== undefined && consumed.searches + request.searches > limits.maxSearches) {
    return denial('BUDGET_EXHAUSTED', 'the research search budget is exhausted')
  }
  if (
    limits.maxModelRounds !== undefined &&
    consumed.modelRounds + request.modelRounds > limits.maxModelRounds
  ) {
    return denial('BUDGET_EXHAUSTED', 'the research model-round budget is exhausted')
  }
  if (limits.maxSources !== undefined && consumed.sources + request.sources > limits.maxSources) {
    return denial('BUDGET_EXHAUSTED', 'the research source budget is exhausted')
  }
  if (
    limits.maxCandidates !== undefined &&
    consumed.candidates + request.candidates > limits.maxCandidates
  ) {
    return denial('BUDGET_EXHAUSTED', 'the research candidate budget is exhausted')
  }
  if (
    limits.maxDownloadBytes !== undefined &&
    consumed.downloadBytes + request.downloadBytes > limits.maxDownloadBytes
  ) {
    return denial('BUDGET_EXHAUSTED', 'the research download-byte budget is exhausted')
  }
  if (
    limits.maxReadBytes !== undefined &&
    consumed.readBytes + request.readBytes > limits.maxReadBytes
  ) {
    return denial('BUDGET_EXHAUSTED', 'the research read-byte budget is exhausted')
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
      searches: request.searches,
      modelRounds: request.modelRounds,
      sources: request.sources,
      candidates: request.candidates,
      downloadBytes: request.downloadBytes,
      readBytes: request.readBytes,
    },
  }
}

export interface SettlementPlanInput {
  readonly reservationStatus: BudgetReservationStatus
  readonly reserved: BudgetConsumption
  readonly consumed: BudgetConsumption
  readonly status: BudgetSettlementStatus
  readonly usage: ToolUsage
  /** Measured research dimensions; `ToolUsage` cannot carry them. */
  readonly measured?: Partial<ResearchUsageDimensions>
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
  measured?: Partial<ResearchUsageDimensions>,
): BudgetConsumption {
  const count = (dimension: keyof ResearchUsageDimensions): number =>
    measured?.[dimension] ?? reserved[dimension]
  const bytesOf = (dimension: keyof ResearchUsageDimensions): number => measured?.[dimension] ?? 0
  return {
    toolCalls: usage.calls ?? reserved.toolCalls,
    repairAttempts: reserved.repairAttempts,
    rows: usage.rows ?? 0,
    bytes: usage.bytes ?? 0,
    modelTokens: usage.modelTokens ?? 0,
    searches: count('searches'),
    modelRounds: count('modelRounds'),
    sources: count('sources'),
    candidates: count('candidates'),
    downloadBytes: bytesOf('downloadBytes'),
    readBytes: bytesOf('readBytes'),
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
    // A search/model round/source/candidate is monotonic: it was spent and is never
    // refunded, so an under-measurement cannot free the reservation.
    searches: consumed.searches + Math.max(0, actual.searches - reserved.searches),
    modelRounds: consumed.modelRounds + Math.max(0, actual.modelRounds - reserved.modelRounds),
    sources: consumed.sources + Math.max(0, actual.sources - reserved.sources),
    candidates: consumed.candidates + Math.max(0, actual.candidates - reserved.candidates),
    downloadBytes: nonNegative(consumed.downloadBytes + (actual.downloadBytes - reserved.downloadBytes)),
    readBytes: nonNegative(consumed.readBytes + (actual.readBytes - reserved.readBytes)),
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
    const actual = consumptionFromUsage(input.usage, input.reserved, input.measured)
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

  const actual = consumptionFromUsage(input.usage, input.reserved, input.measured)
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
    ...(limits.maxSearches === undefined
      ? {}
      : { searchesRemaining: nonNegative(limits.maxSearches - consumed.searches) }),
    ...(limits.maxModelRounds === undefined
      ? {}
      : { modelRoundsRemaining: nonNegative(limits.maxModelRounds - consumed.modelRounds) }),
    ...(limits.maxSources === undefined
      ? {}
      : { sourcesRemaining: nonNegative(limits.maxSources - consumed.sources) }),
    ...(limits.maxCandidates === undefined
      ? {}
      : { candidatesRemaining: nonNegative(limits.maxCandidates - consumed.candidates) }),
    ...(limits.maxDownloadBytes === undefined
      ? {}
      : { downloadBytesRemaining: nonNegative(limits.maxDownloadBytes - consumed.downloadBytes) }),
    ...(limits.maxReadBytes === undefined
      ? {}
      : { readBytesRemaining: nonNegative(limits.maxReadBytes - consumed.readBytes) }),
  }
}
