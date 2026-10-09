import type {
  BudgetLedgerPort,
  JobErrorInfo,
  JobKind,
  JobStageCounts,
  JobAttemptRecord,
  JobStore,
  LogicalJobRecord,
  NewOutboxMessage,
  OutboxMessageRecord,
  PipelineStage,
  RevisionString,
  RunnableJobStage,
  Semver,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

export interface CreateJobInput {
  /** Internal host seam; the public ingestion request never accepts this field. */
  readonly initialStage?: 'awaiting_review'
  readonly initialCounts?: JobStageCounts
  /** Pre-allocated id, so the request-scoped trusted context can name the job. */
  readonly jobId: Uuid
  readonly kind: JobKind
  readonly sourceRef: string
  /** The input reference; `documentRef` or `datasetRef` must be present. */
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly pipelineVersion: Semver
  readonly idempotencyKey: string
}

export interface CreateJobResult {
  readonly jobId: Uuid
  readonly stage: PipelineStage
  readonly revision: RevisionString
  readonly reused: boolean
}

export interface RetryJobInput {
  readonly jobId: Uuid
  readonly failedStage: RunnableJobStage
  readonly idempotencyKey: string
  /** `undefined` means the If-Match header was absent and the call is rejected with 428. */
  readonly expectedRevision: RevisionString | undefined
}

/** Public attempt summary. Carries no payload, no secret and no raw customer content. */
export interface JobAttemptView {
  readonly attemptId: Uuid
  readonly attemptNumber: number
  readonly state: JobAttemptRecord['state']
  readonly stage: PipelineStage
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly abandonedReason?: string
  readonly error?: JobErrorInfo
}

export interface JobPublicationView {
  readonly publicationId: Uuid
  readonly versionRef: VersionRef
  readonly publishedAt: string
}

/** `GET /jobs/{id}` payload: stage, counts and errors, with no secret or full payload. */
export interface JobView {
  readonly jobId: Uuid
  readonly kind: JobKind
  readonly stage: PipelineStage
  readonly pipelineVersion: Semver
  readonly sourceRef: string
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly counts: JobStageCounts
  readonly attemptCount: number
  readonly abandonedAttemptCount: number
  readonly revision: RevisionString
  readonly createdAt: string
  readonly updatedAt: string
  readonly nextAttemptAt: string
  readonly failedStage?: PipelineStage
  readonly lastError?: JobErrorInfo
  readonly publication?: JobPublicationView
  readonly attempts: readonly JobAttemptView[]
}

/**
 * What a stage handler returns. The handler owns the domain work and reports the next stage,
 * the updated counts and any side effect that must be committed with the checkpoint. The
 * worker owns persistence, so a handler cannot write the control database directly.
 */
export interface JobStageOutcome {
  readonly nextStage: PipelineStage
  readonly counts: JobStageCounts
  readonly outbox?: NewOutboxMessage
  /** Present when the stage publishes a version; the worker runs the exactly-once publication. */
  readonly publication?: JobPublicationIntent
  /**
   * Present when the stage replaces the logical job's opaque input reference (for example the
   * `received → parsed` stage rewrites the ingestion reference into the structured extraction
   * reference). The worker commits it in the same transaction as the checkpoint.
   */
  readonly documentRef?: string
}

export interface JobPublicationIntent {
  readonly publicationKey: string
  readonly versionRef: VersionRef
  readonly outboxTopic: string
  readonly outboxPayload: Readonly<Record<string, unknown>>
}

export interface JobStageContext {
  readonly job: LogicalJobRecord
  readonly attempt: JobAttemptRecord
  /**
   * Shared budget ledger (kind `background`), separate from the online run ledger, so an
   * ingestion backlog cannot consume or be consumed by an online run's quota (SPEC §9).
   */
  readonly budget: BudgetLedgerPort
  /** The background ledger opened for this job. */
  readonly ledgerId: Uuid
  /** Trusted tool context, so a handler can use injected ports without minting identity. */
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}

export interface JobStageHandler {
  readonly stage: RunnableJobStage
  run(context: JobStageContext): Promise<JobStageOutcome>
}

export interface JobStageHandlerRegistry {
  get(stage: PipelineStage): JobStageHandler | undefined
}

/**
 * Idempotent outbox consumer. The dispatcher guarantees at-least-once delivery, so the
 * consumer must treat `idempotencyKey` as the dedup key (SPEC D6/§8).
 */
export interface OutboxConsumer {
  consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void>
}

export interface JobServiceDependencies {
  readonly store: JobStore
  readonly now?: () => string
  readonly newId?: () => string
}

export interface JobWorkerResult {
  readonly disposition: 'idle' | 'advanced' | 'stopped' | 'failed'
  readonly jobId?: Uuid
  readonly attemptId?: Uuid
  readonly stage?: PipelineStage
  readonly reclaimedAttemptId?: Uuid
}

export type { JobErrorInfo, JobStageCounts, Sha256Digest }
