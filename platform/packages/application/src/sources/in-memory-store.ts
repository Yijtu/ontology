import { SourceStoreError, isToolContext } from '@ontology/contracts'
import type {
  ProfileRef,
  ScopeRef,
  Sha256Digest,
  SourceBindingRecord,
  SourceBindingUpdate,
  SourcePreflightBindingRecord,
  SourceProbeJobCompletion,
  SourceProbeJobRecord,
  SourceStore,
  SourceVersionRecord,
  ToolContext,
} from '@ontology/contracts'

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new SourceStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SourceStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new SourceStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

/**
 * Reference implementation of the source store for unit tests and local composition. It
 * enforces the same invariants as the database implementation — immutable versions,
 * compare-and-set binding updates, tenant/space isolation — so the registry is exercised
 * against the real rules rather than a permissive fake.
 */
export class InMemorySourceStore implements SourceStore {
  readonly #bindings = new Map<string, SourceBindingRecord>()
  readonly #versions = new Map<string, SourceVersionRecord>()
  readonly #jobs = new Map<string, SourceProbeJobRecord>()
  readonly #preflights = new Map<string, SourcePreflightBindingRecord>()

  async insertBinding(scopeRef: ScopeRef, record: SourceBindingRecord, ctx: ToolContext): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    this.#bindings.set(`${scopePrefix(scopeRef)}${record.sourceId}`, structuredClone(record))
  }

  async findBinding(
    sourceId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourceBindingRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#bindings.get(`${scopePrefix(scopeRef)}${sourceId}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async listBindings(scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const out: SourceBindingRecord[] = []
    for (const [key, record] of this.#bindings) {
      if (key.startsWith(prefix)) out.push(structuredClone(record))
    }
    return out.sort((left, right) => (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0))
  }

  async applyBindingUpdate(
    scopeRef: ScopeRef,
    sourceId: string,
    update: SourceBindingUpdate,
    ctx: ToolContext,
  ): Promise<SourceBindingRecord> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${sourceId}`
    const current = this.#bindings.get(key)
    if (current === undefined) {
      throw new SourceStoreError('SOURCE_NOT_FOUND', `source ${sourceId} is not registered in this scope`)
    }
    if (current.revision !== update.expectedRevision) {
      throw new SourceStoreError(
        'REVISION_CONFLICT',
        `source ${sourceId} revision ${current.revision} does not match ${update.expectedRevision}`,
      )
    }
    const next: SourceBindingRecord = {
      ...current,
      status: update.status,
      revision: String(Number(current.revision) + 1),
      updatedAt: update.updatedAt,
      ...(update.currentVersion === undefined ? {} : { currentVersion: update.currentVersion }),
      ...(update.capabilityVersion === undefined ? {} : { capabilityVersion: update.capabilityVersion }),
    }
    this.#bindings.set(key, next)
    return structuredClone(next)
  }

  async insertVersion(scopeRef: ScopeRef, record: SourceVersionRecord, ctx: ToolContext): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${record.sourceId}\u0000${record.version}`
    const existing = this.#versions.get(key)
    if (existing !== undefined) {
      if (existing.digest !== record.digest) {
        throw new SourceStoreError(
          'VERSION_EXISTS',
          `source ${record.sourceId}@${record.version} already exists with a different digest`,
        )
      }
      return
    }
    this.#versions.set(key, structuredClone(record))
  }

  async findVersion(
    sourceId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourceVersionRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#versions.get(`${scopePrefix(scopeRef)}${sourceId}\u0000${version}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async listVersions(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceVersionRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = `${scopePrefix(scopeRef)}${sourceId}\u0000`
    const out: SourceVersionRecord[] = []
    for (const [key, record] of this.#versions) {
      if (key.startsWith(prefix)) out.push(structuredClone(record))
    }
    return out.sort((left, right) => (left.version < right.version ? -1 : left.version > right.version ? 1 : 0))
  }

  async insertProbeJob(scopeRef: ScopeRef, record: SourceProbeJobRecord, ctx: ToolContext): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    this.#jobs.set(`${scopePrefix(scopeRef)}${record.jobId}`, structuredClone(record))
  }

  async findProbeJob(jobId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#jobs.get(`${scopePrefix(scopeRef)}${jobId}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async listProbeJobs(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const out: SourceProbeJobRecord[] = []
    for (const [key, record] of this.#jobs) {
      if (key.startsWith(prefix) && record.sourceId === sourceId) out.push(structuredClone(record))
    }
    return out
  }

  async completeProbeJob(
    scopeRef: ScopeRef,
    jobId: string,
    completion: SourceProbeJobCompletion,
    ctx: ToolContext,
  ): Promise<SourceProbeJobRecord> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${jobId}`
    const current = this.#jobs.get(key)
    if (current === undefined) {
      throw new SourceStoreError('SOURCE_NOT_FOUND', `probe job ${jobId} is not visible in this scope`)
    }
    const next: SourceProbeJobRecord = {
      ...current,
      status: completion.status,
      completedAt: completion.completedAt,
      ...(completion.capabilities === undefined ? {} : { capabilities: completion.capabilities }),
      ...(completion.schemaRevision === undefined ? {} : { schemaRevision: completion.schemaRevision }),
      ...(completion.errorCode === undefined ? {} : { errorCode: completion.errorCode }),
      ...(completion.safeMessage === undefined ? {} : { safeMessage: completion.safeMessage }),
    }
    this.#jobs.set(key, next)
    return structuredClone(next)
  }

  async insertPreflightBinding(
    scopeRef: ScopeRef,
    record: SourcePreflightBindingRecord,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = preflightKey(scopeRef, record.profileRef, record.snapshotHash)
    // A re-preflight replaces the recorded observation. Keeping the first record forever
    // would leave a preflight permanently stale after a source change, so the record must
    // reflect the fingerprints the latest preflight actually observed.
    this.#preflights.set(key, structuredClone(record))
  }

  async findPreflightBinding(
    profileRef: ProfileRef,
    snapshotHash: Sha256Digest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourcePreflightBindingRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#preflights.get(preflightKey(scopeRef, profileRef, snapshotHash))
    return stored === undefined ? undefined : structuredClone(stored)
  }
}

function preflightKey(scopeRef: ScopeRef, profileRef: ProfileRef, snapshotHash: Sha256Digest): string {
  return `${scopePrefix(scopeRef)}${profileRef.id}\u0000${profileRef.version}\u0000${snapshotHash}`
}
