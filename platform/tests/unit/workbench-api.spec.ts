import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  InMemoryComponentRegistryStore,
  InMemoryIndustryManifestSource,
  InMemoryProfileStore,
  InMemorySourceStore,
  ProfileResolver,
  SourceRegistry,
} from '@ontology/application'
import {
  INDUSTRY_REF,
  SCOPE_A,
  SCOPE_B,
  canonicalProfileValidator,
  fixedClock,
  homeEnergyIndustryManifest,
  registeredComponents,
  sampleProfileSpec,
  seedComponents,
  toolContext,
} from './profile-resolver-fixtures'
import {
  ControlledProbeAdapter,
  DOCUMENTS_ADAPTER_REF,
  RecordingControlRepository,
  SENTINEL_SECRET,
  SentinelSecretResolver,
  StaticProbeAdapterResolver,
  TELEMETRY_ADAPTER_REF,
  capabilityRequirement,
  mappingRef,
  sequentialIds,
} from './source-registry-fixtures'

const PROFILE_ID = 'home-energy-demo'
const PROFILE_VERSION = '1.0.0'
const ADMIN_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'editor-a')
const ADMIN_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'editor-b')
const EDITOR_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'editor-a')

/**
 * Test-only authenticator. Production uses verified OIDC/JWKS (SPEC §3). The trusted
 * principal is selected with test headers so a request can be attributed to a tenant, a
 * subject and a role set; the workbench never reads identity from the body.
 */
function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  const rawScope = request.headers['x-test-scope']
  const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const isB = scope === 'b'
  return {
    principal: {
      tenantId: isB ? SCOPE_B.tenantId : SCOPE_A.tenantId,
      subjectId: subject,
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: isB ? SCOPE_B.spaceId : SCOPE_A.spaceId,
  }
}

interface HarnessOptions {
  readonly industryConfigured?: boolean
  readonly withoutTelemetry?: boolean
  readonly seedProfile?: boolean
}

interface Harness {
  readonly app: ReturnType<typeof createApiServer>
  readonly registry: SourceRegistry
  readonly resolver: ProfileResolver
}

interface RequestOptions {
  readonly body?: object
  readonly roles?: string
  readonly subject?: string
  readonly scope?: 'a' | 'b'
  readonly idempotencyKey?: string | null
  readonly ifMatch?: string
}

function headersOf(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-subject': options.subject ?? 'editor-a',
    'x-test-roles': options.roles ?? 'profile-editor',
    'x-test-scope': options.scope ?? 'a',
  }
  const key = options.idempotencyKey
  if (key !== null) headers['idempotency-key'] = key ?? `idem-${randomUUID()}`
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  return headers
}

async function post(app: ReturnType<typeof createApiServer>, url: string, options: RequestOptions) {
  return app.inject({
    method: 'POST',
    url,
    headers: headersOf(options),
    ...(options.body === undefined ? {} : { payload: options.body }),
  })
}

async function get(app: ReturnType<typeof createApiServer>, url: string, options: RequestOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

interface ErrorBody {
  readonly error: {
    readonly code: string
    readonly reasons?: readonly string[]
    readonly missingCapabilities?: readonly unknown[]
  }
  readonly traceId: string
}

function errorOf(payload: string): ErrorBody {
  return JSON.parse(payload) as ErrorBody
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const components = new InMemoryComponentRegistryStore()
  const store = new InMemoryProfileStore()
  const sourceStore = new InMemorySourceStore()
  const industry = new InMemoryIndustryManifestSource()
  if (options.industryConfigured ?? true) {
    industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())
  }

  const all = registeredComponents()
  const seeded =
    options.withoutTelemetry === true
      ? all.filter((record) => record.manifestRef.id !== 'data-duckdb')
      : all
  await seedComponents(components, seeded, SCOPE_A, ADMIN_A)
  await seedComponents(components, seeded, SCOPE_B, ADMIN_B)

  const resolver = new ProfileResolver({
    control: new RecordingControlRepository(),
    store,
    registry: components,
    industry,
    validator: canonicalProfileValidator(),
    now: fixedClock(),
  })
  const registry = new SourceRegistry({
    control: new RecordingControlRepository(),
    store: sourceStore,
    secrets: new SentinelSecretResolver(),
    adapters: new StaticProbeAdapterResolver([
      new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF }),
      new ControlledProbeAdapter({
        adapterRef: DOCUMENTS_ADAPTER_REF,
        observation: { capabilities: [{ name: 'document_search', version: '1.0.0' }] },
      }),
    ]),
    now: fixedClock(),
    newId: sequentialIds('77777777'),
  })

  const app = createApiServer({
    authenticate: testAuthenticator,
    workbench: { profiles: resolver, sources: registry, components },
  })

  if (options.seedProfile ?? true) {
    const published = await post(app, '/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    if (published.statusCode !== 201) {
      throw new Error(`seeding the profile failed: ${published.statusCode} ${published.payload}`)
    }
  }

  return { app, registry, resolver }
}

async function preflightSnapshot(app: ReturnType<typeof createApiServer>): Promise<string> {
  const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
    body: { version: PROFILE_VERSION },
  })
  if (response.statusCode !== 200) {
    throw new Error(`preflight failed: ${response.statusCode} ${response.payload}`)
  }
  return (response.json() as { data: { resolvedProfile: { snapshotHash: string } } }).data
    .resolvedProfile.snapshotHash
}

describe('GET /components', () => {
  it('lists registered components for a profile editor', async () => {
    const { app } = await buildHarness()
    const response = await get(app, '/api/v1/components')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { data: { components: { manifestRef: { id: string } }[] } }
    expect(body.data.components.map((record) => record.manifestRef.id)).toContain('data-duckdb')
  })

  it('filters by kind and rejects an unknown filter', async () => {
    const { app } = await buildHarness()
    const filtered = await get(app, '/api/v1/components?kind=runtime')
    expect(filtered.statusCode).toBe(200)
    const body = filtered.json() as { data: { components: { manifestRef: { id: string } }[] } }
    expect(body.data.components.map((record) => record.manifestRef.id)).toEqual(['runtime-template'])

    const invalid = await get(app, '/api/v1/components?kind=not-a-kind')
    expect(invalid.statusCode).toBe(400)
    expect(errorOf(invalid.payload).error.code).toBe('INVALID_ARGUMENT')
  })

  it('returns 401 without a principal and 403 without a permitted role', async () => {
    const { app } = await buildHarness()
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/components' })
    expect(anonymous.statusCode).toBe(401)

    const forbidden = await get(app, '/api/v1/components', { roles: 'business-user' })
    expect(forbidden.statusCode).toBe(403)
    expect(errorOf(forbidden.payload).error.code).toBe('FORBIDDEN')
  })
})

describe('POST /profiles', () => {
  it('publishes a profile version and requires an Idempotency-Key', async () => {
    const { app } = await buildHarness({ seedProfile: false })
    const missingKey = await post(app, '/api/v1/profiles', {
      idempotencyKey: null,
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    expect(missingKey.statusCode).toBe(400)
    expect(errorOf(missingKey.payload).error.code).toBe('INVALID_ARGUMENT')

    const created = await post(app, '/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    expect(created.statusCode).toBe(201)
    const record = (created.json() as { data: { digest: string; environment: string } }).data
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(record.environment).toBe('local_dev')
  })

  it('rejects an invalid spec and a conflicting version', async () => {
    const { app } = await buildHarness({ seedProfile: false })
    const invalid = await post(app, '/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: { not: 'a profile spec' },
        environment: 'local_dev',
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(errorOf(invalid.payload).error.code).toBe('INVALID_ARGUMENT')

    await post(app, '/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    const conflicting = sampleProfileSpec({
      policyRef: { id: 'policy-other', version: '1.0.0', digest: `sha256:${'f'.repeat(64)}` },
    })
    const conflict = await post(app, '/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: conflicting,
        environment: 'local_dev',
      },
    })
    expect(conflict.statusCode).toBe(409)
    expect(errorOf(conflict.payload).error.code).toBe('VERSION_CONFLICT')
  })

  it('takes the scope from the principal, not from the request body', async () => {
    const { app } = await buildHarness({ seedProfile: false })
    const created = await post(app, '/api/v1/profiles', {
      body: {
        scopeRef: SCOPE_B,
        profileRef: { id: PROFILE_ID, version: PROFILE_VERSION },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    expect(created.statusCode).toBe(201)

    const crossTenant = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
      scope: 'b',
      subject: 'editor-b',
      body: { version: PROFILE_VERSION },
    })
    expect(crossTenant.statusCode).toBe(404)
    expect(errorOf(crossTenant.payload).error.code).toBe('PROFILE_NOT_FOUND')
  })
})

describe('POST /profiles/{id}/preflight', () => {
  it('resolves a profile and reports explicit degradations, never silently dropping them', async () => {
    const { app } = await buildHarness()
    const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
      body: { version: PROFILE_VERSION },
    })
    expect(response.statusCode).toBe(200)
    const data = (
      response.json() as {
        data: {
          status: string
          resolvedProfile: { snapshotHash: string; explicitDegradations: { capability: string }[] }
        }
      }
    ).data
    expect(data.status).toBe('resolved')
    expect(data.resolvedProfile.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const capabilities = data.resolvedProfile.explicitDegradations.map((entry) => entry.capability)
    expect(capabilities).toContain('model:decision')
    expect(capabilities).toContain('tool:web_search')
  })

  it('reports the exact missing capabilities instead of a resolved manifest', async () => {
    const { app } = await buildHarness({ withoutTelemetry: true })
    const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
      body: { version: PROFILE_VERSION },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      data: { status: string; missingCapabilities: { name: string }[] }
    }
    expect(body.data.status).toBe('missing_capabilities')
    expect(body.data.missingCapabilities.map((entry) => entry.name)).toEqual(['telemetry_read'])
  })

  it('reports an unconfigured industry manifest as 409 CAPABILITY_NOT_CONFIGURED', async () => {
    const { app } = await buildHarness({ industryConfigured: false })
    const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
      body: { version: PROFILE_VERSION },
    })
    expect(response.statusCode).toBe(409)
    expect(errorOf(response.payload).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
  })
})

describe('POST /profiles/{id}/activate with version checks', () => {
  it('requires If-Match (428) and rejects a stale revision (409) without overwriting', async () => {
    const { app } = await buildHarness()
    const snapshotHash = await preflightSnapshot(app)

    const missing = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(missing.statusCode).toBe(428)
    expect(errorOf(missing.payload).error.code).toBe('REVISION_REQUIRED')

    const first = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '*',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(first.statusCode).toBe(200)
    expect((first.json() as { data: { revision: string } }).data.revision).toBe('1')

    const stale = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '99',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(stale.statusCode).toBe(409)
    expect(errorOf(stale.payload).error.code).toBe('VERSION_CONFLICT')

    const current = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '1',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(current.statusCode).toBe(200)
    expect((current.json() as { data: { revision: string } }).data.revision).toBe('2')
  })

  it('rejects activation when no fresh preflight was recorded', async () => {
    const { app } = await buildHarness()
    const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '*',
      body: { version: PROFILE_VERSION, snapshotHash: `sha256:${'a'.repeat(64)}` },
    })
    expect(response.statusCode).toBe(409)
    const body = errorOf(response.payload)
    expect(body.error.code).toBe('PREFLIGHT_STALE')
    expect(body.error.reasons?.join(' ')).toContain('no source binding was recorded')
  })

  it('denies activation to a role without profile-editor', async () => {
    const { app } = await buildHarness()
    const response = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      roles: 'business-user',
      ifMatch: '*',
      body: { version: PROFILE_VERSION, snapshotHash: `sha256:${'a'.repeat(64)}` },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('LOCAL-008 folded wiring: preflight freshness gates activation', () => {
  it('makes a source mapping/capability change stale and forces a re-preflight', async () => {
    const harness = await buildHarness()
    const { app, registry } = harness

    const registered = await post(app, '/api/v1/sources', {
      roles: 'data-editor',
      body: {
        kind: 'read_only_origin',
        role: 'telemetry',
        adapterRef: TELEMETRY_ADAPTER_REF,
        secretRef: 'secret://vault/telemetry',
        mappingRef: mappingRef('telemetry', 'a'),
        capabilityVersion: '1.0.0',
      },
    })
    expect(registered.statusCode).toBe(201)
    const sourceId = (registered.json() as { data: { sourceId: string } }).data.sourceId

    const probe = await post(app, `/api/v1/sources/${sourceId}/probe`, {
      roles: 'data-editor',
      body: { capabilities: [capabilityRequirement('telemetry_read')] },
    })
    expect((probe.json() as { data: { status: string } }).data.status).toBe('succeeded')

    const snapshotHash = await preflightSnapshot(app)
    const activated = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '*',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(activated.statusCode).toBe(200)

    // A new mapping/capability version invalidates the recorded preflight.
    await registry.reviseSource(
      {
        scopeRef: SCOPE_A,
        sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('telemetry', 'd', '1.1.0'),
      },
      EDITOR_A,
    )
    const reprobe = await post(app, `/api/v1/sources/${sourceId}/probe`, {
      roles: 'data-editor',
      body: { capabilities: [capabilityRequirement('telemetry_read')] },
    })
    expect((reprobe.json() as { data: { status: string } }).data.status).toBe('succeeded')

    const stale = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '1',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(stale.statusCode).toBe(409)
    const staleBody = errorOf(stale.payload)
    expect(staleBody.error.code).toBe('PREFLIGHT_STALE')
    expect(staleBody.error.reasons?.join(' ')).toContain('capability version')

    // Re-preflight records the new fingerprints, so the activation can proceed.
    const rePreflight = await post(app, `/api/v1/profiles/${PROFILE_ID}/preflight`, {
      body: { version: PROFILE_VERSION },
    })
    expect(rePreflight.statusCode).toBe(200)
    const reActivated = await post(app, `/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '1',
      body: { version: PROFILE_VERSION, snapshotHash },
    })
    expect(reActivated.statusCode).toBe(200)
    expect((reActivated.json() as { data: { revision: string } }).data.revision).toBe('2')
  })
})

describe('POST /sources and probing', () => {
  it('registers a refs-only binding and never echoes a secret value', async () => {
    const { app } = await buildHarness()
    const registered = await post(app, '/api/v1/sources', {
      roles: 'data-editor',
      body: {
        kind: 'read_only_origin',
        role: 'telemetry',
        adapterRef: TELEMETRY_ADAPTER_REF,
        secretRef: 'secret://vault/telemetry',
        mappingRef: mappingRef('telemetry', 'a'),
        capabilityVersion: '1.0.0',
      },
    })
    expect(registered.statusCode).toBe(201)
    const binding = (
      registered.json() as { data: { sourceId: string; secretRef: string; status: string } }
    ).data
    expect(binding.secretRef).toBe('secret://vault/telemetry')
    expect(binding.status).toBe('registered')
    expect(registered.payload).not.toContain(SENTINEL_SECRET)

    const probe = await post(app, `/api/v1/sources/${binding.sourceId}/probe`, {
      roles: 'data-editor',
      body: { capabilities: [capabilityRequirement('telemetry_read')] },
    })
    expect(probe.statusCode).toBe(200)
    expect(probe.payload).not.toContain(SENTINEL_SECRET)

    const list = await get(app, '/api/v1/sources', { roles: 'data-editor' })
    expect(list.statusCode).toBe(200)
    expect(list.payload).not.toContain(SENTINEL_SECRET)
    const sources = (list.json() as { data: { sources: { status: string }[] } }).data.sources
    expect(sources.map((source) => source.status)).toEqual(['ready'])
  })

  it('requires an Idempotency-Key and rejects a raw secret value as secretRef', async () => {
    const { app } = await buildHarness()
    const missingKey = await post(app, '/api/v1/sources', {
      roles: 'data-editor',
      idempotencyKey: null,
      body: {
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
      },
    })
    expect(missingKey.statusCode).toBe(400)

    const rawSecret = await post(app, '/api/v1/sources', {
      roles: 'data-editor',
      body: {
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: SENTINEL_SECRET,
      },
    })
    expect(rawSecret.statusCode).toBe(400)
    expect(errorOf(rawSecret.payload).error.code).toBe('INVALID_ARGUMENT')
    expect(rawSecret.payload).not.toContain(SENTINEL_SECRET)
  })

  it('leaves a binding failed when the requested capability subset is unsupported', async () => {
    const { app } = await buildHarness()
    const registered = await post(app, '/api/v1/sources', {
      roles: 'data-editor',
      body: {
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
        mappingRef: mappingRef('documents', 'b'),
      },
    })
    const sourceId = (registered.json() as { data: { sourceId: string } }).data.sourceId
    const probe = await post(app, `/api/v1/sources/${sourceId}/probe`, {
      roles: 'data-editor',
      body: { capabilities: [capabilityRequirement('telemetry_read')] },
    })
    expect(probe.statusCode).toBe(200)
    const job = (probe.json() as { data: { status: string; errorCode: string } }).data
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(probe.payload).not.toContain(SENTINEL_SECRET)

    const list = await get(app, '/api/v1/sources', { roles: 'data-editor' })
    const sources = (list.json() as { data: { sources: { status: string }[] } }).data.sources
    expect(sources.map((source) => source.status)).toEqual(['failed'])
  })

  it('denies source registration to a non-data-editor role', async () => {
    const { app } = await buildHarness()
    const response = await post(app, '/api/v1/sources', {
      roles: 'business-user',
      body: {
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
      },
    })
    expect(response.statusCode).toBe(403)
  })
})
