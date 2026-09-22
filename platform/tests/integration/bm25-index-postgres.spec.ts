import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import {
  Bm25DocumentSearchService,
  Bm25IndexBuilder,
  PostgresKeywordIndexStore,
  createBm25DocumentSearchToolHandler,
  createBm25IndexBuildHandler,
} from '@ontology/adapter-search-bm25'
import type { IndexedDocument, WriteGenerationInput } from '@ontology/adapter-search-bm25'
import { JobService, JobWorker, OutboxDispatcher } from '@ontology/application'
import type { JobStageHandler, JobStageHandlerRegistry, OutboxConsumer } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import type {
  DocumentParseRecord,
  OutboxMessageRecord,
  PipelineStage,
  RunnableJobStage,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

// This suite runs real parsing, a durable job and containerised PostgreSQL; when
// the whole test run executes in parallel the per-test default is too tight.
vi.setConfig({ testTimeout: 120_000 })

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function textDocument(label: string): Uint8Array {
  return new TextEncoder().encode(
    [
      `SERVICE TERMS ${label.toUpperCase()}`,
      `1.1 The battery warranty covers five years for ${label}.`,
      `1.2 The solar inverter is maintained by the customer for ${label}.`,
    ].join('\n'),
  )
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appUrl = ''
let scopedClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parseStore: PostgresDocumentParseStore
let indexStore: PostgresKeywordIndexStore
let parseService: LocalDocumentExtractionService
let spanReader: DocumentSpanReader
let database: ControlPostgresDatabase
let jobStore: PostgresJobStore
let jobService: JobService
let budget: BudgetService
let searchService: Bm25DocumentSearchService

async function publishText(label: string, ctx: ToolContext = CTX_A): Promise<DocumentParseRecord> {
  const bytes = textDocument(label)
  const staged = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctx,
  )
  return parseService.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, ctx)
}

function worker(handler: JobStageHandler): JobWorker {
  const pass = (stage: RunnableJobStage, nextStage: PipelineStage): JobStageHandler => ({
    stage,
    run: async (context) => ({ nextStage, counts: context.job.counts }),
  })
  const handlers = new Map<PipelineStage, JobStageHandler>([
    ['received', pass('received', 'parsed')],
    ['parsed', pass('parsed', 'extracted')],
    ['extracted', handler],
  ])
  const registry: JobStageHandlerRegistry = { get: (stage) => handlers.get(stage) }
  return new JobWorker({
    store: jobStore,
    handlers: registry,
    budget,
    workerId: `bm25-worker-${randomUUID().slice(0, 8)}`,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
}

async function buildIndexAsJob(
  collectionRef: string,
  parses: readonly DocumentParseRecord[],
  ctx: ToolContext = CTX_A,
): Promise<void> {
  const builder = new Bm25IndexBuilder({
    parseStore,
    indexStore,
    now: () => new Date().toISOString(),
  })
  const handler = createBm25IndexBuildHandler({ builder, collectionRef, parses })
  const jobId = randomUUID()
  const corpusRef = parses
    .map((parse) => parse.parseId)
    .sort()
    .join(',')
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'source-bm25',
      documentRef: `corpus:${collectionRef}:${corpusRef}`,
      pipelineVersion: '1.0.0',
      idempotencyKey: `bm25-${jobId}`,
    },
    ctx,
  )
  const result = await worker(handler).runOnce(SCOPE_A, ctx)
  expect(result.disposition).toBe('stopped')
}

class RecordingConsumer implements OutboxConsumer {
  readonly seen: string[] = []
  async consume(message: OutboxMessageRecord): Promise<void> {
    this.seen.push(message.idempotencyKey)
  }
}

async function appScopeCount(table: string, tenantId: string): Promise<number> {
  const result = await scopedClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE tenant_id = $1`,
    [tenantId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function withAppScope(
  tenantId: string,
  spaceId: string,
  run: () => Promise<void>,
): Promise<void> {
  await scopedClient.query('BEGIN')
  try {
    await scopedClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
      [tenantId, spaceId],
    )
    await run()
    await scopedClient.query('ROLLBACK')
  } catch (error) {
    await scopedClient.query('ROLLBACK').catch(() => undefined)
    throw error
  }
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
     VALUES ($1, 'bm25-tenant-a'), ($2, 'bm25-tenant-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'bm25-space-a'), ($3, $4, 'bm25-space-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'bm25-index-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  indexStore = new PostgresKeywordIndexStore({ connectionString: appUrl, maxPoolSize: 4 })
  parseService = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => new Date().toISOString(),
  })
  spanReader = new DocumentSpanReader({
    blobs: blobStore,
    store: parseStore,
    now: () => new Date().toISOString(),
  })
  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  jobStore = new PostgresJobStore(database)
  jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    newId: () => randomUUID(),
  })
  searchService = new Bm25DocumentSearchService({
    indexStore,
    spanReader,
    now: () => new Date().toISOString(),
  })
  scopedClient = new Client({ connectionString: appUrl })
  await scopedClient.connect()
}, 300_000)

afterAll(async () => {
  await scopedClient?.end().catch(() => undefined)
  await indexStore?.close().catch(() => undefined)
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('migration 020', () => {
  it('enables RLS on every keyword index table and keeps tenant/space in the keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN (
            'keyword_index_generations', 'keyword_index_documents',
            'keyword_index_postings', 'keyword_index_active')
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.keyword_index_generations',
            'agent_platform.keyword_index_documents',
            'agent_platform.keyword_index_postings')
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.keyword_index_generations')).toEqual([
      'tenant_id',
      'space_id',
      'collection_ref',
      'generation',
    ])
    expect(byTable.get('agent_platform.keyword_index_documents')).toEqual([
      'tenant_id',
      'space_id',
      'collection_ref',
      'generation',
      'chunk_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('020_bm25_keyword_index.sql')
  })
})

describe('BM25 keyword index against real PostgreSQL, blob-local and the parse store', () => {
  it('parses a real document, builds the index as a job stage and searches it end-to-end', async () => {
    const collection = 'manuals/end-to-end'
    const parsed = await publishText('alpha')
    await buildIndexAsJob(collection, [parsed])

    // The job published the index version exactly once and enqueued its outbox.
    const publications = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.job_publications
        WHERE tenant_id = $1 AND space_id = $2`,
      [TENANT_A, SPACE_A],
    )
    expect(Number(publications.rows[0]?.count)).toBeGreaterThanOrEqual(1)
    const pending = await jobStore.listPendingOutbox(SCOPE_A, 10, new Date().toISOString(), CTX_A)
    expect(pending.some((message) => message.idempotencyKey.includes('keyword-index:'))).toBe(true)
    const consumer = new RecordingConsumer()
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer, now: () => new Date().toISOString() })
    expect(await dispatcher.dispatchOnce(SCOPE_A, CTX_A)).toBeGreaterThanOrEqual(1)
    expect(consumer.seen.some((key) => key.includes('keyword-index:'))).toBe(true)

    const response = await searchService.search(
      { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword' },
      CTX_A,
    )
    expect(response.scoreKind).toBe('bm25')
    expect(response.indexVersion.generation).toBe('1')
    expect(response.spans.length).toBeGreaterThan(0)

    // The snippet round-trips to the original through the LOCAL-023 span reader.
    const span = response.spans[0]
    if (span === undefined) throw new Error('expected a span')
    const read = await spanReader.readSpan(
      { documentRef: span.documentRef, locator: span.locator },
      CTX_A,
    )
    expect(read.text).toContain('battery warranty')
    expect(read.documentRef.digest).toBe(span.documentRef.digest)
  })

  it('keeps an older index version stable while a newer one is built and activated', async () => {
    const collection = 'manuals/versions'
    const first = await publishText('version-one-a')
    const second = await publishText('version-one-b')
    await buildIndexAsJob(collection, [first, second])

    const v1 = await searchService.search(
      { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword', limit: 1 },
      CTX_A,
    )
    expect(v1.indexVersion.generation).toBe('1')
    expect(v1.spans).toHaveLength(1)
    const pinned = v1.nextCursor
    expect(pinned).not.toBeNull()
    const v1FirstSpanDigest = v1.spans[0]?.quoteDigest

    const third = await publishText('version-two')
    await buildIndexAsJob(collection, [first, second, third])
    const v2 = await searchService.search(
      { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword', limit: 10 },
      CTX_A,
    )
    expect(v2.indexVersion.generation).toBe('2')
    expect(v2.spans.length).toBeGreaterThanOrEqual(3)

    // The v1 cursor still reads generation 1 and returns the next v1 snippet.
    if (pinned === null || pinned === undefined) throw new Error('expected a pinned cursor')
    const v1PageTwo = await searchService.search(
      { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword', limit: 1, cursor: pinned },
      CTX_A,
    )
    expect(v1PageTwo.indexVersion.generation).toBe('1')
    expect(v1PageTwo.spans[0]?.quoteDigest).not.toBe(v1FirstSpanDigest)
  })

  it('reports a truncated recall range without claiming the corpus lacks the query', async () => {
    const collection = 'manuals/truncated'
    const first = await publishText('truncated-a')
    const second = await publishText('truncated-b')
    await buildIndexAsJob(collection, [first, second])
    const response = await searchService.search(
      { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword', limit: 1 },
      CTX_A,
    )
    expect(response.spans).toHaveLength(1)
    expect(response.completeness).toBe('truncated')
    expect(response.nextCursor).not.toBeNull()
  })

  it('collapses duplicate copies of one document into a single independent span', async () => {
    const collection = 'manuals/duplicates'
    const bytes = textDocument('duplicate')
    const staged = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, CTX_A)
    const published = await blobStore.publish(
      {
        scopeRef: SCOPE_A,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      },
      CTX_A,
    )
    // Two parser versions of identical bytes are two parse records over the same
    // lineage; the index must not present them as two independent evidence spans.
    const parseV1 = await parseService.parse(
      { scopeRef: SCOPE_A, originalRef: published.blobRef, parserVersion: '1.0.0' },
      CTX_A,
    )
    const parseV2 = await parseService.parse(
      { scopeRef: SCOPE_A, originalRef: published.blobRef, parserVersion: '1.0.1' },
      CTX_A,
    )
    expect(parseV2.parseId).not.toBe(parseV1.parseId)
    expect(parseV2.originalRef.digest).toBe(parseV1.originalRef.digest)

    const builder = new Bm25IndexBuilder({
      parseStore,
      indexStore,
      now: () => new Date().toISOString(),
    })
    const built = await builder.build({ collectionRef: collection, parses: [parseV1, parseV2] }, CTX_A)
    await builder.activate(collection, built.generation.generation, CTX_A)
    const detail = await searchService.searchDetailed(
      { query: 'battery warranty duplicate', allowedCollectionRefs: [collection], mode: 'keyword' },
      CTX_A,
    )
    expect(detail.response.spans.length).toBeGreaterThan(0)
    expect(detail.duplicatesCollapsed).toBeGreaterThanOrEqual(1)
    const digests = new Set(detail.response.spans.map((span) => span.documentRef.digest))
    expect(digests.size).toBe(detail.response.spans.length)
  })

  it('returns scoreKind, a cursor and an honest coverage through the real tool handler', async () => {
    const collection = 'manuals/tool-handler'
    const first = await publishText('tool-a')
    const second = await publishText('tool-b')
    await buildIndexAsJob(collection, [first, second])
    const handler = createBm25DocumentSearchToolHandler({ service: searchService })
    const outcome = await handler.execute({
      callId: randomUUID(),
      toolId: 'document_search',
      arguments: { query: 'battery warranty', allowedCollectionRefs: [collection], mode: 'keyword', limit: 1 },
      resultLimits: { maxRows: 200, maxBytes: 1048576, maxDurationMs: 30000 },
      deadline: new Date(Date.now() + 30_000).toISOString(),
      traceId: 'trace-bm25-integration',
      ctx: CTX_A,
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('partial')
    expect(outcome.payload.scoreKind).toBe('bm25')
    expect(outcome.payload.indexVersion.generation).toBe('1')
    expect(outcome.coverage.returned).toBe(1)
    expect(outcome.coverage.knownTotal).toBeGreaterThanOrEqual(2)
    expect(outcome.coverage.truncated).toBe(true)

    // vector/hybrid are refused explicitly, never degraded to keyword.
    await expect(
      handler.execute({
        callId: randomUUID(),
        toolId: 'document_search',
        arguments: { query: 'battery', allowedCollectionRefs: [collection], mode: 'hybrid' },
        resultLimits: { maxRows: 200, maxBytes: 1048576, maxDurationMs: 30000 },
        deadline: new Date(Date.now() + 30_000).toISOString(),
        traceId: 'trace-bm25-integration',
        ctx: CTX_A,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })

  it('does not disclose another tenant index and hides rows under RLS', async () => {
    await expect(
      searchService.search(
        { query: 'battery warranty', allowedCollectionRefs: ['manuals/end-to-end'], mode: 'keyword' },
        CTX_B,
      ),
    ).rejects.toMatchObject({ code: 'INDEX_NOT_FOUND' })

    await withAppScope(TENANT_B, SPACE_B, async () => {
      expect(await appScopeCount('keyword_index_generations', TENANT_A)).toBe(0)
      expect(await appScopeCount('keyword_index_documents', TENANT_A)).toBe(0)
    })
    // The application role can still see its own scope.
    await withAppScope(TENANT_A, SPACE_A, async () => {
      expect(await appScopeCount('keyword_index_generations', TENANT_A)).toBeGreaterThan(0)
    })
  })

  it('rolls back a generation write that fails partway, leaving the active index unchanged', async () => {
    const collection = 'manuals/atomicity'
    const parsed = await publishText('atomicity')
    await buildIndexAsJob(collection, [parsed])
    const activeBefore = await indexStore.getActiveGeneration(SCOPE_A, collection, CTX_A)
    expect(activeBefore?.generation).toBe('1')

    const duplicateChunk = '00000000-0000-4000-8000-00000000ffff'
    const document: IndexedDocument = {
      chunkId: duplicateChunk,
      parseId: randomUUID(),
      documentRef: { id: duplicateChunk, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
      documentDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      text: 'broken generation',
      textDigest: `sha256:${'b'.repeat(64)}`,
      locator: { kind: 'offset', startOffset: 0, endOffset: 1 },
      spanKind: 'verbatim',
      precision: 'exact',
      quoteDigest: `sha256:${'b'.repeat(64)}`,
      ordinal: 0,
      recordedAt: new Date().toISOString(),
      length: 2,
      termFrequencies: new Map([
        ['broken', 1],
        ['generation', 1],
      ]),
    }
    const input: WriteGenerationInput = {
      collectionRef: collection,
      generation: '999',
      indexDigest: `sha256:${'c'.repeat(64)}`,
      indexRef: { id: collection, version: '1.0.0', digest: `sha256:${'c'.repeat(64)}` },
      docCount: 2,
      avgDocLength: 2,
      completeness: 'complete',
      builtAt: new Date().toISOString(),
      documents: [document, document],
    }
    await expect(indexStore.writeGeneration(SCOPE_A, input, CTX_A)).rejects.toBeDefined()

    expect(await indexStore.getGeneration(SCOPE_A, collection, '999', CTX_A)).toBeUndefined()
    const activeAfter = await indexStore.getActiveGeneration(SCOPE_A, collection, CTX_A)
    expect(activeAfter?.generation).toBe('1')
  })
})
