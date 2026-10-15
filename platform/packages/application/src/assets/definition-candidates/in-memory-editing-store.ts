import {
  DefinitionEditingStoreError,
  isToolContext,
} from '@ontology/contracts'
import type {
  DefinitionEditAdjudication,
  DefinitionEditingStore,
  ScopeRef,
  ToolContext,
  UnsupportedDefinitionRule,
  Uuid,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new DefinitionEditingStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (
    ctx.allowedResources.tenantId !== tenantId ||
    scopeRef.tenantId !== tenantId ||
    scopeRef.spaceId !== spaceId
  ) {
    throw new DefinitionEditingStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference definition-editing store for unit tests and local composition (SEE ALSO migration
 * 063). It enforces the same invariants as the future database implementation — tenant/space
 * scoping, append-only adjudications, idempotency on the edit key and non-executable
 * unsupported rules that are never deleted — so the service runs against the real rules.
 */
export class InMemoryDefinitionEditingStore implements DefinitionEditingStore {
  readonly #adjudications = new Map<string, Map<Uuid, DefinitionEditAdjudication>>()
  readonly #adjudicationIdempotency = new Map<string, { readonly scope: string; readonly adjudicationId: Uuid }>()
  readonly #unsupportedRules = new Map<string, Map<string, UnsupportedDefinitionRule>>()
  readonly #unsupportedIdempotency = new Map<string, { readonly scope: string; readonly ruleId: string }>()

  #adjudicationStore(scopeRef: ScopeRef): Map<Uuid, DefinitionEditAdjudication> {
    const key = scopeKey(scopeRef)
    const existing = this.#adjudications.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, DefinitionEditAdjudication>()
    this.#adjudications.set(key, created)
    return created
  }

  #ruleStore(scopeRef: ScopeRef): Map<string, UnsupportedDefinitionRule> {
    const key = scopeKey(scopeRef)
    const existing = this.#unsupportedRules.get(key)
    if (existing !== undefined) return existing
    const created = new Map<string, UnsupportedDefinitionRule>()
    this.#unsupportedRules.set(key, created)
    return created
  }

  async appendAdjudication(
    scopeRef: ScopeRef,
    adjudication: DefinitionEditAdjudication,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication> {
    resolveScope(scopeRef, ctx)
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${adjudication.idempotencyKey}`
    const prior = this.#adjudicationIdempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#adjudicationStore(scopeRef).get(prior.adjudicationId)
      if (stored === undefined) {
        throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'the idempotent adjudication row is missing')
      }
      if (stored.requestDigest !== adjudication.requestDigest) {
        throw new DefinitionEditingStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different adjudication',
        )
      }
      return clone(stored)
    }
    const store = this.#adjudicationStore(scopeRef)
    if (store.has(adjudication.adjudicationId)) {
      throw new DefinitionEditingStoreError(
        'ADJUDICATION_EXISTS',
        `adjudication ${adjudication.adjudicationId} already exists`,
      )
    }
    store.set(adjudication.adjudicationId, clone(adjudication))
    this.#adjudicationIdempotency.set(idempotency, { scope, adjudicationId: adjudication.adjudicationId })
    return clone(adjudication)
  }

  async listAdjudications(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#adjudicationStore(scopeRef).values()]
      .filter((adjudication) => adjudication.workspaceId === workspaceId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0))
      .slice(0, limit)
      .map(clone)
  }

  async findAdjudicationByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication | undefined> {
    resolveScope(scopeRef, ctx)
    const prior = this.#adjudicationIdempotency.get(`${scopeKey(scopeRef)}\u0000${idempotencyKey}`)
    if (prior === undefined) return undefined
    const stored = this.#adjudicationStore(scopeRef).get(prior.adjudicationId)
    return stored === undefined ? undefined : clone(stored)
  }

  async recordUnsupportedRule(
    scopeRef: ScopeRef,
    rule: UnsupportedDefinitionRule,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule> {
    resolveScope(scopeRef, ctx)
    if (rule.executable !== false) {
      throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'an unsupported rule must be non-executable')
    }
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${rule.idempotencyKey}`
    const prior = this.#unsupportedIdempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#ruleStore(scopeRef).get(prior.ruleId)
      if (stored === undefined) {
        throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'the idempotent unsupported-rule row is missing')
      }
      if (
        stored.ruleId !== rule.ruleId ||
        stored.reason !== rule.reason ||
        JSON.stringify(stored.rawForm) !== JSON.stringify(rule.rawForm)
      ) {
        throw new DefinitionEditingStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different unsupported rule',
        )
      }
      return clone(stored)
    }
    const store = this.#ruleStore(scopeRef)
    if (store.has(rule.ruleId)) {
      throw new DefinitionEditingStoreError(
        'UNSUPPORTED_RULE_EXISTS',
        `unsupported rule ${rule.ruleId} already exists`,
      )
    }
    store.set(rule.ruleId, clone(rule))
    this.#unsupportedIdempotency.set(idempotency, { scope, ruleId: rule.ruleId })
    return clone(rule)
  }

  async listUnsupportedRules(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#ruleStore(scopeRef).values()]
      .filter((rule) => rule.workspaceId === workspaceId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0))
      .slice(0, limit)
      .map(clone)
  }
}
