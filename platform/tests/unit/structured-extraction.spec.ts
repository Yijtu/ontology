import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ScopedArtifactReader,
  StructuredParseRecord,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import {
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  StructuredExtractionService,
  encodeStructuredExtractionRef,
} from '@ontology/application'
import type { StructuredExtractionRef } from '@ontology/application'
import {
  InMemoryStructuredIngestionStore,
  STRUCTURED_PARSER_ID,
  STRUCTURED_PARSER_VERSION,
  StructuredDocumentParser,
  reconcileStructuredResult,
} from '@ontology/adapter-extraction-document'
import { toolContext } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import { DEFINITION_REF, buildIndustrySchema } from './extraction-fixtures'

const CTX: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'structured-extraction-unit')
const JOB_ID: Uuid = '88888888-8888-4888-8888-888888888888'
const LEDGER_ID: Uuid = '77777777-7777-4777-8777-777777777777'

interface Harness {
  readonly ingestion: InMemoryStructuredIngestionStore
  readonly candidates: InMemoryCandidateStore
  readonly parser: StructuredDocumentParser
  readonly bytes: Uint8Array
  readonly ref: StructuredExtractionRef
}

async function buildHarness(document: string): Promise<Harness> {
  const parser = new StructuredDocumentParser()
  const bytes = new TextEncoder().encode(document)
  const result = parser.parse(bytes, { mediaType: 'application/json' })
  const { entries, counts } = reconcileStructuredResult(result, SCOPE_A, `sha256:${'a'.repeat(64)}`)
  const parseId = randomUUID()
  const record: StructuredParseRecord = {
    parseId,
    scopeRef: SCOPE_A,
    format: result.format,
    originalMediaType: 'application/json',
    originalRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
    parserId: STRUCTURED_PARSER_ID,
    parserVersion: STRUCTURED_PARSER_VERSION,
    status: result.status,
    coverage: result.coverage,
    counts,
    sheets: result.sheets,
    diagnostics: result.diagnostics,
    createdAt: '2026-09-29T00:00:00Z',
  }
  const ingestion = new InMemoryStructuredIngestionStore()
  await ingestion.recordParse(record, entries, CTX)
  const ref: StructuredExtractionRef = {
    kind: 'structured_extraction',
    parseId,
    parserVersion: STRUCTURED_PARSER_VERSION,
    definitionRef: DEFINITION_REF,
    format: 'json',
    originalRef: record.originalRef,
    originalMediaType: 'application/json',
    options: {},
  }
  return { ingestion, candidates: new InMemoryCandidateStore(), parser, bytes, ref }
}

function serviceOf(harness: Harness): StructuredExtractionService {
  const originals: ScopedArtifactReader = {
    read: () => Promise.resolve(harness.bytes),
  }
  return new StructuredExtractionService({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
    candidates: harness.candidates,
    ingestion: harness.ingestion,
    originals,
    parser: harness.parser,
    now: () => '2026-09-29T00:00:01Z',
  })
}

async function run(harness: Harness) {
  return serviceOf(harness).extract(harness.ref, {
    jobId: JOB_ID,
    ledgerId: LEDGER_ID,
    pipelineVersion: '1.0.0',
    ctx: CTX,
    signal: new AbortController().signal,
  })
}

describe('structured parsed → extracted', () => {
  it('builds an entity candidate from the located JSON record with an exact decimal and a structured span', async () => {
    const harness = await buildHarness(
      '[{"device_native_id":"D-1","device_kind":"charger","rated_power":7.20}]',
    )
    const result = await run(harness)
    expect(result.candidateIds).toHaveLength(1)

    const stored = await harness.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, CTX)
    expect(stored).toHaveLength(1)
    const entity = stored[0]
    expect(entity?.kind).toBe('entity')
    if (entity?.kind !== 'entity') return
    expect(entity.objectId).toBe('device')
    expect(entity.nativeId).toBe('D-1')
    expect(entity.deterministic).toBe(true)
    const power = entity.attributes.find((attribute) => attribute.attributeId === 'rated_power')
    expect(power?.value).toBe('7.20')
    expect(power?.raw).toBe('7.20')
    expect(power?.decimal).toBe('7.20')
    expect(power?.unitCode).toBe('kW')
    expect(typeof power?.value).toBe('string')

    const span = entity.sourceSpans[0]
    expect(span?.kind).toBe('structured')
    if (span?.kind !== 'structured') return
    expect(span.parseId).toBe(harness.ref.parseId)
    expect(span.locator.kind).toBe('json_pointer')
    expect(span.rowDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(entity.inputVersion.promptVersion).toBe('extraction-schema-context@1')
    expect(entity.inputVersion.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('keeps an unknown field as a soft review issue rather than dropping the row', async () => {
    const harness = await buildHarness(
      JSON.stringify([{ device_native_id: 'D-2', device_kind: 'charger', mystery_field: 'x' }]),
    )
    await run(harness)
    const stored = await harness.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, CTX)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.issues.some((issue) => issue.code === 'UNKNOWN_ATTRIBUTE')).toBe(true)
  })

  it('does not drop a row that references no declared object: it is counted as skipped, never published', async () => {
    const harness = await buildHarness(JSON.stringify([{ wholly_unknown: 'x' }]))
    const result = await run(harness)
    expect(result.candidateIds).toHaveLength(0)
    expect(result.counts.skipped).toBe(1)
    expect(await harness.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, CTX)).toHaveLength(0)
  })

  it('round-trips the durable reference through encode/decode without losing the original', async () => {
    const harness = await buildHarness(JSON.stringify([{ device_native_id: 'D-3', device_kind: 'charger' }]))
    const encoded = encodeStructuredExtractionRef(harness.ref)
    expect(encoded).toContain('"kind":"structured_extraction"')
    expect(encoded).toContain(harness.ref.originalRef.digest)
  })

  it('is idempotent: a re-run inserts no duplicate candidate', async () => {
    const harness = await buildHarness(JSON.stringify([{ device_native_id: 'D-4', device_kind: 'charger' }]))
    const service = serviceOf(harness)
    const first = await service.extract(harness.ref, {
      jobId: JOB_ID,
      ledgerId: LEDGER_ID,
      pipelineVersion: '1.0.0',
      ctx: CTX,
      signal: new AbortController().signal,
    })
    const second = await service.extract(harness.ref, {
      jobId: JOB_ID,
      ledgerId: LEDGER_ID,
      pipelineVersion: '1.0.0',
      ctx: CTX,
      signal: new AbortController().signal,
    })
    expect(new Set(second.candidateIds)).toEqual(new Set(first.candidateIds))
    expect(await harness.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, CTX)).toHaveLength(1)
  })
})
