import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresTableArtifactStore } from '@ontology/adapter-control-postgres'
import { TableArtifactReadService } from '@ontology/application'
import {
  TableArtifactReadError,
  createToolContext,
  decodeTableReadCursor,
  encodeTableReadCursor,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  TablePageReadView,
  ToolContext,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const NOW = '2026-09-30T00:00:00Z'
const TABLE_ID = 'table.energy'
const ROW_TOTAL = 1001
const PAGE_SIZE = 250

const outputSchemaRef = { id: 'output.schema', version: '1.0.0', digest: DIGEST }
const columns: readonly TableColumnDescriptor[] = [
  { columnRef: 'amount', semanticPredicate: 'energy.amount', valueType: 'quantity', schemaPointer: '/amount', requiredContextPointers: ['unitPointer'] },
  { columnRef: 'site', semanticPredicate: 'site.id', valueType: 'entity_ref', schemaPointer: '/site' },
]

function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

class MemoryArtifacts implements ImmutableArtifactWriter {
  readonly blobs = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest): Promise<BlobPutImmutableResponse> {
    const digest = digestOfBytes(request.content)
    this.blobs.set(digest, request.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest, verifiedAt: NOW },
    }
  }
}

class MemoryReader implements ScopedArtifactReader {
  readonly #artifacts: MemoryArtifacts

  constructor(artifacts: MemoryArtifacts) {
    this.#artifacts = artifacts
  }

  async read(request: ScopedArtifactReaderRequest): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('no input ref')
    const bytes = this.#artifacts.blobs.get(ref.digest)
    if (bytes === undefined) throw new Error(`no blob for ${ref.digest}`)
    return bytes
  }
}

function ctxFor(target: JobTestScope): ToolContext {
  const runId = randomUUID()
  return createToolContext({
    principal: { tenantId: target.tenantId, subjectId: 'table-reader', roles: ['platform-admin', 'operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: NOW, expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: { tenantId: target.tenantId, spaceId: target.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 0 },
    traceId: `table-artifacts:${randomUUID()}`,
  })
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function buildPage(pageIndex: number, rowKeys: readonly string[]): { ref: ResourceRef; body: TableArtifactPageBody } {
  const ref: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
  const body: TableArtifactPageBody = {
    schemaVersion: 'table-artifact-page@1',
    tableId: TABLE_ID,
    outputSchemaRef,
    pageIndex,
    columnRefs: ['amount', 'site'],
    rowKeyOrder: 'ascending',
    rows: rowKeys.map((rowKey, index) => ({
      rowKey,
      cells: { amount: String(index), site: `site-${rowKey}` },
      bindings: [
        { rowKey, columnRef: 'amount', evidenceRef: evidenceRef(), resultDigest: DIGEST, valuePointer: '/amount', subjectPointer: '/site', unitPointer: '/unit' },
        { rowKey, columnRef: 'site', evidenceRef: evidenceRef(), resultDigest: DIGEST, valuePointer: '/site', subjectPointer: '/site' },
      ],
    })),
    coverage: { returned: rowKeys.length, truncated: false },
  }
  return { ref, body }
}

function buildTable(): { manifest: TableArtifactManifest; pages: readonly { ref: ResourceRef; body: TableArtifactPageBody }[]; ref: ResourceRef; receiptRef: ResourceRef } {
  const pages: { ref: ResourceRef; body: TableArtifactPageBody }[] = []
  for (let pageIndex = 0; pageIndex * PAGE_SIZE < ROW_TOTAL; pageIndex += 1) {
    const start = pageIndex * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, ROW_TOTAL)
    const rowKeys = Array.from({ length: end - start }, (_value, offset) => `r-${String(start + offset).padStart(5, '0')}`)
    pages.push(buildPage(pageIndex, rowKeys))
  }
  const manifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: TABLE_ID,
    outputSchemaRef,
    columns,
    totalRows: ROW_TOTAL,
    rowKeyOrder: 'ascending',
    pages: pages.map((page) => ({
      pageIndex: page.body.pageIndex,
      artifactRef: { ...page.ref, digest: tableArtifactContentDigest(page.body) },
      artifactDigest: tableArtifactContentDigest(page.body),
      rowCount: page.body.rows.length,
      firstRowKey: page.body.rows[0]?.rowKey ?? '',
      lastRowKey: page.body.rows[page.body.rows.length - 1]?.rowKey ?? '',
      pageCoverageDigest: tablePageCoverageDigest(page.body),
    })),
    coverage: { returned: ROW_TOTAL, truncated: false },
    complete: true,
  }
  return {
    manifest,
    pages,
    ref: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    receiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' },
  }
}

function requireCursor(view: TablePageReadView): string {
  if (view.cursor === undefined) throw new Error(`page ${view.pageIndex} unexpectedly had no next cursor`)
  return view.cursor
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<TableArtifactReadError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TableArtifactReadError) {
      expect(error.code).toBe(code)
      return error
    }
    throw error
  }
  throw new Error(`expected a TableArtifactReadError ${code}`)
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let store: PostgresTableArtifactStore
let artifacts: MemoryArtifacts
let service: TableArtifactReadService

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scope = await createJobScope(harness.adminClient, 'table-artifacts')
  otherScope = await createJobScope(harness.adminClient, 'table-artifacts-other')
  artifacts = new MemoryArtifacts()
  store = new PostgresTableArtifactStore(database, { writer: artifacts, reader: new MemoryReader(artifacts) })
  service = new TableArtifactReadService({ manifests: store, pages: store, progress: store })
})

afterAll(async () => {
  await database?.close()
  await harness?.stop()
})

async function seedTable(target: JobTestScope, answerId: string): Promise<{ manifest: TableArtifactManifest }> {
  const built = buildTable()
  const ctx = ctxFor(target)
  for (const page of built.pages) {
    await store.putPage(scopeRef(target), { ...page.ref, digest: tableArtifactContentDigest(page.body) }, page.body, ctx)
  }
  await store.putManifest(scopeRef(target), answerId, built.ref, built.manifest, built.receiptRef, ctx)
  return { manifest: built.manifest }
}

function scopeRef(target: JobTestScope) {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

describe('table artifact manifest and paginated read over real PostgreSQL', () => {
  it('stores only refs/counts/digests and walks the fixed revision across five pages', async () => {
    const answerId = randomUUID()
    await seedTable(scope, answerId)
    const ctx = ctxFor(scope)

    const columnsRow = await harness.adminClient.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'agent_platform' AND table_name = 'table_artifact_pages'`,
    )
    const names = columnsRow.rows.map((row) => row.column_name)
    expect(names).toContain('content_ref')
    expect(names).not.toContain('rows')
    expect(names).not.toContain('page')

    const concat: string[] = []
    let pages = 0
    let view = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    for (;;) {
      pages += 1
      concat.push(...view.rows.map((row) => row.rowKey))
      expect(view.pageCount).toBe(5)
      expect(view.rows.length).toBeLessThanOrEqual(PAGE_SIZE)
      if (view.cursor === undefined) break
      view = await service.readPage({ answerId, tableId: TABLE_ID, cursor: view.cursor }, ctx)
    }
    expect(pages).toBe(5)
    expect(concat).toHaveLength(ROW_TOTAL)
    expect(new Set(concat).size).toBe(ROW_TOTAL)
  })

  it('refuses duplicate and backward cursors using the persisted page tab', async () => {
    const answerId = randomUUID()
    await seedTable(scope, answerId)
    const ctx = ctxFor(scope)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    const cursor = requireCursor(first)
    const second = await service.readPage({ answerId, tableId: TABLE_ID, cursor }, ctx)
    expect(second.pageIndex).toBe(1)

    const progress = await store.get(scopeRef(scope), answerId, TABLE_ID, ctx)
    expect(progress?.highestServedPageIndex).toBe(1)

    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor }, ctx), 'CURSOR_REPLAY')

    const decoded = decodeTableReadCursor(cursor)
    const backward = encodeTableReadCursor({
      version: 1,
      answerId: decoded.answerId,
      tableId: decoded.tableId,
      resultManifestRef: decoded.resultManifestRef,
      resultManifestDigest: decoded.resultManifestDigest,
      scopeDigest: decoded.scopeDigest,
      pageIndex: 0,
    })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor: backward }, ctx), 'CURSOR_BACKWARD')
  })

  it('isolates the table by tenant/space', async () => {
    const answerId = randomUUID()
    await seedTable(scope, answerId)
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID }, ctxFor(otherScope)), 'TABLE_NOT_FOUND')
  })

  it('is idempotent for the same page artifact ref', async () => {
    const built = buildTable()
    const ctx = ctxFor(scope)
    const first = built.pages[0]
    if (first === undefined) throw new Error('no first page')
    const pageRef: ResourceRef = { ...first.ref, digest: tableArtifactContentDigest(first.body) }
    await store.putPage(scopeRef(scope), pageRef, first.body, ctx)
    await store.putPage(scopeRef(scope), pageRef, first.body, ctx)
    const stored = await store.getPage(scopeRef(scope), pageRef, ctx)
    expect(stored?.body.rows.length).toBe(PAGE_SIZE)
  })
})
