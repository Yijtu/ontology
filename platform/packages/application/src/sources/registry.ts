import { randomUUID } from 'node:crypto'
import {
  SourceStoreError,
  isToolContext,
  satisfiesContractRange,
  tryParseSemver,
} from '@ontology/contracts'
import type {
  Capability,
  ControlAppendEventRequest,
  ControlRepository,
  LogicalRole,
  MappingRef,
  ProbeCapability,
  ScopeRef,
  SecretResolver,
  SecretValue,
  SourceBindingRecord,
  SourceFingerprint,
  SourceKind,
  SourcePreflightBindingRecord,
  SourceProbeAdapterResolver,
  SourceProbeJobCompletion,
  SourceProbeJobRecord,
  SourceProbeObservation,
  SourceStatus,
  SourceStore,
  SourceVersionRecord,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { SourceRegistryError } from './errors'
import type {
  AssessSourcePreflightInput,
  ModelSourceContext,
  ModelSourceSummary,
  ProbeSourceInput,
  ProbeJobQueryInput,
  RecordSourcePreflightInput,
  RegisterSourceInput,
  ReviseSourceInput,
  SourceConfigEntry,
  SourceConfigExport,
  SourcePreflightFreshness,
  SourceQueryInput,
} from './types'

const DATA_EDITOR_ROLES: readonly string[] = ['platform-admin', 'data-editor']
const SOURCE_KINDS: readonly SourceKind[] = ['read_only_origin', 'imported']
const LOGICAL_ROLES: readonly LogicalRole[] = ['telemetry', 'catalog', 'documents']
const SECRET_REF_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s]+$/i

const REGISTER_KEYS = new Set([
  'scopeRef',
  'kind',
  'role',
  'adapterRef',
  'secretRef',
  'mappingRef',
  'capabilityVersion',
])
const REVISE_KEYS = new Set(['scopeRef', 'sourceId', 'version', 'capabilityVersion', 'mappingRef'])
const PROBE_KEYS = new Set(['scopeRef', 'sourceId', 'capabilities'])
const QUERY_KEYS = new Set(['scopeRef', 'sourceId'])
const JOB_KEYS = new Set(['scopeRef', 'jobId'])
const RECORD_PREFLIGHT_KEYS = new Set(['scopeRef', 'profileRef', 'snapshotHash', 'roles'])
const ASSESS_PREFLIGHT_KEYS = new Set(['scopeRef', 'profileRef', 'snapshotHash'])

export interface SourceRegistryDependencies {
  /** Durable, idempotent event ledger (C1/D2). */
  readonly control: ControlRepository
  readonly store: SourceStore
  readonly secrets: SecretResolver
  readonly adapters: SourceProbeAdapterResolver
  readonly now?: () => string
  readonly newId?: () => string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject any field the caller is not allowed to send. This is the identity boundary: a
 * request cannot smuggle `principal`, `roles`, `tenantId` or `allowedResources` in beside
 * the declared inputs, so the effective identity always comes from the trusted context.
 */
function assertKnownFields(input: unknown, allowed: ReadonlySet<string>, action: string): void {
  if (!isPlainObject(input)) {
    throw new SourceRegistryError('INVALID_ARGUMENT', `${action} requires an object argument`)
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new SourceRegistryError(
        'INVALID_ARGUMENT',
        `${action} received an unexpected field "${key}"; identity and scope come from the trusted context only`,
      )
    }
  }
}

function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new SourceRegistryError('UNAUTHENTICATED', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SourceRegistryError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new SourceRegistryError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

function assertRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new SourceRegistryError('FORBIDDEN', `${action} requires one of the roles: ${roles.join(', ')}`)
  }
}

function assertSecretRef(secretRef: string): void {
  if (typeof secretRef !== 'string' || !SECRET_REF_PATTERN.test(secretRef)) {
    throw new SourceRegistryError(
      'INVALID_ARGUMENT',
      'secretRef must be an opaque reference such as "secret://vault/name"; a raw secret value is not accepted',
    )
  }
}

function assertAdapterRef(adapterRef: VersionRef): void {
  if (
    !isPlainObject(adapterRef) ||
    typeof adapterRef.id !== 'string' ||
    adapterRef.id.length === 0 ||
    typeof adapterRef.version !== 'string' ||
    tryParseSemver(adapterRef.version) === undefined ||
    typeof adapterRef.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(adapterRef.digest)
  ) {
    throw new SourceRegistryError('INVALID_ARGUMENT', 'adapterRef must be a well-formed {id,version,digest}')
  }
}

function assertSemver(value: string, field: string): void {
  if (tryParseSemver(value) === undefined) {
    throw new SourceRegistryError('INVALID_ARGUMENT', `${field} must be a semver string`)
  }
}

function assertMappingRole(mappingRef: MappingRef | undefined, role: LogicalRole): void {
  if (mappingRef === undefined) return
  if (!isPlainObject(mappingRef) || mappingRef.role !== role) {
    throw new SourceRegistryError('INVALID_ARGUMENT', `mappingRef.role must match the source role ${role}`)
  }
}

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameMappingRef(left: MappingRef | undefined, right: MappingRef | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sourceVersionDigest(input: {
  readonly sourceId: string
  readonly version: string
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  readonly capabilityVersion: string
  readonly mappingRef?: MappingRef
}): string {
  return sha256DigestOf(
    canonicalJson({
      sourceId: input.sourceId,
      version: input.version,
      kind: input.kind,
      role: input.role,
      adapterRef: input.adapterRef,
      capabilityVersion: input.capabilityVersion,
      mappingRef: input.mappingRef ?? null,
    }),
  )
}

function mapStoreError(error: unknown, sourceId: string): SourceRegistryError {
  if (error instanceof SourceStoreError) {
    if (error.code === 'SOURCE_NOT_FOUND') {
      return new SourceRegistryError('SOURCE_NOT_FOUND', error.message, { cause: error })
    }
    if (error.code === 'SCOPE_MISMATCH') {
      return new SourceRegistryError('SCOPE_MISMATCH', error.message, { cause: error })
    }
    if (error.code === 'VERSION_EXISTS' || error.code === 'REVISION_CONFLICT') {
      return new SourceRegistryError('VERSION_CONFLICT', error.message, { cause: error })
    }
  }
  return new SourceRegistryError('SOURCE_UNAVAILABLE', `source ${sourceId} storage call failed`, {
    cause: error,
  })
}

/** Internal consistency of an observation. Any doubt means the probe is not trustworthy. */
function inspectObservation(observation: SourceProbeObservation, expected: VersionRef): string[] {
  const reasons: string[] = []
  if (!sameVersionRef(observation.adapterRef, expected)) {
    reasons.push('the probe answered for a different adapter version than the binding declares')
  }
  if (observation.capabilities.length === 0) {
    reasons.push('the probe confirmed no capability')
  }
  if (observation.supportedDataTypes.length === 0) {
    reasons.push('the probe confirmed no supported data type')
  }
  const limits = observation.limits
  if (limits.maxRows <= 0 || limits.maxBytes <= 0 || limits.maxDurationMs <= 0) {
    reasons.push('the probe reported non-positive limits')
  }
  if (observation.pagination.kind !== 'none' && observation.pagination.pagesFetched < 1) {
    reasons.push('the probe claims pagination without fetching a page')
  }
  if (observation.cancellation.support === 'supported' && !observation.cancellation.attempted) {
    reasons.push('the probe claims cancellation support without attempting a cancel')
  }
  if (observation.catalog.schemaRevision !== observation.snapshot.schemaRevision) {
    reasons.push('the probe reported inconsistent schema revisions')
  }
  return reasons
}

function composeCapabilities(observation: SourceProbeObservation): Capability[] {
  return observation.capabilities.map((capability: ProbeCapability): Capability => ({
    name: capability.name,
    version: capability.version,
    limits: observation.limits,
    consistency: observation.snapshot.consistency,
    cancellation: observation.cancellation.support,
    pagination: observation.pagination.kind,
    supportedDataTypes: [...observation.supportedDataTypes],
  }))
}

/**
 * Source registration and trusted capability probing (SPEC C3/C6, D2; US-008/009).
 *
 * Registration is refs-only and never opens a connection; a probe is what actually
 * exercises the injected adapter. A probe that fails, that is internally inconsistent or
 * that cannot satisfy the requested capability subset leaves the binding `failed`, never
 * `ready`. The resolved secret is used only at the point of use, and every message the
 * service emits is scrubbed of it.
 *
 * A source version pins the adapter, mapping and capability version. Recording the exact
 * fingerprints a preflight observed lets a later change invalidate that preflight instead
 * of silently reinterpreting it.
 */
export class SourceRegistry {
  readonly #control: ControlRepository
  readonly #store: SourceStore
  readonly #secrets: SecretResolver
  readonly #adapters: SourceProbeAdapterResolver
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: SourceRegistryDependencies) {
    this.#control = dependencies.control
    this.#store = dependencies.store
    this.#secrets = dependencies.secrets
    this.#adapters = dependencies.adapters
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => randomUUID())
  }

  async registerSource(input: RegisterSourceInput, ctx: ToolContext): Promise<SourceBindingRecord> {
    assertKnownFields(input, REGISTER_KEYS, 'registering a source')
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, DATA_EDITOR_ROLES, 'registering a source')
    if (!SOURCE_KINDS.includes(input.kind)) {
      throw new SourceRegistryError('INVALID_ARGUMENT', `kind must be one of: ${SOURCE_KINDS.join(', ')}`)
    }
    if (!LOGICAL_ROLES.includes(input.role)) {
      throw new SourceRegistryError('INVALID_ARGUMENT', `role must be one of: ${LOGICAL_ROLES.join(', ')}`)
    }
    assertAdapterRef(input.adapterRef)
    assertSecretRef(input.secretRef)
    assertMappingRole(input.mappingRef, input.role)
    if (input.capabilityVersion !== undefined) assertSemver(input.capabilityVersion, 'capabilityVersion')

    const sourceId = this.#newId()
    const version = '1.0.0'
    const capabilityVersion = input.capabilityVersion ?? input.mappingRef?.version ?? '1.0.0'
    assertSemver(capabilityVersion, 'capabilityVersion')
    const createdAt = this.#now()
    const actor = ctx.principal.subjectId
    const digest = sourceVersionDigest({
      sourceId,
      version,
      kind: input.kind,
      role: input.role,
      adapterRef: input.adapterRef,
      capabilityVersion,
      ...(input.mappingRef === undefined ? {} : { mappingRef: input.mappingRef }),
    })

    const binding: SourceBindingRecord = {
      sourceId,
      scopeRef: input.scopeRef,
      kind: input.kind,
      role: input.role,
      adapterRef: input.adapterRef,
      secretRef: input.secretRef,
      status: 'registered',
      currentVersion: version,
      capabilityVersion,
      revision: '1',
      createdAt,
      createdBy: actor,
      updatedAt: createdAt,
    }
    const versionRecord: SourceVersionRecord = {
      sourceId,
      version,
      digest,
      capabilityVersion,
      ...(input.mappingRef === undefined ? {} : { mappingRef: input.mappingRef }),
      registeredAt: createdAt,
      registeredBy: actor,
    }

    try {
      await this.#store.insertBinding(input.scopeRef, binding, ctx)
      await this.#store.insertVersion(input.scopeRef, versionRecord, ctx)
    } catch (error) {
      throw mapStoreError(error, sourceId)
    }
    await this.#appendAudit(input.scopeRef, sourceId, 'register', version, digest, actor, ctx)
    return binding
  }

  async reviseSource(input: ReviseSourceInput, ctx: ToolContext): Promise<SourceBindingRecord> {
    assertKnownFields(input, REVISE_KEYS, 'revising a source')
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, DATA_EDITOR_ROLES, 'revising a source')
    assertSemver(input.version, 'version')
    assertSemver(input.capabilityVersion, 'capabilityVersion')

    const binding = await this.#requireBinding(input.sourceId, input.scopeRef, ctx)
    assertMappingRole(input.mappingRef, binding.role)

    const digest = sourceVersionDigest({
      sourceId: binding.sourceId,
      version: input.version,
      kind: binding.kind,
      role: binding.role,
      adapterRef: binding.adapterRef,
      capabilityVersion: input.capabilityVersion,
      ...(input.mappingRef === undefined ? {} : { mappingRef: input.mappingRef }),
    })
    const existing = await this.#store.findVersion(binding.sourceId, input.version, input.scopeRef, ctx)
    if (existing !== undefined && existing.digest !== digest) {
      throw new SourceRegistryError(
        'VERSION_CONFLICT',
        `source ${binding.sourceId}@${input.version} already exists with a different digest`,
      )
    }
    if (existing === undefined) {
      const record: SourceVersionRecord = {
        sourceId: binding.sourceId,
        version: input.version,
        digest,
        capabilityVersion: input.capabilityVersion,
        ...(input.mappingRef === undefined ? {} : { mappingRef: input.mappingRef }),
        registeredAt: this.#now(),
        registeredBy: ctx.principal.subjectId,
      }
      try {
        await this.#store.insertVersion(input.scopeRef, record, ctx)
      } catch (error) {
        throw mapStoreError(error, binding.sourceId)
      }
    }

    if (binding.currentVersion === input.version && binding.capabilityVersion === input.capabilityVersion) {
      return binding
    }

    // A new version invalidates any earlier probe: the source must be probed again before it
    // can be `ready`, so a preflight that pinned the old version is visibly stale.
    const updated = await this.#applyUpdate(input.scopeRef, binding, ctx, {
      status: 'registered',
      currentVersion: input.version,
      capabilityVersion: input.capabilityVersion,
    })
    await this.#appendAudit(
      input.scopeRef,
      binding.sourceId,
      'revise',
      input.version,
      digest,
      ctx.principal.subjectId,
      ctx,
    )
    return updated
  }

  async probeSource(input: ProbeSourceInput, ctx: ToolContext): Promise<SourceProbeJobRecord> {
    assertKnownFields(input, PROBE_KEYS, 'probing a source')
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, DATA_EDITOR_ROLES, 'probing a source')
    const binding = await this.#requireBinding(input.sourceId, input.scopeRef, ctx)
    const requested = input.capabilities ?? []
    for (const requirement of requested) {
      if (
        !isPlainObject(requirement) ||
        typeof requirement.name !== 'string' ||
        requirement.name.length === 0 ||
        !isPlainObject(requirement.versionRange)
      ) {
        throw new SourceRegistryError('INVALID_ARGUMENT', 'capabilities must be well-formed requirements')
      }
    }

    const jobId = this.#newId()
    const job: SourceProbeJobRecord = {
      jobId,
      sourceId: binding.sourceId,
      status: 'pending',
      requestedCapabilities: requested,
      createdAt: this.#now(),
    }
    await this.#store.insertProbeJob(input.scopeRef, job, ctx)

    let secret: SecretValue
    try {
      secret = await this.#secrets.resolve(binding.secretRef, ctx)
    } catch {
      // The resolver failed before returning a value, so the service has nothing it could
      // scrub. Emit a fixed, server-authored message instead of the resolver's own text.
      return this.#finishFailed(
        input.scopeRef,
        binding,
        ctx,
        jobId,
        'SOURCE_UNAVAILABLE',
        'the source secret reference could not be resolved',
      )
    }

    const versionRecord = await this.#store.findVersion(
      binding.sourceId,
      binding.currentVersion,
      input.scopeRef,
      ctx,
    )
    const probing = await this.#applyUpdate(input.scopeRef, binding, ctx, { status: 'probing' })
    let observation: SourceProbeObservation
    try {
      const adapter = await this.#adapters.resolve(binding.adapterRef, ctx)
      if (adapter === undefined) {
        return this.#finishFailed(
          input.scopeRef,
          probing,
          ctx,
          jobId,
          'CAPABILITY_NOT_CONFIGURED',
          `no probe adapter is configured for ${binding.adapterRef.id}@${binding.adapterRef.version}`,
        )
      }
      observation = await adapter.probe(
        {
          role: binding.role,
          secretRef: binding.secretRef,
          secret,
          requestedCapabilities: requested,
          ...(versionRecord?.mappingRef === undefined ? {} : { mappingRef: versionRecord.mappingRef }),
        },
        ctx,
      )
    } catch (error) {
      return this.#finishFailed(input.scopeRef, probing, ctx, jobId, 'SOURCE_UNAVAILABLE', secret.redact(safeMessageOf(error)))
    }

    const reasons = inspectObservation(observation, binding.adapterRef)
    if (reasons.length > 0) {
      return this.#finishFailed(input.scopeRef, probing, ctx, jobId, 'SOURCE_UNAVAILABLE', reasons.join('; '))
    }

    const capabilities = composeCapabilities(observation)
    const missing = requested.filter(
      (requirement) =>
        !capabilities.some(
          (capability) =>
            capability.name === requirement.name &&
            satisfiesContractRange(requirement.versionRange, capability.version),
        ),
    )
    if (missing.length > 0) {
      return this.#finishFailed(
        input.scopeRef,
        probing,
        ctx,
        jobId,
        'CAPABILITY_NOT_CONFIGURED',
        `the source does not support the requested capabilities: ${missing.map((entry) => entry.name).join(', ')}`,
      )
    }

    const updated = await this.#applyUpdate(input.scopeRef, probing, ctx, { status: 'ready' })
    const completed = await this.#completeJob(
      input.scopeRef,
      jobId,
      {
        status: 'succeeded',
        completedAt: this.#now(),
        capabilities,
        schemaRevision: observation.snapshot.schemaRevision,
      },
      ctx,
    )
    await this.#appendAudit(
      input.scopeRef,
      updated.sourceId,
      'probe',
      updated.currentVersion,
      sha256DigestOf(canonicalJson({ jobId, capabilities: capabilities.map((c) => `${c.name}@${c.version}`) })),
      ctx.principal.subjectId,
      ctx,
      jobId,
    )
    return completed
  }

  async getSource(input: SourceQueryInput, ctx: ToolContext): Promise<SourceBindingRecord> {
    assertKnownFields(input, QUERY_KEYS, 'reading a source')
    resolveTrustedScope(input.scopeRef, ctx)
    return this.#requireBinding(input.sourceId, input.scopeRef, ctx)
  }

  async listSources(scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord[]> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.listBindings(scopeRef, ctx)
  }

  async getProbeJob(input: ProbeJobQueryInput, ctx: ToolContext): Promise<SourceProbeJobRecord> {
    assertKnownFields(input, JOB_KEYS, 'reading a probe job')
    resolveTrustedScope(input.scopeRef, ctx)
    const job = await this.#store.findProbeJob(input.jobId, input.scopeRef, ctx)
    if (job === undefined) {
      throw new SourceRegistryError('SOURCE_NOT_FOUND', `probe job ${input.jobId} is not visible in this scope`)
    }
    return job
  }

  /** Refs-only export. The `secretRef` is an opaque reference; the resolved value never appears. */
  async exportConfig(scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceConfigExport> {
    resolveTrustedScope(scopeRef, ctx)
    const bindings = await this.#store.listBindings(scopeRef, ctx)
    const sources: SourceConfigEntry[] = []
    for (const binding of bindings) {
      const version = await this.#store.findVersion(binding.sourceId, binding.currentVersion, scopeRef, ctx)
      sources.push({
        sourceId: binding.sourceId,
        kind: binding.kind,
        role: binding.role,
        adapterRef: binding.adapterRef,
        secretRef: binding.secretRef,
        status: binding.status,
        currentVersion: binding.currentVersion,
        ...(binding.capabilityVersion === undefined ? {} : { capabilityVersion: binding.capabilityVersion }),
        revision: binding.revision,
        ...(version?.mappingRef === undefined ? {} : { mappingRef: version.mappingRef }),
      })
    }
    return { scopeRef, exportedAt: this.#now(), sources }
  }

  /**
   * The model-facing view: identity, role, status and confirmed capability names only. No
   * `secretRef`, no mapping object and no physical addressing, so a secret cannot reach a
   * model context.
   */
  async buildModelContext(scopeRef: ScopeRef, ctx: ToolContext): Promise<ModelSourceContext> {
    resolveTrustedScope(scopeRef, ctx)
    const bindings = await this.#store.listBindings(scopeRef, ctx)
    const sources: ModelSourceSummary[] = []
    for (const binding of bindings) {
      const jobs = await this.#store.listProbeJobs(binding.sourceId, scopeRef, ctx)
      const latest = jobs
        .filter((job) => job.status === 'succeeded' && job.capabilities !== undefined)
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))[0]
      sources.push({
        sourceId: binding.sourceId,
        kind: binding.kind,
        role: binding.role,
        status: binding.status,
        capabilities: (latest?.capabilities ?? []).map((capability) => ({
          name: capability.name,
          version: capability.version,
        })),
      })
    }
    return { sources }
  }

  /**
   * Record the exact source fingerprints a resolved preflight observed. Called after a
   * preflight resolves; the fingerprints let a later mapping/capability change invalidate it.
   */
  async recordPreflight(input: RecordSourcePreflightInput, ctx: ToolContext): Promise<void> {
    assertKnownFields(input, RECORD_PREFLIGHT_KEYS, 'recording a source preflight')
    resolveTrustedScope(input.scopeRef, ctx)
    const fingerprints = await this.#fingerprints(input.scopeRef, input.roles, ctx)
    const record: SourcePreflightBindingRecord = {
      profileRef: input.profileRef,
      snapshotHash: input.snapshotHash,
      fingerprints,
      recordedAt: this.#now(),
      recordedBy: ctx.principal.subjectId,
    }
    await this.#store.insertPreflightBinding(input.scopeRef, record, ctx)
  }

  /**
   * A resolved preflight is fresh only when every source it observed is still `ready` and
   * still has the same adapter/mapping/capability version. Any change, or a missing record,
   * marks it stale and requires a re-preflight.
   */
  async assessPreflight(
    input: AssessSourcePreflightInput,
    ctx: ToolContext,
  ): Promise<SourcePreflightFreshness> {
    assertKnownFields(input, ASSESS_PREFLIGHT_KEYS, 'assessing a source preflight')
    resolveTrustedScope(input.scopeRef, ctx)
    const checkedAt = this.#now()
    const recorded = await this.#store.findPreflightBinding(
      input.profileRef,
      input.snapshotHash,
      input.scopeRef,
      ctx,
    )
    if (recorded === undefined) {
      return {
        status: 'stale',
        checkedAt,
        reasons: ['no source binding was recorded for this preflight; run preflight again'],
      }
    }
    const roles = recorded.fingerprints.map((fingerprint) => fingerprint.role)
    const current = await this.#fingerprints(input.scopeRef, roles, ctx)
    const bySourceId = new Map(current.map((fingerprint) => [fingerprint.sourceId, fingerprint]))
    const reasons: string[] = []
    for (const previous of recorded.fingerprints) {
      const now = bySourceId.get(previous.sourceId)
      if (now === undefined) {
        reasons.push(`source ${previous.sourceId} for role ${previous.role} is no longer registered`)
        continue
      }
      if (now.status !== 'ready') {
        reasons.push(`source ${now.sourceId} for role ${now.role} is ${now.status}, not ready`)
        continue
      }
      if (!sameVersionRef(now.adapterRef, previous.adapterRef)) {
        reasons.push(`source ${now.sourceId} for role ${now.role} changed its adapter version`)
      }
      if (now.capabilityVersion !== previous.capabilityVersion) {
        reasons.push(`source ${now.sourceId} for role ${now.role} changed its capability version`)
      }
      if (!sameMappingRef(now.mappingRef, previous.mappingRef)) {
        reasons.push(`source ${now.sourceId} for role ${now.role} changed its mapping version`)
      }
      if (now.sourceDigest !== previous.sourceDigest) {
        reasons.push(`source ${now.sourceId} for role ${now.role} changed its source version`)
      }
    }
    return reasons.length === 0 ? { status: 'fresh', checkedAt } : { status: 'stale', checkedAt, reasons }
  }

  /** Activation guard: throw `PREFLIGHT_STALE` instead of letting a stale manifest activate. */
  async requireFreshPreflight(
    input: AssessSourcePreflightInput,
    ctx: ToolContext,
  ): Promise<SourcePreflightFreshness> {
    const freshness = await this.assessPreflight(input, ctx)
    if (freshness.status === 'stale') {
      throw new SourceRegistryError(
        'PREFLIGHT_STALE',
        'the resolved profile is stale against its source bindings and must be preflighted again',
        { reasons: freshness.reasons },
      )
    }
    return freshness
  }

  async #requireBinding(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord> {
    const binding = await this.#store.findBinding(sourceId, scopeRef, ctx)
    if (binding === undefined) {
      throw new SourceRegistryError('SOURCE_NOT_FOUND', `source ${sourceId} is not registered in this scope`)
    }
    return binding
  }

  async #fingerprints(
    scopeRef: ScopeRef,
    roles: readonly LogicalRole[],
    ctx: ToolContext,
  ): Promise<SourceFingerprint[]> {
    const bindings = await this.#store.listBindings(scopeRef, ctx)
    const wanted = new Set(roles)
    const out: SourceFingerprint[] = []
    for (const binding of bindings) {
      if (!wanted.has(binding.role)) continue
      const version = await this.#store.findVersion(binding.sourceId, binding.currentVersion, scopeRef, ctx)
      out.push({
        role: binding.role,
        sourceId: binding.sourceId,
        status: binding.status,
        sourceVersion: binding.currentVersion,
        sourceDigest: version?.digest ?? sha256DigestOf(canonicalJson({ sourceId: binding.sourceId })),
        adapterRef: binding.adapterRef,
        ...(binding.capabilityVersion === undefined
          ? {}
          : { capabilityVersion: binding.capabilityVersion }),
        ...(version?.mappingRef === undefined ? {} : { mappingRef: version.mappingRef }),
      })
    }
    return out
  }

  async #applyUpdate(
    scopeRef: ScopeRef,
    binding: SourceBindingRecord,
    ctx: ToolContext,
    patch: {
      readonly status: SourceStatus
      readonly currentVersion?: string
      readonly capabilityVersion?: string
    },
  ): Promise<SourceBindingRecord> {
    try {
      return await this.#store.applyBindingUpdate(
        scopeRef,
        binding.sourceId,
        {
          expectedRevision: binding.revision,
          status: patch.status,
          updatedAt: this.#now(),
          ...(patch.currentVersion === undefined ? {} : { currentVersion: patch.currentVersion }),
          ...(patch.capabilityVersion === undefined
            ? {}
            : { capabilityVersion: patch.capabilityVersion }),
        },
        ctx,
      )
    } catch (error) {
      throw mapStoreError(error, binding.sourceId)
    }
  }

  async #finishFailed(
    scopeRef: ScopeRef,
    binding: SourceBindingRecord,
    ctx: ToolContext,
    jobId: string,
    errorCode: 'SOURCE_UNAVAILABLE' | 'CAPABILITY_NOT_CONFIGURED',
    safeMessage: string,
  ): Promise<SourceProbeJobRecord> {
    await this.#applyUpdate(scopeRef, binding, ctx, { status: 'failed' })
    const completed = await this.#completeJob(
      scopeRef,
      jobId,
      {
        status: 'failed',
        completedAt: this.#now(),
        errorCode,
        safeMessage,
      },
      ctx,
    )
    await this.#appendAudit(
      scopeRef,
      binding.sourceId,
      'probe',
      binding.currentVersion,
      sha256DigestOf(canonicalJson({ jobId, errorCode })),
      ctx.principal.subjectId,
      ctx,
      jobId,
    )
    return completed
  }

  async #completeJob(
    scopeRef: ScopeRef,
    jobId: string,
    completion: SourceProbeJobCompletion,
    ctx: ToolContext,
  ): Promise<SourceProbeJobRecord> {
    try {
      return await this.#store.completeProbeJob(scopeRef, jobId, completion, ctx)
    } catch (error) {
      throw mapStoreError(error, jobId)
    }
  }

  async #appendAudit(
    scopeRef: ScopeRef,
    sourceId: string,
    action: 'register' | 'revise' | 'probe',
    version: string,
    digest: string,
    actor: string,
    ctx: ToolContext,
    jobId?: string,
  ): Promise<void> {
    const payload = { sourceId, action, version, digest, jobId: jobId ?? null, actor }
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: `source:${sourceId}`,
      payloadDigest: sha256DigestOf(canonicalJson(payload)),
      idempotencyKey:
        jobId === undefined
          ? `source-${action}:${sourceId}:${version}:${digest}`
          : `source-${action}:${sourceId}:${jobId}`,
    }
    try {
      await this.#control.appendEvent(request, ctx)
    } catch (error) {
      throw new SourceRegistryError(
        'AUDIT_PERSIST_FAILED',
        `could not append the ${action} event for source ${sourceId} to the control ledger`,
        { cause: error },
      )
    }
  }
}

function safeMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the source probe failed'
}
