import { RunStoreError, isToolContext } from '@ontology/contracts'
import type {
  AbandonedAttemptRecord,
  ClarificationResponseRecord,
  NewRunRecord,
  QuestionRewrite,
  RevisionString,
  RunEventInput,
  RunEventRecord,
  RunInsertResult,
  RunRecord,
  RunStateUpdate,
  RunStore,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new RunStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new RunStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new RunStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return { tenantId, spaceId }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function runKey(scopeRef: ScopeRef, runId: string): string {
  return `${scopePrefix(scopeRef)}${runId}`
}

function childKey(scopeRef: ScopeRef, runId: string, id: string): string {
  return `${runKey(scopeRef, runId)}\u0000${id}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Mutable mirror of `RunRecord` so the reference store can compare-and-set in place. */
type StoredRun = { -readonly [Key in keyof RunRecord]: RunRecord[Key] }

/**
 * Reference implementation of the run store for unit tests and local composition. It
 * enforces the same invariants as the database implementation — tenant/space scoping,
 * idempotent creation, compare-and-set revisions, ordered events, private checkpoints — so
 * the service is exercised against the real rules rather than a permissive fake.
 */
export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, StoredRun>()
  readonly #idempotency = new Map<string, string>()
  readonly #events = new Map<string, RunEventRecord[]>()
  readonly #eventKeys = new Map<string, string>()
  readonly #checkpoints = new Map<string, RuntimeCheckpointRecord>()
  readonly #clarifications = new Map<string, ClarificationResponseRecord>()
  readonly #abandoned = new Map<string, AbandonedAttemptRecord>()

  async findRunByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<RunRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const storedKey = this.#idempotency.get(`${scopePrefix(scopeRef)}${idempotencyKey}`)
    if (storedKey === undefined) return undefined
    const run = this.#runs.get(storedKey)
    return run === undefined ? undefined : clone(run)
  }

  async insertRun(
    scopeRef: ScopeRef,
    record: NewRunRecord,
    ctx: ToolContext,
  ): Promise<RunInsertResult> {
    resolveStoreScope(scopeRef, ctx)
    const idempotencySlot = `${scopePrefix(scopeRef)}${record.idempotencyKey}`
    const existingKey = this.#idempotency.get(idempotencySlot)
    if (existingKey !== undefined) {
      const existing = this.#runs.get(existingKey)
      if (existing === undefined) {
        throw new RunStoreError('RUN_NOT_FOUND', 'the idempotency claim references a missing run')
      }
      if (existing.requestDigest !== record.requestDigest) {
        throw new RunStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload',
        )
      }
      return { run: clone(existing), inserted: false }
    }
    const key = runKey(scopeRef, record.runId)
    if (this.#runs.has(key)) {
      throw new RunStoreError('REVISION_CONFLICT', `run ${record.runId} already exists`)
    }
    const run: StoredRun = {
      ...clone(record),
      state: 'created',
      revision: '1',
      updatedAt: record.createdAt,
    }
    this.#runs.set(key, run)
    this.#idempotency.set(idempotencySlot, key)
    return { run: clone(run), inserted: true }
  }

  async getRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<RunRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const run = this.#runs.get(runKey(scopeRef, runId))
    return run === undefined ? undefined : clone(run)
  }

  async compareAndSetRunState(
    scopeRef: ScopeRef,
    runId: Uuid,
    expectedRevision: RevisionString,
    update: RunStateUpdate,
    ctx: ToolContext,
  ): Promise<RunRecord> {
    resolveStoreScope(scopeRef, ctx)
    const key = runKey(scopeRef, runId)
    const run = this.#runs.get(key)
    if (run === undefined) {
      throw new RunStoreError('RUN_NOT_FOUND', `run ${runId} does not exist`)
    }
    if (run.revision !== expectedRevision) {
      throw new RunStoreError(
        'REVISION_CONFLICT',
        `run ${runId} revision ${run.revision} does not match ${expectedRevision}`,
      )
    }
    const next: StoredRun = {
      ...run,
      state: update.state,
      revision: String(Number(run.revision) + 1),
      updatedAt: update.updatedAt,
    }
    if (update.cancelReason !== null) next.cancelReason = update.cancelReason
    if (update.cancelledAt !== null) next.cancelledAt = update.cancelledAt
    if (update.pendingClarificationId === null) delete next.pendingClarificationId
    else if (update.pendingClarificationId !== undefined) {
      next.pendingClarificationId = update.pendingClarificationId
    }
    this.#runs.set(key, next)
    return clone(next)
  }

  async appendRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    event: RunEventInput,
    ctx: ToolContext,
  ): Promise<RunEventRecord> {
    resolveStoreScope(scopeRef, ctx)
    const idempotencySlot = childKey(scopeRef, runId, event.idempotencyKey)
    const existingId = this.#eventKeys.get(idempotencySlot)
    if (existingId !== undefined) {
      const found = (this.#events.get(runKey(scopeRef, runId)) ?? []).find(
        (candidate) => candidate.eventId === existingId,
      )
      if (found !== undefined) return clone(found)
    }
    const record: RunEventRecord = { ...clone(event), runId }
    const key = runKey(scopeRef, runId)
    const list = this.#events.get(key) ?? []
    list.push(record)
    list.sort((left, right) => Number(left.sequence) - Number(right.sequence))
    this.#events.set(key, list)
    this.#eventKeys.set(idempotencySlot, event.eventId)
    return clone(record)
  }

  async findRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    eventId: Uuid,
    ctx: ToolContext,
  ): Promise<RunEventRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const found = (this.#events.get(runKey(scopeRef, runId)) ?? []).find(
      (event) => event.eventId === eventId,
    )
    return found === undefined ? undefined : clone(found)
  }

  async listRunEvents(
    scopeRef: ScopeRef,
    runId: Uuid,
    afterSequence: RevisionString | undefined,
    ctx: ToolContext,
  ): Promise<RunEventRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const list = this.#events.get(runKey(scopeRef, runId)) ?? []
    const filtered =
      afterSequence === undefined
        ? list
        : list.filter((event) => Number(event.sequence) > Number(afterSequence))
    return filtered.map((event) => clone(event))
  }

  async recordQuestionRewrite(
    scopeRef: ScopeRef,
    runId: Uuid,
    rewrite: QuestionRewrite,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = runKey(scopeRef, runId)
    const run = this.#runs.get(key)
    if (run === undefined) {
      throw new RunStoreError('RUN_NOT_FOUND', `run ${runId} does not exist`)
    }
    // Written once and never overwritten: the trace is immutable metadata, not a state
    // transition, so it never bumps the revision a concurrent compare-and-set depends on.
    if (run.questionRewrite === undefined) {
      run.questionRewrite = clone(rewrite)
      this.#runs.set(key, run)
    }
  }

  async saveCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: RuntimeCheckpointRecord,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef> {
    resolveStoreScope(scopeRef, ctx)
    const key = childKey(scopeRef, runId, record.checkpointId)
    const existing = this.#checkpoints.get(key)
    if (existing !== undefined && existing.stateDigest !== record.stateDigest) {
      throw new RunStoreError(
        'CHECKPOINT_CONFLICT',
        `checkpoint ${record.checkpointId} already exists with a different state digest`,
      )
    }
    if (existing === undefined) this.#checkpoints.set(key, clone(record))
    return {
      checkpointId: record.checkpointId,
      runId,
      runtimeKind: record.runtimeKind,
      runtimeVersion: record.runtimeVersion,
      stateDigest: record.stateDigest,
      createdAt: record.createdAt,
    }
  }

  async loadCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    checkpointId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const found = this.#checkpoints.get(childKey(scopeRef, runId, checkpointId))
    return found === undefined ? undefined : clone(found)
  }

  async findLatestCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = `${runKey(scopeRef, runId)}\u0000`
    const candidates = [...this.#checkpoints.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
    const latest = candidates[0]
    if (latest === undefined) return undefined
    return {
      checkpointId: latest.checkpointId,
      runId,
      runtimeKind: latest.runtimeKind,
      runtimeVersion: latest.runtimeVersion,
      stateDigest: latest.stateDigest,
      createdAt: latest.createdAt,
    }
  }

  async recordClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: ClarificationResponseRecord,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = childKey(scopeRef, runId, record.clarificationId)
    if (!this.#clarifications.has(key)) this.#clarifications.set(key, clone(record))
  }

  async findClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    clarificationId: Uuid,
    ctx: ToolContext,
  ): Promise<ClarificationResponseRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const found = this.#clarifications.get(childKey(scopeRef, runId, clarificationId))
    return found === undefined ? undefined : clone(found)
  }

  async recordAbandonedAttempt(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: AbandonedAttemptRecord,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = childKey(scopeRef, runId, record.attemptId)
    if (!this.#abandoned.has(key)) this.#abandoned.set(key, clone(record))
  }

  async listAbandonedAttempts(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<AbandonedAttemptRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = `${runKey(scopeRef, runId)}\u0000`
    return [...this.#abandoned.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => clone(record))
  }
}
