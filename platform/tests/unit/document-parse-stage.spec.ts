import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  InMemoryDocumentParseStore,
  LocalDocumentExtractionService,
} from '@ontology/adapter-extraction-document'
import {
  JobService,
  JobWorker,
  decodeDocumentIngestionRef,
  decodeExtractionJobRef,
  encodeDocumentIngestionRef,
} from '@ontology/application'
import type { JobStageHandler, JobStageOutcome } from '@ontology/application'
import { createIngestionHandlerRegistry } from '@ontology/app-worker'
import type {
  PipelineStage,
  ResourceRef,
  RunnableJobStage,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { InMemoryJobStore } from '@ontology/application'
import { InMemoryArtifactStore } from '../fixtures/documents/test-doubles'
import { toolContext } from './component-registry-fixtures'
import { ManualClock, SCOPE_A, createBudgetHarness } from './job-fixtures'

const EDITOR: ToolContext = toolContext(
  SCOPE_A.tenantId,
  SCOPE_A.spaceId,
  ['data-editor', 'platform-admin'],
  'parse-stage-editor',
)

const DEFINITION_REF: VersionRef = {
  id: 'home-energy-definition',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

interface Harness {
  readonly blobs: InMemoryArtifactStore
  readonly parseStore: InMemoryDocumentParseStore
  readonly store: InMemoryJobStore
  readonly service: JobService
  readonly worker: JobWorker
  readonly downstreamParseIds: Uuid[]
}

async function publishOriginal(
  blobs: InMemoryArtifactStore,
  text: string,
  mediaType = 'text/plain',
): Promise<ResourceRef> {
  const bytes = new TextEncoder().encode(text)
  const staged = await blobs.stage(bytes, { scopeRef: SCOPE_A }, EDITOR)
  const published = await blobs.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    EDITOR,
  )
  return published.blobRef
}

function ingestionDocumentRef(originalRef: ResourceRef): string {
  return encodeDocumentIngestionRef({
    kind: 'document_ingestion',
    originalRef,
    parserVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
  })
}

function buildHarness(): Harness {
  const clock = new ManualClock()
  const blobs = new InMemoryArtifactStore()
  const parseStore = new InMemoryDocumentParseStore()
  const parser = new LocalDocumentExtractionService({
    blobs,
    store: parseStore,
    now: () => '2026-09-21T00:00:00Z',
  })
  const store = new InMemoryJobStore()
  const budget = createBudgetHarness()
  const service = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  const downstreamParseIds: Uuid[] = []
  // Controlled downstream handlers: they prove the `parsed → extracted` stage sees the parse id
  // the `received → parsed` stage wrote, without re-implementing the extraction pipeline here.
  const stub = (stage: RunnableJobStage, nextStage: PipelineStage): JobStageHandler => ({
    stage,
    run: (context): Promise<JobStageOutcome> => {
      if (stage === 'parsed' && context.job.documentRef !== undefined) {
        downstreamParseIds.push(decodeExtractionJobRef(context.job.documentRef).parseId)
      }
      return Promise.resolve({ nextStage, counts: context.job.counts })
    },
  })
  const downstream: readonly JobStageHandler[] = [
    stub('parsed', 'extracted'),
    stub('extracted', 'validated'),
    stub('validated', 'awaiting_review'),
  ]
  const worker = new JobWorker({
    store,
    handlers: createIngestionHandlerRegistry({ parser, downstream }),
    budget: budget.budget,
    workerId: 'parse-stage-worker',
    now: clock.now,
    newId: () => randomUUID(),
  })
  return { blobs, parseStore, store, service, worker, downstreamParseIds }
}

async function createIngestionJob(
  service: JobService,
  documentRef: string,
  idempotencyKey = `parse-stage-${randomUUID()}`,
  sourceRef = 'parse-stage-source',
): Promise<Uuid> {
  const result = await service.createJob(
    {
      jobId: randomUUID(),
      kind: 'ingestion',
      sourceRef,
      documentRef,
      pipelineVersion: '1.0.0',
      idempotencyKey,
    },
    EDITOR,
  )
  return result.jobId
}

describe('document ingestion reference', () => {
  it('round-trips through encode/decode', () => {
    const originalRef: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      kind: 'document',
    }
    const encoded = ingestionDocumentRef(originalRef)
    const decoded = decodeDocumentIngestionRef(encoded)
    expect(decoded.kind).toBe('document_ingestion')
    expect(decoded.originalRef).toEqual(originalRef)
    expect(decoded.definitionRef).toEqual(DEFINITION_REF)
  })

  it('rejects a malformed reference instead of parsing the wrong document', () => {
    expect(() => decodeDocumentIngestionRef('not json')).toThrowError(/not valid JSON/)
    expect(() => decodeDocumentIngestionRef('{"kind":"other"}')).toThrowError(/kind must be/)
    expect(() =>
      decodeDocumentIngestionRef(
        JSON.stringify({ kind: 'document_ingestion', originalRef: {}, parserVersion: '1.0.0' }),
      ),
    ).toThrowError(/originalRef.id/)
  })
})

describe('received → parsed stage', () => {
  it('parses the real document, records coverage and rewrites documentRef for downstream', async () => {
    const harness = buildHarness()
    const originalRef = await publishOriginal(
      harness.blobs,
      'SERVICE TERMS\n1.1 The charger D-1 is rated 7.2 kW.\n1.2 It is monitored by meter M-1.',
    )
    const jobId = await createIngestionJob(harness.service, ingestionDocumentRef(originalRef))

    const result = await harness.worker.runOnce(SCOPE_A, EDITOR)
    expect(result.disposition).toBe('stopped')

    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.stage).toBe('awaiting_review')
    expect(job.counts.processed).toBeGreaterThan(0)
    expect(job.counts.failed).toBe(0)

    const documentRef = job.documentRef
    expect(documentRef).toBeDefined()
    if (documentRef === undefined) return
    const extractionRef = decodeExtractionJobRef(documentRef)
    expect(extractionRef.parserVersion).toBe('1.0.0')
    expect(extractionRef.definitionRef).toEqual(DEFINITION_REF)
    expect(extractionRef.parseId).toBeDefined()
    // The downstream stage observed the exact parse the received stage committed.
    expect(harness.downstreamParseIds).toContain(extractionRef.parseId)
  })

  it('fails explicitly at the received stage for an unparsable media type', async () => {
    const harness = buildHarness()
    const originalRef = await publishOriginal(harness.blobs, 'not really a document', 'application/octet-stream')
    const jobId = await createIngestionJob(harness.service, ingestionDocumentRef(originalRef))

    const result = await harness.worker.runOnce(SCOPE_A, EDITOR)
    expect(result.disposition).toBe('failed')
    expect(result.stage).toBe('received')

    const job = await harness.service.getJob(jobId, EDITOR)
    expect(job.stage).toBe('failed')
    expect(job.failedStage).toBe('received')
    expect(job.lastError?.code).toBe('INVALID_ARGUMENT')
    expect(job.lastError?.message).toBe('no parser is registered for the document media type')
    expect(harness.downstreamParseIds).toEqual([])
  })

  it('reuses the same parse when the same original is ingested again', async () => {
    const harness = buildHarness()
    const originalRef = await publishOriginal(harness.blobs, 'CLAUSE\n2.1 A shared clause.')
    const firstJob = await createIngestionJob(
      harness.service,
      ingestionDocumentRef(originalRef),
      `parse-stage-first-${randomUUID()}`,
    )
    await harness.worker.runOnce(SCOPE_A, EDITOR)
    const first = await harness.service.getJob(firstJob, EDITOR)
    const firstParseId =
      first.documentRef === undefined ? undefined : decodeExtractionJobRef(first.documentRef).parseId
    expect(firstParseId).toBeDefined()

    const secondJob = await createIngestionJob(
      harness.service,
      ingestionDocumentRef(originalRef),
      `parse-stage-second-${randomUUID()}`,
      'parse-stage-source-2',
    )
    await harness.worker.runOnce(SCOPE_A, EDITOR)
    const second = await harness.service.getJob(secondJob, EDITOR)
    const secondParseId =
      second.documentRef === undefined ? undefined : decodeExtractionJobRef(second.documentRef).parseId
    expect(secondParseId).toBe(firstParseId)
  })
})
