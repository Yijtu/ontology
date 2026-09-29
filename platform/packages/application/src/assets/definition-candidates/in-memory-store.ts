import {
  AssetCandidateStoreError,
  assertAssetCandidateBatchShape,
  assertAssetCandidateVersionShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AssetCandidateBatch,
  AssetCandidateInsertResult,
  AssetCandidateQuery,
  AssetCandidateStateTransition,
  AssetCandidateStore,
  AssetCandidateVersion,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

interface StoredBatch {
  readonly batch: AssetCandidateBatch
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new AssetCandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (
    ctx.allowedResources.tenantId !== tenantId ||
    scopeRef.tenantId !== tenantId ||
    scopeRef.spaceId !== spaceId
  ) {
    throw new AssetCandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference definition-candidate store for unit tests and local composition. It enforces the
 * same invariants as the database implementation — tenant/space scoping, idempotent batch
 * insertion (a replayed generation returns the stored batch), append-only candidate content
 * under a state transition and `IDEMPOTENCY_CONFLICT` for a reused key with a different
 * request digest — so the service is exercised against the real rules, not a permissive fake.
 */
export class InMemoryAssetCandidateStore implements AssetCandidateStore {
  readonly #batches = new Map<string, Map<Uuid, StoredBatch>>()
  readonly #batchIdempotency = new Map<string, { readonly scope: string; readonly batchId: Uuid }>()
  readonly #candidates = new Map<string, Map<Uuid, AssetCandidateVersion>>()
  readonly #candidateIdempotency = new Map<string, { readonly scope: string; readonly candidateId: Uuid }>()

  #batchStore(scopeRef: ScopeRef): Map<Uuid, StoredBatch> {
    const key = scopeKey(scopeRef)
    const existing = this.#batches.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, StoredBatch>()
    this.#batches.set(key, created)
    return created
  }

  #candidateStore(scopeRef: ScopeRef): Map<Uuid, AssetCandidateVersion> {
    const key = scopeKey(scopeRef)
    const existing = this.#candidates.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, AssetCandidateVersion>()
    this.#candidates.set(key, created)
    return created
  }

  #candidatesOfBatch(scopeRef: ScopeRef, batchId: Uuid): AssetCandidateVersion[] {
    return [...this.#candidateStore(scopeRef).values()].filter((candidate) => candidate.batchId === batchId)
  }

  async insertBatch(
    scopeRef: ScopeRef,
    batch: AssetCandidateBatch,
    candidates: readonly AssetCandidateVersion[],
    ctx: ToolContext,
  ): Promise<AssetCandidateInsertResult> {
    resolveScope(scopeRef, ctx)
    assertAssetCandidateBatchShape(batch)
    for (const candidate of candidates) assertAssetCandidateVersionShape(candidate)
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${batch.idempotencyKey}`
    const prior = this.#batchIdempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#batchStore(scopeRef).get(prior.batchId)
      if (stored === undefined) {
        throw new AssetCandidateStoreError('STORE_FAILED', 'the idempotent batch row is missing')
      }
      if (stored.batch.requestDigest !== batch.requestDigest) {
        throw new AssetCandidateStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload',
        )
      }
      return { batch: clone(stored.batch), candidates: this.#candidatesOfBatch(scopeRef, prior.batchId), created: false }
    }
    if (this.#batchStore(scopeRef).has(batch.batchId)) {
      throw new AssetCandidateStoreError('STORE_FAILED', `batch ${batch.batchId} already exists`)
    }
    const batchStore = this.#batchStore(scopeRef)
    batchStore.set(batch.batchId, { batch: clone(batch) })
    this.#batchIdempotency.set(idempotency, { scope, batchId: batch.batchId })

    const candidateStore = this.#candidateStore(scopeRef)
    for (const candidate of candidates) {
      const candidateIdempotency = `${scope}\u0000${candidate.idempotencyKey}`
      const existing = this.#candidateIdempotency.get(candidateIdempotency)
      if (existing !== undefined) {
        throw new AssetCandidateStoreError(
          'INVALID_CANDIDATE',
          `candidate idempotency key ${candidate.logicalId} already exists`,
        )
      }
      if (candidateStore.has(candidate.candidateId)) {
        throw new AssetCandidateStoreError('STORE_FAILED', `candidate ${candidate.candidateId} already exists`)
      }
      candidateStore.set(candidate.candidateId, clone(candidate))
      this.#candidateIdempotency.set(candidateIdempotency, { scope, candidateId: candidate.candidateId })
    }
    return { batch: clone(batch), candidates: candidates.map(clone), created: true }
  }

  async getBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined> {
    resolveScope(scopeRef, ctx)
    const stored = this.#batchStore(scopeRef).get(batchId)
    return stored === undefined ? undefined : clone(stored.batch)
  }

  async findBatchByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined> {
    resolveScope(scopeRef, ctx)
    const prior = this.#batchIdempotency.get(`${scopeKey(scopeRef)}\u0000${idempotencyKey}`)
    if (prior === undefined) return undefined
    const stored = this.#batchStore(scopeRef).get(prior.batchId)
    return stored === undefined ? undefined : clone(stored.batch)
  }

  async listBatches(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#batchStore(scopeRef).values()]
      .map((stored) => stored.batch)
      .filter((batch) => batch.workspaceId === workspaceId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0))
      .slice(0, limit)
      .map(clone)
  }

  async getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const candidate = this.#candidateStore(scopeRef).get(candidateId)
    return candidate === undefined ? undefined : clone(candidate)
  }

  async listCandidates(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: AssetCandidateQuery,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#candidateStore(scopeRef).values()].filter(
      (candidate) => candidate.workspaceId === workspaceId,
    )
    if (query.kind !== undefined) records = records.filter((candidate) => candidate.kind === query.kind)
    if (query.state !== undefined) records = records.filter((candidate) => candidate.state === query.state)
    records.sort((left, right) =>
      left.recordedAt !== right.recordedAt
        ? left.recordedAt < right.recordedAt
          ? -1
          : 1
        : left.candidateId < right.candidateId
          ? -1
          : 1,
    )
    return records.slice(0, query.limit ?? records.length).map(clone)
  }

  async listCandidatesByBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    resolveScope(scopeRef, ctx)
    return this.#candidatesOfBatch(scopeRef, batchId).map(clone)
  }

  async transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: AssetCandidateStateTransition,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion> {
    resolveScope(scopeRef, ctx)
    const store = this.#candidateStore(scopeRef)
    const current = store.get(candidateId)
    if (current === undefined) {
      throw new AssetCandidateStoreError(
        'CANDIDATE_NOT_FOUND',
        `candidate ${candidateId} is not visible in this scope`,
      )
    }
    const updated: AssetCandidateVersion = { ...current, state: transition.state, issues: transition.issues }
    store.set(candidateId, clone(updated))
    return clone(updated)
  }
}
