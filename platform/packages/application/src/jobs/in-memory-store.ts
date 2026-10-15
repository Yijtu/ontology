import { JobStoreError, isToolContext } from '@ontology/contracts'
import type {
  JobAttemptCompletion,
  JobAttemptFailure,
  JobAttemptRecord,
  JobInsertResult,
  JobLease,
  JobLeaseRenewal,
  JobLeaseRequest,
  JobPublicationRequest,
  JobPublicationResult,
  JobRetryRequest,
  JobStageAdvance,
  JobStore,
  LogicalJobRecord,
  NewLogicalJobRecord,
  NewOutboxMessage,
  OutboxMessageRecord,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canAdvanceJobStage, isRetryableStage } from './state-machine'

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new JobStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new JobStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new JobStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

type StoredJob = { -readonly [Key in keyof LogicalJobRecord]: LogicalJobRecord[Key] }
type StoredAttempt = { -readonly [Key in keyof JobAttemptRecord]: JobAttemptRecord[Key] }
type StoredOutbox = { -readonly [Key in keyof OutboxMessageRecord]: OutboxMessageRecord[Key] }

function isLive(attempt: JobAttemptRecord): boolean {
  return attempt.state === 'leased' || attempt.state === 'running'
}

function isActive(attempt: JobAttemptRecord): boolean {
  return attempt.state === 'pending' || isLive(attempt)
}

/**
 * Reference implementation of the job store for unit tests and local composition. It enforces
 * the same invariants as the database implementation — tenant/space scoping, content-derived
 * idempotency, atomic lease claims, idempotent stage checkpoints, exactly-once publication and
 * an at-least-once outbox — so the service and worker are exercised against the real rules
 * rather than a permissive fake.
 */
export class InMemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, StoredJob>()
  readonly #idempotency = new Map<string, string>()
  readonly #inputDigest = new Map<string, string>()
  readonly #attempts = new Map<string, StoredAttempt[]>()
  readonly #checkpoints = new Map<string, Set<string>>()
  readonly #publications = new Map<string, Map<string, JobPublicationResult['publication']>>()
  readonly #outbox = new Map<string, StoredOutbox>()
  readonly #outboxIdempotency = new Map<string, string>()

  async findJobByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const jobKey = this.#idempotency.get(`${scopePrefix(scopeRef)}${idempotencyKey}`)
    if (jobKey === undefined) return undefined
    const job = this.#jobs.get(jobKey)
    return job === undefined ? undefined : clone(job)
  }

  async insertJob(
    scopeRef: ScopeRef,
    record: NewLogicalJobRecord,
    ctx: ToolContext,
  ): Promise<JobInsertResult> {
    if (record.initialStage !== undefined && record.initialStage !== 'awaiting_review') throw new JobStoreError('STAGE_CONFLICT', 'the manual source handoff may only wait for actual human review')
    resolveStoreScope(scopeRef, ctx)
    const idempotencySlot = `${scopePrefix(scopeRef)}${record.idempotencyKey}`
    const existingByKey = this.#idempotency.get(idempotencySlot)
    if (existingByKey !== undefined) {
      const existing = this.#requireStored(existingByKey)
      if (existing.inputDigest !== record.inputDigest) {
        throw new JobStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload or pipeline version',
        )
      }
      return { job: clone(existing), inserted: false }
    }
    const digestSlot = `${scopePrefix(scopeRef)}${record.inputDigest}`
    const existingByDigest = this.#inputDigest.get(digestSlot)
    if (existingByDigest !== undefined) {
      // Same content under a different key: the logical job identity is content-derived.
      return { job: clone(this.#requireStored(existingByDigest)), inserted: false }
    }
    const key = `${scopePrefix(scopeRef)}${record.jobId}`
    if (this.#jobs.has(key)) {
      throw new JobStoreError('REVISION_CONFLICT', `job ${record.jobId} already exists`)
    }
    const job: StoredJob = {
      ...clone(record),
      stage: record.initialStage ?? 'received',
      revision: '1',
      attemptCount: 0,
      abandonedAttemptCount: 0,
      nextAttemptAt: record.createdAt,
      updatedAt: record.createdAt,
    }
    this.#jobs.set(key, job)
    this.#idempotency.set(idempotencySlot, key)
    this.#inputDigest.set(digestSlot, key)
    return { job: clone(job), inserted: true }
  }

  async getJob(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<LogicalJobRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#jobs.get(`${scopePrefix(scopeRef)}${jobId}`)
    return job === undefined ? undefined : clone(job)
  }

  async listAttempts(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<JobAttemptRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    return (this.#attempts.get(`${scopePrefix(scopeRef)}${jobId}`) ?? []).map(clone)
  }

  async getAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const attempt = (this.#attempts.get(`${scopePrefix(scopeRef)}${jobId}`) ?? []).find(
      (candidate) => candidate.attemptId === attemptId,
    )
    return attempt === undefined ? undefined : clone(attempt)
  }

  async acquireLease(
    scopeRef: ScopeRef,
    request: JobLeaseRequest,
    ctx: ToolContext,
  ): Promise<JobLease | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const candidates = [...this.#jobs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, job]) => job)
      .filter((job) => request.jobId === undefined || job.jobId === request.jobId)
      .filter((job) => this.#isClaimable(job, prefix, request.now))
      .sort((left, right) => {
        if (left.nextAttemptAt !== right.nextAttemptAt) return left.nextAttemptAt < right.nextAttemptAt ? -1 : 1
        return left.createdAt < right.createdAt ? -1 : 1
      })
    const job = candidates[0]
    if (job === undefined) return undefined

    const key = `${prefix}${job.jobId}`
    const attempts = this.#attempts.get(key) ?? []
    const expired = attempts.find((attempt) => isLive(attempt) && (attempt.leaseExpiresAt ?? '') < request.now)
    let reclaimedAttemptId: Uuid | undefined
    if (expired !== undefined) {
      expired.state = 'abandoned'
      expired.abandonedReason = 'lease expired'
      expired.finishedAt = request.now
      job.abandonedAttemptCount += 1
      reclaimedAttemptId = expired.attemptId
    }

    const pending = attempts.find((attempt) => attempt.state === 'pending')
    const leaseExpiresAt = new Date(Date.parse(request.now) + request.leaseDurationMs).toISOString()
    let attempt: JobAttemptRecord
    if (pending !== undefined) {
      pending.state = 'leased'
      pending.workerId = request.workerId
      pending.leaseExpiresAt = leaseExpiresAt
      if (pending.startedAt === undefined) pending.startedAt = request.now
      attempt = pending
    } else {
      const attemptNumber = job.attemptCount + 1
      attempt = {
        attemptId: globalThis.crypto.randomUUID(),
        jobId: job.jobId,
        attemptNumber,
        state: 'leased',
        stage: job.stage,
        workerId: request.workerId,
        leaseExpiresAt,
        startedAt: request.now,
      }
      attempts.push(attempt)
      job.attemptCount = attemptNumber
    }
    this.#attempts.set(key, attempts)
    job.nextAttemptAt = leaseExpiresAt
    job.revision = String(Number(job.revision) + 1)
    job.updatedAt = request.now
    return {
      job: clone(job),
      attempt: clone(attempt),
      ...(reclaimedAttemptId === undefined ? {} : { reclaimedAttemptId }),
    }
  }

  async renewLease(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    renewal: JobLeaseRenewal,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord> {
    resolveStoreScope(scopeRef, ctx)
    const attempt = this.#requireAttempt(scopeRef, jobId, attemptId)
    if (!isLive(attempt) || attempt.workerId !== renewal.workerId) {
      throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not held by ${renewal.workerId}`)
    }
    attempt.leaseExpiresAt = new Date(Date.parse(renewal.now) + renewal.leaseDurationMs).toISOString()
    attempt.state = 'running'
    return clone(attempt)
  }

  async advanceStage(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    advance: JobStageAdvance,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    const attempt = this.#requireAttempt(scopeRef, jobId, attemptId)
    if (!isLive(attempt)) {
      throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
    }
    const checkpointKey = `${scopePrefix(scopeRef)}${jobId}`
    const stages = this.#checkpoints.get(checkpointKey) ?? new Set<string>()
    if (stages.has(advance.stage)) {
      // Idempotent checkpoint: the stage was already committed by an earlier attempt.
      return clone(job)
    }
    if (!canAdvanceJobStage(job.stage, advance.stage)) {
      throw new JobStoreError(
        'STAGE_CONFLICT',
        `job ${jobId} cannot advance from ${job.stage} to ${advance.stage}`,
      )
    }
    stages.add(advance.stage)
    this.#checkpoints.set(checkpointKey, stages)
    job.stage = advance.stage
    job.counts = clone(advance.counts)
    if (advance.documentRef !== undefined) job.documentRef = advance.documentRef
    job.revision = String(Number(job.revision) + 1)
    job.updatedAt = advance.completedAt
    attempt.stage = advance.stage
    attempt.state = 'running'
    if (advance.outbox !== undefined) this.#insertOutbox(scopeRef, jobId, advance.outbox)
    return clone(job)
  }

  async completeAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    completion: JobAttemptCompletion,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    const attempt = this.#requireAttempt(scopeRef, jobId, attemptId)
    if (attempt.state === 'succeeded') return clone(job)
    if (!isLive(attempt)) {
      throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
    }
    attempt.state = 'succeeded'
    attempt.finishedAt = completion.completedAt
    delete attempt.leaseExpiresAt
    if (completion.finalStage !== job.stage) {
      if (!canAdvanceJobStage(job.stage, completion.finalStage)) {
        throw new JobStoreError(
          'STAGE_CONFLICT',
          `job ${jobId} cannot advance from ${job.stage} to ${completion.finalStage}`,
        )
      }
      job.stage = completion.finalStage
      job.revision = String(Number(job.revision) + 1)
      job.updatedAt = completion.completedAt
    }
    return clone(job)
  }

  async failAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    failure: JobAttemptFailure,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    const attempt = this.#requireAttempt(scopeRef, jobId, attemptId)
    if (attempt.state === 'failed') return clone(job)
    if (!isLive(attempt)) {
      throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
    }
    attempt.state = 'failed'
    attempt.error = clone(failure.error)
    attempt.finishedAt = failure.failedAt
    delete attempt.leaseExpiresAt
    job.stage = 'failed'
    job.failedStage = attempt.stage
    job.lastError = clone(failure.error)
    job.revision = String(Number(job.revision) + 1)
    job.updatedAt = failure.failedAt
    return clone(job)
  }

  async retryJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    expectedRevision: RevisionString,
    request: JobRetryRequest,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    const attempts = this.#attempts.get(`${scopePrefix(scopeRef)}${jobId}`) ?? []
    const replayed = attempts.find((attempt) => attempt.idempotencyKey === request.idempotencyKey)
    if (replayed !== undefined) {
      // Replayed retry: return the existing job without creating a second attempt.
      return clone(job)
    }
    if (job.revision !== expectedRevision) {
      throw new JobStoreError(
        'REVISION_CONFLICT',
        `job ${jobId} revision ${job.revision} does not match ${expectedRevision}`,
      )
    }
    if (job.stage !== 'failed' || !isRetryableStage(request.failedStage)) {
      throw new JobStoreError('STAGE_CONFLICT', `job ${jobId} is not failed at a retryable stage`)
    }
    if (job.failedStage !== undefined && job.failedStage !== request.failedStage) {
      throw new JobStoreError(
        'STAGE_CONFLICT',
        `job ${jobId} failed at ${job.failedStage}, not ${request.failedStage}`,
      )
    }
    const attemptNumber = job.attemptCount + 1
    attempts.push({
      attemptId: request.attemptId,
      jobId,
      attemptNumber,
      state: 'pending',
      stage: request.failedStage,
      idempotencyKey: request.idempotencyKey,
    })
    this.#attempts.set(`${scopePrefix(scopeRef)}${jobId}`, attempts)
    job.stage = request.failedStage
    job.attemptCount = attemptNumber
    job.nextAttemptAt = request.requestedAt
    job.revision = String(Number(job.revision) + 1)
    job.updatedAt = request.requestedAt
    delete job.failedStage
    delete job.lastError
    return clone(job)
  }

  async publishJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    request: JobPublicationRequest,
    ctx: ToolContext,
  ): Promise<JobPublicationResult> {
    resolveStoreScope(scopeRef, ctx)
    const job = this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    const publicationKey = `${scopePrefix(scopeRef)}${jobId}`
    const publications = this.#publications.get(publicationKey) ?? new Map()
    const existing = publications.get(request.publicationKey)
    if (existing !== undefined) {
      if (existing.versionRef.digest !== request.versionRef.digest) {
        throw new JobStoreError(
          'PUBLICATION_CONFLICT',
          `publication ${request.publicationKey} already exists with a different version digest`,
        )
      }
      return { publication: clone(existing), created: false, job: clone(job) }
    }
    const publication = {
      publicationId: request.publicationId,
      versionRef: clone(request.versionRef),
      publishedAt: request.publishedAt,
    }
    publications.set(request.publicationKey, publication)
    this.#publications.set(publicationKey, publications)
    job.publication = clone(publication)
    job.stage = 'published'
    job.revision = String(Number(job.revision) + 1)
    job.updatedAt = request.publishedAt
    this.#insertOutbox(scopeRef, jobId, request.outbox)
    return { publication: clone(publication), created: true, job: clone(job) }
  }

  async appendOutbox(
    scopeRef: ScopeRef,
    jobId: Uuid,
    message: NewOutboxMessage,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord> {
    resolveStoreScope(scopeRef, ctx)
    this.#requireStored(`${scopePrefix(scopeRef)}${jobId}`)
    this.#insertOutbox(scopeRef, jobId, message)
    const outboxId =
      this.#outboxIdempotency.get(`${scopePrefix(scopeRef)}${message.idempotencyKey}`) ??
      message.outboxId
    const record = this.#outbox.get(`${scopePrefix(scopeRef)}${outboxId}`)
    if (record === undefined) {
      throw new JobStoreError('JOB_NOT_FOUND', `outbox message ${message.outboxId} was not appended`)
    }
    return clone(record)
  }

  async listPendingOutbox(
    scopeRef: ScopeRef,
    limit: number,
    now: string,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    return [...this.#outbox.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, message]) => message)
      .filter((message) => message.state === 'pending' && message.availableAt <= now)
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(clone)
  }

  async markOutboxDispatched(
    scopeRef: ScopeRef,
    outboxId: Uuid,
    dispatchedAt: string,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${outboxId}`
    const message = this.#outbox.get(key)
    if (message === undefined) {
      throw new JobStoreError('JOB_NOT_FOUND', `outbox message ${outboxId} does not exist`)
    }
    if (message.state === 'dispatched') return clone(message)
    message.state = 'dispatched'
    message.dispatchedAt = dispatchedAt
    message.attempts += 1
    return clone(message)
  }

  #isClaimable(job: StoredJob, prefix: string, now: string): boolean {
    const attempts = this.#attempts.get(`${prefix}${job.jobId}`) ?? []
    if (attempts.some((attempt) => attempt.state === 'pending')) return true
    if (attempts.some((attempt) => isLive(attempt) && (attempt.leaseExpiresAt ?? '') < now)) return true
    if (job.stage !== 'received' && job.stage !== 'parsed' && job.stage !== 'extracted' && job.stage !== 'validated') {
      return false
    }
    if (attempts.some(isActive)) return false
    return job.nextAttemptAt <= now
  }

  #insertOutbox(scopeRef: ScopeRef, jobId: Uuid, message: NewOutboxMessage): void {
    const idempotencySlot = `${scopePrefix(scopeRef)}${message.idempotencyKey}`
    if (this.#outboxIdempotency.has(idempotencySlot)) return
    const record: StoredOutbox = {
      ...clone(message),
      jobId,
      state: 'pending',
      attempts: 0,
    }
    this.#outbox.set(`${scopePrefix(scopeRef)}${message.outboxId}`, record)
    this.#outboxIdempotency.set(idempotencySlot, message.outboxId)
  }

  #requireStored(key: string): StoredJob {
    const job = this.#jobs.get(key)
    if (job === undefined) throw new JobStoreError('JOB_NOT_FOUND', 'the job does not exist')
    return job
  }

  #requireAttempt(scopeRef: ScopeRef, jobId: Uuid, attemptId: Uuid): StoredAttempt {
    const attempt = (this.#attempts.get(`${scopePrefix(scopeRef)}${jobId}`) ?? []).find(
      (candidate) => candidate.attemptId === attemptId,
    )
    if (attempt === undefined) {
      throw new JobStoreError('ATTEMPT_NOT_FOUND', `attempt ${attemptId} does not exist`)
    }
    return attempt
  }
}
