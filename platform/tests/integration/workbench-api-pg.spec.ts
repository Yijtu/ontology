import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresComponentRegistryStore, runControlMigrations } from '@ontology/adapter-control-postgres'
import { InMemoryIndustryManifestSource } from '@ontology/application'
import {
  createApiServer,
  createPostgresProfileResolver,
  createPostgresRunService,
  createPostgresSourceRegistry,
} from '@ontology/app-api'
import type { AuthenticatedRequest, SourceRegistryComposition } from '@ontology/app-api'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { ProfileResolverComposition, RunServiceComposition } from '@ontology/app-api'
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
} from '../unit/profile-resolver-fixtures'
import {
  ControlledProbeAdapter,
  SENTINEL_SECRET,
  SentinelSecretResolver,
  TELEMETRY_ADAPTER_REF,
  capabilityRequirement,
  mappingRef,
  sequentialIds,
} from '../unit/source-registry-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_ID = 'home-energy-demo'
const PROFILE_V1 = '1.0.0'
const PROFILE_V2 = '1.1.0'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appComposition: RunServiceComposition
let profiles: ProfileResolverComposition
let sources: SourceRegistryComposition
let registryStore: PostgresComponentRegistryStore
let api: ReturnType<typeof createApiServer> | undefined
let baseUrl = ''

const ADMIN_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'pg-editor-a')
const ADMIN_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'pg-editor-b')
const EDITOR_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['data-editor'], 'pg-editor-b')

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

/** Test-only authenticator; the workbench never reads identity from the body. */
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

interface CallOptions {
  readonly body?: object
  readonly roles?: string
  readonly subject?: string
  readonly scope?: 'a' | 'b'
  readonly ifMatch?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-test-subject': options.subject ?? 'editor-a',
    'x-test-roles': options.roles ?? 'profile-editor',
    'x-test-scope': options.scope ?? 'a',
    'idempotency-key': `idem-${randomUUID()}`,
    ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
  }
}

function server(): ReturnType<typeof createApiServer> {
  if (api === undefined) throw new Error('the API server was not built')
  return api
}

async function post(url: string, options: CallOptions) {
  return server().inject({
    method: 'POST',
    url,
    headers: headersOf(options),
    ...(options.body === undefined ? {} : { payload: options.body }),
  })
}

async function get(url: string, options: CallOptions = {}) {
  return server().inject({ method: 'GET', url, headers: headersOf(options) })
}

async function preflight(scope: 'a' | 'b', version: string): Promise<string> {
  const response = await post(`/api/v1/profiles/${PROFILE_ID}/preflight`, {
    scope,
    subject: scope === 'b' ? 'editor-b' : 'editor-a',
    body: { version },
  })
  expect(response.statusCode).toBe(200)
  const data = (
    response.json() as { data: { status: string; resolvedProfile: { snapshotHash: string } } }
  ).data
  expect(data.status).toBe('resolved')
  return data.resolvedProfile.snapshotHash
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'workbench-tenant-a'), ($2, 'workbench-tenant-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_B.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'workbench-space-a'), ($3, $4, 'workbench-space-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, SCOPE_B.tenantId, SCOPE_B.spaceId],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())
  const validator = canonicalProfileValidator()

  appComposition = createPostgresRunService({
    connectionString: appUrl,
    industry,
    validator,
    maxPoolSize: 4,
    now: fixedClock(),
  })
  profiles = createPostgresProfileResolver({
    connectionString: appUrl,
    industry,
    validator,
    maxPoolSize: 4,
    now: fixedClock(),
  })
  sources = createPostgresSourceRegistry({
    connectionString: appUrl,
    secrets: new SentinelSecretResolver(),
    adapters: [new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })],
    maxPoolSize: 4,
    now: fixedClock(),
    newId: sequentialIds('77777777'),
  })
  registryStore = new PostgresComponentRegistryStore(appComposition.database)

  await seedComponents(registryStore, registeredComponents(), SCOPE_A, ADMIN_A)
  await seedComponents(registryStore, registeredComponents(), SCOPE_B, ADMIN_B)

  api = createApiServer({
    authenticate: testAuthenticator,
    runs: { service: appComposition.service, submissionMode: 'records-only' },
    workbench: {
      profiles: profiles.resolver,
      sources: sources.registry,
      components: registryStore,
    },
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  const address = api.server.address()
  if (address === null || typeof address === 'string') throw new Error('the API did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 300_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await sources?.close().catch(() => undefined)
  await profiles?.close().catch(() => undefined)
  await appComposition?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

async function registerTelemetrySource(scope: 'a' | 'b'): Promise<string> {
  const response = await post('/api/v1/sources', {
    scope,
    subject: scope === 'b' ? 'editor-b' : 'editor-a',
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
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: { sourceId: string } }).data.sourceId
}

async function probe(scope: 'a' | 'b', sourceId: string): Promise<void> {
  const response = await post(`/api/v1/sources/${sourceId}/probe`, {
    scope,
    subject: scope === 'b' ? 'editor-b' : 'editor-a',
    roles: 'data-editor',
    body: { capabilities: [capabilityRequirement('telemetry_read')] },
  })
  expect(response.statusCode).toBe(200)
  expect((response.json() as { data: { status: string } }).data.status).toBe('succeeded')
}

describe('workbench over real PostgreSQL', () => {
  it('publishes, preflights, activates and locks a run to its resolved manifest', async () => {
    const published = await post('/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_V1 },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    expect(published.statusCode).toBe(201)

    const sourceId = await registerTelemetrySource('a')
    await probe('a', sourceId)
    const hashV1 = await preflight('a', PROFILE_V1)

    const activated = await post(`/api/v1/profiles/${PROFILE_ID}/activate`, {
      ifMatch: '*',
      body: { version: PROFILE_V1, snapshotHash: hashV1 },
    })
    expect(activated.statusCode).toBe(200)
    expect((activated.json() as { data: { revision: string } }).data.revision).toBe('1')

    const created = await post('/api/v1/runs', {
      roles: 'business-user',
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_V1 },
        question: 'compare tomorrow energy strategies',
        context: { siteRef: 'site-demo-a', timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
      },
    })
    expect(created.statusCode).toBe(202)
    const run = (
      created.json() as { data: { runId: string; resolvedProfileHash: string } }
    ).data
    expect(run.resolvedProfileHash).toBe(hashV1)

    const before = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_ID, hashV1],
    )
    const beforeText = before.rows[0]?.body
    if (beforeText === undefined) throw new Error('the locked resolved profile row is missing')
    expect(beforeText).not.toContain(SENTINEL_SECRET)

    // A second profile version with a different composition.
    const publishedV2 = await post('/api/v1/profiles', {
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_V2 },
        spec: sampleProfileSpec({
          toolBindings: [
            { toolId: 'ontology_lookup', enabled: true },
            { toolId: 'data_query', enabled: true, maxCallsPerRun: 8 },
            { toolId: 'document_search', enabled: true },
            { toolId: 'web_search', enabled: true },
          ],
        }),
        environment: 'local_dev',
      },
    })
    expect(publishedV2.statusCode).toBe(201)
    const hashV2 = await preflight('a', PROFILE_V2)
    expect(hashV2).not.toBe(hashV1)

    // The UI activates the new version through its own HTTP client, not a raw route call.
    const client = new WorkbenchClient({
      baseUrl,
      fetchImpl: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            'x-test-subject': 'editor-a',
            'x-test-roles': 'profile-editor',
            'x-test-scope': 'a',
          },
        }),
    })
    const active = await client.activateProfile({
      profileRef: { id: PROFILE_ID, version: PROFILE_V2 },
      snapshotHash: hashV2,
      expectedRevision: '1',
    })
    expect(active.revision).toBe('2')

    const view = await get(`/api/v1/runs/${run.runId}`, { roles: 'business-user' })
    expect(view.statusCode).toBe(200)
    expect((view.json() as { data: { resolvedProfileHash: string } }).data.resolvedProfileHash).toBe(
      hashV1,
    )

    const after = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_ID, hashV1],
    )
    expect(after.rows[0]?.body).toBe(beforeText)
  }, 60_000)

  it('invalidates a resolved preflight when a source mapping/capability version changes', async () => {
    const published = await post('/api/v1/profiles', {
      scope: 'b',
      subject: 'editor-b',
      body: {
        profileRef: { id: PROFILE_ID, version: PROFILE_V1 },
        spec: sampleProfileSpec(),
        environment: 'local_dev',
      },
    })
    expect(published.statusCode).toBe(201)

    const sourceId = await registerTelemetrySource('b')
    await probe('b', sourceId)
    const snapshotHash = await preflight('b', PROFILE_V1)

    const activated = await post(`/api/v1/profiles/${PROFILE_ID}/activate`, {
      scope: 'b',
      subject: 'editor-b',
      ifMatch: '*',
      body: { version: PROFILE_V1, snapshotHash },
    })
    expect(activated.statusCode).toBe(200)

    await sources.registry.reviseSource(
      {
        scopeRef: SCOPE_B,
        sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('telemetry', 'd', '1.1.0'),
      },
      EDITOR_B,
    )
    await probe('b', sourceId)

    const stale = await post(`/api/v1/profiles/${PROFILE_ID}/activate`, {
      scope: 'b',
      subject: 'editor-b',
      ifMatch: '1',
      body: { version: PROFILE_V1, snapshotHash },
    })
    expect(stale.statusCode).toBe(409)
    const staleBody = stale.json() as { error: { code: string; reasons?: string[] } }
    expect(staleBody.error.code).toBe('PREFLIGHT_STALE')
    expect(staleBody.error.reasons?.join(' ')).toContain('capability version')

    // Re-preflight records the new fingerprints and the activation can proceed.
    const rePreflight = await preflight('b', PROFILE_V1)
    expect(rePreflight).toBe(snapshotHash)
    const reActivated = await post(`/api/v1/profiles/${PROFILE_ID}/activate`, {
      scope: 'b',
      subject: 'editor-b',
      ifMatch: '1',
      body: { version: PROFILE_V1, snapshotHash },
    })
    expect(reActivated.statusCode).toBe(200)
    expect((reActivated.json() as { data: { revision: string } }).data.revision).toBe('2')
  }, 60_000)

  it('keeps the resolved source secret out of every HTTP response', async () => {
    const list = await get('/api/v1/sources', { roles: 'data-editor' })
    expect(list.statusCode).toBe(200)
    expect(list.payload).not.toContain(SENTINEL_SECRET)

    const components = await get('/api/v1/components')
    expect(components.payload).not.toContain(SENTINEL_SECRET)
  })
})
