import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  BusinessPostgresDatabase,
  PostgresQueryAdapter,
} from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import {
  Bm25DocumentSearchService,
  PostgresKeywordIndexStore,
  canonicalIndexDigest,
  decodeCursor,
  encodeCursor,
  termFrequencies,
  tokenize,
} from '@ontology/adapter-search-bm25'
import type {
  IndexedDocument,
  MatchingDocumentPage,
  WriteGenerationInput,
} from '@ontology/adapter-search-bm25'
import { HttpWebSearchProvider } from '@ontology/adapter-search-web'
import { createToolGatewayComposition, createToolHandlerSet } from '@ontology/app-api'
import {
  createToolContext,
  type DocumentSpanReaderPort,
  type ReadSpanRequest,
  type ReadSpanResponse,
  type RevisionString,
  type ScalarValue,
  type ScopeRef,
  type SourceRef,
  type ToolCall,
  type ToolContext,
  type ToolGateway,
  type WebSearchProvider,
  type WebSearchProviderRequest,
  type WebSearchProviderResult,
} from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import type { RunToolBinding } from '@ontology/tool-services'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { SAFE_PAGE, scenarioWith } from '../fixtures/web-search/fixtures'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../unit/tool-gateway-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const READ_ONLY_ROLE = `assembly_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

vi.setConfig({ testTimeout: 120_000 })

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const DIGEST = `sha256:${'a'.repeat(64)}`
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SOURCE_BUSINESS: SourceRef = { namespace: 'demo', sourceId: 'business-db' }
const SOURCE_WEB: SourceRef = { namespace: 'public-web', sourceId: 'search' }
const COLLECTION = 'manuals/assembly'
const MISSING_COLLECTION = 'manuals/no-index'
const CORRUPT_COLLECTION = 'manuals/store-failure'
const CURSOR_COLLECTION = 'manuals/cursor-state'

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

// This suite starts a real PostgreSQL container in `beforeAll`, which under a loaded
// machine can take well over a minute. A context deadline captured at module-import
// time therefore expires before the tests even run. Every time-dependent context is
// built relative to the moment it is used, with a margin that comfortably outlasts the
// 120s integration test budget.
const TEST_DEADLINE_MARGIN_MS = 5 * 60_000

function toolContext(input: {
  readonly tenantId: string
  readonly spaceId: string
  readonly sourceRefs: readonly SourceRef[]
  readonly collectionRefs?: readonly string[]
  readonly domains?: readonly string[]
  readonly deadline?: string
}): ToolContext {
  const grantedAt = new Date()
  const expiresAt =
    input.deadline ?? new Date(grantedAt.getTime() + TEST_DEADLINE_MARGIN_MS).toISOString()
  return createToolContext({
    principal: {
      tenantId: input.tenantId,
      subjectId: 'tool-assembly-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: expiresAt,
    budgetReservation: {
      reservationId: randomUUID(),
      runId: RUN,
      grantedAt: grantedAt.toISOString(),
      expiresAt,
    },
    allowedResources: {
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [...input.sourceRefs],
      collectionRefs: [...(input.collectionRefs ?? [])],
      domains: [...(input.domains ?? [])],
      maxRows: 1000,
    },
    traceId: `trace-${input.tenantId.slice(0, 4)}`,
  })
}

let CTX_A: ToolContext
let CTX_B: ToolContext
let noIndexContext: ToolContext
let corruptContext: ToolContext
let cursorContext: ToolContext

/**
 * Rebuild every time-dependent context from the current clock. `beforeAll` calls this
 * for the container/index setup and `beforeEach` refreshes it, so a test's deadline is
 * relative to that test rather than to module import.
 */
function buildTestContexts(): void {
  CTX_A = toolContext({
    tenantId: TENANT_A,
    spaceId: SPACE_A,
    sourceRefs: [SOURCE_BUSINESS],
    collectionRefs: [COLLECTION],
    domains: ['example.com'],
  })
  CTX_B = toolContext({
    tenantId: TENANT_B,
    spaceId: SPACE_B,
    sourceRefs: [SOURCE_BUSINESS],
    collectionRefs: [COLLECTION],
    domains: ['example.com'],
  })
  noIndexContext = toolContext({
    tenantId: TENANT_A,
    spaceId: SPACE_A,
    sourceRefs: [SOURCE_BUSINESS],
    collectionRefs: [MISSING_COLLECTION],
    domains: ['example.com'],
  })
  corruptContext = toolContext({
    tenantId: TENANT_A,
    spaceId: SPACE_A,
    sourceRefs: [SOURCE_BUSINESS],
    collectionRefs: [CORRUPT_COLLECTION],
    domains: ['example.com'],
  })
  cursorContext = toolContext({
    tenantId: TENANT_A,
    spaceId: SPACE_A,
    sourceRefs: [SOURCE_BUSINESS],
    collectionRefs: [CURSOR_COLLECTION],
    domains: ['example.com'],
  })
}

const MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: { sourceRef: SOURCE_BUSINESS, objectPath: 'sales.orders' },
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
  },
  {
    objectRef: { sourceRef: SOURCE_BUSINESS, objectPath: 'sales.slow_view' },
    schema: 'sales',
    relation: 'slow_view',
    relationKind: 'view',
  },
]

function directPlan(
  sql: string,
  objectPath = 'sales.orders',
  parameters: ScalarValue[] = [],
): Record<string, unknown> {
  return {
    mode: 'direct',
    statementKind: 'select',
    sql,
    parameters,
    referencedObjects: [{ sourceRef: SOURCE_BUSINESS, objectPath }],
    readOnly: true,
  }
}

function dataCall(callId: string, sql: string, objectPath = 'sales.orders'): ToolCall {
  return {
    callId,
    toolId: 'data_query',
    arguments: { kind: 'query', mode: 'direct', queryPlan: directPlan(sql, objectPath) },
  }
}

function documentCall(callId: string, mode: 'keyword' | 'vector' = 'keyword'): ToolCall {
  return {
    callId,
    toolId: 'document_search',
    arguments: { query: 'battery warranty', allowedCollectionRefs: [COLLECTION], mode },
  }
}

function webCall(callId: string): ToolCall {
  return {
    callId,
    toolId: 'web_search',
    // A unique query per call keeps the shared ledger's duplicate-intent guard out of the
    // way, so each case reaches the real provider.
    arguments: { query: `heat pump tariff ${callId}`, allowedDomains: ['example.com'] },
  }
}

/** Real BM25 service whose candidate fetch can be gated, so a search can be caught in flight. */
class GatedKeywordIndexStore extends PostgresKeywordIndexStore {
  gate: Promise<void> | undefined
  entered = false

  override async listMatchingDocuments(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    terms: readonly string[],
    limit: number,
    ctx: ToolContext,
  ): Promise<MatchingDocumentPage> {
    this.entered = true
    if (this.gate !== undefined) await this.gate
    return super.listMatchingDocuments(scopeRef, collectionRef, generation, terms, limit, ctx)
  }
}

class FixtureSpanReader implements DocumentSpanReaderPort {
  readonly #documents: ReadonlyMap<string, IndexedDocument>

  constructor(documents: readonly IndexedDocument[]) {
    this.#documents = new Map(documents.map((document) => [document.documentRef.id, document]))
  }

  async readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    if (ctx.principal.tenantId !== TENANT_A || ctx.allowedResources.spaceId !== SPACE_A) {
      throw new Error('fixture span is outside the trusted tenant/space')
    }
    const document = this.#documents.get(request.documentRef.id)
    if (document === undefined || document.documentRef.digest !== request.documentRef.digest || JSON.stringify(document.locator) !== JSON.stringify(request.locator)) {
      throw new Error('fixture span is not indexed at the requested version and locator')
    }
    return {
      documentRef: document.documentRef,
      text: document.text,
      textDigest: document.textDigest,
      snapshot: {
        sourceRef: { namespace: 'ontology.document', sourceId: document.documentRef.id },
        schemaVersion: '1.0.0',
        readAt: new Date().toISOString(),
        consistency: 'immutable',
        resultDigest: document.documentDigest,
      },
    }
  }
}

/** Records the trusted context the handler injected, then delegates to the real provider. */
class RecordingWebProvider implements WebSearchProvider {
  readonly contexts: ToolContext[] = []
  constructor(private readonly inner: WebSearchProvider) {}
  get providerRef() {
    return this.inner.providerRef
  }
  search(request: WebSearchProviderRequest, ctx: ToolContext): Promise<WebSearchProviderResult> {
    this.contexts.push(ctx)
    return this.inner.search(request, ctx)
  }
}

function indexedDoc(text: string): IndexedDocument {
  const chunkId = randomUUID()
  const tokens = tokenize(text)
  const documentDigest = sha256DigestOf(`document-${chunkId}`)
  return {
    chunkId,
    parseId: randomUUID(),
    documentRef: { id: chunkId, version: '1.0.0', digest: documentDigest, kind: 'document' },
    documentDigest,
    mediaType: 'text/plain',
    text,
    textDigest: sha256DigestOf(text),
    locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: sha256DigestOf(text),
    ordinal: 0,
    recordedAt: '2026-09-21T00:00:00Z',
    length: tokens.length,
    termFrequencies: termFrequencies(tokens),
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(20)
  }
  return predicate()
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let businessAdmin: Client
let businessDb: BusinessPostgresDatabase
let adapter: PostgresQueryAdapter
let controlDatabase: ControlPostgresDatabase
let ledgerStore: PostgresBudgetLedgerStore
let indexStore: GatedKeywordIndexStore
let searchService: Bm25DocumentSearchService
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let budget: BudgetService
let fixture: WebSearchFixture
let provider: RecordingWebProvider
let gateway: ToolGateway

function binding(ledgerId: string): RunToolBinding {
  return { runId: RUN, ledgerId, resolvedProfile: fullProfile(), operations: operationRegistry() }
}

let composition: ReturnType<typeof createToolGatewayComposition>

async function openGateway(ledgerId: string, ctx: ToolContext): Promise<ToolGateway> {
  await budget.openLedger({ ledgerId, kind: 'run', runId: RUN }, ctx)
  return composition.forRun(binding(ledgerId))
}

async function lastReservationStatus(ledgerId: string, ctx: ToolContext): Promise<string | undefined> {
  const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const reservations = await ledgerStore.listReservations(scope, ledgerId, ctx)
  return reservations.at(-1)?.status
}

beforeEach(buildTestContexts)

beforeAll(async () => {
  buildTestContexts()
  fixture = await startWebSearchFixture()

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'assembly-a'), ($2, 'assembly-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'assembly-a'), ($3, $4, 'assembly-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const appStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = appStatement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres')

  // Business database with an independent read-only role.
  const businessDbName = `assembly_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const readPassword = `throwaway_${randomBytes(8).toString('hex')}`
  await adminClient.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${readPassword}'`)
  const businessAdminUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE SCHEMA sales;
    CREATE TABLE sales.orders (
      id integer PRIMARY KEY,
      customer text NOT NULL,
      amount numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO sales.orders (id, customer, amount) VALUES
      (1, 'acme', 10.50), (2, 'beta', 20.00), (3, 'acme', 30.25);
    CREATE VIEW sales.slow_view AS SELECT count(*) AS n FROM generate_series(1, 2000000000);
    GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READ_ONLY_ROLE};
  `)
  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, readPassword, businessDbName)
  businessDb = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 6 })

  objectDir = await mkdtemp(join(tmpdir(), 'assembly-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  ledgerStore = new PostgresBudgetLedgerStore(controlDatabase)
  budget = new BudgetService({
    store: ledgerStore,
    control: new ControlPostgresRepository(controlDatabase),
    newId: () => randomUUID(),
  })

  adapter = new PostgresQueryAdapter({
    database: businessDb,
    mappings: MAPPINGS,
    sourceRef: SOURCE_BUSINESS,
  })

  indexStore = new GatedKeywordIndexStore({ connectionString: appUrl, maxPoolSize: 4 })
  const documents = [indexedDoc('the battery warranty covers five years'), indexedDoc('solar inverter maintenance')]
  searchService = new Bm25DocumentSearchService({
    indexStore,
    spanReader: new FixtureSpanReader(documents),
    now: () => new Date().toISOString(),
  })
  const input: WriteGenerationInput = {
    collectionRef: COLLECTION,
    generation: '1',
    indexDigest: canonicalIndexDigest(COLLECTION, documents),
    indexRef: { id: COLLECTION, version: '1.0.0', digest: canonicalIndexDigest(COLLECTION, documents) },
    docCount: documents.length,
    avgDocLength: documents.reduce((sum, entry) => sum + entry.length, 0) / documents.length,
    completeness: 'complete',
    builtAt: '2026-09-21T00:00:00Z',
    documents,
  }
  await indexStore.writeGeneration(SCOPE_A, input, CTX_A)
  await indexStore.activateGeneration(SCOPE_A, COLLECTION, '1', '2026-09-21T00:00:00Z', CTX_A)

  provider = new RecordingWebProvider(new HttpWebSearchProvider({ baseUrl: fixture.baseUrl }))
  const handlers = createToolHandlerSet({
    query: adapter,
    mappings: new InMemorySemanticMappingRegistry([]),
    documentSearch: searchService,
    webSearch: provider,
    allowWeb: true,
    resolvedProfile: fullProfile(),
    webSourceRef: SOURCE_WEB,
  })
  composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers,
  })
  await budget.openLedger({ ledgerId: LEDGER_A, kind: 'run', runId: RUN }, CTX_A)
  gateway = composition.forRun(binding(LEDGER_A))
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await indexStore?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
  await fixture?.stop()
}, 120_000)

describe('the assembly layer injects the run ToolContext for all three handlers', () => {
  it('data_query reads through the exact trusted context the gateway was invoked with', async () => {
    const allowed = await gateway.invoke(
      dataCall(randomUUID(), 'SELECT id, amount FROM sales.orders ORDER BY id'),
      CTX_A,
    )
    expect(allowed.status).toBe('ok')
    expect(allowed.evidenceRefs).toHaveLength(1)

    // A context with the same run/scope but no approved business source is refused by the
    // real adapter, proving the handler used request.ctx and captured none.
    const noSource = toolContext({ tenantId: TENANT_A, spaceId: SPACE_A, sourceRefs: [] })
    const denied = await gateway.invoke(
      dataCall(randomUUID(), 'SELECT id FROM sales.orders'),
      noSource,
    )
    expect(denied.status).toBe('error')
    expect(denied.error?.code).toBe('FORBIDDEN')
  })

  it('document_search resolves the index in the tenant of the injected context', async () => {
    const found = await gateway.invoke(documentCall(randomUUID()), CTX_A)
    expect(found.status).toBe('ok')
    expect(found.coverage.returned).toBeGreaterThan(0)

    const gatewayB = await openGateway('99999999-9999-4999-8999-999999999999', CTX_B)
    const other = await gatewayB.invoke(documentCall(randomUUID()), CTX_B)
    expect(other.status).toBe('error')
    // The real index is scoped to tenant A, so tenant B's context resolves no generation.
    expect(other.error?.code).toBe('INDEX_NOT_FOUND')
    expect(other.error?.retryable).toBe(false)
    expect(other.error?.message).toContain('no active keyword index')
    expect(other.evidenceRefs).toEqual([])
  })

  it('web_search forwards the injected context to the real provider', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const before = provider.contexts.length
    const result = await gateway.invoke(webCall(randomUUID()), CTX_A)
    expect(result.status).toBe('ok')
    expect(provider.contexts).toHaveLength(before + 1)
    expect(provider.contexts.at(-1)).toBe(CTX_A)
  })
})

describe('run cancellation interrupts the real in-flight call', () => {
  it('interrupts a real PostgreSQL query and settles usage_unknown with no success', async () => {
    const ledger = randomUUID()
    const gatewayQuery = await openGateway(ledger, CTX_A)
    const callId = randomUUID()
    const pending = gatewayQuery.invoke(
      dataCall(callId, 'SELECT * FROM sales.slow_view', 'sales.slow_view'),
      CTX_A,
    )
    const registered = await waitUntil(() => adapter.activeTargets().length > 0)
    expect(registered).toBe(true)

    const receipt = await gatewayQuery.cancel(callId, 'the user cancelled the run', CTX_A)
    expect(['cancelled', 'cancelling']).toContain(receipt.state)

    const result = await pending
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.remoteStateUnknown).toBe(true)
    expect(result.evidenceRefs).toEqual([])
    expect(await lastReservationStatus(ledger, CTX_A)).toBe('usage_unknown')
    expect(await waitUntil(() => adapter.activeTargets().length === 0)).toBe(true)
  })

  it('aborts a real in-flight web search against the fixture and settles usage_unknown', async () => {
    const gatewayWeb = await openGateway('77777777-7777-4777-8777-777777777777', CTX_A)
    fixture.setScenario(scenarioWith([SAFE_PAGE], { delayMs: 10_000 }))
    const callId = randomUUID()
    const requestsBefore = fixture.requests.length
    const pending = gatewayWeb.invoke(webCall(callId), CTX_A)
    expect(await waitUntil(() => fixture.requests.length > requestsBefore)).toBe(true)

    const receipt = await gatewayWeb.cancel(callId, 'the user cancelled the run', CTX_A)
    expect(['cancelled', 'cancelling']).toContain(receipt.state)

    const result = await pending
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.remoteStateUnknown).toBe(true)
    expect(result.evidenceRefs).toEqual([])
    expect(await lastReservationStatus('77777777-7777-4777-8777-777777777777', CTX_A)).toBe('usage_unknown')
  })

  it('stops waiting for an in-flight BM25 search and settles usage_unknown', async () => {
    const gatewayDoc = await openGateway('66666666-6666-4666-8666-666666666666', CTX_A)
    let release: (() => void) | undefined
    indexStore.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    indexStore.entered = false
    const callId = randomUUID()
    const pending = gatewayDoc.invoke(documentCall(callId), CTX_A)
    expect(await waitUntil(() => indexStore.entered)).toBe(true)

    const receipt = await gatewayDoc.cancel(callId, 'the user cancelled the run', CTX_A)
    expect(['cancelled', 'cancelling']).toContain(receipt.state)

    const result = await pending
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.evidenceRefs).toEqual([])
    expect(await lastReservationStatus('66666666-6666-4666-8666-666666666666', CTX_A)).toBe('usage_unknown')
    release?.()
    indexStore.gate = undefined
  })
})

describe('adapter-raised port errors keep their canonical classification on the tool path', () => {
  it('preserves UNSUPPORTED_QUERY from the PostgreSQL adapter', async () => {
    const gatewayCase = await openGateway(randomUUID(), CTX_A)
    const result = await gatewayCase.invoke(
      dataCall(randomUUID(), 'WITH x AS (DELETE FROM sales.orders RETURNING id) SELECT id FROM x'),
      CTX_A,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('UNSUPPORTED_QUERY')
  })

  it('preserves DEADLINE_EXCEEDED (usage_unknown) when the run deadline is exceeded', async () => {
    const gatewayDeadline = await openGateway('55555555-5555-4555-8555-555555555555', CTX_A)
    const soon = toolContext({
      tenantId: TENANT_A,
      spaceId: SPACE_A,
      sourceRefs: [SOURCE_BUSINESS],
      deadline: new Date(Date.now() + 300).toISOString(),
    })
    const result = await gatewayDeadline.invoke(
      dataCall(randomUUID(), 'SELECT * FROM sales.slow_view', 'sales.slow_view'),
      soon,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.remoteStateUnknown).toBe(true)
  })

  it('preserves UNSUPPORTED_QUERY from the BM25 document search (vector mode)', async () => {
    const gatewayCase = await openGateway(randomUUID(), CTX_A)
    const result = await gatewayCase.invoke(documentCall(randomUUID(), 'vector'), CTX_A)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('UNSUPPORTED_QUERY')
  })

  it('preserves the web provider catalogue codes end to end', async () => {
    const cases: readonly { status: number; code: string }[] = [
      { status: 429, code: 'RATE_LIMITED' },
      { status: 503, code: 'SOURCE_UNAVAILABLE' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 413, code: 'RESULT_TOO_LARGE' },
      { status: 504, code: 'DEADLINE_EXCEEDED' },
    ]
    for (const testCase of cases) {
      const gatewayCase = await openGateway(randomUUID(), CTX_A)
      fixture.setScenario({ results: [], status: testCase.status })
      const result = await gatewayCase.invoke(webCall(randomUUID()), CTX_A)
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe(testCase.code)
    }
  })

  it('keeps INVALID_ARGUMENT for schema-rejected arguments', async () => {
    const gatewayCase = await openGateway(randomUUID(), CTX_A)
    const result = await gatewayCase.invoke(
      { callId: randomUUID(), toolId: 'document_search', arguments: {} },
      CTX_A,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('keeps BUDGET_EXHAUSTED from a real reservation denial', async () => {
    const ledger = '44444444-4444-4444-8444-444444444444'
    await budget.openLedger(
      { ledgerId: ledger, kind: 'run', runId: RUN, overrideLimits: { maxToolCalls: 0 } },
      CTX_A,
    )
    const gatewayBudget = composition.forRun(binding(ledger))
    const result = await gatewayBudget.invoke(documentCall(randomUUID()), CTX_A)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('BUDGET_EXHAUSTED')
  })
})

describe('document_search index-state failures keep their canonical code on the tool path', () => {
  function docCallFor(callId: string, collection: string, cursor?: string): ToolCall {
    return {
      callId,
      toolId: 'document_search',
      arguments: {
        query: 'battery warranty',
        allowedCollectionRefs: [collection],
        mode: 'keyword',
        ...(cursor === undefined ? {} : { cursor }),
      },
    }
  }

  it('preserves INDEX_NOT_FOUND for an authorized collection with no active index', async () => {
    const gatewayCase = await openGateway(randomUUID(), noIndexContext)
    const result = await gatewayCase.invoke(
      docCallFor(randomUUID(), MISSING_COLLECTION),
      noIndexContext,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INDEX_NOT_FOUND')
    expect(result.error?.retryable).toBe(false)
    expect(result.evidenceRefs).toEqual([])
  })

  it('preserves SOURCE_UNAVAILABLE when the real index store returns an untrustworthy row', async () => {
    const documents = [indexedDoc('the battery warranty covers five years')]
    const indexDigest = canonicalIndexDigest(CORRUPT_COLLECTION, documents)
    const input: WriteGenerationInput = {
      collectionRef: CORRUPT_COLLECTION,
      generation: '1',
      indexDigest,
      indexRef: { id: CORRUPT_COLLECTION, version: '1.0.0', digest: indexDigest },
      docCount: documents.length,
      avgDocLength: documents.reduce((sum, entry) => sum + entry.length, 0) / documents.length,
      completeness: 'complete',
      builtAt: '2026-09-21T00:00:00Z',
      documents,
    }
    await indexStore.writeGeneration(SCOPE_A, input, CTX_A)
    await indexStore.activateGeneration(SCOPE_A, CORRUPT_COLLECTION, '1', '2026-09-21T00:00:00Z', CTX_A)
    // The real store reads this back on the search path; a locator value it cannot
    // trust is a store integrity failure, not an empty result.
    await adminClient.query(
      `UPDATE agent_platform.keyword_index_documents SET locator = '{"kind":"corrupt"}'::jsonb
        WHERE tenant_id = $1 AND space_id = $2 AND collection_ref = $3`,
      [TENANT_A, SPACE_A, CORRUPT_COLLECTION],
    )

    const gatewayCase = await openGateway(randomUUID(), corruptContext)
    const result = await gatewayCase.invoke(
      docCallFor(randomUUID(), CORRUPT_COLLECTION),
      corruptContext,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.error?.retryable).toBe(true)
    expect(result.evidenceRefs).toEqual([])
  })

  it('preserves SNAPSHOT_UNAVAILABLE when a cursor pins a generation that is gone', async () => {
    const documents = [
      indexedDoc('the battery warranty covers five years'),
      indexedDoc('the battery warranty excludes misuse'),
    ]
    const indexDigest = canonicalIndexDigest(CURSOR_COLLECTION, documents)
    const input: WriteGenerationInput = {
      collectionRef: CURSOR_COLLECTION,
      generation: '1',
      indexDigest,
      indexRef: { id: CURSOR_COLLECTION, version: '1.0.0', digest: indexDigest },
      docCount: documents.length,
      avgDocLength: documents.reduce((sum, entry) => sum + entry.length, 0) / documents.length,
      completeness: 'complete',
      builtAt: '2026-09-21T00:00:00Z',
      documents,
    }
    await indexStore.writeGeneration(SCOPE_A, input, CTX_A)
    await indexStore.activateGeneration(SCOPE_A, CURSOR_COLLECTION, '1', '2026-09-21T00:00:00Z', CTX_A)

    const first = await searchService.search(
      {
        query: 'battery warranty',
        allowedCollectionRefs: [CURSOR_COLLECTION],
        mode: 'keyword',
        limit: 1,
      },
      CTX_A,
    )
    const pinned = first.nextCursor
    if (pinned === null || pinned === undefined) throw new Error('expected a pinned cursor')
    const decoded = decodeCursor(pinned)
    const stale = encodeCursor({
      version: 1,
      queryDigest: decoded.queryDigest,
      collections: decoded.collections.map((entry) => ({
        collectionRef: entry.collectionRef,
        generation: '999999',
      })),
      offset: decoded.offset,
    })

    const gatewayCase = await openGateway(randomUUID(), cursorContext)
    const result = await gatewayCase.invoke(
      docCallFor(randomUUID(), CURSOR_COLLECTION, stale),
      cursorContext,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('SNAPSHOT_UNAVAILABLE')
    expect(result.error?.retryable).toBe(false)
    expect(result.evidenceRefs).toEqual([])
  })
})
