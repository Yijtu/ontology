import {
  RuleActionCandidateStoreError,
  assertRuleActionCandidateShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  RuleActionCandidateQuery,
  RuleActionCandidateStore,
  RuleActionCandidateTransition,
  RuleActionCandidateVersion,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (
    ctx.allowedResources.tenantId !== tenantId ||
    scopeRef.tenantId !== tenantId ||
    scopeRef.spaceId !== spaceId
  ) {
    throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference rule/action candidate store for unit tests and local composition (SEE ALSO
 * migration 064). It enforces the same invariants as the database implementation —
 * tenant/space scoping, append-only candidate revisions, idempotency on the candidate key and
 * a lifecycle transition that never mutates the payload — so the service is exercised against
 * the real rules, not a permissive fake.
 */
export class InMemoryRuleActionCandidateStore implements RuleActionCandidateStore {
  readonly #candidates = new Map<string, Map<Uuid, RuleActionCandidateVersion>>()
  readonly #idempotency = new Map<string, { readonly scope: string; readonly candidateId: Uuid }>()

  #store(scopeRef: ScopeRef): Map<Uuid, RuleActionCandidateVersion> {
    const key = scopeKey(scopeRef)
    const existing = this.#candidates.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, RuleActionCandidateVersion>()
    this.#candidates.set(key, created)
    return created
  }

  async insert(
    scopeRef: ScopeRef,
    candidate: RuleActionCandidateVersion,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion> {
    resolveScope(scopeRef, ctx)
    assertRuleActionCandidateShape(candidate)
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${candidate.idempotencyKey}`
    const prior = this.#idempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#store(scopeRef).get(prior.candidateId)
      if (stored === undefined) {
        throw new RuleActionCandidateStoreError('STORE_FAILED', 'the idempotent candidate row is missing')
      }
      if (stored.contentDigest !== candidate.contentDigest) {
        throw new RuleActionCandidateStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different candidate',
        )
      }
      return clone(stored)
    }
    const store = this.#store(scopeRef)
    if (store.has(candidate.candidateId)) {
      throw new RuleActionCandidateStoreError('STORE_FAILED', `candidate ${candidate.candidateId} already exists`)
    }
    store.set(candidate.candidateId, clone(candidate))
    this.#idempotency.set(idempotency, { scope, candidateId: candidate.candidateId })
    return clone(candidate)
  }

  async get(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const stored = this.#store(scopeRef).get(candidateId)
    return stored === undefined ? undefined : clone(stored)
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: RuleActionCandidateQuery,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#store(scopeRef).values()].filter((candidate) => candidate.workspaceId === workspaceId)
    if (query.kind !== undefined) records = records.filter((candidate) => candidate.kind === query.kind)
    if (query.lifecycle !== undefined) records = records.filter((candidate) => candidate.lifecycle === query.lifecycle)
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

  async transition(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: RuleActionCandidateTransition,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion> {
    resolveScope(scopeRef, ctx)
    const store = this.#store(scopeRef)
    const current = store.get(candidateId)
    if (current === undefined) {
      throw new RuleActionCandidateStoreError(
        'CANDIDATE_NOT_FOUND',
        `candidate ${candidateId} is not visible in this scope`,
      )
    }
    const updated: RuleActionCandidateVersion = {
      ...current,
      lifecycle: transition.lifecycle,
      ...(transition.enabledAt === undefined ? {} : { enabledAt: transition.enabledAt }),
    }
    store.set(candidateId, clone(updated))
    return clone(updated)
  }
}
