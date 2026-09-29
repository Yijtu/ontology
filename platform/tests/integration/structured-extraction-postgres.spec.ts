import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  LocalStructuredIngestionService,
  PostgresStructuredIngestionStore,
  StructuredDocumentParser,
} from '@ontology/adapter-extraction-document'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  CandidateValidationStageHandler,
  ExtractionPipeline,
  InMemoryIndustrySchemaSource,
  JobService,
  JobWorker,
  ReviewHandoffStageHandler,
  StructuredExtractionService,
  StructuredExtractionStageHandler,
  createExtractionHandlerRegistry,
  encodeStructuredExtractionRef,
} from '@ontology/application'
import type { JobStageHandler, StructuredExtractionRef } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import type {
  CandidateRecord,
  DocumentParseStore,
  ResourceRef,
  ScopedArtifactReader,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { DEFINITION_REF, buildIndustrySchema } from '../unit/extraction-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 60_000 })

let harness: JobDbHarness
let database: ControlPostgresDatabase
let jobStore: PostgresJobStore
let candidateStore: PostgresCandidateStore
let budget: BudgetService
let structuredStore: PostgresStructuredIngestionStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let ingestion: LocalStructuredIngestionService
let scope: JobTestScope
let scopeRef: ScopeRef
let ctx: ToolContext
let objectDir = ''

async function publishOriginal(bytes: Uint8Array): Promise<ResourceRef> {
  const staged = await blobStore.stage(bytes, { scopeRef }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'application/json',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctx,
  )
  return published.blobRef
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  jobStore = new PostgresJobStore(database)
  candidateStore = new PostgresCandidateStore(database)
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
  structuredStore = new PostgresStructuredIngestionStore({
    connectionString: harness.appUrl,
    maxPoolSize: 2,
    applicationName: 'ontology-structured-extraction-it',
  })

  scope = await createJobScope(harness.adminClient, 'structured-extraction')
  scopeRef = scope.scopeRef
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'data-editor'], 'structured-extraction-it')

  objectDir = await mkdtemp(join(tmpdir(), 'structured-extraction-it-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  ingestion = new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore })
}, 300_000)

afterAll(async () => {
  await structuredStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

async function stageAtParsed(ref: StructuredExtractionRef): Promise<string> {
  const jobService = new JobService({ store: jobStore, now: () => new Date().toISOString(), newId: () => randomUUID() })
  const jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'structured-extraction-source',
      documentRef: encodeStructuredExtractionRef(ref),
      pipelineVersion: '1.0.0',
      idempotencyKey: `structured-extraction-${jobId.slice(0, 8)}`,
    },
    ctx,
  )
  const now = new Date().toISOString()
  const lease = await jobStore.acquireLease(
    scopeRef,
    { workerId: 'structured-extraction-it-setup', now, leaseDurationMs: 0, jobId },
    ctx,
  )
  if (lease === undefined) throw new Error('could not lease the structured extraction job')
  await jobStore.completeAttempt(scopeRef, jobId, lease.attempt.attemptId, { finalStage: 'parsed', completedAt: now }, ctx)
  return jobId
}

async function listJobCandidates(jobId: string): Promise<readonly CandidateRecord[]> {
  return candidateStore.listCandidates(scopeRef, { jobId }, ctx)
}

describe('structured parsed → extracted against a real PostgreSQL', () => {
  it('persists an entity candidate with a structured locator and an exact decimal', async () => {
    const bytes = new TextEncoder().encode(
      '[{"device_native_id":"I-1","device_kind":"charger","rated_power":11.25}]',
    )
    const originalRef = await publishOriginal(bytes)
    const parsed = await ingestion.parse({ scopeRef, originalRef, options: {} }, ctx)

    const ref: StructuredExtractionRef = {
      kind: 'structured_extraction',
      parseId: parsed.parse.parseId,
      parserVersion: parsed.parse.parserVersion,
      definitionRef: DEFINITION_REF,
      format: 'json',
      originalRef,
      originalMediaType: 'application/json',
      options: {},
    }
    const jobId = await stageAtParsed(ref)

    const originals: ScopedArtifactReader = {
      read: (request) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('no approved input ref')
        return blobStore.readAuthorized({ scopeRef, blobRef: target }, ctx)
      },
    }
    const extraction = new StructuredExtractionService({
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
      candidates: candidateStore,
      ingestion: structuredStore,
      originals,
      parser: new StructuredDocumentParser(),
      now: () => '2026-09-29T00:00:02Z',
    })
    const schemaSource = new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }])
    const pipeline = new ExtractionPipeline({
      schemaSource,
      accountingOwner: 'adapter',
      generationForRun: () => undefined,
      candidates: candidateStore,
      budget,
      modelRef: { modelId: 'not-configured', version: '1.0.0' },
      outputLimit: { maxTokens: 256 },
      now: () => '2026-09-29T00:00:02Z',
    })
    const text: JobStageHandler = {
      stage: 'parsed',
      run: () => Promise.reject(new Error('the text extraction handler must not run for a structured job')),
    }
    const unusedParseStore: DocumentParseStore = {
      recordParse: () => Promise.reject(new Error('the text parse store must not be used')),
      findParseByDigest: () => Promise.reject(new Error('the text parse store must not be used')),
      listChunks: () => Promise.reject(new Error('the text parse store must not be used')),
      listChunksByScope: () => Promise.reject(new Error('the text parse store must not be used')),
      close: () => Promise.resolve(),
    }
    const worker = new JobWorker({
      store: jobStore,
      handlers: createExtractionHandlerRegistry(
        [
          text,
          new CandidateValidationStageHandler({ pipeline, parseStore: unusedParseStore }),
          new ReviewHandoffStageHandler(),
        ],
        { structured: new StructuredExtractionStageHandler({ extraction }) },
      ),
      budget,
      workerId: 'structured-extraction-it-worker',
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    await worker.runUntilIdle(scopeRef, ctx)

    const candidates = await listJobCandidates(jobId)
    expect(candidates).toHaveLength(1)
    const entity = candidates[0]
    expect(entity?.kind).toBe('entity')
    if (entity?.kind !== 'entity') return
    expect(entity.objectId).toBe('device')
    const power = entity.attributes.find((attribute) => attribute.attributeId === 'rated_power')
    expect(power?.value).toBe('11.25')
    expect(power?.decimal).toBe('11.25')
    expect(power?.unitCode).toBe('kW')

    const span = entity.sourceSpans[0]
    expect(span?.kind).toBe('structured')
    if (span?.kind !== 'structured') return
    expect(span.locator.kind).toBe('json_pointer')
    expect(span.parseId).toBe(parsed.parse.parseId)

    // The deterministic validation stage moved the candidate to review and the job reached
    // its stop stage without a model call.
    expect(entity.state).toBe('pending_review')
    const jobService = new JobService({ store: jobStore, now: () => new Date().toISOString(), newId: () => randomUUID() })
    const job = await jobService.getJob(jobId, ctx)
    expect(job.stage).toBe('awaiting_review')

    // The durable row reconciliation and the candidate point at the same original record.
    const rows = await structuredStore.listRecords(scopeRef, parsed.parse.parseId, { limit: 10 }, ctx)
    expect(rows.records).toHaveLength(1)
    expect(rows.records[0]?.recordId).toBe(span.recordId)
  })
})
