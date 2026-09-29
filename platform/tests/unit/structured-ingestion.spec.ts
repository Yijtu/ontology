import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  InMemoryStructuredIngestionStore,
  LocalStructuredIngestionService,
  StructuredIngestionError,
} from '@ontology/adapter-extraction-document'
import {
  InMemoryJobStore,
  JobService,
  JobWorker,
  decodeStructuredIngestionRef,
  encodeStructuredIngestionRef,
  isStructuredIngestionRef,
} from '@ontology/application'
import type { JobStageHandler, JobStageOutcome } from '@ontology/application'
import { createIngestionHandlerRegistry } from '@ontology/app-worker'
import type {
  DocumentParserPort,
  PipelineStage,
  ResourceRef,
  RunnableJobStage,
  StructuredParseOptions,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { InMemoryArtifactStore } from '../fixtures/documents/test-doubles'
import { buildXlsx, cellRef, numberCellXml, rowXml, sharedStringCell, worksheetOf } from '../fixtures/structured/xlsx'
import { toolContext } from './component-registry-fixtures'
import { ManualClock, SCOPE_A, createBudgetHarness } from './job-fixtures'

const EDITOR: ToolContext = toolContext(
  SCOPE_A.tenantId,
  SCOPE_A.spaceId,
  ['data-editor', 'platform-admin'],
  'structured-ingestion-editor',
)

const DEFINITION_REF: VersionRef = {
  id: 'home-energy-definition',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

const CSV_MEDIA = 'text/csv'
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Selection = Omit<StructuredParseOptions, 'mediaType'>

interface Harness {
  readonly blobs: InMemoryArtifactStore
  readonly store: InMemoryStructuredIngestionStore
  readonly jobs: InMemoryJobStore
  readonly service: JobService
  readonly worker: JobWorker
  readonly downstreamParseIds: Uuid[]
}

async function publishBytes(
  blobs: InMemoryArtifactStore,
  bytes: Uint8Array,
  mediaType: string,
): Promise<ResourceRef> {
  const staged = await blobs.stage(bytes, { scopeRef: SCOPE_A }, EDITOR)
  const published = await blobs.publish(
    { scopeRef: SCOPE_A, contentDigest: staged.contentDigest, mediaType, byteSize: staged.byteSize, purpose: 'document' },
    EDITOR,
  )
  return published.blobRef
}

function structuredRef(
  originalRef: ResourceRef,
  format: 'text' | 'json' | 'csv' | 'xlsx',
  options: Selection = {},
): string {
  return encodeStructuredIngestionRef({
    kind: 'structured_ingestion',
    originalRef,
    parserVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
    format,
    options,
  })
}

function buildHarness(): Harness {
  const clock = new ManualClock()
  const blobs = new InMemoryArtifactStore()
  const store = new InMemoryStructuredIngestionStore()
  const ingestion = new LocalStructuredIngestionService({
    blobs,
    store,
    now: () => '2026-09-29T00:00:00Z',
  })
  const jobs = new InMemoryJobStore()
  const budget = createBudgetHarness()
  const service = new JobService({ store: jobs, now: clock.now, newId: () => randomUUID() })
  const downstreamParseIds: Uuid[] = []
  const stub = (stage: RunnableJobStage, nextStage: PipelineStage): JobStageHandler => ({
    stage,
    run: (context): Promise<JobStageOutcome> => {
      if (stage === 'parsed' && context.job.documentRef !== undefined) {
        const parsed: unknown = JSON.parse(context.job.documentRef)
        if (typeof parsed === 'object' && parsed !== null && 'parseId' in parsed) {
          const parseId = (parsed as { parseId?: unknown }).parseId
          if (typeof parseId === 'string') downstreamParseIds.push(parseId)
        }
      }
      return Promise.resolve({ nextStage, counts: context.job.counts })
    },
  })
  const textParser: DocumentParserPort = {
    parse: async () => {
      throw new Error('the text parser must not run for a structured ingestion reference')
    },
  }
  const worker = new JobWorker({
    store: jobs,
    handlers: createIngestionHandlerRegistry({
      parser: textParser,
      structured: ingestion,
      downstream: [stub('parsed', 'extracted'), stub('extracted', 'validated'), stub('validated', 'awaiting_review')],
    }),
    budget: budget.budget,
    workerId: 'structured-ingestion-worker',
    now: clock.now,
    newId: () => randomUUID(),
  })
  return { blobs, store, jobs, service, worker, downstreamParseIds }
}

async function createJob(
  service: JobService,
  documentRef: string,
  sourceRef = 'structured-source',
): Promise<Uuid> {
  const result = await service.createJob(
    {
      jobId: randomUUID(),
      kind: 'ingestion',
      sourceRef,
      documentRef,
      pipelineVersion: '1.0.0',
      idempotencyKey: `structured-${randomUUID()}`,
    },
    EDITOR,
  )
  return result.jobId
}

describe('structured ingestion reference', () => {
  it('round-trips a full selection and rejects malformed references', () => {
    const encoded = structuredRef(
      { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
      'csv',
      { delimiter: ';', headerRow: 2, capBreachMode: 'truncate', caps: { maxRows: 5 } },
    )
    const decoded = decodeStructuredIngestionRef(encoded)
    expect(decoded.format).toBe('csv')
    expect(decoded.options.delimiter).toBe(';')
    expect(decoded.options.headerRow).toBe(2)
    expect(decoded.options.caps?.maxRows).toBe(5)

    expect(isStructuredIngestionRef(encoded)).toBe(true)
    expect(isStructuredIngestionRef('not json')).toBe(false)
    expect(isStructuredIngestionRef(JSON.stringify({ kind: 'document_ingestion' }))).toBe(false)
    expect(() => decodeStructuredIngestionRef('not json')).toThrowError(/not valid JSON/)
    expect(() => decodeStructuredIngestionRef(JSON.stringify({ kind: 'structured_ingestion' }))).toThrowError(
      /format must be/,
    )
  })
})

describe('received → parsed for structured formats', () => {
  it('persists located rows, row reconciliation and rewrites documentRef for downstream', async () => {
    const harness = buildHarness()
    const csv = 'name,qty\nWidget,5\nGadget,\nBolt,2\n'
    const originalRef = await publishBytes(harness.blobs, new TextEncoder().encode(csv), CSV_MEDIA)
    const jobId = await createJob(harness.service, structuredRef(originalRef, 'csv'))

    const result = await harness.worker.runOnce(SCOPE_A, EDITOR)
    expect(result.disposition).toBe('stopped')

    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.stage).toBe('awaiting_review')
    expect(job.counts).toEqual({ total: 3, processed: 3, failed: 0, skipped: 0 })

    const documentRef = job.documentRef
    expect(documentRef).toBeDefined()
    if (documentRef === undefined) return
    const parsed: unknown = JSON.parse(documentRef)
    expect(parsed).toMatchObject({ kind: 'structured_extraction', format: 'csv', definitionRef: DEFINITION_REF })

    const parse = await harness.store.findParseByDigest(SCOPE_A, originalRef.digest, '1.0.0', EDITOR)
    expect(parse).toBeDefined()
    if (parse === undefined) return
    expect(parse.status).toBe('complete')
    expect(parse.counts).toEqual({ total: 3, succeeded: 3, pending: 0, failed: 0, skipped: 0 })

    const page = await harness.store.listRecords(SCOPE_A, parse.parseId, { limit: 10 }, EDITOR)
    expect(page.total).toBe(3)
    expect(page.records.map((entry) => entry.sourceRowKey)).toEqual([
      'csv:sheet:row:2',
      'csv:sheet:row:3',
      'csv:sheet:row:4',
    ])
    expect(page.records.every((entry) => entry.state === 'parsed')).toBe(true)
    expect(page.records.every((entry) => entry.locator.kind === 'table_row')).toBe(true)
    // Values live in the immutable original; the row locator addresses the exact source row.
    const second = page.records[1]
    expect(second?.locator).toMatchObject({ kind: 'table_row', format: 'csv', row: 3 })
    expect(second?.columnCount).toBe(2)
    expect(harness.downstreamParseIds).toContain(parse.parseId)
  })

  it('keeps stable record identities for a duplicate import and never merges distinct rows', async () => {
    const harness = buildHarness()
    const csv = 'sku,qty\nA-1,10\nA-1,10\n'
    const firstRef = await publishBytes(harness.blobs, new TextEncoder().encode(csv), CSV_MEDIA)
    await createJob(harness.service, structuredRef(firstRef, 'csv'), 'structured-dedup-1')
    await harness.worker.runOnce(SCOPE_A, EDITOR)
    const firstParse = await harness.store.findParseByDigest(SCOPE_A, firstRef.digest, '1.0.0', EDITOR)
    expect(firstParse).toBeDefined()
    if (firstParse === undefined) return

    // Two rows of the same entity are two distinct records with two stable identities.
    const firstPage = await harness.store.listRecords(SCOPE_A, firstParse.parseId, { limit: 10 }, EDITOR)
    expect(firstPage.records).toHaveLength(2)
    expect(firstPage.records[0]?.recordId).not.toBe(firstPage.records[1]?.recordId)

    // A duplicate upload of identical bytes is a distinct logical job but the same logical parse.
    const secondRef = await publishBytes(harness.blobs, new TextEncoder().encode(csv), CSV_MEDIA)
    expect(secondRef.digest).toBe(firstRef.digest)
    await createJob(harness.service, structuredRef(secondRef, 'csv'), 'structured-dedup-2')
    await harness.worker.runOnce(SCOPE_A, EDITOR)

    const secondParse = await harness.store.findParseByDigest(SCOPE_A, secondRef.digest, '1.0.0', EDITOR)
    expect(secondParse?.parseId).toBe(firstParse.parseId)
    expect(
      await harness.store.countRecords(SCOPE_A, firstParse.parseId, EDITOR),
    ).toEqual({ total: 2, succeeded: 2, pending: 0, failed: 0, skipped: 0 })

    const parseRows = await harness.store.listRecords(SCOPE_A, firstParse.parseId, { limit: 10 }, EDITOR)
    expect(parseRows.records.map((entry) => entry.recordId)).toEqual(
      firstPage.records.map((entry) => entry.recordId),
    )
  })

  it('records a truncated parse as partial and pages the captured rows', async () => {
    const harness = buildHarness()
    const rows = Array.from({ length: 8 }, (_value, index) => `R-${index + 1},${index + 1}`)
    const csv = `sku,qty\n${rows.join('\n')}\n`
    const originalRef = await publishBytes(harness.blobs, new TextEncoder().encode(csv), CSV_MEDIA)
    const jobId = await createJob(
      harness.service,
      structuredRef(originalRef, 'csv', { capBreachMode: 'truncate', caps: { maxRows: 3 } }),
    )

    await harness.worker.runOnce(SCOPE_A, EDITOR)
    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.stage).toBe('awaiting_review')
    // A partial parse is never reported as a full success: 5 rows stay pending.
    expect(job.counts).toEqual({ total: 8, processed: 3, failed: 0, skipped: 5 })

    const parse = await harness.store.findParseByDigest(SCOPE_A, originalRef.digest, '1.0.0', EDITOR)
    expect(parse?.status).toBe('incomplete')
    expect(parse?.coverage.completeness).toBe('truncated')
    expect(parse?.counts).toEqual({ total: 8, succeeded: 3, pending: 5, failed: 0, skipped: 0 })
    if (parse === undefined) return

    const firstPage = await harness.store.listRecords(SCOPE_A, parse.parseId, { limit: 2 }, EDITOR)
    expect(firstPage.records).toHaveLength(2)
    expect(firstPage.total).toBe(3)
    expect(firstPage.nextCursor).toBeDefined()
    const secondPage = await harness.store.listRecords(
      SCOPE_A,
      parse.parseId,
      { limit: 2, cursor: firstPage.nextCursor ?? '' },
      EDITOR,
    )
    expect(secondPage.records).toHaveLength(1)
    expect(secondPage.nextCursor).toBeUndefined()
  })

  it('locates a failed row through the error cell and a pending row through an unevaluated formula', async () => {
    const harness = buildHarness()
    const shared = ['Name', 'Qty', 'Status', 'Widget', 'Gadget', 'Broken']
    const workbook = buildXlsx({
      sharedStrings: shared,
      sheetXml: worksheetOf([
        rowXml(1, [sharedStringCell(cellRef(1, 1), 0), sharedStringCell(cellRef(2, 1), 1), sharedStringCell(cellRef(3, 1), 2)]),
        rowXml(2, [sharedStringCell(cellRef(1, 2), 3), numberCellXml(cellRef(2, 2), '5'), sharedStringCell(cellRef(3, 2), 2)]),
        rowXml(3, [sharedStringCell(cellRef(1, 3), 4), `<c r="${cellRef(2, 3)}"><f>B3*2</f></c>`, sharedStringCell(cellRef(3, 3), 2)]),
        rowXml(4, [sharedStringCell(cellRef(1, 4), 5), `<c r="${cellRef(2, 4)}" t="e"><v>#REF!</v></c>`, sharedStringCell(cellRef(3, 4), 2)]),
      ]),
    })
    const originalRef = await publishBytes(harness.blobs, workbook, XLSX_MEDIA)
    const jobId = await createJob(harness.service, structuredRef(originalRef, 'xlsx'))

    await harness.worker.runOnce(SCOPE_A, EDITOR)
    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.counts).toEqual({ total: 3, processed: 1, failed: 1, skipped: 1 })

    const parse = await harness.store.findParseByDigest(SCOPE_A, originalRef.digest, '1.0.0', EDITOR)
    expect(parse).toBeDefined()
    if (parse === undefined) return
    expect(parse.format).toBe('xlsx')
    expect(parse.counts).toEqual({ total: 3, succeeded: 1, pending: 1, failed: 1, skipped: 0 })

    const failures = await harness.store.listFailures(SCOPE_A, parse.parseId, 10, EDITOR)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.row).toBe(4)
    expect(failures[0]?.error?.code).toBe('CELL_ERROR')
    // The failure locates the exact original cell, not just the row.
    expect(failures[0]?.error?.locator?.kind).toBe('table_cell')
  })

  it('fails the received stage for a rejected parse and never claims partial success', async () => {
    const harness = buildHarness()
    const originalRef = await publishBytes(harness.blobs, new TextEncoder().encode('name,qty\n"oops,5\n'), CSV_MEDIA)
    const jobId = await createJob(harness.service, structuredRef(originalRef, 'csv'))

    const result = await harness.worker.runOnce(SCOPE_A, EDITOR)
    expect(result.disposition).toBe('failed')
    expect(result.stage).toBe('received')

    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.stage).toBe('failed')
    expect(job.failedStage).toBe('received')
    expect(job.lastError?.code).toBe('INVALID_ARGUMENT')
    // The classified message locates the failure (diagnostic code + source row), no content leaked.
    expect(job.lastError?.message).toContain('MALFORMED_CSV')
    expect(job.lastError?.message).toContain('row 2')
    expect(job.counts.processed).toBe(0)
    // The job still references the immutable original, so the failure locates the source.
    expect(job.documentRef).toBeDefined()
    expect(
      await harness.store.findParseByDigest(SCOPE_A, originalRef.digest, '1.0.0', EDITOR),
    ).toBeUndefined()
  })

  it('refuses a declared format that does not match the stored original', async () => {
    const harness = buildHarness()
    const originalRef = await publishBytes(harness.blobs, new TextEncoder().encode('a,b\n1,2\n'), CSV_MEDIA)
    const jobId = await createJob(harness.service, structuredRef(originalRef, 'json'))

    const result = await harness.worker.runOnce(SCOPE_A, EDITOR)
    expect(result.disposition).toBe('failed')
    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.failedStage).toBe('received')
    expect(job.lastError?.code).toBe('INVALID_ARGUMENT')
  })

  it('refuses a cross-scope store call instead of leaking another space', async () => {
    const harness = buildHarness()
    const foreign = toolContext('00000000-0000-4000-8000-000000000000', SCOPE_A.spaceId, ['data-editor'], 'foreign')
    await expect(harness.store.listRecords(SCOPE_A, randomUUID(), { limit: 1 }, foreign)).rejects.toBeInstanceOf(
      StructuredIngestionError,
    )
  })
})
