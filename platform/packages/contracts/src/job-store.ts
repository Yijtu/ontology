import type {
  ErrorCode,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Durable background jobs: logical jobs, attempts, leases, stage checkpoints, exactly-once
 * publication and a transactional outbox (SPEC D6/C6, US-009/US-011, FR-10/11/13).
 *
 * Two records are deliberately separate:
 *
 * - the **logical job** carries the stable identity — tenant/space, source/document version,
 *   pipeline version — its current pipeline stage, queryable counts and its last classified
 *   error. It survives retries and crash recovery.
 * - each **attempt** is one execution with its own id, lease, worker and outcome. A retry
 *   creates a *new attempt of the same logical job*, never a new logical job.
 *
 * The idempotency key includes the input **and** the pipeline version: the same key with the
 * same input/pipeline reuses the logical job, while the same key with a different input or
 * pipeline version is an `IDEMPOTENCY_CONFLICT` (never an overwrite).
 *
 * The port lives next to `RunStore`/`SourceStore` so an adapter implements it while depending
 * on `contracts` alone (SPEC §2: adapters → contracts). The application layer receives it by
 * construction injection and never imports an adapter or driver.
 */

/** D6 pipeline: `received → parsed → extracted → validated → awaiting_review → published`. */
export type PipelineStage =
  | 'received'
  | 'parsed'
  | 'extracted'
  | 'validated'
  | 'awaiting_review'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'rejected'

/** Stages a worker is allowed to claim and advance without a human decision. */
export const RUNNABLE_JOB_STAGES = ['received', 'parsed', 'extracted', 'validated'] as const
export type RunnableJobStage = (typeof RUNNABLE_JOB_STAGES)[number]

/** Stages where a worker stops: the job is waiting on a human or is already terminal. */
export const STOP_JOB_STAGES = ['awaiting_review', 'published', 'failed', 'cancelled', 'rejected'] as const
export type StopJobStage = (typeof STOP_JOB_STAGES)[number]

export function isRunnableJobStage(stage: PipelineStage): stage is RunnableJobStage {
  return (RUNNABLE_JOB_STAGES as readonly PipelineStage[]).includes(stage)
}

export function isStopJobStage(stage: PipelineStage): stage is StopJobStage {
  return (STOP_JOB_STAGES as readonly PipelineStage[]).includes(stage)
}

const NEXT_STAGE: Readonly<Partial<Record<PipelineStage, PipelineStage>>> = {
  received: 'parsed',
  parsed: 'extracted',
  extracted: 'validated',
  validated: 'awaiting_review',
  awaiting_review: 'published',
}

export function nextPipelineStage(stage: PipelineStage): PipelineStage | undefined {
  return NEXT_STAGE[stage]
}

/**
 * True when `from → to` is a legal advance. Re-applying the same stage is allowed and treated
 * as an idempotent checkpoint. `validated → awaiting_review` is the worker stop,
 * `awaiting_review → published` is the human-approved publication step, and
 * `→ failed/cancelled/rejected` is allowed from every non-terminal stage. A terminal job can
 * never be advanced again, which is what stops a human-pending or failed job from being
 * re-run forever.
 */
export function canAdvanceJobStage(from: PipelineStage, to: PipelineStage): boolean {
  if (from === to) return true
  if (isTerminalJobStage(from)) return false
  if (to === 'failed' || to === 'cancelled' || to === 'rejected') return true
  return NEXT_STAGE[from] === to
}

/** Only a failed runnable stage can be retried. */
export function isRetryableStage(stage: PipelineStage): stage is RunnableJobStage {
  return (RUNNABLE_JOB_STAGES as readonly PipelineStage[]).includes(stage)
}

export function isTerminalJobStage(stage: PipelineStage): boolean {
  return stage === 'published' || stage === 'failed' || stage === 'cancelled' || stage === 'rejected'
}

export type JobKind = 'ingestion' | 'simulation' | 'dataset_materialization'

/**
 * Attempt lifecycle. `pending` is a retry that was requested but not yet leased; `leased`
 * and `running` are live; `abandoned` means the lease expired (a crashed worker) and the
 * attempt can be reclaimed by a new attempt.
 */
export type JobAttemptState =
  | 'pending'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'abandoned'

export type OutboxState = 'pending' | 'dispatched'

/**
 * Queryable stage progress. `total` is the unit count the stage observed (may grow as more
 * pages are processed), `processed` the successfully handled count, `failed` the error count
 * and `skipped` the explicitly unprocessed count. Unprocessed items are never counted as
 * processed (SPEC D6: 未处理项不计完成).
 */
export interface JobStageCounts {
  readonly total: number
  readonly processed: number
  readonly failed: number
  readonly skipped: number
}

export const EMPTY_JOB_COUNTS: JobStageCounts = { total: 0, processed: 0, failed: 0, skipped: 0 }

/**
 * Classified, secret-scrubbed job error. `message` must already be safe to return: no secret
 * value and no full customer payload (SPEC §8). The stage keeps the checkpoint that failed.
 */
export interface JobErrorInfo {
  readonly code: ErrorCode
  readonly stage: PipelineStage
  readonly message: string
  readonly retryable: boolean
  readonly occurredAt: Rfc3339UtcTimestamp
}

export interface NewLogicalJobRecord {
  readonly jobId: Uuid
  readonly kind: JobKind
  readonly sourceRef: string
  /** The input reference; `documentRef` or `datasetRef` must be present. */
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly pipelineVersion: Semver
  readonly idempotencyKey: string
  /** Content digest of the input **and** the pipeline version; the logical identity. */
  readonly inputDigest: Sha256Digest
  readonly counts: JobStageCounts
  readonly createdAt: Rfc3339UtcTimestamp
  readonly createdBy: string
}

export interface JobPublicationRef {
  readonly publicationId: Uuid
  readonly versionRef: VersionRef
  readonly publishedAt: Rfc3339UtcTimestamp
}

export interface LogicalJobRecord extends NewLogicalJobRecord {
  readonly stage: PipelineStage
  readonly revision: RevisionString
  readonly attemptCount: number
  readonly abandonedAttemptCount: number
  readonly failedStage?: PipelineStage
  readonly lastError?: JobErrorInfo
  readonly nextAttemptAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly publication?: JobPublicationRef
}

export interface JobAttemptRecord {
  readonly attemptId: Uuid
  readonly jobId: Uuid
  readonly attemptNumber: number
  readonly state: JobAttemptState
  /** The stage this attempt is currently executing (or failed at). */
  readonly stage: PipelineStage
  readonly workerId?: string
  readonly leaseExpiresAt?: Rfc3339UtcTimestamp
  readonly startedAt?: Rfc3339UtcTimestamp
  readonly finishedAt?: Rfc3339UtcTimestamp
  readonly abandonedReason?: string
  readonly error?: JobErrorInfo
  /** Retry idempotency key, when the attempt was created by `POST /jobs/{id}/retry`. */
  readonly idempotencyKey?: string
}

export interface NewOutboxMessage {
  readonly outboxId: Uuid
  readonly topic: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly idempotencyKey: string
  readonly availableAt: Rfc3339UtcTimestamp
  readonly createdAt: Rfc3339UtcTimestamp
}

export interface OutboxMessageRecord extends NewOutboxMessage {
  readonly jobId: Uuid
  readonly state: OutboxState
  readonly attempts: number
  readonly dispatchedAt?: Rfc3339UtcTimestamp
}

export interface JobInsertResult {
  readonly job: LogicalJobRecord
  readonly inserted: boolean
}

export interface JobLeaseRequest {
  readonly workerId: string
  readonly now: Rfc3339UtcTimestamp
  readonly leaseDurationMs: number
  /** Restrict the claim to one job (used by tests and targeted recovery). */
  readonly jobId?: Uuid
}

export interface JobLease {
  readonly job: LogicalJobRecord
  readonly attempt: JobAttemptRecord
  /** Set when this claim abandoned an expired attempt of the same logical job. */
  readonly reclaimedAttemptId?: Uuid
}

export interface JobLeaseRenewal {
  readonly workerId: string
  readonly now: Rfc3339UtcTimestamp
  readonly leaseDurationMs: number
}

/**
 * One idempotent stage checkpoint. `outbox` is written in the same transaction as the stage
 * change, so a committed state change always has its side effect enqueued (SPEC D6/§8).
 */
export interface JobStageAdvance {
  readonly stage: PipelineStage
  readonly counts: JobStageCounts
  readonly completedAt: Rfc3339UtcTimestamp
  readonly outbox?: NewOutboxMessage
  /**
   * Optional replacement for the logical job's opaque input reference, committed in the same
   * transaction as the stage checkpoint. The `received → parsed` stage uses it to replace the
   * ingestion reference with the structured extraction reference, so downstream stages resolve
   * the parse from the job record without re-parsing and without a second source of truth. It
   * is additive: a stage that does not set it leaves `documentRef` untouched, and an already
   * committed checkpoint never rewrites it again.
   */
  readonly documentRef?: string
}

export interface JobAttemptCompletion {
  readonly finalStage: PipelineStage
  readonly completedAt: Rfc3339UtcTimestamp
}

export interface JobAttemptFailure {
  readonly error: JobErrorInfo
  readonly failedAt: Rfc3339UtcTimestamp
}

export interface JobRetryRequest {
  readonly failedStage: RunnableJobStage
  readonly idempotencyKey: string
  readonly attemptId: Uuid
  readonly requestedAt: Rfc3339UtcTimestamp
}

/**
 * Exactly-once publication. `publicationKey` is unique inside the logical job, so a re-run
 * after a crash inserts nothing and reports `created: false`. The `outbox` row is written in
 * the same transaction as the publication, so a crash between commit and dispatch still
 * delivers.
 */
export interface JobPublicationRequest {
  readonly publicationId: Uuid
  readonly publicationKey: string
  readonly versionRef: VersionRef
  readonly publishedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
}

export interface JobPublicationResult {
  readonly publication: JobPublicationRef
  readonly created: boolean
  readonly job: LogicalJobRecord
}

/** C6 wire shapes for the job endpoints. Identity is established by the server. */
export interface CreateJobResponse {
  readonly jobId: Uuid
  readonly stage: PipelineStage
  readonly jobUrl: string
}

export interface RetryJobResponse {
  readonly jobId: Uuid
  readonly stage: PipelineStage
  readonly attemptCount: number
}

export type JobStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'JOB_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'PUBLICATION_CONFLICT'
  | 'STAGE_CONFLICT'
  | 'LEASE_LOST'

export class JobStoreError extends Error {
  readonly code: JobStoreErrorCode

  constructor(code: JobStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JobStoreError'
    this.code = code
  }
}

/**
 * Control persistence for durable jobs (D6). Every method runs inside the trusted
 * tenant/space scope; RLS is a second layer behind the application filter. Leases are
 * claimed atomically (`FOR UPDATE SKIP LOCKED`), stage checkpoints are idempotent per stage,
 * publication is exactly-once per key and the outbox is at-least-once.
 */
export interface JobStore {
  findJobByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord | undefined>
  /**
   * Insert a logical job. Reusing the same `idempotencyKey` with the same `inputDigest`
   * returns the existing job; a different digest raises `IDEMPOTENCY_CONFLICT`. A different
   * idempotency key with the same `inputDigest` also returns the existing logical job, so the
   * logical identity is content-derived and stable.
   */
  insertJob(
    scopeRef: ScopeRef,
    record: NewLogicalJobRecord,
    ctx: ToolContext,
  ): Promise<JobInsertResult>
  getJob(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<LogicalJobRecord | undefined>
  listAttempts(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<JobAttemptRecord[]>
  getAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord | undefined>
  /**
   * Atomically claim one unit of work: a pending retry attempt, an expired live attempt
   * (which is first marked `abandoned`), or a runnable job with no live attempt. Returns
   * `undefined` when there is nothing to do, so a job in `awaiting_review` is never re-run
   * by the reclaimer.
   */
  acquireLease(
    scopeRef: ScopeRef,
    request: JobLeaseRequest,
    ctx: ToolContext,
  ): Promise<JobLease | undefined>
  renewLease(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    renewal: JobLeaseRenewal,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord>
  /**
   * Idempotent stage checkpoint: records `(job, stage)` at most once, updates the job stage
   * and counts and enqueues any outbox message in the same transaction. Re-applying the same
   * stage is a no-op, so a crash before the attempt is finalised cannot double-apply.
   */
  advanceStage(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    advance: JobStageAdvance,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord>
  /** Mark the attempt succeeded and set the job's final stop stage. Idempotent. */
  completeAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    completion: JobAttemptCompletion,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord>
  /** Mark the attempt and the logical job failed. Never auto-retried; an explicit retry is required. */
  failAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    failure: JobAttemptFailure,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord>
  /**
   * Create a new attempt of the same logical job starting at `failedStage`. Idempotent on the
   * retry key: replaying the same retry returns the existing job without a second attempt.
   */
  retryJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    expectedRevision: RevisionString,
    request: JobRetryRequest,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord>
  /** Exactly-once publication plus its outbox message, committed in one transaction. */
  publishJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    request: JobPublicationRequest,
    ctx: ToolContext,
  ): Promise<JobPublicationResult>
  /**
   * Append one side-effect message to an existing logical job's outbox without a stage
   * advance. A consumer that must hand a follow-up change back to the worker (for example the
   * semantic materialisation request emitted after a publication) uses this instead of
   * inventing a second outbox table. The `(tenant, space, idempotency_key)` unique key makes a
   * replayed append a no-op, so an at-least-once producer never enqueues the same side effect
   * twice; the returned record is the existing message on replay.
   */
  appendOutbox(
    scopeRef: ScopeRef,
    jobId: Uuid,
    message: NewOutboxMessage,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord>
  listPendingOutbox(
    scopeRef: ScopeRef,
    limit: number,
    now: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord[]>
  /** Mark a message dispatched. Re-marking an already-dispatched message is a harmless no-op. */
  markOutboxDispatched(
    scopeRef: ScopeRef,
    outboxId: Uuid,
    dispatchedAt: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord>
}
