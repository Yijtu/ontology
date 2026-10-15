import { JobStoreError, isToolContext } from '@ontology/contracts'
import type {
  JobAttemptRecord,
  JobStore,
  LogicalJobRecord,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { JobServiceError } from './errors'
import type { JobServiceErrorCode } from './errors'
import { isRetryableStage } from './state-machine'
import type {
  CreateJobInput,
  CreateJobResult,
  JobAttemptView,
  JobServiceDependencies,
  JobView,
  RetryJobInput,
} from './types'

const EDITOR_ROLES: readonly string[] = ['data-editor', 'platform-admin']
const READER_ROLES: readonly string[] = ['scoped-reader', 'operator', 'platform-admin']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new JobServiceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new JobServiceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new JobServiceError('FORBIDDEN', 'only a data-editor may manage ingestion jobs')
}

function assertJobReader(job: LogicalJobRecord, ctx: ToolContext): void {
  if (job.createdBy === ctx.principal.subjectId) return
  if (READER_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new JobServiceError('FORBIDDEN', 'only the job creator or a scoped reader may read this job')
}

function toAttemptView(attempt: JobAttemptRecord): JobAttemptView {
  return {
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    stage: attempt.stage,
    ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
    ...(attempt.abandonedReason === undefined ? {} : { abandonedReason: attempt.abandonedReason }),
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
  }
}

function toView(job: LogicalJobRecord, attempts: readonly JobAttemptRecord[]): JobView {
  return {
    jobId: job.jobId,
    kind: job.kind,
    stage: job.stage,
    pipelineVersion: job.pipelineVersion,
    sourceRef: job.sourceRef,
    ...(job.documentRef === undefined ? {} : { documentRef: job.documentRef }),
    ...(job.datasetRef === undefined ? {} : { datasetRef: job.datasetRef }),
    counts: job.counts,
    attemptCount: job.attemptCount,
    abandonedAttemptCount: job.abandonedAttemptCount,
    revision: job.revision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt,
    ...(job.failedStage === undefined ? {} : { failedStage: job.failedStage }),
    ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
    ...(job.publication === undefined ? {} : { publication: job.publication }),
    attempts: [...attempts]
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map(toAttemptView),
  }
}

function mapStoreError(error: unknown): never {
  if (error instanceof JobStoreError) {
    const code: JobServiceErrorCode =
      error.code === 'REVISION_CONFLICT' ||
      error.code === 'STAGE_CONFLICT' ||
      error.code === 'PUBLICATION_CONFLICT' ||
      error.code === 'LEASE_LOST'
        ? 'VERSION_CONFLICT'
        : error.code
    throw new JobServiceError(code, error.message, { cause: error })
  }
  throw error
}

/**
 * The durable job service (C6/D6). It owns logical-job identity, the idempotency key (which
 * covers the input **and** the pipeline version), optimistic concurrency and the queryable
 * stage/counts/error view. It holds no database driver and no worker loop: the store arrives
 * by construction injection and the worker lives in `apps/worker`.
 */
export class JobService {
  readonly #store: JobStore
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: JobServiceDependencies) {
    this.#store = dependencies.store
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Create (or reuse) a logical ingestion job. The `Idempotency-Key` is required; the same
   * key with the same input/pipeline version returns the same logical job, while the same key
   * with a different payload or pipeline version is `IDEMPOTENCY_CONFLICT` (409), never an
   * overwrite. A different key with the same content also reuses the logical job, so the
   * identity is content-derived.
   */
  async createJob(input: CreateJobInput, ctx: ToolContext): Promise<CreateJobResult> {
    if (input.initialStage !== undefined && input.initialStage !== 'awaiting_review' || input.initialCounts !== undefined && input.initialStage === undefined ||
        input.initialCounts !== undefined && (Object.keys(input.initialCounts).some((key) => !['total','processed','failed','skipped'].includes(key)) || [input.initialCounts.total,input.initialCounts.processed,input.initialCounts.failed,input.initialCounts.skipped].some((count) => !Number.isSafeInteger(count) || count < 0 || count > 20_000) || input.initialCounts.processed + input.initialCounts.failed + input.initialCounts.skipped > input.initialCounts.total)) throw new JobServiceError('INVALID_ARGUMENT', 'the trusted manual source handoff requires bounded actual parsed counts and an awaiting-review stage')
    const scopeRef = scopeOf(ctx)
    assertEditor(ctx)
    if (
      !isNonEmptyString(input.idempotencyKey) ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 256
    ) {
      throw new JobServiceError(
        'INVALID_ARGUMENT',
        'Idempotency-Key must be a string between 8 and 256 characters',
      )
    }
    if (!isNonEmptyString(input.jobId)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'jobId must be a non-empty uuid')
    }
    if (!isNonEmptyString(input.sourceRef)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'sourceRef must be a non-empty string')
    }
    if (input.documentRef === undefined && input.datasetRef === undefined) {
      throw new JobServiceError(
        'INVALID_ARGUMENT',
        'one of documentRef or datasetRef must be a non-empty string',
      )
    }
    if (input.documentRef !== undefined && !isNonEmptyString(input.documentRef)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'documentRef must be a non-empty string')
    }
    if (input.datasetRef !== undefined && !isNonEmptyString(input.datasetRef)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'datasetRef must be a non-empty string')
    }
    if (!isNonEmptyString(input.pipelineVersion)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'pipelineVersion must be a non-empty string')
    }

    const inputDigest = this.#inputDigest(input)
    const existing = await this.#store.findJobByIdempotencyKey(scopeRef, input.idempotencyKey, ctx)
    if (existing !== undefined) {
      if (existing.inputDigest !== inputDigest) {
        throw new JobServiceError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload or pipeline version',
        )
      }
      return { jobId: existing.jobId, stage: existing.stage, revision: existing.revision, reused: true }
    }

    const createdAt = this.#now()
    let inserted
    try {
      inserted = await this.#store.insertJob(
        scopeRef,
        {
          jobId: input.jobId,
          kind: input.kind,
          ...(input.initialStage === undefined ? {} : { initialStage: input.initialStage }),
          sourceRef: input.sourceRef,
          ...(input.documentRef === undefined ? {} : { documentRef: input.documentRef }),
          ...(input.datasetRef === undefined ? {} : { datasetRef: input.datasetRef }),
          pipelineVersion: input.pipelineVersion,
          idempotencyKey: input.idempotencyKey,
          inputDigest,
          counts: input.initialCounts ?? { total: 0, processed: 0, failed: 0, skipped: 0 },
          createdAt,
          createdBy: ctx.principal.subjectId,
        },
        ctx,
      )
    } catch (error) {
      mapStoreError(error)
    }

    if (!inserted.inserted) {
      // A concurrent insert (or the same content under another key) won. Same digest means the
      // same logical job; anything else is a conflict, never an overwrite.
      if (inserted.job.inputDigest !== inputDigest) {
        throw new JobServiceError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload or pipeline version',
        )
      }
      return {
        jobId: inserted.job.jobId,
        stage: inserted.job.stage,
        revision: inserted.job.revision,
        reused: true,
      }
    }
    return {
      jobId: inserted.job.jobId,
      stage: inserted.job.stage,
      revision: inserted.job.revision,
      reused: false,
    }
  }

  /** `GET /jobs/{id}`: stage, counts and classified errors, never a secret or full payload. */
  async getJob(jobId: Uuid, ctx: ToolContext): Promise<JobView> {
    const scopeRef = scopeOf(ctx)
    const job = await this.#requireJob(scopeRef, jobId, ctx)
    assertJobReader(job, ctx)
    const attempts = await this.#store.listAttempts(scopeRef, jobId, ctx)
    return toView(job, attempts)
  }

  /**
   * `POST /jobs/{id}/retry`: the same logical job gets a **new attempt** at `failedStage`.
   * The If-Match revision is required, the retry key makes the call idempotent, and a job
   * that is not failed (for example one still in `awaiting_review`) is refused.
   */
  async retryJob(input: RetryJobInput, ctx: ToolContext): Promise<JobView> {
    const scopeRef = scopeOf(ctx)
    assertEditor(ctx)
    const job = await this.#requireJob(scopeRef, input.jobId, ctx)
    if (
      !isNonEmptyString(input.idempotencyKey) ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 256
    ) {
      throw new JobServiceError(
        'INVALID_ARGUMENT',
        'Idempotency-Key must be a string between 8 and 256 characters',
      )
    }
    if (!isRetryableStage(input.failedStage)) {
      throw new JobServiceError('INVALID_ARGUMENT', 'failedStage must be a runnable pipeline stage')
    }
    if (input.expectedRevision === undefined) {
      throw new JobServiceError('REVISION_REQUIRED', 'this update requires an If-Match expected revision')
    }

    // The store checks the retry key before the revision and stage, so replaying a retry is
    // idempotent even after the job advanced; a fresh retry on a non-failed job is refused.
    let updated: LogicalJobRecord
    try {
      updated = await this.#store.retryJob(
        scopeRef,
        job.jobId,
        input.expectedRevision,
        {
          failedStage: input.failedStage,
          idempotencyKey: input.idempotencyKey,
          attemptId: this.#newId(),
          requestedAt: this.#now(),
        },
        ctx,
      )
    } catch (error) {
      mapStoreError(error)
    }
    const attempts = await this.#store.listAttempts(scopeRef, job.jobId, ctx)
    return toView(updated, attempts)
  }

  async #requireJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    let job: LogicalJobRecord | undefined
    try {
      job = await this.#store.getJob(scopeRef, jobId, ctx)
    } catch (error) {
      mapStoreError(error)
    }
    if (job === undefined) {
      throw new JobServiceError('JOB_NOT_FOUND', `job ${jobId} is not visible in this scope`)
    }
    return job
  }

  #inputDigest(input: CreateJobInput): RevisionString {
    return sha256DigestOf(
      canonicalJson({
        kind: input.kind,
        sourceRef: input.sourceRef,
        documentRef: input.documentRef,
        datasetRef: input.datasetRef ?? null,
        pipelineVersion: input.pipelineVersion,
        ...(input.initialStage === undefined ? {} : { initialStage: input.initialStage, initialCounts: input.initialCounts ?? { total: 0, processed: 0, failed: 0, skipped: 0 } }),
      }),
    )
  }
}
