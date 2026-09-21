import { describe, expect, it } from 'vitest'
import {
  ComponentRegistry,
  ComponentRegistryError,
  InMemoryComponentRegistryStore,
} from '@ontology/application'
import type {
  ComponentListFilter,
  ComponentVersionRecord,
  RegistrationSource,
} from '@ontology/application'
import type {
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  DIGEST_A,
  DIGEST_B,
  FakeBlobPort,
  RecordingControlRepository,
  RUN_A,
  RUN_B,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  canonicalManifestValidator,
  fixedClock,
  sampleArtifactRef,
  sampleManifest,
  toolContext,
} from './component-registry-fixtures'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }
const ADMIN_A = toolContext(TENANT_A, SPACE_A, ['platform-admin'])
const ADMIN_B = toolContext(TENANT_B, SPACE_B, ['platform-admin'])
const RUN_CONTROLLER = toolContext(TENANT_A, SPACE_A, ['run-controller'], 'runner')
const NO_ROLES = toolContext(TENANT_A, SPACE_A, [], 'nobody')

interface Harness {
  readonly registry: ComponentRegistry
  readonly store: InMemoryComponentRegistryStore
  readonly control: RecordingControlRepository
  readonly blobs: FakeBlobPort
}

function setup(): Harness {
  const clock = fixedClock()
  const store = new InMemoryComponentRegistryStore({ now: clock })
  const control = new RecordingControlRepository()
  const blobs = new FakeBlobPort()
  const registry = new ComponentRegistry({
    control,
    store,
    artifacts: blobs,
    validator: canonicalManifestValidator(),
    now: clock,
  })
  return { registry, store, control, blobs }
}

async function captureError(run: () => Promise<unknown>): Promise<ComponentRegistryError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ComponentRegistryError) return error
    throw error
  }
  throw new Error('expected the registry call to fail')
}

async function register(
  harness: Harness,
  overrides?: Parameters<typeof sampleManifest>[0],
  ctx: ToolContext = ADMIN_A,
  scopeRef: ScopeRef = SCOPE_A,
): Promise<ComponentVersionRecord> {
  const manifest = sampleManifest(overrides)
  const artifactRef = sampleArtifactRef(manifest.digest)
  harness.blobs.authorize(artifactRef)
  return harness.registry.register(
    { scopeRef, manifest, artifactRef, source: 'operator' },
    ctx,
  )
}

async function advanceTo(
  registry: ComponentRegistry,
  ref: VersionRef,
  target: ModuleLifecycleState,
  ctx: ToolContext = ADMIN_A,
): Promise<void> {
  const order: ModuleLifecycleState[] = ['validated', 'active', 'deprecated', 'retired']
  for (const state of order) {
    await registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref, to: state }, ctx)
    if (state === target) return
  }
}

const REF = { id: 'telemetry-pg', version: '1.0.0', digest: DIGEST_A } satisfies VersionRef

describe('component manifest validation', () => {
  it('reports an invalid manifest with field errors and never persists it', async () => {
    const harness = setup()

    const badRange = sampleManifest({ contractRange: { min: '2.0.0', max: '1.0.0' } })
    const badRangeArtifact = sampleArtifactRef(badRange.digest)
    harness.blobs.authorize(badRangeArtifact)
    const rangeError = await captureError(() =>
      harness.registry.register(
        { scopeRef: SCOPE_A, manifest: badRange, artifactRef: badRangeArtifact, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(rangeError.code).toBe('INVALID_MANIFEST')
    expect(rangeError.fieldErrors?.some((field) => field.pointer === '/contractRange')).toBe(true)

    const urlEntrypoint = sampleManifest({
      entrypointRef: { kind: 'package', ref: 'https://example.invalid/component.tgz' },
    })
    const urlArtifact = sampleArtifactRef(urlEntrypoint.digest)
    harness.blobs.authorize(urlArtifact)
    const urlError = await captureError(() =>
      harness.registry.register(
        { scopeRef: SCOPE_A, manifest: urlEntrypoint, artifactRef: urlArtifact, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(urlError.code).toBe('INVALID_MANIFEST')
    expect(urlError.fieldErrors?.some((field) => field.pointer === '/entrypointRef/ref')).toBe(true)

    const emptyProvides = sampleManifest({ provides: [] })
    const emptyArtifact = sampleArtifactRef(emptyProvides.digest)
    harness.blobs.authorize(emptyArtifact)
    const schemaError = await captureError(() =>
      harness.registry.register(
        { scopeRef: SCOPE_A, manifest: emptyProvides, artifactRef: emptyArtifact, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(schemaError.code).toBe('INVALID_MANIFEST')

    expect(await harness.store.listVersions(SCOPE_A, {}, ADMIN_A)).toEqual([])
    expect(harness.control.appended).toEqual([])
  })

  it('rejects a manifest smuggled with an extra install field', async () => {
    const harness = setup()
    const manifest = { ...sampleManifest(), install: { url: 'https://example.invalid/x' } }
    const artifactRef = sampleArtifactRef(DIGEST_A)
    harness.blobs.authorize(artifactRef)
    const error = await captureError(() =>
      harness.registry.register(
        { scopeRef: SCOPE_A, manifest, artifactRef, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('INVALID_MANIFEST')
    expect(await harness.store.listVersions(SCOPE_A, {}, ADMIN_A)).toEqual([])
  })
})

describe('version freezing', () => {
  it('rejects the same id+version with a different digest and keeps the original', async () => {
    const harness = setup()
    const first = await register(harness)
    expect(first.manifestRef.digest).toBe(DIGEST_A)

    const conflicting = sampleManifest({ digest: DIGEST_B })
    const conflictingArtifact = sampleArtifactRef(DIGEST_B, '77777777-7777-4777-8777-777777777777')
    harness.blobs.authorize(conflictingArtifact)
    const error = await captureError(() =>
      harness.registry.register(
        {
          scopeRef: SCOPE_A,
          manifest: conflicting,
          artifactRef: conflictingArtifact,
          source: 'operator',
        },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('VERSION_CONFLICT')
    expect(error.fieldErrors?.some((field) => field.pointer === '/digest')).toBe(true)

    const stored = await harness.registry.getComponent(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(stored.manifestRef.digest).toBe(DIGEST_A)
    const trail = await harness.registry.getAuditTrail(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(trail).toHaveLength(1)
  })

  it('treats an identical re-registration as idempotent', async () => {
    const harness = setup()
    const first = await register(harness)
    const second = await register(harness)
    expect(second).toEqual(first)

    const trail = await harness.registry.getAuditTrail(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(trail).toHaveLength(1)
    expect(harness.control.appended).toHaveLength(1)
  })
})

describe('lifecycle transitions', () => {
  it('walks the full registered → validated → active → deprecated → retired lifecycle', async () => {
    const harness = setup()
    const registered = await register(harness)
    expect(registered.lifecycleState).toBe('registered')

    const validated = await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'validated' },
      ADMIN_A,
    )
    expect(validated.lifecycleState).toBe('validated')
    expect(validated.validatedAt).toBeDefined()

    const active = await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'active' },
      ADMIN_A,
    )
    expect(active.lifecycleState).toBe('active')

    const deprecated = await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'deprecated' },
      ADMIN_A,
    )
    expect(deprecated.lifecycleState).toBe('deprecated')

    const retired = await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'retired' },
      ADMIN_A,
    )
    expect(retired.lifecycleState).toBe('retired')
    expect(retired.retiredAt).toBeDefined()

    const trail = await harness.registry.getAuditTrail(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(trail.map((event) => event.toState)).toEqual([
      'registered',
      'validated',
      'active',
      'deprecated',
      'retired',
    ])
    expect(trail.map((event) => event.fromState)).toEqual([
      null,
      'registered',
      'validated',
      'active',
      'deprecated',
    ])
    expect(trail.every((event) => event.digest === DIGEST_A)).toBe(true)
    expect(new Set(trail.map((event) => event.payloadDigest)).size).toBe(5)
    expect(harness.control.appended.map((event) => event.idempotencyKey)).toEqual(
      trail.map((event) => event.idempotencyKey),
    )
    expect(harness.control.appended.map((event) => event.payloadDigest)).toEqual(
      trail.map((event) => event.payloadDigest),
    )
  })

  it.each<[ModuleLifecycleState, ModuleLifecycleState]>([
    ['registered', 'active'],
    ['registered', 'deprecated'],
    ['registered', 'retired'],
    ['validated', 'registered'],
    ['validated', 'deprecated'],
    ['active', 'validated'],
    ['active', 'registered'],
    ['deprecated', 'active'],
    ['deprecated', 'validated'],
    ['retired', 'active'],
    ['retired', 'registered'],
  ])('rejects the illegal transition %s → %s', async (from, to) => {
    const harness = setup()
    await register(harness)
    if (from !== 'registered') await advanceTo(harness.registry, REF, from)

    const error = await captureError(() =>
      harness.registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to }, ADMIN_A),
    )
    expect(error.code).toBe('ILLEGAL_TRANSITION')

    const stored = await harness.registry.getComponent(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(stored.lifecycleState).toBe(from)
  })

  it('rejects a transition whose digest is not the registered one', async () => {
    const harness = setup()
    await register(harness)
    const error = await captureError(() =>
      harness.registry.transition(
        {
          scopeRef: SCOPE_A,
          kind: 'data_backend',
          ref: { id: REF.id, version: REF.version, digest: DIGEST_B },
          to: 'validated',
        },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('VERSION_NOT_FOUND')
  })
})

describe('active references freeze retirement', () => {
  it('refuses to retire a version referenced by an active run', async () => {
    const harness = setup()
    await register(harness)
    await advanceTo(harness.registry, REF, 'deprecated')

    const reference = await harness.registry.acquireActiveReference(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, runId: RUN_A },
      RUN_CONTROLLER,
    )
    expect(reference.runId).toBe(RUN_A)

    const error = await captureError(() =>
      harness.registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'retired' }, ADMIN_A),
    )
    expect(error.code).toBe('ACTIVE_REFERENCE_EXISTS')
    const stillDeprecated = await harness.registry.getComponent(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF },
      ADMIN_A,
    )
    expect(stillDeprecated.lifecycleState).toBe('deprecated')

    const released = await harness.registry.releaseActiveReference(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, runId: RUN_A },
      RUN_CONTROLLER,
    )
    expect(released).toBe(true)

    const retired = await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'retired' },
      ADMIN_A,
    )
    expect(retired.lifecycleState).toBe('retired')
  })

  it('keeps references per run and refuses to pin a retired version', async () => {
    const harness = setup()
    await register(harness)
    await advanceTo(harness.registry, REF, 'retired')

    const error = await captureError(() =>
      harness.registry.acquireActiveReference(
        { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, runId: RUN_B },
        RUN_CONTROLLER,
      ),
    )
    expect(error.code).toBe('VERSION_RETIRED')
  })

  it('requires a run-controller role to pin a version', async () => {
    const harness = setup()
    await register(harness)
    const error = await captureError(() =>
      harness.registry.acquireActiveReference(
        { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, runId: RUN_A },
        NO_ROLES,
      ),
    )
    expect(error.code).toBe('FORBIDDEN')
  })
})

describe('no dynamic installation', () => {
  it.each<RegistrationSource>(['mcp_discovery', 'model_output'])(
    'refuses to install from a %s source',
    async (source) => {
      const harness = setup()
      const manifest = sampleManifest()
      const artifactRef = sampleArtifactRef(manifest.digest)
      harness.blobs.authorize(artifactRef)
      const error = await captureError(() =>
        harness.registry.register({ scopeRef: SCOPE_A, manifest, artifactRef, source }, ADMIN_A),
      )
      expect(error.code).toBe('DYNAMIC_INSTALL_FORBIDDEN')
      expect(await harness.store.listVersions(SCOPE_A, {}, ADMIN_A)).toEqual([])
      expect(harness.control.appended).toEqual([])
    },
  )
})

describe('availability and authorization', () => {
  it('lists only active, non-revoked versions as available', async () => {
    const harness = setup()
    await register(harness)
    expect(await harness.registry.listAvailableComponents(SCOPE_A, {}, ADMIN_A)).toEqual([])

    await advanceTo(harness.registry, REF, 'validated')
    expect(await harness.registry.listAvailableComponents(SCOPE_A, {}, ADMIN_A)).toEqual([])

    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'active' },
      ADMIN_A,
    )
    const available = await harness.registry.listAvailableComponents(SCOPE_A, {}, ADMIN_A)
    expect(available).toHaveLength(1)
    expect(available[0]?.manifestRef).toEqual(REF)

    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'deprecated' },
      ADMIN_A,
    )
    expect(await harness.registry.listAvailableComponents(SCOPE_A, {}, ADMIN_A)).toEqual([])
  })

  it('excludes a revoked publication from the available set', async () => {
    const harness = setup()
    await register(harness, { trustStatus: 'revoked' })
    await advanceTo(harness.registry, REF, 'active')
    const filter: ComponentListFilter = {}
    const all = await harness.registry.listComponents(SCOPE_A, filter, ADMIN_A)
    expect(all).toHaveLength(1)
    expect(await harness.registry.listAvailableComponents(SCOPE_A, filter, ADMIN_A)).toEqual([])
  })

  it('refuses registration when the artifact is not authorized in scope', async () => {
    const harness = setup()
    const manifest = sampleManifest()
    const artifactRef: ResourceRef = sampleArtifactRef(manifest.digest)
    const error = await captureError(() =>
      harness.registry.register(
        { scopeRef: SCOPE_A, manifest, artifactRef, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('ARTIFACT_NOT_AUTHORIZED')
    expect(await harness.store.listVersions(SCOPE_A, {}, ADMIN_A)).toEqual([])
  })

  it('refuses registration and transition from a non-admin principal', async () => {
    const harness = setup()
    const registerError = await captureError(() =>
      register(harness, undefined, NO_ROLES),
    )
    expect(registerError.code).toBe('FORBIDDEN')

    await register(harness)
    const transitionError = await captureError(() =>
      harness.registry.transition(
        { scopeRef: SCOPE_A, kind: 'data_backend', ref: REF, to: 'validated' },
        NO_ROLES,
      ),
    )
    expect(transitionError.code).toBe('FORBIDDEN')
  })

  it('rejects a request whose scope does not match the trusted principal', async () => {
    const harness = setup()
    const error = await captureError(() => register(harness, undefined, ADMIN_B, SCOPE_A))
    expect(error.code).toBe('SCOPE_MISMATCH')
    expect(await harness.store.listVersions(SCOPE_B, {}, ADMIN_B)).toEqual([])
  })

  it('isolates registered versions by tenant and space', async () => {
    const harness = setup()
    await register(harness)
    expect(await harness.registry.listComponents(SCOPE_B, {}, ADMIN_B)).toEqual([])
    const error = await captureError(() =>
      harness.registry.getComponent({ scopeRef: SCOPE_B, kind: 'data_backend', ref: REF }, ADMIN_B),
    )
    expect(error.code).toBe('VERSION_NOT_FOUND')
  })
})
