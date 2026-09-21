import { describe, expect, it } from 'vitest'
import {
  InMemoryComponentRegistryStore,
  InMemoryIndustryManifestSource,
  InMemoryProfileStore,
  ProfileResolver,
  ProfileResolverError,
  canonicalJson,
} from '@ontology/application'
import type {
  ComponentKey,
  ComponentLifecycleAudit,
  ComponentVersionRecord,
  IndustryManifest,
  ModuleLifecycleState,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  RecordingControlRepository,
  fixedClock,
  toolContext,
} from './component-registry-fixtures'
import {
  BACKEND_REFS,
  COMPUTE_HANDLER_REF,
  DECISION_MODEL_REF,
  GENERATION_MODEL_REF,
  INDUSTRY_REF,
  POLICY_REF,
  RUNTIME_REF,
  SCOPE_A,
  SCOPE_B,
  canonicalProfileValidator,
  homeEnergyIndustryManifest,
  componentRecord,
  registeredComponents,
  sampleProfileSpec,
  seedComponents,
} from './profile-resolver-fixtures'

const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const PROFILE_REF_V2: ProfileRef = { id: 'home-energy-demo', version: '2.0.0' }

const ADMIN_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'editor-a')
const ADMIN_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'editor-b')
const VIEWER_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'viewer-a')

interface SetupOptions {
  readonly components?: readonly ComponentVersionRecord[]
  readonly industryManifest?: IndustryManifest
  readonly omitIndustryManifest?: boolean
  readonly startMs?: number
}

async function setup(options: SetupOptions = {}) {
  const control = new RecordingControlRepository()
  const store = new InMemoryProfileStore()
  const registry = new InMemoryComponentRegistryStore()
  const industry = new InMemoryIndustryManifestSource()
  if (options.omitIndustryManifest !== true) {
    industry.register(INDUSTRY_REF, options.industryManifest ?? homeEnergyIndustryManifest())
  }
  const resolver = new ProfileResolver({
    control,
    store,
    registry,
    industry,
    validator: canonicalProfileValidator(),
    now: fixedClock(options.startMs ?? Date.UTC(2026, 8, 21, 0, 0, 0)),
  })
  await seedComponents(registry, options.components ?? registeredComponents(), SCOPE_A, ADMIN_A)
  return { control, store, registry, industry, resolver }
}

async function resolveSample(
  options: SetupOptions = {},
): Promise<Awaited<ReturnType<typeof setup>> & { readonly result: PreflightResult }> {
  const context = await setup(options)
  await context.resolver.publish(
    { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
    ADMIN_A,
  )
  const result = await context.resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
  return { ...context, result }
}

function capture(run: () => Promise<unknown>): Promise<ProfileResolverError> {
  return run().then(
    () => {
      throw new Error('expected the profile call to fail')
    },
    (error: unknown) => {
      if (error instanceof ProfileResolverError) return error
      throw error
    },
  )
}

function requireResolved(result: PreflightResult): NonNullable<PreflightResult['resolvedProfile']> {
  if (result.resolvedProfile === undefined) throw new Error('expected a resolved profile')
  return result.resolvedProfile
}

/** Move a seeded component version through the lifecycle projection. */
async function transition(
  registry: InMemoryComponentRegistryStore,
  scopeRef: ScopeRef,
  key: ComponentKey,
  record: ComponentVersionRecord,
  to: ModuleLifecycleState,
  ctx: ToolContext,
): Promise<void> {
  const audit: ComponentLifecycleAudit = {
    fromState: record.lifecycleState,
    toState: to,
    digest: record.manifestRef.digest,
    payloadDigest: `sha256:${'0'.repeat(64)}`,
    idempotencyKey: `transition:${key.id}:${key.version}:${to}`,
    occurredAt: '2026-09-21T00:05:00Z',
    actor: ctx.principal.subjectId,
  }
  await registry.applyTransition(
    scopeRef,
    key,
    record.lifecycleState,
    { ...record, lifecycleState: to },
    audit,
    ctx,
  )
}

async function requireVersion(
  registry: InMemoryComponentRegistryStore,
  scopeRef: ScopeRef,
  key: ComponentKey,
  ctx: ToolContext,
): Promise<ComponentVersionRecord> {
  const record = await registry.findVersion(key, scopeRef, ctx)
  if (record === undefined) throw new Error(`component ${key.id}@${key.version} is missing`)
  return record
}

describe('preflight checks every required capability one by one (C1, US-002)', () => {
  it('resolves each required capability to an exact version and digest', async () => {
    const { result } = await resolveSample()
    expect(result.status).toBe('resolved')
    const resolved = requireResolved(result)
    expect(resolved.resolvedCapabilities.map((capability) => capability.name).sort()).toEqual([
      'compute.home-energy.plan',
      'document_search',
      'structured_query',
      'telemetry_read',
    ])
    for (const capability of resolved.resolvedCapabilities) {
      expect(capability.sourceComponentRef.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(capability.sourceComponentRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    expect(resolved.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('reports a missing required capability explicitly instead of dropping it', async () => {
    const components = registeredComponents().filter((record) => record.manifestRef.id !== 'data-duckdb')
    const { result } = await resolveSample({ components })
    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name)).toEqual(['telemetry_read'])
    expect(result.missingCapabilities?.map((entry) => entry.name)).not.toContain('structured_query')
    expect(result.resolvedProfile).toBeUndefined()
  })

  it('keeps every required capability in the gap list when only some are available', async () => {
    const components = registeredComponents().filter(
      (record) =>
        record.manifestRef.id !== 'data-duckdb' && record.manifestRef.id !== 'search-bm25',
    )
    const { result } = await resolveSample({ components })
    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name).sort()).toEqual([
      'document_search',
      'telemetry_read',
    ])
  })

  it('reports a capability whose exact version is out of the declared range', async () => {
    const components = registeredComponents().filter((record) => record.manifestRef.id !== 'data-postgres')
    components.push(
      componentRecord({
        kind: 'data_backend',
        id: 'data-postgres',
        version: '2.5.0',
        digest: BACKEND_REFS.catalog.digest,
        provides: [{ name: 'structured_query', version: '2.5.0' }],
      }),
    )
    const { result } = await resolveSample({ components })
    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name)).toEqual(['structured_query'])
  })

  it('refuses a bound version that is retired instead of resolving it', async () => {
    const components = registeredComponents().map((record) =>
      record.manifestRef.id === 'runtime-template'
        ? { ...record, lifecycleState: 'retired' as const }
        : record,
    )
    const { result } = await resolveSample({ components })
    expect(result.status).toBe('incompatible')
    expect(result.incompatibleReasons?.some((reason) => reason.includes('retired'))).toBe(true)
  })

  it('rejects an industry manifest with no well-formed required capability', async () => {
    const manifest: IndustryManifest = { ...homeEnergyIndustryManifest(), requiredCapabilities: [] }
    const { result } = await resolveSample({ industryManifest: manifest })
    expect(result.status).toBe('incompatible')
    expect(result.resolvedProfile).toBeUndefined()
  })

  it('fails with CAPABILITY_NOT_CONFIGURED when the industry manifest is absent', async () => {
    const { resolver } = await setup({ omitIndustryManifest: true })
    await resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
      ADMIN_A,
    )
    const error = await capture(() =>
      resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A),
    )
    expect(error.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(error.httpStatus).toBe(409)
  })
})

describe('resolved manifest captures exact versions and a deterministic hash (C1)', () => {
  it('preserves every declared reference exactly', async () => {
    const { result } = await resolveSample()
    const resolved = requireResolved(result)
    const spec = sampleProfileSpec()
    expect(resolved.industryRef).toEqual(spec.industryRef)
    expect(resolved.runtimeRef).toEqual(spec.runtimeRef)
    expect(resolved.policyRef).toEqual(spec.policyRef)
    expect(resolved.mappingRefs).toEqual(spec.mappingRefs)
    expect(resolved.backendBindings).toEqual(spec.backendBindings)
    expect(resolved.modelBindings).toEqual(spec.modelBindings)
    expect(resolved.toolBindings).toEqual(spec.toolBindings)
    expect(resolved.computeBindings).toEqual(spec.computeBindings)

    const resolvedIds = new Set(resolved.resolvedVersions.map((ref) => ref.id))
    for (const ref of [
      INDUSTRY_REF,
      RUNTIME_REF,
      POLICY_REF,
      BACKEND_REFS.catalog,
      BACKEND_REFS.documents,
      BACKEND_REFS.telemetry,
      GENERATION_MODEL_REF,
      DECISION_MODEL_REF,
      COMPUTE_HANDLER_REF,
    ]) {
      expect(resolvedIds.has(ref.id), ref.id).toBe(true)
    }
    for (const mapping of spec.mappingRefs) expect(resolvedIds.has(mapping.id)).toBe(true)
  })

  it('hashes an identical resolved set identically, regardless of wall-clock time', async () => {
    const first = await resolveSample({ startMs: Date.UTC(2026, 8, 21, 0, 0, 0) })
    const second = await resolveSample({ startMs: Date.UTC(2027, 0, 1, 12, 30, 0) })
    expect(requireResolved(second.result).snapshotHash).toBe(requireResolved(first.result).snapshotHash)
    expect(requireResolved(first.result).resolvedAt).not.toBe(requireResolved(second.result).resolvedAt)
  })

  it('hashes a different resolved set differently', async () => {
    const first = await resolveSample()
    const components = registeredComponents().map((record) =>
      record.manifestRef.id === 'data-postgres' ? { ...record, manifestRef: { ...record.manifestRef, version: '1.1.0' } } : record,
    )
    const second = await resolveSample({ components })
    expect(requireResolved(second.result).snapshotHash).not.toBe(requireResolved(first.result).snapshotHash)
  })
})

describe('explicit degradations and not_configured visibility (FR-32, US-023)', () => {
  it('records disabled bindings as explicit degradations and never as available', async () => {
    const { result } = await resolveSample()
    const resolved = requireResolved(result)
    const byCapability = new Map(
      resolved.explicitDegradations.map((degradation) => [degradation.capability, degradation]),
    )
    expect(byCapability.get('model:decision')).toMatchObject({
      reason: 'CAPABILITY_NOT_CONFIGURED',
      fallback: 'deterministic',
    })
    expect(byCapability.get('tool:web_search')).toMatchObject({
      reason: 'CAPABILITY_NOT_CONFIGURED',
      fallback: 'none',
    })
    const availableNames = resolved.resolvedCapabilities.map((capability) => capability.name)
    expect(availableNames).not.toContain('model:decision')
    expect(availableNames).not.toContain('tool:web_search')
  })

  it('keeps an unimplemented component visible as not_configured and never substitutes it', async () => {
    const spec = sampleProfileSpec()
    const { resolver } = await setup()
    await resolver.publish(
      {
        scopeRef: SCOPE_A,
        profileRef: PROFILE_REF,
        spec: {
          ...spec,
          backendBindings: {
            ...spec.backendBindings,
            telemetry: {
              role: 'telemetry',
              adapterRef: { id: 'data-ha', version: '1.0.0', digest: `sha256:${'9'.repeat(64)}` },
              mappingRef: 'home-energy.mapping.ha-anker',
            },
          },
        },
        environment: 'local_dev',
      },
      ADMIN_A,
    )
    const result = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    const resolved = requireResolved(result)
    const telemetryBackend = resolved.explicitDegradations.find(
      (degradation) => degradation.capability === 'backend:telemetry',
    )
    expect(telemetryBackend).toMatchObject({
      reason: 'CAPABILITY_NOT_CONFIGURED',
      fallback: 'none',
    })
    const telemetryCapability = resolved.resolvedCapabilities.find(
      (capability) => capability.name === 'telemetry_read',
    )
    expect(telemetryCapability?.sourceComponentRef.id).toBe('data-duckdb')
    expect(
      resolved.resolvedCapabilities.some(
        (capability) => capability.sourceComponentRef.id === 'data-ha',
      ),
    ).toBe(false)
  })

  it('records an unconfigured model binding as not_configured', async () => {
    const components = registeredComponents().filter((record) => record.manifestRef.id !== 'company-llm')
    const { result } = await resolveSample({ components })
    const resolved = requireResolved(result)
    expect(
      resolved.explicitDegradations.find((degradation) => degradation.capability === 'model:generation'),
    ).toMatchObject({ reason: 'CAPABILITY_NOT_CONFIGURED', fallback: 'reject' })
  })
})

describe('activation is a compare-and-set (C6)', () => {
  it('rejects activation with a missing If-Match expectation', async () => {
    const { resolver, result } = await resolveSample()
    const error = await capture(() =>
      resolver.activate(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: requireResolved(result).snapshotHash },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('REVISION_REQUIRED')
    expect(error.httpStatus).toBe(428)
  })

  it('activates once from an empty expectation and rejects a stale repeat', async () => {
    const { resolver, result } = await resolveSample()
    const snapshotHash = requireResolved(result).snapshotHash
    const first = await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
      ADMIN_A,
    )
    expect(first.revision).toBe('1')

    const stale = await capture(() =>
      resolver.activate(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
        ADMIN_A,
      ),
    )
    expect(stale.code).toBe('VERSION_CONFLICT')
    expect(stale.httpStatus).toBe(409)

    const second = await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: '1' },
      ADMIN_A,
    )
    expect(second.revision).toBe('2')

    const staleAgain = await capture(() =>
      resolver.activate(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: '1' },
        ADMIN_A,
      ),
    )
    expect(staleAgain.code).toBe('VERSION_CONFLICT')
  })

  it('refuses to activate a manifest that was never resolved', async () => {
    const { resolver } = await setup()
    await resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
      ADMIN_A,
    )
    const error = await capture(() =>
      resolver.activate(
        {
          scopeRef: SCOPE_A,
          profileRef: PROFILE_REF,
          snapshotHash: `sha256:${'7'.repeat(64)}`,
          expectedRevision: null,
        },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('SNAPSHOT_UNAVAILABLE')
  })

  it('refuses to activate a stale manifest when inputs changed after preflight', async () => {
    const { resolver, registry, result } = await resolveSample()
    const snapshotHash = requireResolved(result).snapshotHash
    const key: ComponentKey = { kind: 'runtime', id: 'runtime-template', version: '1.0.0' }
    const record = await requireVersion(registry, SCOPE_A, key, ADMIN_A)
    await transition(registry, SCOPE_A, key, record, 'deprecated', ADMIN_A)
    const deprecated = await requireVersion(registry, SCOPE_A, key, ADMIN_A)
    await transition(registry, SCOPE_A, key, deprecated, 'retired', ADMIN_A)

    const error = await capture(() =>
      resolver.activate(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('PROFILE_INCOMPATIBLE')
    expect(error.httpStatus).toBe(409)
  })
})

describe('new configuration never rewrites an earlier resolved manifest (US-023)', () => {
  it('leaves an earlier manifest byte-identical when a newer component version is published', async () => {
    const { resolver, registry, store, result } = await resolveSample()
    const firstHash = requireResolved(result).snapshotHash
    const before = await store.findResolvedProfile(PROFILE_REF, firstHash, SCOPE_A, ADMIN_A)
    if (before === undefined) throw new Error('the resolved manifest was not persisted')
    const beforeJson = canonicalJson(before.resolved)

    await seedComponents(
      registry,
      [
        componentRecord({
          kind: 'data_backend',
          id: 'data-postgres',
          version: '1.1.0',
          digest: `sha256:${'1'.repeat(64)}`,
          provides: [{ name: 'structured_query', version: '1.1.0' }],
        }),
      ],
      SCOPE_A,
      ADMIN_A,
    )
    const key: ComponentKey = { kind: 'data_backend', id: 'data-postgres', version: '1.0.0' }
    const previous = await requireVersion(registry, SCOPE_A, key, ADMIN_A)
    await transition(registry, SCOPE_A, key, previous, 'deprecated', ADMIN_A)

    const second = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    expect(requireResolved(second).snapshotHash).not.toBe(firstHash)
    expect(
      requireResolved(second).resolvedCapabilities.find(
        (capability) => capability.name === 'structured_query',
      )?.sourceComponentRef.version,
    ).toBe('1.1.0')

    const after = await store.findResolvedProfile(PROFILE_REF, firstHash, SCOPE_A, ADMIN_A)
    if (after === undefined) throw new Error('the earlier resolved manifest disappeared')
    expect(canonicalJson(after.resolved)).toBe(beforeJson)
  })

  it('leaves an earlier manifest untouched when a newer profile version is published', async () => {
    const { resolver, store, result } = await resolveSample()
    const firstHash = requireResolved(result).snapshotHash
    const before = await store.findResolvedProfile(PROFILE_REF, firstHash, SCOPE_A, ADMIN_A)
    if (before === undefined) throw new Error('the resolved manifest was not persisted')
    const beforeJson = canonicalJson(before.resolved)

    const specV2 = sampleProfileSpec()
    await resolver.publish(
      {
        scopeRef: SCOPE_A,
        profileRef: PROFILE_REF_V2,
        spec: {
          ...specV2,
          toolBindings: specV2.toolBindings.map((binding) =>
            binding.toolId === 'web_search' ? { ...binding, enabled: true } : binding,
          ),
        },
        environment: 'local_dev',
      },
      ADMIN_A,
    )

    const v1 = await resolver.getProfileVersion({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    expect(canonicalJson(v1.spec)).toBe(canonicalJson(sampleProfileSpec()))
    const after = await store.findResolvedProfile(PROFILE_REF, firstHash, SCOPE_A, ADMIN_A)
    if (after === undefined) throw new Error('the earlier resolved manifest disappeared')
    expect(canonicalJson(after.resolved)).toBe(beforeJson)
  })
})

describe('publish validation, isolation and audit (C1/D2)', () => {
  it('rejects a profile that fails canonical schema validation', async () => {
    const { resolver } = await setup()
    const invalid = sampleProfileSpec()
    delete (invalid as Partial<ProfileSpec>).runtimeRef
    const error = await capture(() =>
      resolver.publish(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: invalid, environment: 'local_dev' },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.httpStatus).toBe(400)
  })

  it('rejects a profile that carries a URL or credential', async () => {
    const { resolver } = await setup()
    const spec = sampleProfileSpec()
    const error = await capture(() =>
      resolver.publish(
        {
          scopeRef: SCOPE_A,
          profileRef: PROFILE_REF,
          spec: {
            ...spec,
            mappingRefs: spec.mappingRefs.map((mapping) => ({
              ...mapping,
              sourceObjectRef: {
                ...mapping.sourceObjectRef,
                objectPath: 'https://user:secret@db.example/prod',
              },
            })),
          },
          environment: 'local_dev',
        },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.httpStatus).toBe(400)
  })

  it('rejects a principal without the profile-editor role', async () => {
    const { resolver } = await setup()
    const error = await capture(() =>
      resolver.publish(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
        VIEWER_A,
      ),
    )
    expect(error.code).toBe('FORBIDDEN')
  })

  it('keeps profile versions inside the tenant/space boundary', async () => {
    const { resolver } = await resolveSample()
    expect(await resolver.listProfileVersions(SCOPE_B, {}, ADMIN_B)).toEqual([])
    const error = await capture(() =>
      resolver.getProfileVersion({ scopeRef: SCOPE_B, profileRef: PROFILE_REF }, ADMIN_B),
    )
    expect(error.code).toBe('PROFILE_NOT_FOUND')
  })

  it('appends an idempotent audit event for publish and activation', async () => {
    const { control, resolver, result } = await resolveSample()
    const snapshotHash = requireResolved(result).snapshotHash
    await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
      ADMIN_A,
    )
    const streams = new Set(control.appended.map((event) => event.streamRef))
    expect(streams.has(`profile:${PROFILE_REF.id}`)).toBe(true)
    const keys = control.appended.map((event) => event.idempotencyKey)
    expect(keys.some((key) => key.startsWith('profile-publish:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('profile-activate:'))).toBe(true)

    const appends = control.appended.length
    await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: '1' },
      ADMIN_A,
    )
    await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: '1' },
      ADMIN_A,
    ).catch(() => undefined)
    expect(control.appended.length).toBe(appends + 1)
  })
})

describe('reference stores reject a mismatched trusted scope', () => {
  it('refuses a scope that disagrees with the trusted context', async () => {
    const { resolver } = await setup()
    const error = await capture(() =>
      resolver.listProfileVersions(SCOPE_A, {}, toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'x')),
    )
    expect(error.code).toBe('SCOPE_MISMATCH')
  })
})
