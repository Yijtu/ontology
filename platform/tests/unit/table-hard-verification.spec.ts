import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TABLE_HARD_VERIFICATION_POLICY,
  createToolContext,
  tableArtifactContentDigest,
  tableManifestContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ResourceRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableArtifactRow,
  TableCellBinding,
  TableColumnDescriptor,
  TableHardVerificationOutcome,
  TableHardVerificationPolicy,
  ToolContext,
} from '@ontology/contracts'
import {
  InMemoryTableArtifactStore,
  InMemoryTableVerificationStore,
  TableHardVerificationService,
} from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import {
  InMemoryVerificationArtifacts,
  InMemoryVerificationEvidence,
  RUN_ID,
  SCOPE_A,
  buildEvidence,
  toolContext,
} from './verification-fixtures'

/**
 * V03-033 (#204): batched full-table hard verification.
 *
 * The table has 1001 rows across five 250-row pages and four columns (entity, quantity, money,
 * currency). The positive test walks every row and proves the receipt binds 1001 rows / 4004
 * cells. The injected cases each break exactly one axis — value, unit, currency, swapped row,
 * missing page, tampered manifest, truncation — and must block with a located finding.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DRAFT_HASH = `sha256:${'d'.repeat(64)}`
const TABLE_ID = 'table.energy'
const TOTAL = 1001
const PAGE_SIZE = 250

const columns: readonly TableColumnDescriptor[] = [
  { columnRef: 'site', semanticPredicate: 'site.id', valueType: 'entity_ref', schemaPointer: '/site' },
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/amount',
    requiredContextPointers: ['unitPointer'],
  },
  { columnRef: 'price', semanticPredicate: 'energy.price', valueType: 'money', schemaPointer: '/price' },
  { columnRef: 'currency', semanticPredicate: 'energy.currency', valueType: 'string', schemaPointer: '/currency' },
]

function siteOf(index: number): string {
  return `site-r-${String(index).padStart(5, '0')}`
}

function amountOf(index: number): string {
  return `${String(100 + (index % 900))}.${String(index % 100).padStart(2, '0')}`
}

function priceOf(index: number): string {
  return `${String(1 + (index % 9))}.${String((index * 7) % 100).padStart(2, '0')}`
}

function currencyOf(index: number): string {
  return index % 2 === 0 ? 'CNY' : 'USD'
}

interface Fixture {
  readonly service: TableHardVerificationService
  readonly store: InMemoryTableArtifactStore
  readonly verification: InMemoryTableVerificationStore
  readonly evidence: InMemoryVerificationEvidence
  readonly artifacts: VerificationArtifactStore
  readonly manifest: TableArtifactManifest
  readonly manifestRef: ResourceRef
  readonly ctx: ToolContext
}

interface FixtureOptions {
  readonly complete?: boolean
  readonly truncated?: boolean
  readonly totalRows?: number
  /** Applied to the row's cells before page digests are computed. */
  readonly mutateCells?: (cells: Record<string, unknown>, index: number) => void
  /** Returns a replacement binding for one cell before page digests are computed. */
  readonly overrideBinding?: (binding: TableCellBinding, index: number) => TableCellBinding
  /** Do not store this page's artifact, keeping its descriptor (a missing page). */
  readonly omitPageArtifact?: number
  readonly policy?: TableHardVerificationPolicy
}

function verifierArtifacts(): { readonly store: VerificationArtifactStore; readonly memory: InMemoryVerificationArtifacts } {
  const memory = new InMemoryVerificationArtifacts()
  const store: VerificationArtifactStore = {
    getAuthorized: (request) => memory.getAuthorized(request),
    readAuthorized: (request) => memory.readAuthorized(request),
  }
  return { store, memory }
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const store = new InMemoryTableArtifactStore()
  const verification = new InMemoryTableVerificationStore()
  const evidence = new InMemoryVerificationEvidence()
  const { store: artifacts, memory } = verifierArtifacts()
  const ctx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['operator'], 'table-verifier', RUN_ID)

  const payload = {
    table: {
      columns: [
        { name: 'site', type: 'text', semanticFieldRef: 'site.id' },
        { name: 'amount', type: 'decimal', semanticFieldRef: 'energy.amount', unit: 'kWh' },
        { name: 'price', type: 'decimal', semanticFieldRef: 'energy.price' },
        { name: 'currency', type: 'text', semanticFieldRef: 'energy.currency' },
      ],
      rows: Array.from({ length: TOTAL }, (_value, index) => [
        siteOf(index),
        amountOf(index),
        priceOf(index),
        currencyOf(index),
      ]),
    },
  }
  const payloadRef = memory.put(randomUUID(), payload)
  const record = await evidence.record(SCOPE_A, buildEvidence({ payloadRef, resultDigest: payloadRef.digest }))
  const evidenceRef = record.evidenceRef
  const resultDigest = record.envelope.resultDigest

  const pages: { ref: ResourceRef; body: TableArtifactPageBody }[] = []
  for (let pageIndex = 0; pageIndex * PAGE_SIZE < TOTAL; pageIndex += 1) {
    const start = pageIndex * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, TOTAL)
    const rows: TableArtifactRow[] = []
    for (let index = start; index < end; index += 1) {
      const rowKey = siteOf(index)
      const cells: Record<string, unknown> = {
        site: siteOf(index),
        amount: { value: amountOf(index), unit: 'kWh' },
        price: { amount: priceOf(index), currency: currencyOf(index) },
        currency: currencyOf(index),
      }
      options.mutateCells?.(cells, index)
      const base: readonly TableCellBinding[] = [
        {
          rowKey,
          columnRef: 'site',
          evidenceRef,
          resultDigest,
          valuePointer: `/table/rows/${String(index)}/0`,
          subjectPointer: `/table/rows/${String(index)}/0`,
          fieldRefPointer: '/table/columns/0',
        },
        {
          rowKey,
          columnRef: 'amount',
          evidenceRef,
          resultDigest,
          valuePointer: `/table/rows/${String(index)}/1`,
          subjectPointer: `/table/rows/${String(index)}/0`,
          fieldRefPointer: '/table/columns/1',
          unitPointer: '/table/columns/1/unit',
        },
        {
          rowKey,
          columnRef: 'price',
          evidenceRef,
          resultDigest,
          valuePointer: `/table/rows/${String(index)}/2`,
          subjectPointer: `/table/rows/${String(index)}/0`,
          fieldRefPointer: '/table/columns/2',
          currencyPointer: `/table/rows/${String(index)}/3`,
        },
        {
          rowKey,
          columnRef: 'currency',
          evidenceRef,
          resultDigest,
          valuePointer: `/table/rows/${String(index)}/3`,
          subjectPointer: `/table/rows/${String(index)}/0`,
          fieldRefPointer: '/table/columns/3',
        },
      ]
      const bindings =
        options.overrideBinding === undefined
          ? [...base]
          : base.map((binding) => options.overrideBinding?.(binding, index) ?? binding)
      rows.push({ rowKey, subject: rowKey, cells, bindings })
    }
    const body: TableArtifactPageBody = {
      schemaVersion: 'table-artifact-page@1',
      tableId: TABLE_ID,
      outputSchemaRef: { id: 'output.schema', version: '1.0.0', digest: DIGEST },
      pageIndex,
      columnRefs: columns.map((column) => column.columnRef),
      rowKeyOrder: 'ascending',
      rows,
      coverage: { returned: rows.length, truncated: false },
    }
    const contentDigest = tableArtifactContentDigest(body)
    pages.push({ ref: { id: randomUUID(), version: '1.0.0', digest: contentDigest, kind: 'artifact' }, body })
  }

  for (const page of pages) {
    if (page.body.pageIndex === options.omitPageArtifact) continue
    await store.putPage(SCOPE_A, page.ref, page.body, ctx)
  }

  const manifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: TABLE_ID,
    outputSchemaRef: { id: 'output.schema', version: '1.0.0', digest: DIGEST },
    columns,
    totalRows: options.totalRows ?? TOTAL,
    rowKeyOrder: 'ascending',
    pages: pages.map((page) => ({
      pageIndex: page.body.pageIndex,
      artifactRef: page.ref,
      artifactDigest: page.ref.digest,
      rowCount: page.body.rows.length,
      firstRowKey: page.body.rows[0]?.rowKey ?? '',
      lastRowKey: page.body.rows[page.body.rows.length - 1]?.rowKey ?? '',
      pageCoverageDigest: tablePageCoverageDigest(page.body),
    })),
    coverage: { returned: TOTAL, truncated: options.truncated ?? false },
    complete: options.complete ?? true,
  }
  const manifestRef: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: tableManifestContentDigest(manifest),
    kind: 'artifact',
  }
  const service = new TableHardVerificationService({
    pages: store,
    evidence,
    artifacts,
    receipts: verification,
    progress: verification,
    now: () => '2026-09-21T00:00:00Z',
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  })
  return { service, store, verification, evidence, artifacts, manifest, manifestRef, ctx }
}

function request(fixture: Fixture): Parameters<TableHardVerificationService['verifyTable']>[0] {
  return {
    resultManifestRef: fixture.manifestRef,
    resultManifestDigest: fixture.manifestRef.digest,
    draftHash: DRAFT_HASH,
    tableId: TABLE_ID,
    manifest: fixture.manifest,
  }
}

function codes(outcome: TableHardVerificationOutcome): string[] {
  return outcome.report.findings.map((finding) => finding.code)
}

function expiringCtx(): ToolContext {
  return createToolContext({
    principal: { tenantId: SCOPE_A.tenantId, subjectId: 'table-verifier', roles: ['operator'], scopes: [], authEpoch: 1 },
    runId: RUN_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: RUN_ID,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId: SCOPE_A.tenantId,
      spaceId: SCOPE_A.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `table-verify:${randomUUID()}`,
  })
}

describe('batched full-table hard verification', () => {
  it('verifies all 1001 rows across five pages and archives a complete receipt', async () => {
    const fixture = await buildFixture()
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('pass')
    expect(outcome.report.checkedRows).toBe(TOTAL)
    expect(outcome.report.checkedCells).toBe(TOTAL * columns.length)
    expect(outcome.report.expectedRows).toBe(TOTAL)
    expect(outcome.report.pageDigests).toHaveLength(5)
    if (outcome.status !== 'pass') throw new Error('expected a pass')
    expect(outcome.receipt.receipt.checkedRows).toBe(TOTAL)
    const stored = await fixture.verification.getReceipt(SCOPE_A, outcome.receipt.ref, fixture.ctx)
    expect(stored?.receipt.tableId).toBe(TABLE_ID)
  })

  it('blocks a wrong amount with a located value_mismatch', async () => {
    const fixture = await buildFixture({
      mutateCells: (cells, index) => {
        if (index === 999) cells['amount'] = { value: '999999.99', unit: 'kWh' }
      },
    })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('value_mismatch')
    const finding = outcome.report.findings.find((entry) => entry.code === 'value_mismatch')
    expect(finding?.rowKey).toBe(siteOf(999))
    expect(finding?.columnRef).toBe('amount')
  })

  it('blocks a wrong unit', async () => {
    const fixture = await buildFixture({
      mutateCells: (cells, index) => {
        if (index === 5) cells['amount'] = { value: amountOf(5), unit: 'MWh' }
      },
    })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('unit_mismatch')
  })

  it('blocks a wrong currency', async () => {
    const fixture = await buildFixture({
      mutateCells: (cells, index) => {
        if (index === 7) cells['price'] = { amount: priceOf(7), currency: 'EUR' }
      },
    })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('currency_mismatch')
  })

  it('blocks a swapped row binding (value from another evidence row)', async () => {
    const fixture = await buildFixture({
      overrideBinding: (binding, index) =>
        index === 300 && binding.columnRef === 'amount'
          ? { ...binding, valuePointer: `/table/rows/${String(301)}/1` }
          : binding,
    })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('cross_row_binding')
  })

  it('blocks a missing row (total row count does not reconcile)', async () => {
    const fixture = await buildFixture({ totalRows: TOTAL + 1 })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('row_count_mismatch')
  })

  it('blocks a missing page artifact', async () => {
    const fixture = await buildFixture({ omitPageArtifact: 2 })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('page_not_found')
  })

  it('blocks a tampered manifest whose body no longer matches its ref digest', async () => {
    const fixture = await buildFixture()
    const tampered: TableArtifactManifest = { ...fixture.manifest, tableId: `${TABLE_ID}.tampered` }
    const outcome = await fixture.service.verifyTable({ ...request(fixture), manifest: tampered }, fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('manifest_digest_mismatch')
  })

  it('blocks an incomplete/truncated table', async () => {
    const fixture = await buildFixture({ complete: false, truncated: true })
    const outcome = await fixture.service.verifyTable(request(fixture), fixture.ctx)
    expect(outcome.status).toBe('fail')
    expect(codes(outcome)).toContain('manifest_incomplete')
    expect(codes(outcome)).toContain('coverage_truncated')
  })

  it('records recovery progress and resumes without skipping or double-counting rows', async () => {
    const fixture = await buildFixture()
    let ticks = 0
    const clock = (): string => {
      const minute = ticks * 4
      ticks += 1
      return new Date(Date.parse('2026-09-21T00:00:00Z') + minute * 60_000).toISOString()
    }
    const slow = new TableHardVerificationService({
      pages: fixture.store,
      evidence: fixture.evidence,
      artifacts: fixture.artifacts,
      receipts: fixture.verification,
      progress: fixture.verification,
      now: clock,
    })
    const ctx = expiringCtx()
    const interrupted = await slow.verifyTable(request(fixture), ctx)
    expect(interrupted.status).toBe('incomplete')
    expect(codes(interrupted)).toContain('batch_deadline_exceeded')
    const progress = await fixture.verification.getProgress(SCOPE_A, fixture.manifestRef, TABLE_ID, ctx)
    expect(progress?.checkedRows).toBe(PAGE_SIZE * 2)

    const resumedCtx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['operator'], 'table-verifier', RUN_ID)
    const resumed = await fixture.service.verifyTable({ ...request(fixture), resume: true }, resumedCtx)
    expect(resumed.status).toBe('pass')
    expect(resumed.report.checkedRows).toBe(TOTAL)
  })

  it('resumes correctly when a batch is smaller than a page', async () => {
    const fixture = await buildFixture({
      policy: { ...DEFAULT_TABLE_HARD_VERIFICATION_POLICY, maxRowsPerBatch: 100 },
    })
    let ticks = 0
    const clock = (): string => {
      const minute = ticks * 4
      ticks += 1
      return new Date(Date.parse('2026-09-21T00:00:00Z') + minute * 60_000).toISOString()
    }
    const slow = new TableHardVerificationService({
      pages: fixture.store,
      evidence: fixture.evidence,
      artifacts: fixture.artifacts,
      receipts: fixture.verification,
      progress: fixture.verification,
      now: clock,
      policy: { ...DEFAULT_TABLE_HARD_VERIFICATION_POLICY, maxRowsPerBatch: 100 },
    })
    const ctx = expiringCtx()
    const interrupted = await slow.verifyTable(request(fixture), ctx)
    expect(interrupted.status).toBe('incomplete')
    const progress = await fixture.verification.getProgress(SCOPE_A, fixture.manifestRef, TABLE_ID, ctx)
    expect(progress?.nextPageIndex).toBe(0)
    expect(progress?.nextRowInPage).toBe(200)
    expect(progress?.checkedRows).toBe(200)

    const resumedCtx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['operator'], 'table-verifier', RUN_ID)
    const resumed = await fixture.service.verifyTable({ ...request(fixture), resume: true }, resumedCtx)
    expect(resumed.status).toBe('pass')
    expect(resumed.report.checkedRows).toBe(TOTAL)
    expect(resumed.report.checkedCells).toBe(TOTAL * columns.length)
  })
})
