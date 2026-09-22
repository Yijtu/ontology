import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import {
  Bm25DocumentSearchService,
  DocumentSearchError,
  PostgresKeywordIndexStore,
  createBm25DocumentSearchToolHandler,
} from '@ontology/adapter-search-bm25'
import { ERROR_CATALOG } from '@ontology/contracts'
import type { DocumentSpanReaderPort, ReadSpanResponse, ScopeRef } from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'
import { buildGateway, gatewayContext, openGatewayLedger } from '../unit/tool-gateway-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

// Starting the container, migrating and then stopping it mid-test is the point of
// this suite; the per-test default is too tight when the whole run is parallel.
vi.setConfig({ testTimeout: 120_000 })

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '33333333-3333-4333-8333-333333333333'
const COLLECTION = 'manuals/connection-failure'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }

/** The span reader is never reached while the store is down; it is a strict stub. */
const unusedSpanReader: DocumentSpanReaderPort = {
  async readSpan(): Promise<ReadSpanResponse> {
    throw new Error('the span reader must not be reached when the store is unavailable')
  },
}

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

let container: PostgresContainer | undefined
let adminClient: Client
let appUrl = ''
let indexStore: PostgresKeywordIndexStore
let searchService: Bm25DocumentSearchService

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  let adminUrl: string
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  // The database is deliberately stopped later in the test; an idle admin socket
  // then closes, so swallow its background error rather than crashing the run.
  adminClient.on('error', () => undefined)
  await adminClient.connect()

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) {
    throw new Error('could not build the application-role login statement')
  }
  await adminClient.query(alterStatement)
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  indexStore = new PostgresKeywordIndexStore({
    connectionString: appUrl,
    maxPoolSize: 4,
    connectionTimeoutMs: 2_000,
  })
  searchService = new Bm25DocumentSearchService({
    indexStore,
    spanReader: unusedSpanReader,
    now: () => new Date().toISOString(),
  })
}, 300_000)

afterAll(async () => {
  await indexStore?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('BM25 keyword index store against a real PostgreSQL that is stopped', () => {
  it('classifies the connection loss as SOURCE_UNAVAILABLE end-to-end on the tool path', async () => {
    const storeCtx = createTestToolContext(TENANT, SPACE)

    // 1. The store is genuinely reachable before the outage, so the failure below
    //    is a real connection loss and not a misconfigured connection string.
    await expect(indexStore.getActiveGeneration(SCOPE, COLLECTION, storeCtx)).resolves.toBeUndefined()

    // 2. Stop the real database.
    if (container === undefined) {
      throw new Error('the container-stop test requires a real PostgreSQL container')
    }
    await container.stop()

    // 3. The store reports the canonical retryable code with the original cause,
    //    rather than the raw driver error.
    const storeFailure = await indexStore
      .getActiveGeneration(SCOPE, COLLECTION, storeCtx)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(storeFailure).toBeInstanceOf(DocumentSearchError)
    expect(storeFailure).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    })
    const cause = (storeFailure as DocumentSearchError).cause
    expect(cause).toBeDefined()
    process.stdout.write(
      `[bm25-store-connection] container=${container.containerName} cause=${String(
        (cause as { code?: unknown }).code ?? (cause as Error).name,
      )} message=${(cause as Error).message}\n`,
    )

    // 4. A fresh pool (no idle socket) takes the refused-connect path and classifies
    //    it the same way.
    const freshStore = new PostgresKeywordIndexStore({
      connectionString: appUrl,
      maxPoolSize: 1,
      connectionTimeoutMs: 2_000,
    })
    await expect(
      freshStore.getActiveGeneration(SCOPE, COLLECTION, storeCtx),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', httpStatus: 503, retryable: true })
    await freshStore.close().catch(() => undefined)

    // 5. The canonical catalogue semantics are unchanged: 503, limited, bounded retry.
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE.httpStatus).toBe(503)
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE.retryable).toBe('limited')
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE.maxRetries).toBe(2)

    // 6. End-to-end through the real gateway: the classification is preserved and is
    //    not downgraded to INTERNAL_ERROR, and no traceable success is returned.
    const ctx = gatewayContext({
      collectionRefs: [COLLECTION],
      runId: RUN,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    })
    const handler = createBm25DocumentSearchToolHandler({ service: searchService })
    const harness = buildGateway({ handlers: [handler], ctx })
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'document_search',
        arguments: {
          query: 'battery warranty',
          allowedCollectionRefs: [COLLECTION],
          mode: 'keyword',
        },
      },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.error?.retryable).toBe(true)
    expect(result.error?.code).not.toBe('INTERNAL_ERROR')
    expect(result.evidenceRefs).toEqual([])
    expect(result.sourceSnapshots).toEqual([])
  })
})
