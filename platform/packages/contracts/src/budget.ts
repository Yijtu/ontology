import type {
  BudgetRemaining,
  ByteSize,
  DurationMs,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  ToolUsage,
  Uuid,
} from './generated/contracts'
import { ERROR_CATALOG } from './generated/error-catalogue'
import type { ToolContext } from './trusted'

/**
 * Shared budget ledger (SPEC D7.2, ADR-14, C4/C6.2).
 *
 * One run has exactly one ledger. Retries, parallel calls, re-collection and draft
 * repair all draw from the same monotonic counters and can never reset them. A
 * background/import job has its own ledger of a different `kind`, so an ingestion
 * backlog cannot starve an online question or borrow from its quota.
 *
 * This module only defines the port, the persisted record shapes and the classified
 * failure. The pure arithmetic lives in `@ontology/core` and the PostgreSQL
 * implementation in `@ontology/adapter-control-postgres`.
 */

/** A run ledger and a background/import ledger are limited independently (D7.2). */
export type BudgetLedgerKind = 'run' | 'background'

/** Lifecycle of one atomic reservation. Terminal statuses are idempotent. */
export type BudgetReservationStatus =
  | 'reserved'
  | 'running'
  | 'settled'
  | 'failed'
  | 'abandoned'
  | 'usage_unknown'

/** How a reservation is closed. `usage_unknown` keeps the reserved amount held. */
export type BudgetSettlementStatus = 'completed' | 'failed' | 'cancelled' | 'usage_unknown'

/** Reasons a call is refused before it executes (reserve denial or intent no-progress). */
export type BudgetDenialCode =
  | 'BUDGET_EXHAUSTED'
  | 'DEADLINE_EXCEEDED'
  | 'RATE_LIMITED'
  | 'NO_PROGRESS'

/** Consumption in the units the run budget is expressed in (SPEC §9). */
export interface BudgetConsumption {
  readonly toolCalls: number
  readonly repairAttempts: number
  readonly rows: number
  readonly bytes: ByteSize
  readonly modelTokens: number
}

/**
 * Adjustable initial budget (SPEC §9). Scenarios and deployments may tighten these
 * values; a model may never loosen them, so an override is always intersected with
 * the deployment base by `tightenBudgetLimits` in `@ontology/core`.
 */
export interface BudgetLedgerLimits {
  readonly maxToolCalls: number
  readonly maxRepairAttempts: number
  readonly maxParallelTools: number
  readonly maxRows: number
  readonly maxBytes: ByteSize
  readonly maxModelTokens?: number
  readonly deadlineMs: DurationMs
}

/** Persisted ledger state. `consumed` is monotonic apart from settlement reconciliation. */
export interface BudgetLedgerRecord {
  readonly ledgerId: Uuid
  readonly kind: BudgetLedgerKind
  readonly limits: BudgetLedgerLimits
  readonly deadline: Rfc3339UtcTimestamp
  readonly consumed: BudgetConsumption
  readonly revision: RevisionString
  readonly createdAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly runId?: Uuid
}

export interface NewBudgetLedger {
  readonly ledgerId: Uuid
  readonly kind: BudgetLedgerKind
  readonly limits: BudgetLedgerLimits
  readonly openedAt: Rfc3339UtcTimestamp
  readonly runId?: Uuid
}

/** Identity of the model-proposed call an intent describes. */
export interface BudgetIntentDescriptor {
  readonly callId: Uuid
  readonly toolId: string
  readonly argumentsDigest: Sha256Digest
  readonly attempt: number
}

/** Intent persisted before the call executes (SPEC §8, C4). */
export interface NewToolIntent extends BudgetIntentDescriptor {
  readonly intentId: Uuid
  readonly ledgerId: Uuid
  readonly reservationId: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly retryReason?: string
}

export type ToolIntentRecord = NewToolIntent

/**
 * Atomic reservation written before a call executes. `reserved` is the estimate that
 * was charged up front; `actual` is filled in at settlement. `expiresAt` is the
 * propagated deadline the child call must honour.
 */
export interface BudgetReservationRecord {
  readonly reservationId: Uuid
  readonly ledgerId: Uuid
  readonly idempotencyKey: string
  readonly status: BudgetReservationStatus
  readonly intentRequired: boolean
  readonly reserved: BudgetConsumption
  readonly parallelTools: number
  readonly usageUnknown: boolean
  readonly evidenceRefs: readonly ResourceRef[]
  readonly deadline: Rfc3339UtcTimestamp
  readonly grantedAt: Rfc3339UtcTimestamp
  readonly expiresAt: Rfc3339UtcTimestamp
  readonly settledAt?: Rfc3339UtcTimestamp
  /**
   * Measured usage after settlement. For `usage_unknown` this is the conservatively
   * held estimate (the remote may have been billed), not a measured zero.
   */
  readonly actual?: BudgetConsumption
  readonly runId?: Uuid
}

/** What the caller may still spend. `remaining` is the runtime-visible projection. */
export interface BudgetLedgerSnapshot {
  readonly ledgerId: Uuid
  readonly kind: BudgetLedgerKind
  readonly deadline: Rfc3339UtcTimestamp
  readonly remaining: BudgetRemaining
  readonly rowsRemaining: number
  readonly bytesRemaining: ByteSize
  readonly parallelToolsRemaining: number
}

/** Explicit refusal. A denied reservation never touched the counters. */
export interface BudgetDenial {
  readonly code: BudgetDenialCode
  readonly message: string
  readonly retryAfterMs?: DurationMs
}

export interface AtomicReserveRequest {
  readonly ledgerId: Uuid
  readonly reservationId: Uuid
  readonly idempotencyKey: string
  readonly now: Rfc3339UtcTimestamp
  readonly consumption: BudgetConsumption
  readonly parallelTools: number
  readonly requiresIntent: boolean
  readonly requestedDeadline?: Rfc3339UtcTimestamp
}

export interface AtomicReserveOutcome {
  readonly granted: boolean
  readonly remaining: BudgetLedgerSnapshot
  readonly reservation?: BudgetReservationRecord
  readonly denial?: BudgetDenial
}

export interface AtomicSettleRequest {
  readonly ledgerId: Uuid
  readonly reservationId: Uuid
  readonly now: Rfc3339UtcTimestamp
  readonly status: BudgetSettlementStatus
  readonly usage: ToolUsage
  readonly evidenceRefs: readonly ResourceRef[]
}

export interface AtomicSettleOutcome {
  readonly reservation: BudgetReservationRecord
  /** `false` when the settlement was an idempotent no-op. */
  readonly applied: boolean
  readonly remaining: BudgetLedgerSnapshot
}

export interface IntentRecordResult {
  readonly intent: ToolIntentRecord
  /** Set when the same tool + normalized arguments already ran in this ledger. */
  readonly duplicateOf?: Uuid
}

/**
 * Persistence port for the shared budget ledger. Implementations MUST make
 * `reserveAtomic` and `settleAtomic` atomic under contention: the decision is
 * computed from the locked ledger row and the counters are updated in the same
 * transaction, so parallel requests for the last allowance cannot oversubscribe.
 */
export interface BudgetLedgerStore {
  ensureLedger(
    scopeRef: ScopeRef,
    ledger: NewBudgetLedger,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord>
  getLedger(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetLedgerRecord | undefined>
  reserveAtomic(
    scopeRef: ScopeRef,
    request: AtomicReserveRequest,
    ctx: ToolContext,
  ): Promise<AtomicReserveOutcome>
  recordIntent(
    scopeRef: ScopeRef,
    intent: NewToolIntent,
    ctx: ToolContext,
  ): Promise<IntentRecordResult>
  findIntent(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<ToolIntentRecord | undefined>
  settleAtomic(
    scopeRef: ScopeRef,
    request: AtomicSettleRequest,
    ctx: ToolContext,
  ): Promise<AtomicSettleOutcome>
  getReservation(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    reservationId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord | undefined>
  listReservations(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord[]>
  listIntents(scopeRef: ScopeRef, ledgerId: Uuid, ctx: ToolContext): Promise<ToolIntentRecord[]>
  /** In-flight parallel tools: non-terminal, non-expired reservations with a slot. */
  countActiveParallelTools(
    scopeRef: ScopeRef,
    ledgerId: Uuid,
    now: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<number>
}

export interface OpenBudgetLedgerInput {
  readonly ledgerId: Uuid
  readonly kind: BudgetLedgerKind
  readonly overrideLimits?: Partial<BudgetLedgerLimits>
  readonly runId?: Uuid
}

export interface BudgetReserveInput {
  readonly ledgerId: Uuid
  readonly idempotencyKey: string
  readonly toolCalls?: number
  readonly repair?: boolean
  readonly parallel?: boolean
  readonly rows?: number
  readonly bytes?: ByteSize
  readonly modelTokens?: number
  readonly requestedDeadline?: Rfc3339UtcTimestamp
  readonly requiresIntent?: boolean
}

export interface RecordIntentInput {
  readonly ledgerId: Uuid
  readonly reservationId: Uuid
  readonly intentId: Uuid
  readonly descriptor: BudgetIntentDescriptor
  readonly retryReason?: string
}

export interface BudgetSettlementInput {
  readonly ledgerId: Uuid
  readonly reservationId: Uuid
  readonly status: BudgetSettlementStatus
  readonly usage: ToolUsage
  readonly evidenceRefs: readonly ResourceRef[]
}

/**
 * Service port the tool gateway (LOCAL-011) and the controller depend on. Every
 * method takes the trusted ToolContext; scope is never read from the request.
 */
export interface BudgetLedgerPort {
  openLedger(input: OpenBudgetLedgerInput, ctx: ToolContext): Promise<BudgetLedgerRecord>
  reserve(input: BudgetReserveInput, ctx: ToolContext): Promise<AtomicReserveOutcome>
  recordIntent(input: RecordIntentInput, ctx: ToolContext): Promise<ToolIntentRecord>
  settle(input: BudgetSettlementInput, ctx: ToolContext): Promise<AtomicSettleOutcome>
  remaining(ledgerId: Uuid, ctx: ToolContext): Promise<BudgetLedgerSnapshot>
}

export type BudgetLedgerErrorCode =
  | BudgetDenialCode
  | 'EVIDENCE_PERSIST_FAILED'
  | 'INTENT_NOT_RECORDED'
  | 'RESERVATION_NOT_FOUND'
  | 'LEDGER_NOT_FOUND'
  | 'SCOPE_MISMATCH'
  | 'SETTLEMENT_CONFLICT'
  | 'INVALID_BUDGET_REQUEST'

const EXTRA_HTTP_STATUS: Readonly<Record<string, number>> = {
  EVIDENCE_PERSIST_FAILED: 500,
  INTENT_NOT_RECORDED: 409,
  RESERVATION_NOT_FOUND: 404,
  LEDGER_NOT_FOUND: 404,
  SCOPE_MISMATCH: 403,
  SETTLEMENT_CONFLICT: 409,
  INVALID_BUDGET_REQUEST: 400,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

/** Reuse the canonical catalogue mapping; only add codes the catalogue lacks. */
export function httpStatusForBudgetError(code: BudgetLedgerErrorCode): number {
  const status = CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
  if (status === undefined) {
    throw new Error(`no HTTP status is mapped for budget error ${code}`)
  }
  return status
}

export interface BudgetLedgerErrorOptions extends ErrorOptions {
  readonly retryAfterMs?: DurationMs
}

/**
 * Classified budget failure. A denial code (BUDGET_EXHAUSTED/DEADLINE_EXCEEDED/
 * RATE_LIMITED/NO_PROGRESS) keeps the catalogue's HTTP status (C6.2) so the API
 * layer never re-derives a mapping, and never becomes an empty success.
 */
export class BudgetLedgerError extends Error {
  readonly code: BudgetLedgerErrorCode
  readonly httpStatus: number
  readonly retryAfterMs: DurationMs | undefined

  constructor(code: BudgetLedgerErrorCode, message: string, options?: BudgetLedgerErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BudgetLedgerError'
    this.code = code
    this.httpStatus = httpStatusForBudgetError(code)
    this.retryAfterMs = options?.retryAfterMs
  }
}

export function isBudgetLedgerError(value: unknown): value is BudgetLedgerError {
  return value instanceof BudgetLedgerError
}
