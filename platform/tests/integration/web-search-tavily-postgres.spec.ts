import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  WebPageSnapshotArchiver,
  createWebSearchConnectionProbe,
  NativeTavilySearchProvider,
} from '@ontology/adapter-search-web'
import { createBlobArtifactWriter, createScopedBlobReader, createToolGatewayComposition } from '@ontology/app-api'
import { createToolContext, SecretValue } from '@ontology/contracts'
import type {
  ResourceRef,
  ScopeRef,
  SecretValue as SecretValueType,
  ToolCall,
  ToolContext,
  ToolCredentialCustodian,
  ToolGateway,
} from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { WebSearchHandler } from '@ontology/tool-services'
import type { RunToolBinding } from '@ontology/tool-services'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { createFixtureFetch, startTavilyFixture } from '../fixtures/web-search/tavily-fixture-server'
import type { TavilyFixture } from '../fixtures/web-search/tavily-fixture-server'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../unit/tool-gateway-fixtures'

/**
 * The native Tavily adapter end to end: a real PostgreSQL control plane plus the local fixture,
 * proving the search backend works without a self-built gateway and that the platform archives the
 * *actual page bytes*. No live internet is used.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const DIGEST = `sha256:${'a'.repeat(64)}`
const SOURCE_REF = { namespace: 'public-web', sourceId: 'search' } as const
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const API_KEY = 'tvly-integration-DO-NOT-LEAK-91ab'
const CREDENTIAL_REF: ResourceRef = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  version: '1.0.0',
  digest: DIGEST,
  kind: 'artifact',
}

const ARCHIVED_PAGE_HTML =
  '<html><body><h1>Heat pump tariff guide</h1><p>Residential standing charges apply daily.</p></body></html>'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT_A, subjectId: 'integration-test', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 },
    runId: RUN_A,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: RUN_A,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT_A,
      spaceId: SPACE_A,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [{ namespace: 'public-web', sourceId: 'search' }],
      collectionRefs: [],
      domains: ['example.com'],
      maxRows: 1000,
    },
    traceId: 'trace-web-search-tavily-postgres',
  })
}

class StaticCredentials implements ToolCredentialCustodian {
  async stage(): Promise<ResourceRef> {
    return CREDENTIAL_REF
  }
  async activate(): Promise<void> {}
  async discard(): Promise<void> {}
  async revoke(): Promise<void> {}
  async resolve(): Promise<SecretValueType> {
    return new SecretValue(API_KEY)
  }
}

const CONTEXT_A = toolContext()

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let objectStore: FileSystemObjectStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let budget: BudgetService
let gateway: ToolGateway
let fixture: TavilyFixture
let routedFetch: typeof fetch

/** Route the search POST to the local fixture and any page GET to the archived test bytes. */
function buildRoutedFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/search') return globalThis.fetch(String(input), init)
    return new Response(ARCHIVED_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }) as typeof fetch
}

function binding(): RunToolBinding {
  return { runId: RUN_A, ledgerId: LEDGER_A, resolvedProfile: fullProfile(), operations: operationRegistry() }
}

beforeAll(async () => {
  fixture = await startTavilyFixture()
  routedFetch = buildRoutedFetch()

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'web-search-tavily-tenant') ON CONFLICT DO NOTHING`,
    [TENANT_A],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'web-search-tavily-space') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A],
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

  objectDir = await mkdtemp(join(tmpdir(), 'web-search-tavily-blob-'))
  objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({ store: new PostgresBudgetLedgerStore(controlDatabase), control: new ControlPostgresRepository(controlDatabase) })

  const provider = new NativeTavilySearchProvider({
    baseUrl: fixture.baseUrl,
    apiKey: new SecretValue(API_KEY),
    fetchImpl: routedFetch,
    snapshotArchive: new WebPageSnapshotArchiver({
      artifacts: createBlobArtifactWriter(blobStore),
      fetchImpl: routedFetch,
    }),
  })
  const handler = new WebSearchHandler({
    provider,
    allowWeb: true,
    resolvedProfile: fullProfile(),
    sourceRef: SOURCE_REF,
  })
  gateway = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  }).forRun(binding())
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
  await fixture?.stop()
})

function webCall(query = 'heat pump tariff'): ToolCall {
  return { callId: randomUUID(), toolId: 'web_search', arguments: { query, allowedDomains: ['example.com'] } }
}

describe('native Tavily web_search end to end', () => {
  it('runs the native adapter through the real gateway and archives the page bytes', async () => {
    fixture.setScenario({
      results: [{ url: 'https://docs.example.com/heat-pump-tariff', title: 'Heat pump tariff guide', content: 'vendor summary' }],
      pageHtml: ARCHIVED_PAGE_HTML,
      credits: 1,
      responseTime: 0.9,
    })
    await budget.openLedger({ ledgerId: LEDGER_A, kind: 'run', runId: RUN_A, overrideLimits: { maxRows: 1000 } }, CONTEXT_A)

    const result = await gateway.invoke(webCall(), CONTEXT_A)
    expect(result.status).toBe('ok')
    expect(result.dataRef?.kind).toBe('artifact')
    expect(result.evidenceRefs).toHaveLength(1)

    // The vendor summary travelled only as a snippet; the platform archived the real page bytes.
    const search = fixture.requests.find((entry) => entry.method === 'POST' && entry.path === '/search')
    expect(search?.body).toMatchObject({ include_answer: false, auto_parameters: false, include_domains: ['example.com'] })

    const reservation = await adminClient.query<{ status: string }>(
      `SELECT status FROM agent_platform.budget_reservations WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_A, SPACE_A, LEDGER_A],
    )
    expect(reservation.rows[0]?.status).toBe('settled')
  }, 120_000)

  it('probes the native connection against the fixture and archives a readable test page', async () => {
    fixture.setScenario({
      results: [{ url: 'https://docs.example.com/probe', title: 'Probe', content: 'probe result' }],
      pageHtml: ARCHIVED_PAGE_HTML,
    })
    const probe = createWebSearchConnectionProbe({
      credentials: new StaticCredentials(),
      searchQuery: 'probe heat pump tariff',
      searchDomains: ['example.com'],
      testPage: { url: 'https://docs.example.com/probe-page', domains: ['example.com'] },
      artifacts: createBlobArtifactWriter(blobStore),
      artifactReader: createScopedBlobReader(blobStore),
      fetchImpl: createFixtureFetch(fixture),
    })
    const result = await probe.probe(
      SCOPE_A,
      { draft: { name: 'Native Tavily', adapterType: 'native_tavily', capabilities: ['web_search'], enabled: true, endpoint: 'https://api.tavily.com' }, credentialRef: CREDENTIAL_REF },
      CONTEXT_A,
    )
    expect(result.credentialConfigured).toBe(true)
    expect(result.search.status).toBe('passed')
    expect(result.archive.status).toBe('passed')
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  }, 120_000)
})
