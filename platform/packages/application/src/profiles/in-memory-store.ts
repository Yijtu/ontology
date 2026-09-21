import { ProfileStoreError, isToolContext } from '@ontology/contracts'
import type {
  ActiveProfileRecord,
  ProfileActivation,
  ProfileListFilter,
  ProfileRef,
  ProfileStore,
  ProfileVersionRecord,
  ResolvedProfileRecord,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'

function resolveStoreScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new ProfileStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProfileStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new ProfileStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return { tenantId, spaceId }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function versionKey(scopeRef: ScopeRef, ref: ProfileRef): string {
  return `${scopePrefix(scopeRef)}${ref.id}\u0000${ref.version}`
}

function resolvedKey(scopeRef: ScopeRef, ref: ProfileRef, snapshotHash: Sha256Digest): string {
  return `${versionKey(scopeRef, ref)}\u0000${snapshotHash}`
}

/**
 * Reference implementation of the profile store for unit tests and local composition. It
 * enforces the same invariants as the database implementation — immutable profile
 * versions, immutable content-addressed resolved manifests, compare-and-set activation —
 * so the resolver is exercised against the real rules rather than a permissive fake.
 */
export class InMemoryProfileStore implements ProfileStore {
  readonly #versions = new Map<string, ProfileVersionRecord>()
  readonly #resolved = new Map<string, ResolvedProfileRecord>()
  readonly #active = new Map<string, ActiveProfileRecord>()

  async findProfileVersion(
    ref: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#versions.get(versionKey(scopeRef, ref))
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async listProfileVersions(
    scopeRef: ScopeRef,
    filter: ProfileListFilter,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const out: ProfileVersionRecord[] = []
    for (const [key, record] of this.#versions) {
      if (!key.startsWith(prefix)) continue
      if (filter.environment !== undefined && record.environment !== filter.environment) continue
      out.push(structuredClone(record))
    }
    return out.sort((left, right) => {
      if (left.profileRef.id !== right.profileRef.id) return left.profileRef.id < right.profileRef.id ? -1 : 1
      return left.profileRef.version < right.profileRef.version ? -1 : left.profileRef.version > right.profileRef.version ? 1 : 0
    })
  }

  async insertProfileVersion(
    scopeRef: ScopeRef,
    record: ProfileVersionRecord,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = versionKey(scopeRef, record.profileRef)
    const existing = this.#versions.get(key)
    if (existing !== undefined) {
      if (existing.digest !== record.digest) {
        throw new ProfileStoreError(
          'VERSION_EXISTS',
          `profile ${record.profileRef.id}@${record.profileRef.version} is already published with a different digest`,
        )
      }
      return
    }
    this.#versions.set(key, structuredClone(record))
  }

  async findResolvedProfile(
    profileRef: ProfileRef,
    snapshotHash: Sha256Digest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#resolved.get(resolvedKey(scopeRef, profileRef, snapshotHash))
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async listResolvedProfiles(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = `${versionKey(scopeRef, profileRef)}\u0000`
    const out: ResolvedProfileRecord[] = []
    for (const [key, record] of this.#resolved) {
      if (key.startsWith(prefix)) out.push(structuredClone(record))
    }
    return out.sort((left, right) => (left.snapshotHash < right.snapshotHash ? -1 : left.snapshotHash > right.snapshotHash ? 1 : 0))
  }

  async insertResolvedProfile(
    scopeRef: ScopeRef,
    record: ResolvedProfileRecord,
    ctx: ToolContext,
  ): Promise<void> {
    resolveStoreScope(scopeRef, ctx)
    const key = resolvedKey(scopeRef, record.profileRef, record.snapshotHash)
    if (this.#resolved.has(key)) return
    this.#resolved.set(key, structuredClone(record))
  }

  async getActiveProfile(
    profileId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const stored = this.#active.get(`${scopePrefix(scopeRef)}${profileId}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async compareAndSetActiveProfile(
    scopeRef: ScopeRef,
    expectedRevision: RevisionString | null,
    activation: ProfileActivation,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord> {
    resolveStoreScope(scopeRef, ctx)
    const key = `${scopePrefix(scopeRef)}${activation.profileRef.id}`
    const current = this.#active.get(key)

    if (expectedRevision === null) {
      if (current !== undefined) {
        throw new ProfileStoreError(
          'REVISION_CONFLICT',
          `profile ${activation.profileRef.id} already has an active version`,
        )
      }
      const next: ActiveProfileRecord = { ...structuredClone(activation), revision: '1' }
      this.#active.set(key, next)
      return structuredClone(next)
    }

    if (current === undefined) {
      throw new ProfileStoreError(
        'NO_ACTIVE_PROFILE',
        `profile ${activation.profileRef.id} has no active version to update`,
      )
    }
    if (current.revision !== expectedRevision) {
      throw new ProfileStoreError(
        'REVISION_CONFLICT',
        `profile ${activation.profileRef.id} active revision ${current.revision} does not match ${expectedRevision}`,
      )
    }
    const next: ActiveProfileRecord = {
      ...structuredClone(activation),
      revision: String(Number(current.revision) + 1),
    }
    this.#active.set(key, next)
    return structuredClone(next)
  }
}
