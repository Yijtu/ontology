import { createHash } from 'node:crypto'
import { canRetireComponentVersion, canTransitionLifecycle, isToolContext } from '@ontology/contracts'
import type {
  BlobPort,
  ComponentVersionRecord,
  ControlAppendEventRequest,
  ControlRepository,
  FieldError,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { tryParseSemver } from '@ontology/contracts'
import { ComponentRegistryError } from './errors'
import { isSha256DigestValue, toFieldErrors, validateComponentManifestSemantics } from './manifest'
import type { ManifestValidator } from './manifest'
import { ComponentStoreError } from './store'
import type { ComponentLifecycleAudit, ComponentRegistryStore } from './store'
import {
  componentKeyFromRef,
  componentKeyOf,
  componentKeyString,
} from './types'
import type {
  ActiveComponentReference,
  ActiveComponentReferenceInput,
  ComponentKey,
  ComponentLifecycleEvent,
  ComponentListFilter,
  ComponentReferenceInput,
  RegisterComponentInput,
  RegistrationSource,
  TransitionComponentInput,
} from './types'

export interface ComponentRegistryDependencies {
  /** Durable, monotonic, idempotent event ledger (C1/D2). */
  readonly control: ControlRepository
  /** Immutable version projection, active references and lifecycle history. */
  readonly store: ComponentRegistryStore
  /** Authorizes the immutable artifact a registration points at. */
  readonly artifacts: BlobPort
  /** Canonical JSON-Schema validator, injected by the composition root. */
  readonly validator: ManifestValidator
  readonly now?: () => string
}

const INSTALLABLE_SOURCES: ReadonlySet<string> = new Set<RegistrationSource>(['operator'])
const RUN_REFERENCE_ROLES: readonly string[] = ['platform-admin', 'run-controller']

function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ComponentRegistryError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ComponentRegistryError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new ComponentRegistryError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

/**
 * Trust is the server-established principal's, never a manifest or request field. A
 * model-shaped object cannot reach this method with the brand, and a non-admin
 * principal cannot register or transition.
 */
function assertPlatformAdmin(ctx: ToolContext): void {
  if (!ctx.principal.roles.includes('platform-admin')) {
    throw new ComponentRegistryError(
      'FORBIDDEN',
      'component registration and lifecycle transitions require the platform-admin role',
    )
  }
}

function assertRunController(ctx: ToolContext): void {
  if (!RUN_REFERENCE_ROLES.some((role) => ctx.principal.roles.includes(role))) {
    throw new ComponentRegistryError('FORBIDDEN', 'the principal may not pin a component version to a run')
  }
}

function assertInstallableSource(source: RegistrationSource): void {
  if (!INSTALLABLE_SOURCES.has(source)) {
    throw new ComponentRegistryError(
      'DYNAMIC_INSTALL_FORBIDDEN',
      `registration source "${String(source)}" cannot install a component; only an explicit operator request may`,
    )
  }
}

function assertArtifactRefShape(ref: ResourceRef): void {
  const issues: FieldError[] = []
  if (ref.kind !== 'artifact') {
    issues.push({ pointer: '/artifactRef/kind', reason: 'artifactRef.kind must be artifact' })
  }
  if (typeof ref.id !== 'string' || ref.id.trim().length === 0) {
    issues.push({ pointer: '/artifactRef/id', reason: 'artifactRef.id must be a non-empty string' })
  }
  if (!isSha256DigestValue(ref.digest)) {
    issues.push({ pointer: '/artifactRef/digest', reason: 'artifactRef.digest must be sha256:<64 lowercase hex>' })
  }
  if (typeof ref.version !== 'string' || tryParseSemver(ref.version) === undefined) {
    issues.push({ pointer: '/artifactRef/version', reason: 'artifactRef.version must be a semver string' })
  }
  if (issues.length > 0) {
    throw new ComponentRegistryError(
      'INVALID_ARGUMENT',
      'artifactRef is not a valid immutable artifact reference',
      { fieldErrors: issues },
    )
  }
}

function sha256DigestOf(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function streamRefFor(key: ComponentKey): string {
  return `component:${key.kind}:${key.id}@${key.version}`
}

function lifecycleAudit(
  key: ComponentKey,
  digest: Sha256Digest,
  fromState: ModuleLifecycleState | null,
  toState: ModuleLifecycleState,
  occurredAt: string,
  actor: string,
): ComponentLifecycleAudit {
  const payload = JSON.stringify({
    kind: key.kind,
    id: key.id,
    version: key.version,
    digest,
    fromState,
    toState,
    occurredAt,
    actor,
  })
  return {
    fromState,
    toState,
    digest,
    payloadDigest: sha256DigestOf(payload),
    idempotencyKey: `component-lifecycle:${key.kind}:${key.id}:${key.version}:${toState}`,
    occurredAt,
    actor,
  }
}

function timestampFor(record: ComponentVersionRecord, state: ModuleLifecycleState): string {
  switch (state) {
    case 'registered':
      return record.registeredAt
    case 'validated':
      return record.validatedAt ?? record.registeredAt
    case 'active':
      return record.activatedAt ?? record.registeredAt
    case 'deprecated':
      return record.deprecatedAt ?? record.registeredAt
    case 'retired':
      return record.retiredAt ?? record.registeredAt
  }
}

function withLifecycleTimestamp(
  record: ComponentVersionRecord,
  to: ModuleLifecycleState,
  at: string,
): ComponentVersionRecord {
  switch (to) {
    case 'validated':
      return { ...record, lifecycleState: 'validated', validatedAt: at }
    case 'active':
      return { ...record, lifecycleState: 'active', activatedAt: at }
    case 'deprecated':
      return { ...record, lifecycleState: 'deprecated', deprecatedAt: at }
    case 'retired':
      return { ...record, lifecycleState: 'retired', retiredAt: at }
    case 'registered':
      throw new ComponentRegistryError(
        'ILLEGAL_TRANSITION',
        'registered is the initial lifecycle state and cannot be re-entered',
      )
  }
}

function versionConflict(key: ComponentKey): ComponentRegistryError {
  return new ComponentRegistryError(
    'VERSION_CONFLICT',
    `component ${key.kind}/${key.id}@${key.version} is already registered with a different digest`,
    {
      fieldErrors: [
        {
          pointer: '/digest',
          reason: 'a registered version is frozen; publish a new version instead of overwriting its digest',
        },
      ],
    },
  )
}

/**
 * Component registration, lifecycle and version freezing (C1, D2).
 *
 * The API operates on a manifest plus an immutable artifact reference only. It never
 * accepts bytes, a network URL or a filesystem path, and there is no code path that
 * fetches a package: an MCP discovery result or a model output is data, not an
 * install trigger. Registration and transitions require the platform-admin role.
 *
 * The same `id`+`version` with a different `digest` is rejected, an invalid manifest is
 * reported and never stored, and a version referenced by an active run cannot be
 * retired. Every state change is written to the immutable projection and appended to
 * the `ControlRepository` event ledger, so the full
 * `registered → validated → active → deprecated → retired` history is reconstructible
 * and cannot be rewritten.
 */
export class ComponentRegistry {
  readonly #control: ControlRepository
  readonly #store: ComponentRegistryStore
  readonly #artifacts: BlobPort
  readonly #validator: ManifestValidator
  readonly #now: () => string

  constructor(dependencies: ComponentRegistryDependencies) {
    this.#control = dependencies.control
    this.#store = dependencies.store
    this.#artifacts = dependencies.artifacts
    this.#validator = dependencies.validator
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async register(input: RegisterComponentInput, ctx: ToolContext): Promise<ComponentVersionRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertPlatformAdmin(ctx)
    assertInstallableSource(input.source)
    assertArtifactRefShape(input.artifactRef)

    const validation = this.#validator(input.manifest)
    const issues = validation.valid
      ? validateComponentManifestSemantics(input.manifest)
      : validation.issues
    if (issues.length > 0) {
      throw new ComponentRegistryError(
        'INVALID_MANIFEST',
        'the component manifest failed validation and was not registered',
        { fieldErrors: toFieldErrors(issues) },
      )
    }

    await this.#assertArtifactAuthorized(input.artifactRef, input.scopeRef, ctx)

    const key = componentKeyOf(input.manifest)
    const digest = input.manifest.digest
    const actor = ctx.principal.subjectId

    const existing = await this.#store.findVersion(key, input.scopeRef, ctx)
    if (existing !== undefined) {
      if (existing.manifestRef.digest !== digest) throw versionConflict(key)
      // Identical re-registration is idempotent. Re-appending the ledger event is a
      // no-op when it already exists and closes the gap if a previous attempt crashed
      // between the projection write and the ledger append.
      await this.#appendAudit(
        input.scopeRef,
        key,
        lifecycleAudit(key, digest, null, 'registered', existing.registeredAt, actor),
        ctx,
      )
      return existing
    }

    const occurredAt = this.#now()
    const record: ComponentVersionRecord = {
      manifestRef: { id: key.id, version: key.version, digest },
      manifest: input.manifest,
      lifecycleState: 'registered',
      registeredAt: occurredAt,
    }
    const audit = lifecycleAudit(key, digest, null, 'registered', occurredAt, actor)
    try {
      await this.#store.insertVersion(
        input.scopeRef,
        { record, artifactRef: input.artifactRef, audit },
        ctx,
      )
    } catch (error) {
      if (error instanceof ComponentStoreError && error.code === 'VERSION_EXISTS') {
        const raced = await this.#store.findVersion(key, input.scopeRef, ctx)
        if (raced !== undefined && raced.manifestRef.digest === digest) {
          await this.#appendAudit(
            input.scopeRef,
            key,
            lifecycleAudit(key, digest, null, 'registered', raced.registeredAt, actor),
            ctx,
          )
          return raced
        }
        throw versionConflict(key)
      }
      throw error
    }
    await this.#appendAudit(input.scopeRef, key, audit, ctx)
    return record
  }

  async transition(
    input: TransitionComponentInput,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertPlatformAdmin(ctx)

    const key = componentKeyFromRef(input.kind, input.ref)
    const actor = ctx.principal.subjectId
    const record = await this.#store.findVersion(key, input.scopeRef, ctx)
    if (record === undefined || record.manifestRef.digest !== input.ref.digest) {
      throw new ComponentRegistryError(
        'VERSION_NOT_FOUND',
        `component ${componentKeyString(key)} is not registered with digest ${input.ref.digest}`,
      )
    }

    const from = record.lifecycleState
    const to = input.to
    if (from === to) {
      await this.#appendAudit(
        input.scopeRef,
        key,
        lifecycleAudit(key, record.manifestRef.digest, from, to, timestampFor(record, to), actor),
        ctx,
      )
      return record
    }
    if (!canTransitionLifecycle(from, to)) {
      throw new ComponentRegistryError(
        'ILLEGAL_TRANSITION',
        `component ${componentKeyString(key)} cannot move from ${from} to ${to}`,
      )
    }
    if (to === 'retired') {
      const references = await this.#store.listActiveReferences(input.scopeRef, key, ctx)
      const activeRefs: VersionRef[] = references.map((reference) => ({
        id: reference.key.id,
        version: reference.key.version,
        digest: record.manifestRef.digest,
      }))
      if (references.length > 0 || !canRetireComponentVersion(record, activeRefs)) {
        throw new ComponentRegistryError(
          'ACTIVE_REFERENCE_EXISTS',
          `component ${componentKeyString(key)} is referenced by ${references.length} active run(s) and cannot be retired`,
          {
            fieldErrors: [
              {
                pointer: '/lifecycleState',
                reason: 'an active run pins this version; release every reference before retiring it',
              },
            ],
          },
        )
      }
    }

    const occurredAt = this.#now()
    const next = withLifecycleTimestamp(record, to, occurredAt)
    const audit = lifecycleAudit(key, record.manifestRef.digest, from, to, occurredAt, actor)
    try {
      await this.#store.applyTransition(input.scopeRef, key, from, next, audit, ctx)
    } catch (error) {
      if (error instanceof ComponentStoreError) {
        if (error.code === 'ACTIVE_REFERENCE_EXISTS') {
          throw new ComponentRegistryError(
            'ACTIVE_REFERENCE_EXISTS',
            `component ${componentKeyString(key)} is referenced by an active run and cannot be retired`,
          )
        }
        if (error.code === 'VERSION_NOT_FOUND') {
          throw new ComponentRegistryError(
            'VERSION_NOT_FOUND',
            `component ${componentKeyString(key)} is not registered`,
          )
        }
        if (error.code === 'CONCURRENT_MODIFICATION') {
          const current = await this.#store.findVersion(key, input.scopeRef, ctx)
          if (current !== undefined && current.lifecycleState === to) {
            await this.#appendAudit(
              input.scopeRef,
              key,
              lifecycleAudit(key, current.manifestRef.digest, from, to, timestampFor(current, to), actor),
              ctx,
            )
            return current
          }
          throw new ComponentRegistryError(
            'ILLEGAL_TRANSITION',
            `component ${componentKeyString(key)} changed concurrently to ${current?.lifecycleState ?? 'unknown'}`,
          )
        }
      }
      throw error
    }
    await this.#appendAudit(input.scopeRef, key, audit, ctx)
    return next
  }

  async getComponent(
    input: ComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord> {
    const { record } = await this.#requireVersion(input, ctx)
    return record
  }

  async listComponents(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.listVersions(scopeRef, filter, ctx)
  }

  /**
   * The usable set: only `active` versions are available, and a revoked publication is
   * excluded even if its state says active. A manifest that failed validation is never
   * in this set because it was never persisted.
   */
  async listAvailableComponents(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]> {
    resolveTrustedScope(scopeRef, ctx)
    const effective: ComponentListFilter = {
      lifecycleState: 'active',
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    }
    const records = await this.#store.listVersions(scopeRef, effective, ctx)
    return records.filter((record) => record.manifest.trustStatus !== 'revoked')
  }

  async acquireActiveReference(
    input: ActiveComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRunController(ctx)
    const { key, record } = await this.#requireVersion(input, ctx)
    if (record.lifecycleState === 'retired') {
      throw new ComponentRegistryError(
        'VERSION_RETIRED',
        `component ${componentKeyString(key)} is retired and cannot be referenced by a run`,
      )
    }
    return this.#store.acquireActiveReference(input.scopeRef, key, input.runId, ctx)
  }

  async releaseActiveReference(
    input: ActiveComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<boolean> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRunController(ctx)
    const key = componentKeyFromRef(input.kind, input.ref)
    return this.#store.releaseActiveReference(input.scopeRef, key, input.runId, ctx)
  }

  async listActiveReferences(
    input: ComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference[]> {
    const { key } = await this.#requireVersion(input, ctx)
    return this.#store.listActiveReferences(input.scopeRef, key, ctx)
  }

  /** Ordered append-only history; the lifecycle can be replayed from it. */
  async getAuditTrail(
    input: ComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<ComponentLifecycleEvent[]> {
    const { key } = await this.#requireVersion(input, ctx)
    return this.#store.listLifecycleEvents(input.scopeRef, key, ctx)
  }

  async #requireVersion(
    input: ComponentReferenceInput,
    ctx: ToolContext,
  ): Promise<{ key: ComponentKey; record: ComponentVersionRecord }> {
    resolveTrustedScope(input.scopeRef, ctx)
    const key = componentKeyFromRef(input.kind, input.ref)
    const record = await this.#store.findVersion(key, input.scopeRef, ctx)
    if (record === undefined || record.manifestRef.digest !== input.ref.digest) {
      throw new ComponentRegistryError(
        'VERSION_NOT_FOUND',
        `component ${componentKeyString(key)} is not registered with digest ${input.ref.digest}`,
      )
    }
    return { key, record }
  }

  async #assertArtifactAuthorized(
    artifactRef: ResourceRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<void> {
    try {
      const authorized = await this.#artifacts.getAuthorized({ scopeRef, blobRef: artifactRef }, ctx)
      if (authorized.contentDigest !== artifactRef.digest) {
        throw new ComponentRegistryError(
          'ARTIFACT_NOT_AUTHORIZED',
          `artifact ${artifactRef.id} does not match the authorized content digest`,
        )
      }
    } catch (error) {
      if (error instanceof ComponentRegistryError) throw error
      throw new ComponentRegistryError(
        'ARTIFACT_NOT_AUTHORIZED',
        `artifact ${artifactRef.id} is not authorized in the requested scope`,
        { cause: error },
      )
    }
  }

  async #appendAudit(
    scopeRef: ScopeRef,
    key: ComponentKey,
    audit: ComponentLifecycleAudit,
    ctx: ToolContext,
  ): Promise<void> {
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: streamRefFor(key),
      payloadDigest: audit.payloadDigest,
      idempotencyKey: audit.idempotencyKey,
    }
    try {
      await this.#control.appendEvent(request, ctx)
    } catch (error) {
      throw new ComponentRegistryError(
        'AUDIT_PERSIST_FAILED',
        `could not append the ${audit.toState} event for ${componentKeyString(key)} to the control ledger`,
        { cause: error },
      )
    }
  }
}
