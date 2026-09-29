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
  IdentityStrongIdentity,
  IdentityPublishedBindingSnapshot,
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

function copyMap<K, V>(source: ReadonlyMap<K, V> | undefined): Map<K, V> {
  return new Map([...(source ?? new Map<K, V>())].map(([key, value]) => [key, clone(value)] as const))
}

function copyDecisionMap(
  source: ReadonlyMap<Uuid, readonly IdentityDecisionRecord[]> | undefined,
): Map<Uuid, IdentityDecisionRecord[]> {
  return new Map(
    [...(source ?? new Map<Uuid, readonly IdentityDecisionRecord[]>())].map(
      ([key, value]) => [key, [...value].map(clone)] as const,
    ),
  )
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
  readonly #heads = new Map<string, Map<Uuid, bigint>>()
  readonly #assertions = new Map<string, Map<Uuid, IdentityAssertionRecord>>()
  readonly #constraints = new Map<string, Map<Uuid, IdentityLinkConstraintRecord>>()
  readonly #readRevisions = new Map<string, bigint>()
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
    return String(this.#scoped(this.#heads, scopeRef).get(candidateId) ?? 0n)
  }

  async latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    resolveScope(scopeRef, ctx)
    return String(this.#readRevisions.get(scopeKey(scopeRef)) ?? 0n)
  }

  async readPublishedBindings(
    scopeRef: ScopeRef,
    candidateIds: readonly Uuid[],
    ctx: ToolContext,
  ): Promise<IdentityPublishedBindingSnapshot> {
    resolveScope(scopeRef, ctx)
    const uniqueIds = [...new Set(candidateIds)]
    const boundedIds = uniqueIds.slice(0, 1_000)
    const readRevision = String(this.#readRevisions.get(scopeKey(scopeRef)) ?? 0n)
    const assertions = this.#scoped(this.#assertions, scopeRef)
    const constraints = this.#scoped(this.#constraints, scopeRef)
    const bindings = boundedIds.map((candidateId) => ({
      candidateId,
      openAssertions: [...assertions.values()]
        .filter((assertion) => assertion.candidateId === candidateId && assertion.validTo === undefined)
        .map(clone),
      cannotLinkEntityIds: [...constraints.values()]
        .filter((constraint) => constraint.candidateId === candidateId && constraint.kind === 'cannot_link')
        .map((constraint) => constraint.entityId)
        .sort(),
    }))
    return { readRevision, bindings, complete: uniqueIds.length <= 1_000 }
  }

  async appendDecision(
    scopeRef: ScopeRef,
    input: AppendIdentityDecisionInput,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord> {
    resolveScope(scopeRef, ctx)
    const key = scopeKey(scopeRef)
    const heads = copyMap(this.#heads.get(key))
    const entities = copyMap(this.#entities.get(key))
    const assertions = copyMap(this.#assertions.get(key))
    const constraints = copyMap(this.#constraints.get(key))
    const decisions = copyDecisionMap(this.#decisions.get(key))
    const head = heads.get(input.draft.candidateId) ?? 0n
    if (String(head) !== input.expectedRevision) {
      throw new IdentityDecisionStoreError(
        'REVISION_CONFLICT',
        `candidate ${input.draft.candidateId} is at revision ${String(head)}, not ${input.expectedRevision}`,
      )
    }
    const revisionNumber = head + 1n
    const revision = String(revisionNumber)

    const changesCluster =
      input.openAssertion !== undefined ||
      (input.closeAssertions?.length ?? 0) > 0 ||
      input.linkConstraint !== undefined
    const targetEntityId = input.draft.targetEntityId
    if (changesCluster && (input.expectedTargetEntityRevision === undefined || targetEntityId === undefined)) {
      throw new IdentityDecisionStoreError(
        'DECISION_STORE_FAILED',
        'a match, split or cannot-link write requires the target entity revision it read',
      )
    }
    const currentTarget = targetEntityId === undefined ? undefined : entities.get(targetEntityId)
    if (input.expectedTargetEntityRevision !== undefined) {
      if (currentTarget === undefined) {
        throw new IdentityDecisionStoreError('ENTITY_NOT_FOUND', `target entity ${targetEntityId ?? ''} is not visible`)
      }
      if (currentTarget.revision !== input.expectedTargetEntityRevision) {
        throw new IdentityDecisionStoreError(
          'REVISION_CONFLICT',
          `target entity ${targetEntityId} is at revision ${currentTarget.revision}, not ${input.expectedTargetEntityRevision}`,
        )
      }
    }

    if (input.entity !== undefined) {
      const existing = entities.get(input.entity.entityId)
      if (input.expectedTargetEntityRevision !== undefined) {
        if (input.entity.entityId !== targetEntityId) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'entity update does not match the revision-checked target')
        }
        if (existing === undefined || existing.revision !== input.expectedTargetEntityRevision) {
          throw new IdentityDecisionStoreError('REVISION_CONFLICT', `target entity ${input.entity.entityId} changed before update`)
        }
        entities.set(input.entity.entityId, {
          ...clone(input.entity),
          revision: String(BigInt(existing.revision) + 1n),
          scopeDimensions: existing.scopeDimensions,
          ...(existing.createdFromCandidateId === undefined
            ? {}
            : { createdFromCandidateId: existing.createdFromCandidateId }),
        })
      } else {
        if (existing !== undefined) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', `entity ${input.entity.entityId} already exists`)
        }
        entities.set(input.entity.entityId, clone(input.entity))
      }
    } else if (input.expectedTargetEntityRevision !== undefined && currentTarget !== undefined) {
      entities.set(currentTarget.entityId, {
        ...currentTarget,
        revision: String(BigInt(currentTarget.revision) + 1n),
        updatedAt: input.draft.recordedAt,
      })
    }
    if (input.openAssertion !== undefined) {
      if (input.openAssertion.entityId !== targetEntityId || input.openAssertion.candidateId !== input.draft.candidateId) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'opened assertion target does not match the revision-checked entity')
      }
      if (assertions.has(input.openAssertion.assertionId)) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', `assertion ${input.openAssertion.assertionId} already exists`)
      }
      assertions.set(input.openAssertion.assertionId, clone(input.openAssertion))
    }
    for (const close of input.closeAssertions ?? []) {
      const existing = assertions.get(close.assertionId)
      if (existing === undefined || existing.validTo !== undefined || existing.entityId !== targetEntityId) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', `assertion ${close.assertionId} is not visible`)
      }
      assertions.set(close.assertionId, { ...existing, validTo: close.validTo })
    }
    if (input.linkConstraint !== undefined) {
      if (input.linkConstraint.entityId !== targetEntityId || input.linkConstraint.candidateId !== input.draft.candidateId) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'cannot-link does not match the reviewed target and candidate')
      }
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
    const invalidationOutboxId = input.invalidation?.eventId
    if (input.invalidation !== undefined && input.outboxJobId === undefined) {
      throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'a split invalidation needs an anchoring job id')
    }
    const record: IdentityDecisionRecord = {
      ...input.draft,
      revision,
      ...(revisionNumber === 1n ? {} : { supersedesRevision: String(head) }),
      ...(invalidationOutboxId === undefined ? {} : { invalidationOutboxId }),
    }
    const history = decisions.get(record.candidateId) ?? []
    history.push(clone(record))
    heads.set(record.candidateId, revisionNumber)
    decisions.set(record.candidateId, history)
    this.#entities.set(key, entities)
    this.#assertions.set(key, assertions)
    this.#constraints.set(key, constraints)
    this.#heads.set(key, heads)
    this.#decisions.set(key, decisions)
    this.#readRevisions.set(key, (this.#readRevisions.get(key) ?? 0n) + 1n)
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

  async hasReviewedIdentity(
    scopeRef: ScopeRef,
    entityId: string,
    identity: IdentityStrongIdentity,
    ctx: ToolContext,
  ): Promise<boolean> {
    resolveScope(scopeRef, ctx)
    const assertions = this.#scoped(this.#assertions, scopeRef)
    const decisions = this.#scoped(this.#decisions, scopeRef)
    for (const assertion of assertions.values()) {
      if (assertion.entityId !== entityId || assertion.validTo !== undefined) continue
      const history = decisions.get(assertion.candidateId) ?? []
      if (
        history.some(
          (decision) =>
            decision.decisionId === assertion.decisionId &&
            decision.kind === 'match' &&
            decision.targetEntityId === entityId &&
            decision.strongIdentity?.kind === identity.kind &&
            decision.strongIdentity.value === identity.value &&
            decision.strongIdentity.attributeId === identity.attributeId,
        )
      ) {
        return true
      }
    }
    return false
  }

  /** Test seam: mint the id an outbox message would receive for a split. */
  nextOutboxId(): Uuid {
    return this.#newId()
  }
}
