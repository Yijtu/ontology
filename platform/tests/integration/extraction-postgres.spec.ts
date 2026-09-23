import { randomUUID } from 'node:crypto'
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
  PostgresEvidenceStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
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
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
  encodeExtractionJobRef,
} from '@ontology/application'
import { JobService, JobWorker } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import {
  InMemorySemanticDefinitionStore,
  SemanticDefinitionService,
  projectIndustrySchema,
} from '@ontology/semantic-engine'
import type { ParsedDocument } from '@ontology/contracts'
import type { ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { sampleCoreDraft } from '../unit/semantic-definition-fixtures'
import {
  CountingGenerationPort,
  MODEL_REF,
  generationResponse,
} from '../unit/extraction-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import { createCompanyExtractionGeneration } from '../../apps/api/src/composition/company-extraction'
import { LocalNativeCandidateIngestion } from '../../apps/api/src/composition/local-native-candidates'
import { createRequestToolContext } from '../../apps/api/src/http/context'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

// Real PostgreSQL + blob-local round-trips are slower than the default 5s budget.
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

const INVALID_PAYLOAD = {
  entities: [
    {
      objectId: 'device',
      attributes: [
        { attributeId: 'device_native_id', value: 'D-3' },
        { attributeId: 'device_kind', value: 'charger' },
        { attributeId: 'rated_power', value: 'not-a-number', unitCode: 'kW' },
      ],
    },
    { objectId: 'meter', attributes: [{ attributeId: 'meter_native_id', value: 'M-3' }] },
  ],
  relations: [
    {
      relationId: 'meter_monitors_device',
      from: { objectId: 'meter', entityIndex: 1 },
      to: { objectId: 'device', entityIndex: 99 },
    },
  ],
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let jobStore: PostgresJobStore
let candidateStore: PostgresCandidateStore
let budgetStore: PostgresBudgetLedgerStore
let budget: BudgetService
let worker: JobWorker
let jobService: JobService
let definitionService: SemanticDefinitionService
let scope: JobTestScope
let ctx: ToolContext
let definitionRef: VersionRef
let schemaSource: InMemoryIndustrySchemaSource
let parseStore: PostgresDocumentParseStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let extraction: LocalDocumentExtractionService
let reader: DocumentSpanReader
let generation: CountingGenerationPort
let objectDir = ''

async function publishOriginal(text: string): Promise<{ readonly blobRef: ParsedDocument['originalRef'] }> {
  const bytes = new TextEncoder().encode(text)
  const staged = await blobStore.stage(bytes, { scopeRef: scope.scopeRef }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef: scope.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctx,
  )
  return { blobRef: published.blobRef }
}

async function publishAndParse(text: string): Promise<ParsedDocument> {
  const original = await publishOriginal(text)
  return extraction.parse({ scopeRef: scope.scopeRef, originalRef: original.blobRef }, ctx)
}

async function createAndCompleteParse(
  parsed: ParsedDocument,
  truncatedChunkIds: readonly Uuid[],
): Promise<Uuid> {
  const jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'extraction-integration-source',
      documentRef: encodeExtractionJobRef({
        parseId: parsed.parseId,
        parserVersion: parsed.parserVersion,
        definitionRef,
        ...(truncatedChunkIds.length === 0 ? {} : { truncatedChunkIds }),
      }),
      pipelineVersion: '1.0.0',
      idempotencyKey: `extraction-job-${jobId.slice(0, 8)}`,
    },
    ctx,
  )
  // The parse stage is LOCAL-023's real adapter; this test completes it directly so the
  // extraction pipeline runs as the real `parsed → extracted → validated` job stages.
  const now = new Date().toISOString()
  const lease = await jobStore.acquireLease(
    scope.scopeRef,
    // A zero lease keeps `next_attempt_at` at `now`, so the worker can claim the job
    // immediately after this setup attempt completes.
    { workerId: 'extraction-it-setup', now, leaseDurationMs: 0, jobId },
    ctx,
  )
  if (lease === undefined) throw new Error('could not lease the newly created job')
  await jobStore.completeAttempt(
    scope.scopeRef,
    jobId,
    lease.attempt.attemptId,
    { finalStage: 'parsed', completedAt: now },
    ctx,
  )
  return jobId
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  jobStore = new PostgresJobStore(database)
  candidateStore = new PostgresCandidateStore(database)
  budgetStore = new PostgresBudgetLedgerStore(database)
  budget = new BudgetService({
    store: budgetStore,
    control: new ControlPostgresRepository(database),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
  jobService = new JobService({ store: jobStore, now: () => new Date().toISOString(), newId: () => randomUUID() })

  scope = await createJobScope(harness.adminClient, 'extraction')
  ctx = toolContext(
    scope.tenantId,
    scope.spaceId,
    ['platform-admin', 'data-editor', 'semantic-publisher'],
    'extraction-integration',
  )

  definitionService = new SemanticDefinitionService({
    control: new ControlPostgresRepository(database),
    store: new InMemorySemanticDefinitionStore(),
  })
  const published = await definitionService.publish(
    sampleCoreDraft({ scopeRef: scope.scopeRef }),
    ctx,
  )
  definitionRef = published.ref
  schemaSource = new InMemoryIndustrySchemaSource([
    { ref: definitionRef, schema: projectIndustrySchema(published) },
  ])

  objectDir = await mkdtemp(join(tmpdir(), 'extraction-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  extraction = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => '2026-09-22T00:00:00Z',
  })
  reader = new DocumentSpanReader({ blobs: blobStore, store: parseStore, now: () => '2026-09-22T00:00:01Z' })

  generation = new CountingGenerationPort(generationResponse(ACCURATE_PAYLOAD))
  const pipeline = new ExtractionPipeline({
    schemaSource,
    generation,
    candidates: candidateStore,
    budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: () => '2026-09-22T00:00:02Z',
  })
  const handlers = createExtractionHandlerRegistry([
    new ExtractionStageHandler({ pipeline, parseStore }),
    new CandidateValidationStageHandler({ pipeline, parseStore }),
    new ReviewHandoffStageHandler(),
  ])
  worker = new JobWorker({
    store: jobStore,
    handlers,
    budget,
    workerId: 'extraction-it-worker',
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
}, 300_000)

afterAll(async () => {
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

describe('extraction candidates against a real PostgreSQL', () => {
  it('validates accurate candidates, links real spans, records usage and leaves the definition unchanged', async () => {
    const parsed = await publishAndParse(
      'SERVICE TERMS\n1.1 The charger D-1 is rated 7.2 kW.\n1.2 It is monitored by meter M-1.',
    )
    expect(parsed.chunks.length).toBeGreaterThan(0)
    const jobId = await createAndCompleteParse(parsed, [])
    const callsBefore = generation.callCount

    await worker.runUntilIdle(scope.scopeRef, ctx)

    const job = await jobService.getJob(jobId, ctx)
    expect(job.stage).toBe('awaiting_review')
    expect(generation.callCount - callsBefore).toBe(parsed.chunks.length)

    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(candidates.every((candidate) => candidate.state === 'pending_review')).toBe(true)
    for (const candidate of candidates) {
      expect(candidate.sourceSpans.length).toBeGreaterThan(0)
      expect(candidate.sourceSpans[0]?.parseId).toBe(parsed.parseId)
      const chunkIds = parsed.chunks.map((chunk) => chunk.chunkId)
      expect(chunkIds).toContain(candidate.sourceSpans[0]?.chunkId)
      expect(candidate.inputVersion.definitionRef.digest).toBe(definitionRef.digest)
    }
    const entities = candidates.filter((candidate) => candidate.kind === 'entity')
    expect(entities.some((entity) => entity.usage?.inputTokens === 12)).toBe(true)

    // The published definition version is byte-for-byte unchanged by the run.
    const reread = await definitionService.getVersion(
      {
        scopeRef: scope.scopeRef,
        namespace: 'home-energy',
        definitionId: definitionRef.id,
        version: definitionRef.version,
      },
      ctx,
    )
    expect(reread.ref.digest).toBe(definitionRef.digest)

    // A span round-trips through the real parse store to the exact chunk text.
    const firstChunkId = candidates[0]?.sourceSpans[0]?.chunkId
    const chunk = parsed.chunks.find((entry) => entry.chunkId === firstChunkId)
    expect(chunk).toBeDefined()
    if (chunk === undefined) return
    const read = await reader.readSpan(
      { documentRef: parsed.originalRef, locator: chunk.locator },
      ctx,
    )
    expect(read.text).toBe(chunk.text)

    const reservations = await budgetStore.listReservations(scope.scopeRef, jobId, ctx)
    expect(reservations).toHaveLength(parsed.chunks.length)
    expect(reservations.every((reservation) => reservation.status === 'settled')).toBe(true)
  })

  it('keeps a candidate from a truncated chunk in an explicit pending-review state', async () => {
    const parsed = await publishAndParse('CLAUSE\n2.1 A clause the parser could not capture completely.')
    const truncatedChunkIds = parsed.chunks.map((chunk) => chunk.chunkId)
    const jobId = await createAndCompleteParse(parsed, truncatedChunkIds)

    await worker.runUntilIdle(scope.scopeRef, ctx)

    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((candidate) => candidate.state === 'pending_review')).toBe(true)
    expect(candidates.every((candidate) => candidate.issues.some((issue) => issue.code === 'TRUNCATED_CHUNK'))).toBe(true)
  })

  it('persists model-output evidence and review candidates against the job ledger', async () => {
    const parsed = await publishAndParse('设备 D-7 是充电器，额定功率 7.2 kW。')
    expect(parsed.chunks).toHaveLength(1)
    const modelCtx = createRequestToolContext({
      principal: { tenantId: scope.tenantId, subjectId: 'model-extraction-it', roles: ['platform-admin', 'data-editor'], scopes: [], authEpoch: 1 },
      spaceId: scope.spaceId, runId: randomUUID(), traceId: 'model-extraction-postgres',
      allowedResourceKinds: ['artifact', 'document', 'evidence'],
    })
    const payload = JSON.stringify({ entities: [{ objectId: 'device', attributes: [
      { attributeId: 'device_native_id', value: 'D-7' },
      { attributeId: 'device_kind', value: 'charger' },
      { attributeId: 'rated_power', value: 7.2, unitCode: 'kW' },
    ] }], relations: [], rules: [], exceptions: [] })
    const sse = [
      { id: 'chatcmpl-it', object: 'chat.completion.chunk', created: 1, model: 'test-vendor', choices: [{ index: 0, delta: { content: payload }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-it', object: 'chat.completion.chunk', created: 1, model: 'test-vendor', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const evidence = new PostgresEvidenceStore(database)
    const configured = createCompanyExtractionGeneration({
      budget, evidence, fetchImpl,
      env: {
        ONTOLOGY_COMPANY_MODEL_BASE_URL: 'https://company.example/v1',
        ONTOLOGY_COMPANY_MODEL_ENDPOINT: 'chat/completions',
        ONTOLOGY_EXTRACTION_VENDOR_MODEL: 'test-vendor',
        ONTOLOGY_COMPANY_MODEL_API_KEY: 'fake-postgres-test-key',
      },
    })
    if (configured === undefined) throw new Error('test model configuration is missing')
    const definition = await definitionService.getVersion({
      scopeRef: scope.scopeRef, namespace: 'home-energy',
      definitionId: definitionRef.id, version: definitionRef.version,
    }, modelCtx)
    const ingestion = new LocalNativeCandidateIngestion({
      jobs: jobService, jobStore, candidates: candidateStore, parseStore,
      definition, budget, generation: configured,
    })
    const idempotencyKey = `model-extraction-${randomUUID()}`
    const result = await ingestion.extract(parsed.parseId, idempotencyKey, modelCtx)
    const jobId = result.jobId
    expect(result.stage).toBe('awaiting_review')
    expect(result.modelCalls).toBe(1)
    expect(result.deterministic).toBe(false)
    const replay = await ingestion.extract(parsed.parseId, idempotencyKey, modelCtx)
    expect(replay.jobId).toBe(jobId)
    expect(calls).toBe(1)
    const stored = await candidateStore.listCandidates(scope.scopeRef, { jobId }, modelCtx)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.state).toBe('pending_review')
    expect(stored[0]?.sourceSpans[0]?.chunkId).toBe(parsed.chunks[0]?.chunkId)
    expect(stored[0]?.deterministic).toBe(false)
    const modelEvidence = await evidence.listByRun(scope.scopeRef, jobId, modelCtx)
    expect(modelEvidence).toHaveLength(1)
    expect(modelEvidence[0]?.envelope.kind).toBe('model_output')
    const reservations = await budgetStore.listReservations(scope.scopeRef, jobId, modelCtx)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
    expect(reservations[0]?.evidenceRefs[0]?.id).toBe(modelEvidence[0]?.evidenceRef.id)
  })

  it('maps native strong-ID records deterministically with zero model calls', async () => {
    const nativeText = JSON.stringify({
      device_native_id: 'DEV-9',
      device_name: 'Charger Nine',
      device_kind: 'charger',
      rated_power: 11,
    })
    const parsed = await publishAndParse(nativeText)
    const jobId = await createAndCompleteParse(parsed, [])
    const callsBefore = generation.callCount

    await worker.runUntilIdle(scope.scopeRef, ctx)

    expect(generation.callCount).toBe(callsBefore)
    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    expect(candidates).toHaveLength(1)
    const entity = candidates[0]
    expect(entity?.kind).toBe('entity')
    if (entity?.kind !== 'entity') return
    expect(entity.deterministic).toBe(true)
    expect(entity.nativeId).toBe('DEV-9')
    expect(entity.state).toBe('pending_review')
    expect(entity.usage?.inputTokens).toBe(0)
    // No remote call means no budget reservation for this ledger.
    expect(await budgetStore.listReservations(scope.scopeRef, jobId, ctx)).toHaveLength(0)
  })

  it('fails a fake reference and a type error instead of accepting them', async () => {
    const parsed = await publishAndParse('CLAUSE\n3.1 A relation pointing at an entity that does not exist.')
    const jobId = await createAndCompleteParse(parsed, [])
    generation.enqueue(generationResponse(INVALID_PAYLOAD))

    await worker.runUntilIdle(scope.scopeRef, ctx)

    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    expect(
      candidates.some(
        (candidate) =>
          candidate.kind === 'relation' &&
          candidate.state === 'failed' &&
          candidate.issues.some((issue) => issue.code === 'DANGLING_REFERENCE'),
      ),
    ).toBe(true)
    expect(
      candidates.some(
        (candidate) =>
          candidate.kind === 'entity' &&
          candidate.state === 'failed' &&
          candidate.issues.some((issue) => issue.code === 'TYPE_MISMATCH'),
      ),
    ).toBe(true)

    // The job still reaches review with the invalid candidates recorded, never dropped.
    const job = await jobService.getJob(jobId, ctx)
    expect(job.stage).toBe('awaiting_review')
  })
})

describe('extraction candidate migration', () => {
  it('enables RLS and keeps tenant/space in the key', async () => {
    const unprotected = await harness.adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname = 'extraction_candidates'
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await harness.adminClient.query<{ columns: string[] }>(
      `SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text = 'agent_platform.extraction_candidates'
        GROUP BY c.conname`,
    )
    expect(keys.rows[0]?.columns).toEqual(['tenant_id', 'space_id', 'candidate_id'])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: harness.adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('022_extraction_candidates.sql')
  })
})
