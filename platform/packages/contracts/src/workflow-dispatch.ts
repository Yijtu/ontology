import type { RevisionString, Rfc3339UtcTimestamp, Sha256Digest, Uuid } from './generated/contracts'
import type { ToolContext } from './trusted'

/** The only durable background action currently admitted by the Core host. */
export type WorkflowDispatchActionKind = 'drive_run'

export type WorkflowDispatchState = 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'

/** The worker reloads the canonical run through RunService; no request body is duplicated here. */
export interface WorkflowDispatchPayload {
  readonly runId: Uuid
}

/** Immutable enqueue identity. The store computes and persists payloadDigest. */
export interface NewWorkflowDispatch {
  readonly runId: Uuid
  /** Stable per logical drive; a resume/clarification drive uses a distinct value. */
  readonly logicalActionId: string
}

export interface WorkflowDispatchRecord {
  readonly dispatchId: Uuid
  readonly runId: Uuid
  readonly actionKind: WorkflowDispatchActionKind
  readonly logicalActionId: string
  readonly payload: WorkflowDispatchPayload
  readonly payloadDigest: Sha256Digest
  readonly state: WorkflowDispatchState
  /** Monotonic lease-claim count. The first claim is "1". */
  readonly attempt: RevisionString
  /** Monotonic revision used for every CAS transition. */
  readonly revision: RevisionString
  readonly availableAt: Rfc3339UtcTimestamp
  readonly createdAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly leaseOwnerId?: Uuid
  readonly leaseExpiresAt?: Rfc3339UtcTimestamp
  readonly failureCode?: string
}

export interface WorkflowDispatchLease extends WorkflowDispatchRecord {
  readonly state: 'leased'
  readonly leaseOwnerId: Uuid
  readonly leaseExpiresAt: Rfc3339UtcTimestamp
}

export interface WorkflowDispatchClaimRequest {
  readonly ownerId: Uuid
  readonly leaseDurationMs: number
}

/** The complete fence returned by claim/renew; every worker mutation must echo all fields. */
export interface WorkflowDispatchFence {
  readonly dispatchId: Uuid
  readonly ownerId: Uuid
  readonly attempt: RevisionString
  readonly expectedRevision: RevisionString
}

export interface WorkflowDispatchRenewal extends WorkflowDispatchFence {
  readonly leaseDurationMs: number
}

export interface WorkflowDispatchFailure extends WorkflowDispatchFence {
  /** A bounded machine-readable code only; payloads and provider error messages are not stored. */
  readonly failureCode: string
}

export interface WorkflowDispatchCancelRequest {
  readonly dispatchId: Uuid
  readonly expectedRevision: RevisionString
}

export type WorkflowDispatchErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'DISPATCH_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'LEASE_LOST'
  | 'INVALID_ARGUMENT'
  | 'CORRUPT_RECORD'

export class WorkflowDispatchError extends Error {
  readonly code: WorkflowDispatchErrorCode

  constructor(code: WorkflowDispatchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkflowDispatchError'
    this.code = code
  }
}

/**
 * Durable execution ownership for one logical controller drive. The scope comes only from
 * the host-minted ToolContext; the Postgres adapter applies the same tenant/space in RLS.
 * Reusing `(runId, logicalActionId)` returns the existing record and never opens a budget
 * ledger. Distinct resumes of one run must use distinct logicalActionIds.
 *
 * Claiming is atomic. Expired leases are reclaimed with a new attempt and revision. Worker
 * operations require the latest unexpired lease fence; `cancel` is a trusted host CAS that
 * can revoke a pending or leased action and invalidate its old fence. This port does not
 * publish answers or recover the RunService/dispatch commit gap: the host must re-check the
 * run's cancellation state and current lease before publishing a result.
 */
export interface WorkflowDispatchPort {
  enqueue(input: NewWorkflowDispatch, ctx: ToolContext): Promise<WorkflowDispatchRecord>
  get(dispatchId: Uuid, ctx: ToolContext): Promise<WorkflowDispatchRecord | undefined>
  claimNext(
    request: WorkflowDispatchClaimRequest,
    ctx: ToolContext,
  ): Promise<WorkflowDispatchLease | undefined>
  renew(request: WorkflowDispatchRenewal, ctx: ToolContext): Promise<WorkflowDispatchLease>
  complete(fence: WorkflowDispatchFence, ctx: ToolContext): Promise<WorkflowDispatchRecord>
  fail(request: WorkflowDispatchFailure, ctx: ToolContext): Promise<WorkflowDispatchRecord>
  cancel(
    request: WorkflowDispatchCancelRequest,
    ctx: ToolContext,
  ): Promise<WorkflowDispatchRecord>
}
