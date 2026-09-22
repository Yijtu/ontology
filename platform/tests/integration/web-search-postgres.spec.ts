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
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { HttpWebSearchProvider } from '@ontology/adapter-search-web'
import { createToolGatewayComposition } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolCall, ToolContext, ToolGateway } from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { WebSearchHandler } from '@ontology/tool-services'
import type { RunToolBinding } from '@ontology/tool-services'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { INJECTION_PAGE, SAFE_PAGE, scenarioWith } from '../fixtures/web-search/fixtures'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../unit/tool-gateway-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const DIGEST = `sha256:${'a'.repeat(64)}`
const SOURCE_REF = { namespace: 'public-web', sourceId: 'search' } as const

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT_A,
      subjectId: 'integration-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
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
    traceId: 'trace-web-search-postgres',
  })
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
let evidenceStore: PostgresEvidenceStore
let gateway: ToolGateway
let fixture: WebSearchFixture

function binding(): RunToolBinding {
  return { runId: RUN_A, ledgerId: LEDGER_A, resolvedProfile: fullProfile(), operations: operationRegistry() }
}

beforeAll(async () => {
  fixture = await startWebSearchFixture()

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'web-search-tenant')
     ON CONFLICT DO NOTHING`,
    [TENANT_A],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'web-search-space')
     ON CONFLICT DO NOTHING`,
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

  objectDir = await mkdtemp(join(tmpdir(), 'web-search-blob-'))
  objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)

  const handler = new WebSearchHandler({
    provider: new HttpWebSearchProvider({ baseUrl: fixture.baseUrl }),
    allowWeb: true,
    resolvedProfile: fullProfile(),
    sourceRef: SOURCE_REF,
    ctx: CONTEXT_A,
  })
  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  })
  gateway = composition.forRun(binding())
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
  return {
    callId: randomUUID(),
    toolId: 'web_search',
    arguments: { query, allowedDomains: ['example.com'] },
  }
}

function pagesOf(inlineData: unknown): { snippet?: string; contentTrust?: string }[] {
  if (typeof inlineData !== 'object' || inlineData === null || Array.isArray(inlineData)) return []
  const pages = (inlineData as Record<string, unknown>).pages
  if (!Array.isArray(pages)) return []
  return pages.filter(
    (entry): entry is { snippet?: string; contentTrust?: string } =>
      typeof entry === 'object' && entry !== null,
  )
}

describe('real end-to-end web_search against PostgreSQL and blob-local', () => {
  it('runs against a real PostgreSQL and the controlled fixture (no live internet)', async () => {
    const version = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(version.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[web-search] image=${container.image} container=${container.containerName} fixture=${fixture.baseUrl}\n`,
      )
    }
  })

  it('executes, archives the result and the evidence, and settles the budget', async () => {
    await budget.openLedger(
      { ledgerId: LEDGER_A, kind: 'run', runId: RUN_A, overrideLimits: { maxRows: 1000 } },
      CONTEXT_A,
    )
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const requestsBefore = fixture.requests.length

    const result = await gateway.invoke(webCall(), CONTEXT_A)
    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.dataRef?.kind).toBe('artifact')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)
    expect(result.sourceSnapshots[0]?.sourceRef).toEqual(SOURCE_REF)
    expect(fixture.requests.length).toBe(requestsBefore + 1)
    expect(fixture.requests.at(-1)?.domains).toEqual(['example.com'])

    const blobRef = result.dataRef
    if (blobRef === undefined) throw new Error('the result carried no dataRef')
    const authorized = await blobStore.getAuthorized({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A)
    expect(authorized.integrityVerified).toBe(true)

    // The archived bytes really hold the preserved page URL and untrusted content trust.
    const archived = JSON.parse(new TextDecoder().decode(await objectStore.read(blobRef.digest))) as {
      pages: { url: string; fetchedAt: string; publishedAt?: string; contentTrust: string }[]
    }
    expect(archived.pages[0]?.url).toBe(SAFE_PAGE.url)
    expect(archived.pages[0]?.publishedAt).toBe('2025-03-01T00:00:00Z')
    expect(archived.pages[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(archived.pages[0]?.contentTrust).toBe('untrusted_data')

    const evidenceRef = result.evidenceRefs[0]
    if (evidenceRef === undefined) throw new Error('the result carried no evidenceRef')
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, CONTEXT_A)
    expect(record?.envelope.kind).toBe('web_page')
    expect(record?.envelope.payloadRef?.id).toBe(blobRef.id)
    expect(record?.envelopeDigest).toBe(record?.envelope.integrity.digest)

    const reservation = await adminClient.query<{ status: string }>(
      `SELECT status FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_A, SPACE_A, LEDGER_A],
    )
    expect(reservation.rows[0]?.status).toBe('settled')
  })

  it('archives an injection page as untrusted evidence without changing authority', async () => {
    fixture.setScenario(scenarioWith([INJECTION_PAGE]))
    const result = await gateway.invoke(webCall('supplier notices and instructions'), CONTEXT_A)
    expect(result.status).toBe('ok')

    const pages = pagesOf(result.inlineData)
    expect(pages[0]?.contentTrust).toBe('untrusted_data')
    expect(pages[0]?.snippet).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')

    // The trusted context allowlist is unchanged after fetching untrusted content.
    expect(CONTEXT_A.allowedResources.domains).toEqual(['example.com'])
    expect(fixture.requests.at(-1)?.domains).toEqual(['example.com'])
  })
})
