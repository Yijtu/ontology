import type {
  DeploymentEnvironment,
  IndustryManifest,
  ProfileRef,
  ProfileSpec,
  ResolvedProfile,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Persistence and composition ports for scenario profiles (C1/C6, D2).
 *
 * These live next to `ComponentRegistryStore` so an adapter can implement them while
 * depending on `contracts` alone (SPEC §2: adapters → contracts). The application layer
 * receives them by construction injection and never imports an adapter or driver.
 */

/**
 * One immutable published profile version. `digest` pins exactly the ProfileSpec content,
 * so the same id+version with another digest is a conflict, never an overwrite. A binding
 * change is a new profile version (C1 module lifecycle).
 */
export interface ProfileVersionRecord {
  readonly profileRef: ProfileRef
  readonly spec: ProfileSpec
  readonly digest: Sha256Digest
  readonly environment: DeploymentEnvironment
  readonly createdAt: Rfc3339UtcTimestamp
  readonly createdBy: string
}

export interface ProfileListFilter {
  readonly environment?: DeploymentEnvironment
}

/**
 * The exact resolved manifest a preflight produced, archived under its content hash. It is
 * immutable: the resolved content, its exact versions/digests and the explicit
 * degradations cannot be rewritten after the fact, so a newer configuration never
 * changes an earlier manifest.
 */
export interface ResolvedProfileRecord {
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  readonly outputVersion: Semver
  readonly outputDigest: Sha256Digest
  readonly resolved: ResolvedProfile
  readonly checkedAt: Rfc3339UtcTimestamp
  readonly resolvedAt: Rfc3339UtcTimestamp
  readonly createdAt: Rfc3339UtcTimestamp
}

/**
 * The value of an activation. `revision` is assigned by the store, monotonically, so the
 * caller's If-Match expectation is a compare-and-set token rather than a last-write-wins
 * update.
 */
export interface ProfileActivation {
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  readonly activatedAt: Rfc3339UtcTimestamp
  readonly activatedBy: string
}

export interface ActiveProfileRecord extends ProfileActivation {
  readonly revision: RevisionString
}

export type ProfileStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'VERSION_EXISTS'
  | 'VERSION_NOT_FOUND'
  | 'RESOLVED_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'NO_ACTIVE_PROFILE'

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode

  constructor(code: ProfileStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProfileStoreError'
    this.code = code
  }
}

/**
 * Control persistence for profiles (D2). It keeps immutable profile versions, immutable
 * resolved manifests and the single active pointer per profile id, always inside the
 * trusted tenant/space scope.
 *
 * Implementations must make `compareAndSetActiveProfile` a compare-and-set on the revision
 * and must never overwrite a stored profile version or resolved manifest.
 */
export interface ProfileStore {
  findProfileVersion(
    ref: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord | undefined>
  listProfileVersions(
    scopeRef: ScopeRef,
    filter: ProfileListFilter,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord[]>
  insertProfileVersion(
    scopeRef: ScopeRef,
    record: ProfileVersionRecord,
    ctx: ToolContext,
  ): Promise<void>
  findResolvedProfile(
    profileRef: ProfileRef,
    snapshotHash: Sha256Digest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord | undefined>
  listResolvedProfiles(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord[]>
  insertResolvedProfile(
    scopeRef: ScopeRef,
    record: ResolvedProfileRecord,
    ctx: ToolContext,
  ): Promise<void>
  getActiveProfile(
    profileId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord | undefined>
  /**
   * Compare-and-set the active pointer. `expectedRevision === null` means "no active
   * profile is expected" (first activation). A stale expectation raises
   * `REVISION_CONFLICT`; a missing row raises `NO_ACTIVE_PROFILE`.
   */
  compareAndSetActiveProfile(
    scopeRef: ScopeRef,
    expectedRevision: RevisionString | null,
    activation: ProfileActivation,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord>
}

/**
 * Resolves the declarative industry manifest a ProfileSpec pins by reference. The pack is
 * data, not code: the composition root supplies it (from a published artifact or an
 * in-memory fixture) and the application layer never imports an industry pack.
 */
export interface IndustryManifestSource {
  getManifest(
    ref: VersionRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryManifest | undefined>
}
