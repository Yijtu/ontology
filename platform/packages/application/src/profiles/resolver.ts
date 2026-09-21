import {
  ProfileStoreError,
  findEmbeddedSecretViolations,
  hasWellFormedCapabilityRequirements,
  isToolContext,
  preflightProfile,
  tryParseSemver,
} from '@ontology/contracts'
import type {
  ActiveProfileRecord,
  ComponentRegistryStore,
  ControlAppendEventRequest,
  ControlRepository,
  IndustryManifestSource,
  PreflightResult,
  ProfileActivation,
  ProfileListFilter,
  ProfileRef,
  ProfileStore,
  ProfileVersionRecord,
  ResolvedProfile,
  ResolvedProfileRecord,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import { canonicalJson, profileSpecDigest, refKey, resolvedProfileDigest, sha256DigestOf } from './canonical'
import { availableComponentKeys, capabilitiesFromComponents, computeExplicitDegradations } from './degradations'
import { ProfileResolverError } from './errors'
import type {
  ActivateProfileInput,
  PreflightProfileInput,
  ProfileReferenceInput,
  PublishProfileInput,
  ResolvedProfileQuery,
} from './types'
import type { RunProfileBinding } from '../runs/types'
import type { ProfileSpecValidator } from './validator'

export interface ProfileResolverDependencies {
  /** Durable, monotonic, idempotent event ledger (C1/D2). */
  readonly control: ControlRepository
  /** Immutable profile versions, resolved manifests and the active pointer. */
  readonly store: ProfileStore
  /** Source of the exact registered component versions a profile resolves against. */
  readonly registry: ComponentRegistryStore
  /** Declarative industry manifest resolved by reference, never imported as code. */
  readonly industry: IndustryManifestSource
  /** Canonical JSON-Schema validator for the ProfileSpec boundary, supplied by the host. */
  readonly validator: ProfileSpecValidator
  readonly now?: () => string
}

const EDITOR_ROLES: readonly string[] = ['platform-admin', 'profile-editor']

function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProfileResolverError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProfileResolverError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new ProfileResolverError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function assertRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new ProfileResolverError('FORBIDDEN', `${action} requires one of the roles: ${roles.join(', ')}`)
  }
}

function assertProfileRef(ref: ProfileRef): void {
  if (typeof ref.id !== 'string' || ref.id.trim().length === 0) {
    throw new ProfileResolverError('INVALID_ARGUMENT', 'profileRef.id must be a non-empty string')
  }
  if (typeof ref.version !== 'string' || tryParseSemver(ref.version) === undefined) {
    throw new ProfileResolverError('INVALID_ARGUMENT', 'profileRef.version must be a semver string')
  }
}

function profileLabel(ref: ProfileRef): string {
  return `${ref.id}@${ref.version}`
}

function versionConflict(ref: ProfileRef, existingDigest: string | undefined): ProfileResolverError {
  return new ProfileResolverError(
    'VERSION_CONFLICT',
    `profile ${profileLabel(ref)} is already published with digest ${existingDigest ?? 'unknown'}`,
  )
}

/**
 * Replace the provisional output digest with the deterministic content hash of the
 * resolved manifest. The contract preflight cannot compute this itself (the hash covers
 * the resolved set), so the application layer attaches it after resolution. A failed
 * preflight is hashed over its explicit gap list so its output is versioned too.
 */
function finalizePreflight(
  result: PreflightResult,
  profileRef: ProfileRef,
  degradations: ResolvedProfile['explicitDegradations'],
): PreflightResult {
  if (result.status === 'resolved' && result.resolvedProfile !== undefined) {
    const withDegradations: ResolvedProfile = {
      ...result.resolvedProfile,
      explicitDegradations: degradations,
    }
    const snapshotHash = resolvedProfileDigest(profileRef, withDegradations)
    return {
      ...result,
      outputDigest: snapshotHash,
      resolvedProfile: { ...withDegradations, snapshotHash },
    }
  }
  const outputDigest = sha256DigestOf(
    canonicalJson({
      profileRef,
      status: result.status,
      missingCapabilities: result.missingCapabilities ?? [],
      incompatibleReasons: result.incompatibleReasons ?? [],
    }),
  )
  return { ...result, outputDigest }
}

/**
 * Scenario preflight, resolved-manifest persistence and CAS activation (C1/C6).
 *
 * Preflight checks every required capability of the industry manifest one by one and
 * returns the exact missing list; a required capability is never dropped by intersecting
 * it with what happens to be registered. The resolved manifest records exact
 * versions/digests for runtime, industry, mapping, backends, tools, models, compute and
 * policy plus a deterministic `snapshotHash`, and every allowed reduction is written into
 * `explicitDegradations` while unimplemented components stay `CAPABILITY_NOT_CONFIGURED`.
 *
 * A published profile version and a resolved manifest are immutable, so a newer profile
 * or component version never rewrites an earlier manifest. Activation is a compare-and-set
 * on the active revision (`If-Match`): a stale expectation conflicts and a missing one is
 * rejected. It also re-runs preflight first, so a manifest whose inputs changed cannot be
 * activated without being redone.
 */
export class ProfileResolver {
  readonly #control: ControlRepository
  readonly #store: ProfileStore
  readonly #registry: ComponentRegistryStore
  readonly #industry: IndustryManifestSource
  readonly #validator: ProfileSpecValidator
  readonly #now: () => string

  constructor(dependencies: ProfileResolverDependencies) {
    this.#control = dependencies.control
    this.#store = dependencies.store
    this.#registry = dependencies.registry
    this.#industry = dependencies.industry
    this.#validator = dependencies.validator
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async publish(input: PublishProfileInput, ctx: ToolContext): Promise<ProfileVersionRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, EDITOR_ROLES, 'publishing a profile version')
    assertProfileRef(input.profileRef)

    const validation = this.#validator(input.spec)
    if (!validation.valid) {
      throw new ProfileResolverError(
        'INVALID_ARGUMENT',
        `profile ${profileLabel(input.profileRef)} failed schema validation and was not published: ${validation.issues
          .map((issue) => `${issue.pointer} ${issue.message}`)
          .join('; ')}`,
      )
    }

    const violations = findEmbeddedSecretViolations(input.spec)
    if (violations.length > 0) {
      throw new ProfileResolverError(
        'INVALID_ARGUMENT',
        `profile ${profileLabel(input.profileRef)} carries a secret, URL or credential and was not published: ${violations
          .map((violation) => `${violation.path} (${violation.code})`)
          .join(', ')}`,
      )
    }

    const digest = profileSpecDigest(input.spec)
    const actor = ctx.principal.subjectId
    const existing = await this.#store.findProfileVersion(input.profileRef, input.scopeRef, ctx)
    if (existing !== undefined) {
      if (existing.digest !== digest) throw versionConflict(input.profileRef, existing.digest)
      await this.#appendAudit(input.scopeRef, input.profileRef, 'publish', existing.digest, existing.createdAt, actor, ctx)
      return existing
    }

    const createdAt = this.#now()
    const record: ProfileVersionRecord = {
      profileRef: input.profileRef,
      spec: input.spec,
      digest,
      environment: input.environment,
      createdAt,
      createdBy: actor,
    }
    try {
      await this.#store.insertProfileVersion(input.scopeRef, record, ctx)
    } catch (error) {
      if (error instanceof ProfileStoreError && error.code === 'VERSION_EXISTS') {
        const raced = await this.#store.findProfileVersion(input.profileRef, input.scopeRef, ctx)
        if (raced !== undefined && raced.digest === digest) {
          await this.#appendAudit(input.scopeRef, input.profileRef, 'publish', raced.digest, raced.createdAt, actor, ctx)
          return raced
        }
        throw versionConflict(input.profileRef, raced?.digest)
      }
      throw error
    }
    await this.#appendAudit(input.scopeRef, input.profileRef, 'publish', digest, createdAt, actor, ctx)
    return record
  }

  async preflight(input: PreflightProfileInput, ctx: ToolContext): Promise<PreflightResult> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, EDITOR_ROLES, 'preflighting a profile')
    const result = await this.#resolve(input.scopeRef, input.profileRef, ctx)
    if (result.status === 'resolved' && result.resolvedProfile !== undefined) {
      await this.#persistResolved(input.scopeRef, input.profileRef, result, ctx)
    }
    return result
  }

  async activate(input: ActivateProfileInput, ctx: ToolContext): Promise<ActiveProfileRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, EDITOR_ROLES, 'activating a profile')
    if (input.expectedRevision === undefined) {
      throw new ProfileResolverError(
        'REVISION_REQUIRED',
        'activating a profile requires an If-Match expected revision',
      )
    }

    await this.#requireProfileVersion(input.profileRef, input.scopeRef, ctx)
    const stored = await this.#store.findResolvedProfile(
      input.profileRef,
      input.snapshotHash,
      input.scopeRef,
      ctx,
    )
    if (stored === undefined) {
      throw new ProfileResolverError(
        'SNAPSHOT_UNAVAILABLE',
        `no resolved manifest ${input.snapshotHash} for profile ${profileLabel(input.profileRef)}; run preflight again`,
      )
    }
    if (stored.resolved.snapshotHash !== input.snapshotHash) {
      throw new ProfileResolverError(
        'SNAPSHOT_UNAVAILABLE',
        `resolved manifest ${input.snapshotHash} for profile ${profileLabel(input.profileRef)} is inconsistent with its content hash`,
      )
    }

    // Inputs may have changed since the preflight was produced. Re-resolving and comparing
    // the content hash is the "激活前若输入变更要重做" rule: an unchanged set hashes
    // identically, anything else blocks the stale activation.
    const fresh = await this.#resolve(input.scopeRef, input.profileRef, ctx)
    if (
      fresh.status !== 'resolved' ||
      fresh.resolvedProfile === undefined ||
      fresh.resolvedProfile.snapshotHash !== input.snapshotHash
    ) {
      throw new ProfileResolverError(
        'PROFILE_INCOMPATIBLE',
        `profile ${profileLabel(input.profileRef)} changed since preflight; the resolved manifest is stale and must be redone`,
        {
          ...(fresh.missingCapabilities === undefined
            ? {}
            : { missingCapabilities: fresh.missingCapabilities }),
          ...(fresh.incompatibleReasons === undefined
            ? {}
            : { incompatibleReasons: fresh.incompatibleReasons }),
        },
      )
    }

    const activation: ProfileActivation = {
      profileRef: input.profileRef,
      snapshotHash: input.snapshotHash,
      activatedAt: this.#now(),
      activatedBy: ctx.principal.subjectId,
    }
    let active: ActiveProfileRecord
    try {
      active = await this.#store.compareAndSetActiveProfile(
        input.scopeRef,
        input.expectedRevision,
        activation,
        ctx,
      )
    } catch (error) {
      if (error instanceof ProfileStoreError) {
        if (error.code === 'REVISION_CONFLICT' || error.code === 'NO_ACTIVE_PROFILE') {
          throw new ProfileResolverError(
            'VERSION_CONFLICT',
            `the active revision of profile ${input.profileRef.id} changed; refresh and retry`,
            { cause: error },
          )
        }
        if (error.code === 'SCOPE_MISMATCH') {
          throw new ProfileResolverError('SCOPE_MISMATCH', error.message, { cause: error })
        }
      }
      throw error
    }

    await this.#appendAudit(
      input.scopeRef,
      input.profileRef,
      'activate',
      input.snapshotHash,
      activation.activatedAt,
      activation.activatedBy,
      ctx,
      active.revision,
    )
    return active
  }

  /**
   * Resolve (and persist) the exact manifest a run binds to. Unlike `preflight` this is not
   * an editing action: a business user may bind the published profile their run uses, but
   * cannot publish, preflight or activate one. The returned `resolvedProfileHash` is what the
   * run locks immutably, so a later profile or component version never alters that run.
   */
  async bindRunProfile(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RunProfileBinding> {
    resolveTrustedScope(scopeRef, ctx)
    const result = await this.#resolve(scopeRef, profileRef, ctx)
    const resolved = result.resolvedProfile
    if (result.status !== 'resolved' || resolved === undefined) {
      const missing = result.missingCapabilities ?? []
      const reasons = result.incompatibleReasons ?? []
      throw new ProfileResolverError(
        result.status === 'incompatible' ? 'PROFILE_INCOMPATIBLE' : 'CAPABILITY_NOT_CONFIGURED',
        `profile ${profileLabel(profileRef)} cannot be bound to a run (${result.status})${
          missing.length > 0 ? `: missing ${missing.map((entry) => entry.name).join(', ')}` : ''
        }${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}`,
        {
          ...(result.missingCapabilities === undefined
            ? {}
            : { missingCapabilities: result.missingCapabilities }),
          ...(result.incompatibleReasons === undefined
            ? {}
            : { incompatibleReasons: result.incompatibleReasons }),
        },
      )
    }
    await this.#persistResolved(scopeRef, profileRef, result, ctx)
    return {
      profileRef,
      resolvedProfileHash: resolved.snapshotHash,
      resolvedProfileRef: {
        id: profileRef.id,
        version: profileRef.version,
        snapshotHash: resolved.snapshotHash,
      },
      runtimeRef: resolved.runtimeRef,
    }
  }

  async getProfileVersion(input: ProfileReferenceInput, ctx: ToolContext): Promise<ProfileVersionRecord> {
    return this.#requireProfileVersion(input.profileRef, input.scopeRef, ctx)
  }

  async listProfileVersions(
    scopeRef: ScopeRef,
    filter: ProfileListFilter,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord[]> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.listProfileVersions(scopeRef, filter, ctx)
  }

  async getResolvedProfile(
    input: ResolvedProfileQuery,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    const record = await this.#store.findResolvedProfile(
      input.profileRef,
      input.snapshotHash,
      input.scopeRef,
      ctx,
    )
    if (record === undefined) {
      throw new ProfileResolverError(
        'SNAPSHOT_UNAVAILABLE',
        `no resolved manifest ${input.snapshotHash} for profile ${profileLabel(input.profileRef)}`,
      )
    }
    return record
  }

  async getActiveProfile(
    scopeRef: ScopeRef,
    profileId: string,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord | undefined> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.getActiveProfile(profileId, scopeRef, ctx)
  }

  async #requireProfileVersion(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord> {
    resolveTrustedScope(scopeRef, ctx)
    const record = await this.#store.findProfileVersion(profileRef, scopeRef, ctx)
    if (record === undefined) {
      throw new ProfileResolverError(
        'PROFILE_NOT_FOUND',
        `profile ${profileLabel(profileRef)} is not published in this scope`,
      )
    }
    return record
  }

  async #resolve(scopeRef: ScopeRef, profileRef: ProfileRef, ctx: ToolContext): Promise<PreflightResult> {
    const profileRecord = await this.#requireProfileVersion(profileRef, scopeRef, ctx)
    const industryManifest = await this.#industry.getManifest(
      profileRecord.spec.industryRef,
      scopeRef,
      ctx,
    )
    if (industryManifest === undefined) {
      throw new ProfileResolverError(
        'CAPABILITY_NOT_CONFIGURED',
        `industry manifest ${refKey(profileRecord.spec.industryRef)} is not configured in this scope`,
      )
    }

    const checkedAt = this.#now()
    if (!hasWellFormedCapabilityRequirements(industryManifest.requiredCapabilities)) {
      return {
        status: 'incompatible',
        profileRef,
        outputVersion: profileRef.version,
        outputDigest: sha256DigestOf(
          canonicalJson({ profileRef, reason: 'malformed-required-capabilities' }),
        ),
        checkedAt,
        incompatibleReasons: ['industry manifest declares no well-formed required capability'],
      }
    }

    const components = await this.#registry.listVersions(scopeRef, {}, ctx)
    const availableCapabilities = capabilitiesFromComponents(components)
    const availableComponents = availableComponentKeys(components)
    const degradations = computeExplicitDegradations(profileRecord.spec, availableComponents)

    const provisional = sha256DigestOf(canonicalJson({ profileRef, digest: profileRecord.digest }))
    const result = preflightProfile({
      profileRef,
      profile: profileRecord.spec,
      industryManifest,
      components,
      availableCapabilities,
      outputVersion: profileRef.version,
      outputDigest: provisional,
      snapshotHash: provisional,
      checkedAt,
      resolvedAt: checkedAt,
    })
    return finalizePreflight(result, profileRef, degradations)
  }

  async #persistResolved(
    scopeRef: ScopeRef,
    profileRef: ProfileRef,
    result: PreflightResult,
    ctx: ToolContext,
  ): Promise<void> {
    const resolved = result.resolvedProfile
    if (resolved === undefined) return
    const record: ResolvedProfileRecord = {
      profileRef,
      snapshotHash: resolved.snapshotHash,
      outputVersion: result.outputVersion,
      outputDigest: result.outputDigest,
      resolved,
      checkedAt: result.checkedAt,
      resolvedAt: resolved.resolvedAt,
      createdAt: this.#now(),
    }
    await this.#store.insertResolvedProfile(scopeRef, record, ctx)
  }

  async #appendAudit(
    scopeRef: ScopeRef,
    profileRef: ProfileRef,
    action: 'publish' | 'activate',
    digest: Sha256Digest,
    occurredAt: string,
    actor: string,
    ctx: ToolContext,
    revision?: string,
  ): Promise<void> {
    const payload = {
      profileRef,
      action,
      digest,
      revision: revision ?? null,
      occurredAt,
      actor,
    }
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: `profile:${profileRef.id}`,
      payloadDigest: sha256DigestOf(canonicalJson(payload)),
      idempotencyKey:
        revision === undefined
          ? `profile-${action}:${profileRef.id}:${profileRef.version}:${digest}`
          : `profile-${action}:${profileRef.id}:${profileRef.version}:${digest}:${revision}`,
    }
    try {
      await this.#control.appendEvent(request, ctx)
    } catch (error) {
      throw new ProfileResolverError(
        'AUDIT_PERSIST_FAILED',
        `could not append the ${action} event for profile ${profileLabel(profileRef)} to the control ledger`,
        { cause: error },
      )
    }
  }
}
