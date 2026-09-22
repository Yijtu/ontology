import { CandidateStoreError, isToolContext } from '@ontology/contracts'
import type {
  CandidateInsertResult,
  CandidateQuery,
  CandidateRecord,
  CandidateStateCounts,
  CandidateStateTransition,
  CandidateStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new CandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new CandidateStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new CandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference candidate store for unit tests and local composition. It enforces the same
 * invariants as the database implementation — tenant/space scoping, idempotent insertion on
 * `idempotencyKey` and immutable candidate payloads under a state transition — so the
 * pipeline is exercised against the real rules rather than a permissive fake.
 */
export class InMemoryCandidateStore implements CandidateStore {
  readonly #byScope = new Map<string, Map<Uuid, CandidateRecord>>()
  readonly #idempotency = new Map<string, { readonly scope: string; readonly candidateId: Uuid }>()

  #candidates(scopeRef: ScopeRef): Map<Uuid, CandidateRecord> {
    const key = scopeKey(scopeRef)
    const existing = this.#byScope.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, CandidateRecord>()
    this.#byScope.set(key, created)
    return created
  }

  #requireCandidate(scopeRef: ScopeRef, candidateId: Uuid): CandidateRecord {
    const record = this.#candidates(scopeRef).get(candidateId)
    if (record === undefined) {
      throw new CandidateStoreError('CANDIDATE_NOT_FOUND', `candidate ${candidateId} is not visible in this scope`)
    }
    return record
  }

  async insertCandidates(
    scopeRef: ScopeRef,
    candidates: readonly CandidateRecord[],
    ctx: ToolContext,
  ): Promise<CandidateInsertResult> {
    resolveScope(scopeRef, ctx)
    const scope = scopeKey(scopeRef)
    const store = this.#candidates(scopeRef)
    const candidateIds: Uuid[] = []
    let inserted = 0
    let existing = 0
    for (const candidate of candidates) {
      const idempotency = `${scope}\u0000${candidate.idempotencyKey}`
      const prior = this.#idempotency.get(idempotency)
      if (prior !== undefined) {
        existing += 1
        candidateIds.push(prior.candidateId)
        continue
      }
      if (store.has(candidate.candidateId)) {
        throw new CandidateStoreError(
          'CANDIDATE_STORE_FAILED',
          `candidate ${candidate.candidateId} already exists with a different idempotency key`,
        )
      }
      const stored = clone(candidate)
      store.set(stored.candidateId, stored)
      this.#idempotency.set(idempotency, { scope, candidateId: stored.candidateId })
      inserted += 1
      candidateIds.push(stored.candidateId)
    }
    return { inserted, existing, candidateIds }
  }

  async getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const record = this.#candidates(scopeRef).get(candidateId)
    return record === undefined ? undefined : clone(record)
  }

  async listCandidates(
    scopeRef: ScopeRef,
    query: CandidateQuery,
    ctx: ToolContext,
  ): Promise<CandidateRecord[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#candidates(scopeRef).values()]
    if (query.jobId !== undefined) records = records.filter((record) => record.jobId === query.jobId)
    if (query.state !== undefined) records = records.filter((record) => record.state === query.state)
    if (query.kind !== undefined) records = records.filter((record) => record.kind === query.kind)
    records.sort((left, right) => {
      if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1
      return left.candidateId < right.candidateId ? -1 : 1
    })
    const limit = query.limit ?? records.length
    return records.slice(0, limit).map(clone)
  }

  async transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: CandidateStateTransition,
    ctx: ToolContext,
  ): Promise<CandidateRecord> {
    resolveScope(scopeRef, ctx)
    const current = this.#requireCandidate(scopeRef, candidateId)
    const updated: CandidateRecord =
      current.kind === 'entity'
        ? { ...current, state: transition.state, issues: transition.issues }
        : { ...current, state: transition.state, issues: transition.issues }
    this.#candidates(scopeRef).set(candidateId, clone(updated))
    return clone(updated)
  }

  async countCandidates(
    scopeRef: ScopeRef,
    jobId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateStateCounts> {
    resolveScope(scopeRef, ctx)
    const records = [...this.#candidates(scopeRef).values()].filter((record) => record.jobId === jobId)
    let pendingReview = 0
    let failed = 0
    let rejected = 0
    for (const record of records) {
      if (record.state === 'pending_review') pendingReview += 1
      else if (record.state === 'failed') failed += 1
      else if (record.state === 'rejected') rejected += 1
    }
    return {
      total: records.length,
      produced: records.length - pendingReview - failed - rejected,
      pendingReview,
      failed,
      rejected,
    }
  }
}
