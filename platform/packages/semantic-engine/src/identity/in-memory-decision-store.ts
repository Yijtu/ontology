import { IdentityDecisionStoreError, isToolContext } from '@ontology/contracts'
import type {
  AppendIdentityDecisionInput,
  IdentityAssertionFilter,
  IdentityAssertionRecord,
  IdentityDecisionRecord,
  IdentityDecisionStore,
  IdentityEntityFilter,
  IdentityEntityRecord,
  IdentityLinkConstraintRecord,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new IdentityDecisionStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IdentityDecisionStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new IdentityDecisionStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference decision store for unit tests and local composition. It enforces the same
 * invariants as the database implementation — tenant/space scoping, compare-and-swap on
 * the candidate decision head, append-only decision versions and time-bounded assertions —
 * so the service is exercised against the real rules, not a permissive fake.
 */
export class InMemoryIdentityDecisionStore implements IdentityDecisionStore {
  readonly #entities = new Map<string, Map<string, IdentityEntityRecord>>()
  readonly #decisions = new Map<string, Map<Uuid, IdentityDecisionRecord[]>>()
  readonly #heads = new Map<string, Map<Uuid, number>>()
  readonly #assertions = new Map<string, Map<Uuid, IdentityAssertionRecord>>()
  readonly #constraints = new Map<string, Map<Uuid, IdentityLinkConstraintRecord>>()
  readonly #newId: () => string

  constructor(newId: () => string = () => globalThis.crypto.randomUUID()) {
    this.#newId = newId
  }

  #scoped<T>(store: Map<string, Map<string, T>>, scopeRef: ScopeRef): Map<string, T> {
    const key = scopeKey(scopeRef)
    const existing = store.get(key)
    if (existing !== undefined) return existing
    const created = new Map<string, T>()
    store.set(key, created)
    return created
  }

  async getEntity(
    scopeRef: ScopeRef,
    entityId: string,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const entity = this.#scoped(this.#entities, scopeRef).get(entityId)
    return entity === undefined ? undefined : clone(entity)
  }

  async listEntities(
    scopeRef: ScopeRef,
    filter: IdentityEntityFilter,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#scoped(this.#entities, scopeRef).values()]
    if (filter.objectId !== undefined) records = records.filter((record) => record.objectId === filter.objectId)
    if (filter.state !== undefined) records = records.filter((record) => record.state === filter.state)
    records.sort((left, right) => (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0))
    return records.slice(0, filter.limit ?? records.length).map(clone)
  }

  async latestRevision(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RevisionString> {
    resolveScope(scopeRef, ctx)
    return String(this.#scoped(this.#heads, scopeRef).get(candidateId) ?? 0)
  }

  async appendDecision(
    scopeRef: ScopeRef,
    input: AppendIdentityDecisionInput,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord> {
    resolveScope(scopeRef, ctx)
    const heads = this.#scoped(this.#heads, scopeRef)
    const head = heads.get(input.draft.candidateId) ?? 0
    if (String(head) !== input.expectedRevision) {
      throw new IdentityDecisionStoreError(
        'REVISION_CONFLICT',
        `candidate ${input.draft.candidateId} is at revision ${String(head)}, not ${input.expectedRevision}`,
      )
    }
    const revision = String(head + 1)
    const revisionNumber = head + 1

    if (input.entity !== undefined) {
      this.#scoped(this.#entities, scopeRef).set(input.entity.entityId, clone(input.entity))
    }
    if (input.openAssertion !== undefined) {
      this.#scoped(this.#assertions, scopeRef).set(input.openAssertion.assertionId, clone(input.openAssertion))
    }
    for (const close of input.closeAssertions ?? []) {
      const assertions = this.#scoped(this.#assertions, scopeRef)
      const existing = assertions.get(close.assertionId)
      if (existing === undefined) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', `assertion ${close.assertionId} is not visible`)
      }
      assertions.set(close.assertionId, { ...existing, validTo: close.validTo })
    }
    if (input.linkConstraint !== undefined) {
      const constraints = this.#scoped(this.#constraints, scopeRef)
      const duplicate = [...constraints.values()].find(
        (constraint) =>
          constraint.candidateId === input.linkConstraint?.candidateId &&
          constraint.entityId === input.linkConstraint?.entityId &&
          constraint.kind === input.linkConstraint?.kind,
      )
      if (duplicate === undefined) {
        constraints.set(input.linkConstraint.constraintId, clone(input.linkConstraint))
      }
    }
    const invalidationOutboxId = input.invalidation === undefined ? undefined : this.#newId()
    const record: IdentityDecisionRecord = {
      ...input.draft,
      revision,
      ...(revisionNumber === 1 ? {} : { supersedesRevision: String(head) }),
      ...(invalidationOutboxId === undefined ? {} : { invalidationOutboxId }),
    }
    const byCandidate = this.#decisions.get(scopeKey(scopeRef)) ?? new Map<Uuid, IdentityDecisionRecord[]>()
    this.#decisions.set(scopeKey(scopeRef), byCandidate)
    const history = byCandidate.get(record.candidateId) ?? []
    history.push(clone(record))
    byCandidate.set(record.candidateId, history)
    heads.set(record.candidateId, revisionNumber)
    return clone(record)
  }

  async getDecision(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const history = this.#scoped(this.#decisions, scopeRef).get(candidateId) ?? []
    const record = history.find((entry) => entry.revision === revision)
    return record === undefined ? undefined : clone(record)
  }

  async listDecisions(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord[]> {
    resolveScope(scopeRef, ctx)
    const history = this.#scoped(this.#decisions, scopeRef).get(candidateId) ?? []
    return [...history].sort((left, right) => Number(left.revision) - Number(right.revision)).map(clone)
  }

  async listAssertions(
    scopeRef: ScopeRef,
    filter: IdentityAssertionFilter,
    ctx: ToolContext,
  ): Promise<IdentityAssertionRecord[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#scoped(this.#assertions, scopeRef).values()]
    if (filter.entityId !== undefined) records = records.filter((record) => record.entityId === filter.entityId)
    if (filter.candidateId !== undefined) records = records.filter((record) => record.candidateId === filter.candidateId)
    if (filter.openOnly === true) records = records.filter((record) => record.validTo === undefined)
    records.sort((left, right) =>
      left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0,
    )
    return records.map(clone)
  }

  async listLinkConstraints(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<IdentityLinkConstraintRecord[]> {
    resolveScope(scopeRef, ctx)
    const records = [...this.#scoped(this.#constraints, scopeRef).values()].filter(
      (record) => record.candidateId === candidateId,
    )
    return records.map(clone)
  }

  /** Test seam: mint the id an outbox message would receive for a split. */
  nextOutboxId(): Uuid {
    return this.#newId()
  }
}
