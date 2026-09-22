import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  DocumentExtractionError,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  CandidateValidationStageHandler,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryIndustrySchemaSource,
  JobService,
  JobWorker,
  ReviewHandoffStageHandler,
  decodeDocumentIngestionRef,
  decodeExtractionJobRef,
  encodeDocumentIngestionRef,
} from '@ontology/application'
import { createIngestionHandlerRegistry } from '@ontology/app-worker'
import { createJobApi } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { BudgetService } from '@ontology/core'
import {
  InMemorySemanticDefinitionStore,
  SemanticDefinitionService,
  projectIndustrySchema,
} from '@ontology/semantic-engine'
import type {
  DocumentParserPort,
  DocumentParseRequest,
  ParsedDocument,
  ResourceRef,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { ManualClock } from '../unit/job-fixtures'
import { sampleCoreDraft } from '../unit/semantic-definition-fixtures'
import {
  CountingGenerationPort,
  MODEL_REF,
  generationResponse,
} from '../unit/extraction-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 60_000 })

const ACCURATE_PAYLOAD = {
  entities: [
    {
      objectId: 'device',
      attributes: [
        { attributeId: 'device_native_id', value: 'D-1' },
        { attributeId: 'device_name', value: 'Charger D-1' },
        { attributeId: 'device_kind', value: 'charger' },
        { attributeId: 'rated_power', value: 7.2, unitCode: 'kW' },
      ],
    },
    { objectId: 'meter', attributes: [{ attributeId: 'meter_native_id', value: 'M-1' }] },
  ],
  relations: [
    {
      relationId: 'meter_monitors_device',
      from: { objectId: 'meter', entityIndex: 1 },
      to: { objectId: 'device', entityIndex: 0 },
    },
  ],
}

/** A parser wrapper that fails its first call, so the retry path is exercised without a mock. */
class FlakyParser implements DocumentParserPort {
  #calls = 0

  constructor(private readonly inner: DocumentParserPort) {}

  async parse(request: DocumentParseRequest, ctx: ToolContext): Promise<ParsedDocument> {
    this.#calls += 1
    if (this.#calls === 1) {
      throw new DocumentExtractionError('ORIGINAL_UNREADABLE', 'transient original read failure')
    }
    return this.inner.parse(request, ctx)
  }
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let store: PostgresJobStore
let candidateStore: PostgresCandidateStore
let budgetStore: PostgresBudgetLedgerStore
let budget: BudgetService
let jobService: JobService
let app: ReturnType<typeof createJobApi>
// One shared clock for the service, the worker and the lease, so a job created by the API is
// immediately claimable and a reclaim test can expire a lease deterministically.
const clock = new ManualClock()
let parseStore: PostgresDocumentParseStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parser: LocalDocumentExtractionService
let objectDir = ''

interface IngestionContext {
  readonly scope: JobTestScope
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly definitionRef: VersionRef
  readonly schemaSource: InMemoryIndustrySchemaSource
}

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  const rawTenant = request.headers['x-test-tenant']
  const tenant = Array.isArray(rawTenant) ? rawTenant[0] : rawTenant
  const rawSpace = request.headers['x-test-space']
  const space = Array.isArray(rawSpace) ? rawSpace[0] : rawSpace
  if (typeof tenant !== 'string' || tenant.length === 0 || typeof space !== 'string' || space.length === 0) {
    return undefined
  }
  return {
    principal: { tenantId: tenant, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: space,
  }
}

/** Fresh tenant/space, clock and published definition, so the reclaimer never crosses tests. */
async function newContext(prefix: string): Promise<IngestionContext> {
  const scope = await createJobScope(harness.adminClient, prefix)
  const ctx = toolContext(
    scope.tenantId,
    scope.spaceId,
    ['platform-admin', 'data-editor', 'semantic-publisher'],
    `${prefix}-ctx`,
  )
  const definitionService = new SemanticDefinitionService({
    control: new ControlPostgresRepository(database),
    store: new InMemorySemanticDefinitionStore(),
  })
  const published = await definitionService.publish(sampleCoreDraft({ scopeRef: scope.scopeRef }), ctx)
  const schemaSource = new InMemoryIndustrySchemaSource([
    { ref: published.ref, schema: projectIndustrySchema(published) },
  ])
  return { scope, scopeRef: scope.scopeRef, ctx, definitionRef: published.ref, schemaSource }
}

async function publishOriginal(
  context: IngestionContext,
  text: string,
  mediaType = 'text/plain',
): Promise<ResourceRef> {
  const bytes = new TextEncoder().encode(text)
  return publishOriginalBytes(context, bytes, mediaType)
}

async function publishOriginalBytes(
  context: IngestionContext,
  bytes: Uint8Array,
  mediaType: string,
): Promise<ResourceRef> {
  const staged = await blobStore.stage(bytes, { scopeRef: context.scopeRef }, context.ctx)
  const published = await blobStore.publish(
    {
      scopeRef: context.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    context.ctx,
  )
  return published.blobRef
}

/** A real two-page PDF whose second content stream is corrupt, so page 2 is a genuine gap. */
function brokenPageTwoPdf(): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL('../fixtures/documents/broken-page-2.pdf', import.meta.url))),
  )
}

function ingestionDocumentRef(context: IngestionContext, originalRef: ResourceRef): string {
  return encodeDocumentIngestionRef({
    kind: 'document_ingestion',
    originalRef,
    parserVersion: '1.0.0',
    definitionRef: context.definitionRef,
  })
}

async function ingest(
  context: IngestionContext,
  documentRef: string,
  key = `ingest-${randomUUID()}`,
): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ingestions',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-test-subject': 'ingestion-editor',
      'x-test-roles': 'data-editor,platform-admin',
      'x-test-tenant': context.scope.tenantId,
      'x-test-space': context.scope.spaceId,
    },
    payload: { sourceRef: 'ingestion-source', documentRef, pipelineVersion: '1.0.0' },
  })
}

function buildWorker(
  context: IngestionContext,
  injected: DocumentParserPort,
  jobStore: PostgresJobStore,
  workerId: string,
): JobWorker {
  const generation = new CountingGenerationPort(generationResponse(ACCURATE_PAYLOAD))
  const pipeline = new ExtractionPipeline({
    schemaSource: context.schemaSource,
    generation,
    candidates: candidateStore,
    budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: clock.now,
  })
  const downstream = [
    new ExtractionStageHandler({ pipeline, parseStore }),
    new CandidateValidationStageHandler({ pipeline, parseStore }),
    new ReviewHandoffStageHandler(),
  ]
  return new JobWorker({
    store: jobStore,
    handlers: createIngestionHandlerRegistry({ parser: injected, downstream }),
    budget,
    workerId,
    now: clock.now,
    newId: () => randomUUID(),
  })
}

async function scalar(sql: string, values: readonly unknown[]): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(sql, [...values])
  return Number(result.rows[0]?.count ?? '0')
}

function countArtifacts(scopeRef: ScopeRef): Promise<number> {
  return scalar(
    `SELECT count(*)::text AS count FROM agent_platform.artifact_blobs
      WHERE tenant_id = $1 AND space_id = $2`,
    [scopeRef.tenantId, scopeRef.spaceId],
  )
}

/** Fails the first `advanceStage` *before* it commits, i.e. after the parser archived but before the checkpoint. */
class FaultInjectingJobStore extends PostgresJobStore {
  failNextAdvanceBeforeCommit = false

  override async advanceStage(
    ...args: Parameters<PostgresJobStore['advanceStage']>
  ): ReturnType<PostgresJobStore['advanceStage']> {
    if (this.failNextAdvanceBeforeCommit) {
      this.failNextAdvanceBeforeCommit = false
      throw new Error('simulated crash after archival before the stage checkpoint')
    }
    return super.advanceStage(...args)
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresJobStore(database)
  candidateStore = new PostgresCandidateStore(database)
  budgetStore = new PostgresBudgetLedgerStore(database)
  budget = new BudgetService({
    store: budgetStore,
    control: new ControlPostgresRepository(database),
    now: clock.now,
    newId: () => randomUUID(),
  })
  jobService = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  app = createJobApi({ service: jobService, authenticate: testAuthenticator })

  objectDir = await mkdtemp(join(tmpdir(), 'ingestion-pipeline-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  parser = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: clock.now,
  })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

describe('POST /ingestions runs received → parsed → awaiting_review with the real parser', () => {
  it('parses inside the worker, archives artifacts and reaches awaiting_review', async () => {
    const context = await newContext('ingestion-e2e')
    const originalRef = await publishOriginal(
      context,
      'SERVICE TERMS\n1.1 The charger D-1 is rated 7.2 kW.\n1.2 It is monitored by meter M-1.',
    )
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    expect(created.statusCode).toBe(202)
    const createdData = created.json() as { data: { jobId: string; stage: string } }
    expect(createdData.data.stage).toBe('received')
    const jobId = createdData.data.jobId

    const worker = buildWorker(context, parser, store, 'ingestion-e2e-worker')
    await worker.runUntilIdle(context.scopeRef, context.ctx)

    const view = await jobService.getJob(jobId, context.ctx)
    expect(view.stage).toBe('awaiting_review')
    expect(view.counts.processed).toBeGreaterThan(0)
    expect(view.counts.failed).toBe(0)

    // The job's documentRef is the structured extraction reference the parsed stage wrote.
    expect(view.documentRef).toBeDefined()
    if (view.documentRef === undefined) return
    const extractionRef = decodeExtractionJobRef(view.documentRef)
    expect(extractionRef.parserVersion).toBe('1.0.0')
    expect(extractionRef.definitionRef).toEqual(context.definitionRef)

    // The parse, its coverage and its derived artifacts are durable and consistent.
    const parse = await parseStore.findParseByDigest(context.scopeRef, originalRef.digest, '1.0.0', context.ctx)
    expect(parse).toBeDefined()
    if (parse === undefined) return
    expect(parse.parseId).toBe(extractionRef.parseId)
    expect(parse.coverage.status).toBe('complete')
    expect(parse.normalizedRef.digest).toMatch(/^sha256:/)
    expect(parse.spanMapRef.digest).toMatch(/^sha256:/)

    const chunks = await parseStore.listChunks(context.scopeRef, parse.parseId, context.ctx)
    expect(chunks.length).toBeGreaterThan(0)
    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
          WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, originalRef.digest],
      ),
    ).toBe(1)
    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.document_chunks
          WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, parse.parseId],
      ),
    ).toBe(chunks.length)
    // original (document) + normalized text + span map, all content-addressed in this scope.
    expect(await countArtifacts(context.scopeRef)).toBe(3)

    const candidates = await candidateStore.listCandidates(context.scopeRef, { jobId }, context.ctx)
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(candidates.every((candidate) => candidate.state === 'pending_review')).toBe(true)
    expect(candidates.every((candidate) => candidate.sourceSpans[0]?.parseId === parse.parseId)).toBe(true)

    // C6: the public GET surfaces the same stage, counts and rewritten documentRef.
    const httpView = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: {
        'x-test-subject': 'ingestion-viewer',
        'x-test-roles': 'scoped-reader',
        'x-test-tenant': context.scope.tenantId,
        'x-test-space': context.scope.spaceId,
      },
    })
    expect(httpView.statusCode).toBe(200)
    const httpData = httpView.json() as {
      data: { stage: string; counts: { processed: number }; documentRef?: string }
    }
    expect(httpData.data.stage).toBe('awaiting_review')
    expect(httpData.data.counts.processed).toBe(view.counts.processed)
    expect(httpData.data.documentRef).toBe(view.documentRef)
  })

  it('deduplicates a re-ingested original onto one parse and one lineage', async () => {
    const context = await newContext('ingestion-dedup')
    const text = 'CLAUSE\n4.1 A shared clause for the dedup case.'
    const firstRef = await publishOriginal(context, text)
    const firstJob = await ingest(context, ingestionDocumentRef(context, firstRef))
    const firstId = (firstJob.json() as { data: { jobId: string } }).data.jobId
    await buildWorker(context, parser, store, 'ingestion-dedup-1').runUntilIdle(
      context.scopeRef,
      context.ctx,
    )
    const first = await jobService.getJob(firstId, context.ctx)
    const firstParseId =
      first.documentRef === undefined ? undefined : decodeExtractionJobRef(first.documentRef).parseId
    expect(firstParseId).toBeDefined()

    // A duplicate upload of identical bytes, under a different source so it is a distinct job.
    const secondRef = await publishOriginal(context, text)
    expect(secondRef.digest).toBe(firstRef.digest)
    const second = await ingest(context, ingestionDocumentRef(context, secondRef))
    const secondId = (second.json() as { data: { jobId: string } }).data.jobId
    await buildWorker(context, parser, store, 'ingestion-dedup-2').runUntilIdle(
      context.scopeRef,
      context.ctx,
    )
    const secondView = await jobService.getJob(secondId, context.ctx)
    const secondParseId =
      secondView.documentRef === undefined
        ? undefined
        : decodeExtractionJobRef(secondView.documentRef).parseId
    expect(secondParseId).toBe(firstParseId)

    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
          WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, firstRef.digest],
      ),
    ).toBe(1)
    // One content-addressed blob for the original, two authorized references (one per upload).
    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.artifact_blobs
          WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, firstRef.digest],
      ),
    ).toBe(1)
    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.artifact_references
          WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3 AND purpose = 'document'`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, firstRef.digest],
      ),
    ).toBe(2)
  })
})

describe('received → parsed truncation lineage with the real parser', () => {
  it('carries a real truncation case into the job reference and keeps it out of complete evidence', async () => {
    const context = await newContext('ingestion-truncation')
    const originalRef = await publishOriginalBytes(context, brokenPageTwoPdf(), 'application/pdf')
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const worker = buildWorker(context, parser, store, 'ingestion-truncation-worker')
    await worker.runUntilIdle(context.scopeRef, context.ctx)

    const view = await jobService.getJob(jobId, context.ctx)
    expect(view.stage).toBe('awaiting_review')
    expect(view.documentRef).toBeDefined()
    if (view.documentRef === undefined) return
    const ref = decodeExtractionJobRef(view.documentRef)
    expect(ref.truncatedChunkIds).toBeDefined()
    const truncatedChunkIds = ref.truncatedChunkIds ?? []
    expect(truncatedChunkIds.length).toBeGreaterThan(0)

    // The parse itself is partial, and the truncated ids are exactly the parser's lineage.
    const parse = await parseStore.findParseByDigest(
      context.scopeRef,
      originalRef.digest,
      '1.0.0',
      context.ctx,
    )
    expect(parse?.coverage.status).toBe('partial')
    expect(parse?.parseId).toBe(ref.parseId)

    // Downstream: a candidate grounded in a truncated chunk is never produced as complete.
    const candidates = await candidateStore.listCandidates(context.scopeRef, { jobId }, context.ctx)
    expect(candidates.length).toBeGreaterThan(0)
    const truncated = new Set(truncatedChunkIds)
    const fromTruncated = candidates.filter((candidate) =>
      candidate.sourceSpans.some((span) => truncated.has(span.chunkId)),
    )
    expect(fromTruncated.length).toBeGreaterThan(0)
    expect(fromTruncated.every((candidate) => candidate.state === 'pending_review')).toBe(true)
    expect(
      fromTruncated.every((candidate) =>
        candidate.issues.some((issue) => issue.code === 'TRUNCATED_CHUNK'),
      ),
    ).toBe(true)
  })

  it('commits the truncation lineage atomically with the parsed checkpoint', async () => {
    const context = await newContext('ingestion-truncation-atomic')
    const originalRef = await publishOriginalBytes(context, brokenPageTwoPdf(), 'application/pdf')
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const faultStore = new FaultInjectingJobStore(database)
    faultStore.failNextAdvanceBeforeCommit = true
    const crashing = buildWorker(context, parser, faultStore, 'ingestion-truncation-crash')
    await expect(crashing.runOnce(context.scopeRef, context.ctx)).rejects.toThrow(
      /simulated crash after archival/,
    )

    // The parse archived its chunks, but the checkpoint never committed, so the job still carries
    // the ingestion reference and no truncation lineage has leaked into it.
    const afterCrash = await store.getJob(context.scopeRef, jobId, context.ctx)
    expect(afterCrash?.stage).toBe('received')
    expect(afterCrash?.documentRef).toBeDefined()
    if (afterCrash?.documentRef === undefined) return
    expect(decodeDocumentIngestionRef(afterCrash.documentRef).kind).toBe('document_ingestion')

    clock.advance(5 * 60_000)
    const recovering = buildWorker(context, parser, store, 'ingestion-truncation-recover')
    const result = await recovering.runOnce(context.scopeRef, context.ctx)
    expect(result.disposition).toBe('stopped')

    // Recovery commits the extraction reference and its truncated ids together with the checkpoint.
    const done = await jobService.getJob(jobId, context.ctx)
    expect(done.stage).toBe('awaiting_review')
    expect(done.documentRef).toBeDefined()
    if (done.documentRef === undefined) return
    const ref = decodeExtractionJobRef(done.documentRef)
    expect(ref.truncatedChunkIds?.length ?? 0).toBeGreaterThan(0)
  })

  it('reports an empty truncation lineage for a fully captured document', async () => {
    const context = await newContext('ingestion-clean')
    const originalRef = await publishOriginal(
      context,
      'SERVICE TERMS\n7.1 A complete clause.\n7.2 Another complete clause.',
    )
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const worker = buildWorker(context, parser, store, 'ingestion-clean-worker')
    await worker.runUntilIdle(context.scopeRef, context.ctx)

    const view = await jobService.getJob(jobId, context.ctx)
    expect(view.stage).toBe('awaiting_review')
    if (view.documentRef === undefined) return
    const ref = decodeExtractionJobRef(view.documentRef)
    expect(ref.truncatedChunkIds).toEqual([])
  })
})

describe('received → parsed reclaim and honest failure', () => {
  it('reclaims a crash after archival before the checkpoint without duplicating artifacts or spans', async () => {
    const context = await newContext('ingestion-crash')
    const originalRef = await publishOriginal(
      context,
      'SERVICE TERMS\n5.1 A clause for the crash-reclaim case.\n5.2 It must converge.',
    )
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const faultStore = new FaultInjectingJobStore(database)
    faultStore.failNextAdvanceBeforeCommit = true
    const crashing = buildWorker(context, parser, faultStore, 'ingestion-crash-worker')
    await expect(crashing.runOnce(context.scopeRef, context.ctx)).rejects.toThrow(
      /simulated crash after archival/,
    )

    // The parser archived its artifacts and spans, but the job is still at `received`.
    const afterCrash = await store.getJob(context.scopeRef, jobId, context.ctx)
    expect(afterCrash?.stage).toBe('received')
    const parseAfterCrash = await parseStore.findParseByDigest(
      context.scopeRef,
      originalRef.digest,
      '1.0.0',
      context.ctx,
    )
    expect(parseAfterCrash).toBeDefined()
    if (parseAfterCrash === undefined) return
    const chunksAfterCrash = await parseStore.listChunks(context.scopeRef, parseAfterCrash.parseId, context.ctx)
    expect(chunksAfterCrash.length).toBeGreaterThan(0)
    const artifactsAfterCrash = await countArtifacts(context.scopeRef)

    // Let the crashed lease expire and reclaim from the interrupted `received` stage.
    clock.advance(5 * 60_000)
    const recovering = buildWorker(context, parser, faultStore, 'ingestion-recover-worker')
    const result = await recovering.runOnce(context.scopeRef, context.ctx)
    expect(result.reclaimedAttemptId).toBeDefined()
    expect(result.disposition).toBe('stopped')

    const done = await jobService.getJob(jobId, context.ctx)
    expect(done.stage).toBe('awaiting_review')

    // One parse, the same spans and the same artifacts: the re-run converged, nothing duplicated.
    const parseAfterRecovery = await parseStore.findParseByDigest(
      context.scopeRef,
      originalRef.digest,
      '1.0.0',
      context.ctx,
    )
    expect(parseAfterRecovery?.parseId).toBe(parseAfterCrash.parseId)
    expect(
      await parseStore.listChunks(context.scopeRef, parseAfterCrash.parseId, context.ctx),
    ).toHaveLength(chunksAfterCrash.length)
    expect(await countArtifacts(context.scopeRef)).toBe(artifactsAfterCrash)
    expect(
      await scalar(
        `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
          WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3`,
        [context.scopeRef.tenantId, context.scopeRef.spaceId, originalRef.digest],
      ),
    ).toBe(1)

    const attempts = await store.listAttempts(context.scopeRef, jobId, context.ctx)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['abandoned', 'succeeded'])
  })

  it('records a parse failure as failed at the received stage and never masquerades as complete', async () => {
    const context = await newContext('ingestion-fail')
    const originalRef = await publishOriginal(context, 'not a supported document', 'application/octet-stream')
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const worker = buildWorker(context, parser, store, 'ingestion-fail-worker')
    await worker.runUntilIdle(context.scopeRef, context.ctx)

    const view = await jobService.getJob(jobId, context.ctx)
    expect(view.stage).toBe('failed')
    expect(view.failedStage).toBe('received')
    expect(view.lastError?.code).toBe('INVALID_ARGUMENT')
    expect(view.lastError?.message).toBe('no parser is registered for the document media type')
    expect(
      await parseStore.findParseByDigest(context.scopeRef, originalRef.digest, '1.0.0', context.ctx),
    ).toBeUndefined()

    // The failed stage is retryable through the public C6 surface.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `retry-${randomUUID()}`,
        'x-test-subject': 'ingestion-editor',
        'x-test-roles': 'data-editor,platform-admin',
        'x-test-tenant': context.scope.tenantId,
        'x-test-space': context.scope.spaceId,
        'if-match': view.revision,
      },
      payload: { failedStage: 'received' },
    })
    expect(retry.statusCode).toBe(200)

    // Re-running the same unsupported document fails honestly again, never at `awaiting_review`.
    await worker.runUntilIdle(context.scopeRef, context.ctx)
    const again = await jobService.getJob(jobId, context.ctx)
    expect(again.stage).toBe('failed')
    expect(again.failedStage).toBe('received')
    expect(again.lastError?.code).toBe('INVALID_ARGUMENT')
  })

  it('recovers from a transient parse failure through retry with the real parser', async () => {
    const context = await newContext('ingestion-transient')
    const originalRef = await publishOriginal(context, 'CLAUSE\n6.1 A clause parsed after a transient failure.')
    const created = await ingest(context, ingestionDocumentRef(context, originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const flaky = new FlakyParser(parser)
    const failing = buildWorker(context, flaky, store, 'ingestion-transient-fail')
    await failing.runUntilIdle(context.scopeRef, context.ctx)
    const failed = await jobService.getJob(jobId, context.ctx)
    expect(failed.stage).toBe('failed')
    expect(failed.failedStage).toBe('received')
    expect(failed.lastError?.code).toBe('SOURCE_UNAVAILABLE')
    expect(failed.lastError?.retryable).toBe(true)

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `retry-${randomUUID()}`,
        'x-test-subject': 'ingestion-editor',
        'x-test-roles': 'data-editor,platform-admin',
        'x-test-tenant': context.scope.tenantId,
        'x-test-space': context.scope.spaceId,
        'if-match': failed.revision,
      },
      payload: { failedStage: 'received' },
    })
    expect(retry.statusCode).toBe(200)

    const recovering = buildWorker(context, parser, store, 'ingestion-transient-recover')
    await recovering.runUntilIdle(context.scopeRef, context.ctx)
    const done = await jobService.getJob(jobId, context.ctx)
    expect(done.stage).toBe('awaiting_review')
    expect(
      await parseStore.findParseByDigest(context.scopeRef, originalRef.digest, '1.0.0', context.ctx),
    ).toBeDefined()
  })
})
