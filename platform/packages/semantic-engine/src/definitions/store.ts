import { isToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import type {
  DefinitionBinding,
  SemanticDefinitionAudit,
  SemanticDefinitionEvent,
  SemanticDefinitionListFilter,
  SemanticDefinitionVersion,
} from './types'
import { SemanticDefinitionStoreError } from './errors'
import { definitionRefKey } from './canonical'

/**
 * Persistence port for published definition versions (D2/D3).
 *
 * It stores immutable versions, an append-only publication history and the data→version
 * bindings. Every key is tenant/space scoped and `ControlRepository` remains the durable,
 * monotonic event ledger; this port is the reconstructable version projection. A new
 * version is a new row — there is no update path for a published version.
 */
export interface SemanticDefinitionStore {
  findVersion(
    namespace: string,
    definitionId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion | undefined>
  listVersions(
    scopeRef: ScopeRef,
    filter: SemanticDefinitionListFilter,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion[]>
  insertVersion(
    scopeRef: ScopeRef,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    ctx: ToolContext,
  ): Promise<void>
  listEvents(
    scopeRef: ScopeRef,
    definitionId: string,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionEvent[]>
  bindData(scopeRef: ScopeRef, binding: DefinitionBinding, ctx: ToolContext): Promise<void>
  findBinding(
    scopeRef: ScopeRef,
    dataRefId: string,
    ctx: ToolContext,
  ): Promise<DefinitionBinding | undefined>
}

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new SemanticDefinitionStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SemanticDefinitionStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new SemanticDefinitionStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function versionKey(scopeRef: ScopeRef, namespace: string, definitionId: string, version: string): string {
  return `${scopePrefix(scopeRef)}${namespace}\u0000${definitionId}\u0000${version}`
}

interface StoredVersion {
  readonly version: SemanticDefinitionVersion
  readonly events: SemanticDefinitionEvent[]
}

/**
 * Reference store for unit tests and local composition. It enforces the same invariants
 * as the database implementation — immutable versions, append-only events, one binding
 * per data set — so the service is exercised against the real rules, not a permissive fake.
 */
export class InMemorySemanticDefinitionStore implements SemanticDefinitionStore {
  readonly #versions = new Map<string, StoredVersion>()
  readonly #bindings = new Map<string, DefinitionBinding>()

  async findVersion(
    namespace: string,
    definitionId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#versions.get(versionKey(scopeRef, namespace, definitionId, version))
    return stored === undefined ? undefined : structuredClone(stored.version)
  }

  async listVersions(
    scopeRef: ScopeRef,
    filter: SemanticDefinitionListFilter,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const out: SemanticDefinitionVersion[] = []
    for (const [key, stored] of this.#versions) {
      if (!key.startsWith(prefix)) continue
      if (filter.namespace !== undefined && stored.version.namespace !== filter.namespace) continue
      if (filter.layer !== undefined && stored.version.layer !== filter.layer) continue
      out.push(structuredClone(stored.version))
    }
    return out
  }

  async insertVersion(
    scopeRef: ScopeRef,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = versionKey(scopeRef, version.namespace, version.ref.id, version.ref.version)
    if (this.#versions.has(key)) {
      throw new SemanticDefinitionStoreError(
        'VERSION_EXISTS',
        `definition ${version.namespace}/${version.ref.id}@${version.ref.version} is already published`,
      )
    }
    this.#versions.set(key, {
      version: structuredClone(version),
      events: [this.#eventOf(version, audit, 1)],
    })
  }

  async listEvents(
    scopeRef: ScopeRef,
    definitionId: string,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionEvent[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const out: SemanticDefinitionEvent[] = []
    for (const [key, stored] of this.#versions) {
      if (!key.startsWith(prefix)) continue
      if (stored.version.ref.id !== definitionId) continue
      out.push(...stored.events)
    }
    return out
      .map((event) => structuredClone(event))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.seq - right.seq)
  }

  async bindData(scopeRef: ScopeRef, binding: DefinitionBinding, ctx: ToolContext): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${binding.dataRef.id}`
    const existing = this.#bindings.get(key)
    if (existing !== undefined) {
      if (definitionRefKey(existing.definitionRef) === definitionRefKey(binding.definitionRef)) {
        if (existing.definitionRef.digest === binding.definitionRef.digest) return
      }
      throw new SemanticDefinitionStoreError(
        'BINDING_CONFLICT',
        `data ${binding.dataRef.id} is already bound to ${definitionRefKey(existing.definitionRef)}`,
      )
    }
    this.#bindings.set(key, structuredClone(binding))
  }

  async findBinding(
    scopeRef: ScopeRef,
    dataRefId: string,
    ctx: ToolContext,
  ): Promise<DefinitionBinding | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const binding = this.#bindings.get(`${scopePrefix(scopeRef)}${dataRefId}`)
    return binding === undefined ? undefined : structuredClone(binding)
  }

  #eventOf(
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    seq: number,
  ): SemanticDefinitionEvent {
    return {
      definitionId: version.ref.id,
      version: version.ref.version,
      namespace: version.namespace,
      digest: audit.digest,
      payloadDigest: audit.payloadDigest,
      idempotencyKey: audit.idempotencyKey,
      occurredAt: audit.occurredAt,
      actor: audit.actor,
      seq,
    }
  }
}
