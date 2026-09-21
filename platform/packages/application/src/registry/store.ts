import { isToolContext } from '@ontology/contracts'
import type {
  ComponentVersionRecord,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import type {
  ActiveComponentReference,
  ComponentKey,
  ComponentLifecycleEvent,
  ComponentListFilter,
} from './types'
import { componentKeyString } from './types'

/**
 * Store-level failures. The registry service maps them onto classified
 * `ComponentRegistryError` codes; the store never leaks a driver error upward.
 */
export type ComponentStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'VERSION_EXISTS'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_RETIRED'
  | 'CONCURRENT_MODIFICATION'
  | 'ACTIVE_REFERENCE_EXISTS'

export class ComponentStoreError extends Error {
  readonly code: ComponentStoreErrorCode

  constructor(code: ComponentStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ComponentStoreError'
    this.code = code
  }
}

/** The append-only lifecycle record the service hands to the store on every change. */
export interface ComponentLifecycleAudit {
  readonly fromState: ModuleLifecycleState | null
  readonly toState: ModuleLifecycleState
  readonly digest: Sha256Digest
  readonly payloadDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly occurredAt: string
  readonly actor: string
}

export interface ComponentRegistrationRecordInput {
  readonly record: ComponentVersionRecord
  readonly artifactRef: ResourceRef
  readonly audit: ComponentLifecycleAudit
}

/**
 * Persistence port for the component registry (D2). It keeps immutable versions, the
 * active-run reference set and an append-only lifecycle history, always inside the
 * trusted tenant/space scope. `ControlRepository` is used separately for the durable
 * event ledger; this port is the version projection.
 *
 * Implementations must make `applyTransition` a compare-and-set on the lifecycle state
 * and must refuse to retire a version that still has an active reference.
 */
export interface ComponentRegistryStore {
  findVersion(
    key: ComponentKey,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord | undefined>
  listVersions(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]>
  insertVersion(
    scopeRef: ScopeRef,
    input: ComponentRegistrationRecordInput,
    ctx: ToolContext,
  ): Promise<void>
  applyTransition(
    scopeRef: ScopeRef,
    key: ComponentKey,
    expectedFrom: ModuleLifecycleState,
    next: ComponentVersionRecord,
    audit: ComponentLifecycleAudit,
    ctx: ToolContext,
  ): Promise<void>
  listActiveReferences(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference[]>
  acquireActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference>
  releaseActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<boolean>
  listLifecycleEvents(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ComponentLifecycleEvent[]>
}

export interface InMemoryComponentRegistryStoreOptions {
  readonly now?: () => string
}

interface StoredVersion {
  record: ComponentVersionRecord
  artifactRef: ResourceRef
  events: ComponentLifecycleEvent[]
  references: Map<string, ActiveComponentReference>
}

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new ComponentStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ComponentStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new ComponentStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

function storageKey(scopeRef: ScopeRef, key: ComponentKey): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${componentKeyString(key)}`
}

function eventFromAudit(key: ComponentKey, audit: ComponentLifecycleAudit): ComponentLifecycleEvent {
  return {
    key: { ...key },
    digest: audit.digest,
    fromState: audit.fromState,
    toState: audit.toState,
    payloadDigest: audit.payloadDigest,
    idempotencyKey: audit.idempotencyKey,
    occurredAt: audit.occurredAt,
    actor: audit.actor,
  }
}

/**
 * Reference store for unit tests and local composition. It enforces the same
 * invariants as the database implementation — version freeze, compare-and-set
 * transitions, refuse-to-retire-while-referenced — so the service is exercised
 * against the real rules, not a permissive fake.
 */
export class InMemoryComponentRegistryStore implements ComponentRegistryStore {
  readonly #versions = new Map<string, StoredVersion>()
  readonly #now: () => string

  constructor(options?: InMemoryComponentRegistryStoreOptions) {
    this.#now = options?.now ?? (() => new Date().toISOString())
  }

  async findVersion(
    key: ComponentKey,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    return entry === undefined ? undefined : structuredClone(entry.record)
  }

  async listVersions(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
    const out: ComponentVersionRecord[] = []
    for (const [mapKey, entry] of this.#versions) {
      if (!mapKey.startsWith(prefix)) continue
      if (filter.kind !== undefined && entry.record.manifest.kind !== filter.kind) continue
      if (filter.lifecycleState !== undefined && entry.record.lifecycleState !== filter.lifecycleState) {
        continue
      }
      out.push(structuredClone(entry.record))
    }
    return out
  }

  async insertVersion(
    scopeRef: ScopeRef,
    input: ComponentRegistrationRecordInput,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key: ComponentKey = {
      kind: input.record.manifest.kind,
      id: input.record.manifestRef.id,
      version: input.record.manifestRef.version,
    }
    const mapKey = storageKey(scopeRef, key)
    if (this.#versions.has(mapKey)) {
      throw new ComponentStoreError(
        'VERSION_EXISTS',
        `component ${componentKeyString(key)} is already registered`,
      )
    }
    this.#versions.set(mapKey, {
      record: structuredClone(input.record),
      artifactRef: structuredClone(input.artifactRef),
      events: [eventFromAudit(key, input.audit)],
      references: new Map(),
    })
  }

  async applyTransition(
    scopeRef: ScopeRef,
    key: ComponentKey,
    expectedFrom: ModuleLifecycleState,
    next: ComponentVersionRecord,
    audit: ComponentLifecycleAudit,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    if (entry === undefined) {
      throw new ComponentStoreError('VERSION_NOT_FOUND', `component ${componentKeyString(key)} is not registered`)
    }
    if (entry.record.lifecycleState !== expectedFrom) {
      throw new ComponentStoreError(
        'CONCURRENT_MODIFICATION',
        `component ${componentKeyString(key)} is ${entry.record.lifecycleState}, not ${expectedFrom}`,
      )
    }
    if (next.lifecycleState === 'retired' && entry.references.size > 0) {
      throw new ComponentStoreError(
        'ACTIVE_REFERENCE_EXISTS',
        `component ${componentKeyString(key)} is referenced by an active run`,
      )
    }
    entry.record = structuredClone(next)
    if (!entry.events.some((event) => event.idempotencyKey === audit.idempotencyKey)) {
      entry.events.push(eventFromAudit(key, audit))
    }
  }

  async listActiveReferences(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference[]> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    if (entry === undefined) return []
    return [...entry.references.values()].map((reference) => structuredClone(reference))
  }

  async acquireActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    if (entry === undefined) {
      throw new ComponentStoreError('VERSION_NOT_FOUND', `component ${componentKeyString(key)} is not registered`)
    }
    if (entry.record.lifecycleState === 'retired') {
      throw new ComponentStoreError('VERSION_RETIRED', `component ${componentKeyString(key)} is retired`)
    }
    const existing = entry.references.get(runId)
    if (existing !== undefined) return structuredClone(existing)
    const reference: ActiveComponentReference = { key: { ...key }, runId, acquiredAt: this.#now() }
    entry.references.set(runId, reference)
    return structuredClone(reference)
  }

  async releaseActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<boolean> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    if (entry === undefined) return false
    return entry.references.delete(runId)
  }

  async listLifecycleEvents(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ComponentLifecycleEvent[]> {
    resolveStoreScope(scopeRef, ctx)
    const entry = this.#versions.get(storageKey(scopeRef, key))
    if (entry === undefined) return []
    return entry.events.map((event) => structuredClone(event))
  }
}
