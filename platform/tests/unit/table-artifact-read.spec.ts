import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TableArtifactReadError,
  createToolContext,
  decodeTableReadCursor,
  encodeTableReadCursor,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ResourceRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  TablePageReadView,
  ToolContext,
} from '@ontology/contracts'
import { InMemoryTableArtifactStore, TableArtifactReadService } from '@ontology/application'

/**
 * V03-032 (#203): the fixed-revision paginated table reader.
 *
 * The table has 1001 rows across five 250-row pages. The tests walk it, then prove the reader
 * refuses a duplicate, backward or gapped cursor, a cursor from another scope and a cursor
 * from another generation, and that it never renders an unverified, corrupt or out-of-order
 * page.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const TABLE_ID = 'table.energy'
const ROW_TOTAL = 1001
const PAGE_SIZE = 250

const outputSchemaRef = { id: 'output.schema', version: '1.0.0', digest: DIGEST }

const columns: readonly TableColumnDescriptor[] = [
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/properties/rows/items/properties/amount',
    requiredContextPointers: ['unitPointer'],
  },
  {
    columnRef: 'site',
    semanticPredicate: 'site.id',
    valueType: 'entity_ref',
    schemaPointer: '/properties/rows/items/properties/site',
  },
]

interface BuiltTable {
  readonly ref: ResourceRef
  readonly receiptRef: ResourceRef
  readonly manifest: TableArtifactManifest
}

interface BuiltPage {
  readonly ref: ResourceRef
  readonly body: TableArtifactPageBody
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function buildPage(pageIndex: number, rowKeys: readonly string[]): BuiltPage {
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

function buildTable(total: number): { table: BuiltTable; pages: readonly BuiltPage[] } {
  const pages: BuiltPage[] = []
  for (let pageIndex = 0; pageIndex * PAGE_SIZE < total; pageIndex += 1) {
    const start = pageIndex * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, total)
    const rowKeys = Array.from({ length: end - start }, (_value, offset) => `r-${String(start + offset).padStart(5, '0')}`)
    pages.push(buildPage(pageIndex, rowKeys))
  }
  const manifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: TABLE_ID,
    outputSchemaRef,
    columns,
    totalRows: total,
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
    coverage: { returned: total, truncated: false },
    complete: true,
  }
  return {
    table: {
      ref: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      receiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' },
      manifest,
    },
    pages,
  }
}

function ctxFor(scope: { tenantId: string; spaceId: string }): ToolContext {
  const runId = randomUUID()
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'table-reader', roles: ['operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: { tenantId: scope.tenantId, spaceId: scope.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 0 },
    traceId: `table-read:${randomUUID()}`,
  })
}

const scopeA = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: '22222222-2222-4222-8222-222222222222' }
const scopeB = { tenantId: '33333333-3333-4333-8333-333333333333', spaceId: '44444444-4444-4444-8444-444444444444' }

interface Seeded {
  readonly service: TableArtifactReadService
  readonly store: InMemoryTableArtifactStore
  readonly table: BuiltTable
  readonly answerId: string
}

async function makeService(options: { readonly verified?: boolean; readonly mutateManifest?: (manifest: TableArtifactManifest) => TableArtifactManifest } = {}): Promise<Seeded> {
  const store = new InMemoryTableArtifactStore()
  const built = buildTable(ROW_TOTAL)
  const answerId = randomUUID()
  const ctx = ctxFor(scopeA)
  for (const page of built.pages) {
    await store.putPage(scopeA, { ...page.ref, digest: tableArtifactContentDigest(page.body) }, page.body, ctx)
  }
  const manifest = options.mutateManifest === undefined ? built.table.manifest : options.mutateManifest(built.table.manifest)
  if (options.verified === false) {
    store.indexVerifiedTable(scopeA, answerId, TABLE_ID, { ref: built.table.ref, manifest })
  } else {
    store.indexVerifiedTable(scopeA, answerId, TABLE_ID, { ref: built.table.ref, manifest, verificationReceiptRef: built.table.receiptRef })
  }
  return { service: new TableArtifactReadService({ manifests: store, pages: store, progress: store }), store, table: built.table, answerId }
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

describe('fixed-revision paginated table reader', () => {
  it('walks all five pages with no duplicate or missing row key', async () => {
    const { service, answerId } = await makeService()
    const ctx = ctxFor(scopeA)
    const concat: string[] = []
    let pages = 0
    let view = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    for (;;) {
      pages += 1
      concat.push(...view.rows.map((row) => row.rowKey))
      expect(view.pageCount).toBe(5)
      expect(view.totalRows).toBe(ROW_TOTAL)
      if (view.cursor === undefined) break
      view = await service.readPage({ answerId, tableId: TABLE_ID, cursor: view.cursor }, ctx)
    }
    expect(pages).toBe(5)
    expect(concat).toHaveLength(ROW_TOTAL)
    expect(new Set(concat).size).toBe(ROW_TOTAL)
    const ordered = concat.every((key, index) => index === 0 || key > (concat[index - 1] ?? ''))
    expect(ordered).toBe(true)
  })

  it('refuses a duplicate cursor instead of silently concatenating the same page', async () => {
    const { service, answerId } = await makeService()
    const ctx = ctxFor(scopeA)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    const cursor = requireCursor(first)
    const second = await service.readPage({ answerId, tableId: TABLE_ID, cursor }, ctx)
    expect(second.pageIndex).toBe(1)
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor }, ctx), 'CURSOR_REPLAY')
  })

  it('refuses a backward cursor', async () => {
    const { service, answerId } = await makeService()
    const ctx = ctxFor(scopeA)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    await service.readPage({ answerId, tableId: TABLE_ID, cursor: requireCursor(first) }, ctx)
    const decoded = decodeTableReadCursor(requireCursor(first))
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

  it('refuses a cursor that skips a page', async () => {
    const { service, answerId, table } = await makeService()
    const ctx = ctxFor(scopeA)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    const gap = encodeTableReadCursor({
      ...decodeTableReadCursor(requireCursor(first)),
      pageIndex: 2,
      lastRowKey: table.manifest.pages[1]?.lastRowKey ?? '',
    })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor: gap }, ctx), 'CURSOR_GAP')
  })

  it('refuses a generation change instead of mixing two revisions', async () => {
    const { service, store, answerId } = await makeService()
    const ctx = ctxFor(scopeA)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    const rebuilt = buildTable(ROW_TOTAL)
    store.indexVerifiedTable(scopeA, answerId, TABLE_ID, {
      ref: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'artifact' },
      manifest: rebuilt.table.manifest,
      verificationReceiptRef: rebuilt.table.receiptRef,
    })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor: requireCursor(first) }, ctx), 'TABLE_REVISION_CHANGED')
  })

  it('refuses a cursor minted in another scope', async () => {
    const { service, answerId } = await makeService()
    const ctx = ctxFor(scopeA)
    const first = await service.readPage({ answerId, tableId: TABLE_ID }, ctx)
    const foreign = encodeTableReadCursor({ ...decodeTableReadCursor(requireCursor(first)), scopeDigest: `sha256:${'d'.repeat(64)}` })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID, cursor: foreign }, ctx), 'SCOPE_MISMATCH')
  })

  it('does not resolve a table from another tenant/space', async () => {
    const { service, answerId } = await makeService()
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID }, ctxFor(scopeB)), 'TABLE_NOT_FOUND')
  })

  it('refuses to render an unverified table', async () => {
    const { service, answerId } = await makeService({ verified: false })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID }, ctxFor(scopeA)), 'TABLE_UNVERIFIED')
  })

  it('refuses a page whose digest does not match its descriptor', async () => {
    const { service, answerId } = await makeService({
      mutateManifest: (manifest) => ({
        ...manifest,
        pages: manifest.pages.map((page, index) => (index === 0 ? { ...page, artifactDigest: DIGEST_B } : page)),
      }),
    })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID }, ctxFor(scopeA)), 'PAGE_DIGEST_MISMATCH')
  })

  it('refuses an out-of-order page instead of rendering it', async () => {
    const store = new InMemoryTableArtifactStore()
    const answerId = randomUUID()
    const ctx = ctxFor(scopeA)
    const page = buildPage(0, ['r-003', 'r-001'])
    const pageRef: ResourceRef = { ...page.ref, digest: tableArtifactContentDigest(page.body) }
    await store.putPage(scopeA, pageRef, page.body, ctx)
    const manifest: TableArtifactManifest = {
      schemaVersion: 'table-artifact-manifest@1',
      tableId: TABLE_ID,
      outputSchemaRef,
      columns,
      totalRows: 2,
      rowKeyOrder: 'ascending',
      pages: [
        {
          pageIndex: 0,
          artifactRef: pageRef,
          artifactDigest: tableArtifactContentDigest(page.body),
          rowCount: page.body.rows.length,
          firstRowKey: 'r-003',
          lastRowKey: 'r-001',
          pageCoverageDigest: tablePageCoverageDigest(page.body),
        },
      ],
      coverage: { returned: 2, truncated: false },
      complete: true,
    }
    store.indexVerifiedTable(scopeA, answerId, TABLE_ID, {
      ref: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      manifest,
      verificationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' },
    })
    const service = new TableArtifactReadService({ manifests: store, pages: store, progress: store })
    await expectCode(service.readPage({ answerId, tableId: TABLE_ID }, ctx), 'PAGE_ROW_ORDER_VIOLATION')
  })
})
