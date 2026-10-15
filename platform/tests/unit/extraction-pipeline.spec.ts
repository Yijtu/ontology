import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CandidateRecord, DocumentChunkRecord, ToolContext } from '@ontology/contracts'
import type { ExtractionInput, ExtractionRunContext, JobStageHandler } from '@ontology/application'
import {
  CandidateValidationStageHandler,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
  encodeExtractionJobRef,
} from '@ontology/application'
import { JobService, JobWorker, InMemoryJobStore } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import { createBudgetHarness, ManualClock } from './job-fixtures'
import {
  CountingGenerationPort,
  DEFINITION_REF,
  FaultInjectingCandidateStore,
  JOB_ID,
  LEDGER_ID,
  MODEL_REF,
  PARSE_ID,
  PARSER_VERSION,
  StaticDocumentParseStore,
  buildIndustrySchema,
  chunkOf,
  generationResponse,
  textSpan,
} from './extraction-fixtures'

const EDITOR_CTX: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'extraction-unit')

function inputOf(
  chunks: readonly DocumentChunkRecord[],
  overrides: Partial<ExtractionInput> = {},
): ExtractionInput {
  return {
    jobId: JOB_ID,
    parseId: PARSE_ID,
    parserVersion: PARSER_VERSION,
    pipelineVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
    chunks,
    truncatedChunkIds: [],
    ...overrides,
  }
}

function buildHarness(): {
  readonly pipeline: ExtractionPipeline
  readonly generation: CountingGenerationPort
  readonly candidates: InMemoryCandidateStore
  readonly budget: ReturnType<typeof createBudgetHarness>
  readonly schema: ReturnType<typeof buildIndustrySchema>
  readonly run: ExtractionRunContext
} {
  const budget = createBudgetHarness()
  const candidates = new InMemoryCandidateStore()
  const generation = new CountingGenerationPort()
  const schema = buildIndustrySchema()
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema }]),
    generation,
    candidates,
    budget: budget.budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: () => '2026-09-22T00:00:00Z',
  })
  return {
    pipeline,
    generation,
    candidates,
    budget,
    schema,
    run: { ledgerId: LEDGER_ID, ctx: EDITOR_CTX, signal: new AbortController().signal },
  }
}

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

describe('extraction pipeline against the industry schema', () => {
  it('validates candidates, links every source span and records usage plus input version', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('The charger D-1 is rated 7.2 kW and is monitored by meter M-1.', 0)]
    h.generation.enqueue(generationResponse(ACCURATE_PAYLOAD))
    const input = inputOf(chunks)
    const schemaBefore = JSON.stringify(h.schema)

    const extracted = await h.pipeline.extract(input, h.run)
    expect(extracted.modelCalls).toBe(1)
    expect(extracted.candidateIds).toHaveLength(3)

    const validated = await h.pipeline.validate(input, h.run)
    expect(validated.pendingReview).toBe(3)
    expect(validated.failed).toBe(0)

    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored).toHaveLength(3)
    for (const candidate of stored) {
      expect(candidate.state).toBe('pending_review')
      expect(candidate.sourceSpans).toHaveLength(1)
      expect(candidate.sourceSpans[0]?.parseId).toBe(PARSE_ID)
      expect(textSpan(candidate.sourceSpans[0])?.chunkId).toBe(chunks[0]?.chunkId)
      expect(textSpan(candidate.sourceSpans[0])?.quoteDigest).toBe(chunks[0]?.quoteDigest)
      expect(candidate.inputVersion.definitionRef.digest).toBe(DEFINITION_REF.digest)
      expect(candidate.inputVersion.pipelineVersion).toBe('1.0.0')
    }
    const entities = stored.filter((candidate) => candidate.kind === 'entity')
    expect(entities.every((entity) => entity.usage?.inputTokens === 12)).toBe(true)

    // Extraction is append-only: the schema it validated against is byte-for-byte unchanged.
    expect(JSON.stringify(h.schema)).toBe(schemaBefore)

    const reservations = await h.budget.store.listReservations(SCOPE_A, LEDGER_ID, EDITOR_CTX)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
    expect(reservations[0]?.actual?.modelTokens).toBe(19)
    expect(reservations[0]?.evidenceRefs[0]?.kind).toBe('chunk')
  })

  it('sends a missing required attribute to an explicit failed state', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('a charger without a declared kind', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [{ objectId: 'device', attributes: [{ attributeId: 'device_name', value: 'Unnamed' }] }],
        relations: [],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.state).toBe('failed')
    expect(stored[0]?.issues.some((issue) => issue.code === 'CARDINALITY_VIOLATION')).toBe(true)
  })

  it('fails a type error instead of coercing the value into shape', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('rated power stated as a string', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_kind', value: 'charger' },
              { attributeId: 'rated_power', value: 'not-a-number', unitCode: 'kW' },
            ],
          },
        ],
        relations: [],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored[0]?.state).toBe('failed')
    expect(stored[0]?.issues.some((issue) => issue.code === 'TYPE_MISMATCH')).toBe(true)
  })

  it('preserves the raw and exact decimal of a quantity without a lossy Number', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('the charger is rated 7.20 kW', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_native_id', value: 'D-P' },
              { attributeId: 'device_kind', value: 'charger' },
              { attributeId: 'rated_power', value: '7.20', raw: '7.20', decimal: '7.20', unitCode: 'kW' },
            ],
          },
        ],
        relations: [],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    const entity = stored[0]
    expect(entity?.state).toBe('pending_review')
    if (entity?.kind !== 'entity') return
    const power = entity.attributes.find((attribute) => attribute.attributeId === 'rated_power')
    expect(power?.value).toBe('7.20')
    expect(typeof power?.value).toBe('string')
    expect(power?.raw).toBe('7.20')
    expect(power?.decimal).toBe('7.20')
    expect(power?.unitCode).toBe('kW')
  })

  it('sends an unknown field to pending review instead of failing or dropping it', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('a charger with an extra field', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_native_id', value: 'D-U' },
              { attributeId: 'device_kind', value: 'charger' },
              { attributeId: 'mystery_field', value: 'unknown' },
            ],
          },
        ],
        relations: [],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    const entity = stored[0]
    expect(entity?.state).toBe('pending_review')
    expect(entity?.issues.some((issue) => issue.code === 'UNKNOWN_ATTRIBUTE')).toBe(true)
  })

  it('keeps a named-but-unidentified relation endpoint in pending review, not a drop or a hard failure', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('a meter monitors a charger whose identity is not confirmed', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_native_id', value: 'D-R' },
              { attributeId: 'device_kind', value: 'charger' },
            ],
          },
          { objectId: 'meter', attributes: [{ attributeId: 'meter_native_id', value: 'M-R' }] },
        ],
        relations: [
          {
            relationId: 'meter_monitors_device',
            from: { objectId: 'meter', entityIndex: 1 },
            to: { objectId: 'device' },
          },
        ],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    const relation = stored.find((candidate) => candidate.kind === 'relation')
    expect(relation?.state).toBe('pending_review')
    expect(relation?.issues.some((issue) => issue.code === 'UNRESOLVED_ENDPOINT')).toBe(true)
  })

  it('fails a fake relation reference instead of accepting it', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('a relation pointing at an entity that does not exist', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_kind', value: 'charger' },
              { attributeId: 'device_native_id', value: 'D-1' },
            ],
          },
          { objectId: 'meter', attributes: [{ attributeId: 'meter_native_id', value: 'M-1' }] },
        ],
        relations: [
          {
            relationId: 'meter_monitors_device',
            from: { objectId: 'meter', entityIndex: 1 },
            to: { objectId: 'device', entityIndex: 99 },
          },
        ],
      }),
    )
    const input = inputOf(chunks)
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    const relation = stored.find((candidate) => candidate.kind === 'relation')
    expect(relation?.state).toBe('failed')
    expect(relation?.issues.some((issue) => issue.code === 'DANGLING_REFERENCE')).toBe(true)
    // The two entities are still valid and stay reviewable.
    expect(stored.filter((candidate) => candidate.state === 'pending_review')).toHaveLength(2)
  })

  it('marks a candidate from a truncated chunk as pending review, never silently complete', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('the parser could not finish this chunk', 0)]
    h.generation.enqueue(
      generationResponse({
        entities: [
          {
            objectId: 'device',
            attributes: [
              { attributeId: 'device_kind', value: 'charger' },
              { attributeId: 'device_native_id', value: 'D-2' },
            ],
          },
        ],
        relations: [],
      }),
    )
    const input = inputOf(chunks, { truncatedChunkIds: [chunks[0]?.chunkId ?? ''] })
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored[0]?.state).toBe('pending_review')
    expect(stored[0]?.issues.some((issue) => issue.code === 'TRUNCATED_CHUNK')).toBe(true)
  })

  it('maps native strong-ID records deterministically with zero model calls', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const nativeText = JSON.stringify({
      device_native_id: 'DEV-9',
      device_name: 'Charger Nine',
      device_kind: 'charger',
      rated_power: 11,
    })
    const chunks = [chunkOf(nativeText, 0)]
    const input = inputOf(chunks)

    const extracted = await h.pipeline.extract(input, h.run)
    expect(h.generation.callCount).toBe(0)
    expect(extracted.deterministicCandidates).toBe(1)
    expect(extracted.modelCalls).toBe(0)

    await h.pipeline.validate(input, h.run)
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored).toHaveLength(1)
    const entity = stored[0]
    expect(entity?.kind).toBe('entity')
    if (entity?.kind !== 'entity') return
    expect(entity.deterministic).toBe(true)
    expect(entity.nativeId).toBe('DEV-9')
    expect(entity.identityScopeId).toBe('device_identity')
    expect(entity.state).toBe('pending_review')
    expect(entity.usage?.inputTokens).toBe(0)
    // No remote call was made, so no budget reservation was taken.
    expect(await h.budget.store.listReservations(SCOPE_A, LEDGER_ID, EDITOR_CTX)).toHaveLength(0)
  })

  it('is idempotent for a duplicate job: a re-run inserts no duplicate candidate', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunks = [chunkOf('a duplicate extraction of the same chunk', 0)]
    const input = inputOf(chunks)

    h.generation.enqueue(generationResponse(ACCURATE_PAYLOAD))
    const first = await h.pipeline.extract(input, h.run)
    h.generation.enqueue(generationResponse(ACCURATE_PAYLOAD))
    const second = await h.pipeline.extract(input, h.run)

    expect(first.candidateIds).toHaveLength(3)
    expect(second.candidateIds).toHaveLength(3)
    expect(new Set(second.candidateIds)).toEqual(new Set(first.candidateIds))
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored).toHaveLength(3)
  })
})

interface JobHarness {
  readonly worker: JobWorker
  readonly jobService: JobService
  readonly candidates: InMemoryCandidateStore
  readonly faults: FaultInjectingCandidateStore
  readonly generation: CountingGenerationPort
  readonly budget: ReturnType<typeof createBudgetHarness>
  readonly receivedCalls: () => number
}

function buildJobHarness(chunks: readonly DocumentChunkRecord[]): JobHarness {
  const budget = createBudgetHarness()
  const store = new InMemoryJobStore()
  const clock = new ManualClock()
  const jobService = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  const candidates = new InMemoryCandidateStore()
  const faults = new FaultInjectingCandidateStore(candidates)
  const generation = new CountingGenerationPort()
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
    generation,
    candidates: faults,
    budget: budget.budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: clock.now,
  })
  let receivedCalls = 0
  const received: JobStageHandler = {
    stage: 'received',
    run: (context) => {
      receivedCalls += 1
      return Promise.resolve({ nextStage: 'parsed', counts: context.job.counts })
    },
  }
  const parseStore = new StaticDocumentParseStore(chunks)
  const handlers = createExtractionHandlerRegistry([
    received,
    new ExtractionStageHandler({ pipeline, parseStore, now: clock.now, newId: () => randomUUID() }),
    new CandidateValidationStageHandler({ pipeline, parseStore }),
    new ReviewHandoffStageHandler(),
  ])
  const worker = new JobWorker({
    store,
    handlers,
    budget: budget.budget,
    workerId: 'extraction-unit-worker',
    now: clock.now,
    newId: () => randomUUID(),
  })
  return { worker, jobService, candidates, faults, generation, budget, receivedCalls: () => receivedCalls }
}

async function createExtractionJob(jobService: JobService): Promise<void> {
  await jobService.createJob(
    {
      jobId: JOB_ID,
      kind: 'ingestion',
      sourceRef: 'source-1',
      documentRef: encodeExtractionJobRef({
        parseId: PARSE_ID,
        parserVersion: PARSER_VERSION,
        definitionRef: DEFINITION_REF,
      }),
      pipelineVersion: '1.0.0',
      idempotencyKey: 'extraction-job-key-0001',
    },
    EDITOR_CTX,
  )
}

describe('extraction as a durable job stage', () => {
  it('retries from the failed extraction stage without redoing earlier stages or duplicating candidates', async () => {
    const chunks = [chunkOf('a chunk extracted after a transient model failure', 0)]
    const h = buildJobHarness(chunks)
    await createExtractionJob(h.jobService)

    h.generation.enqueue({ error: new Error('model unavailable') })
    const failed = await h.worker.runOnce(SCOPE_A, EDITOR_CTX)
    expect(failed.disposition).toBe('failed')
    expect(failed.stage).toBe('parsed')

    const afterFailure = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    expect(afterFailure.failedStage).toBe('parsed')
    expect(await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)).toHaveLength(0)
    // A failed model call may still have been billed, so the reservation is held as
    // `usage_unknown` rather than released as free.
    const held = await h.budget.store.listReservations(SCOPE_A, JOB_ID, EDITOR_CTX)
    expect(held).toHaveLength(1)
    expect(held[0]?.status).toBe('usage_unknown')

    await h.jobService.retryJob(
      {
        jobId: JOB_ID,
        failedStage: 'parsed',
        idempotencyKey: 'extraction-retry-key-0001',
        expectedRevision: afterFailure.revision,
      },
      EDITOR_CTX,
    )
    h.generation.enqueue(generationResponse(ACCURATE_PAYLOAD))
    await h.worker.runUntilIdle(SCOPE_A, EDITOR_CTX)

    const finalJob = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    expect(finalJob.stage).toBe('awaiting_review')
    const stored = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(stored).toHaveLength(3)
    expect(stored.every((candidate) => candidate.state === 'pending_review')).toBe(true)
    // The earlier `received` stage ran once; the failed model call plus the successful retry
    // are the only two generation calls.
    expect(h.receivedCalls()).toBe(1)
    expect(h.generation.callCount).toBe(2)
    // The retry's definitive settlement released the held allowance.
    const settled = await h.budget.store.listReservations(SCOPE_A, JOB_ID, EDITOR_CTX)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.status).toBe('settled')
  })

  it('retries from the failed validation stage without re-running extraction', async () => {
    const chunks = [chunkOf('a chunk whose validation fails once', 0)]
    const h = buildJobHarness(chunks)
    await createExtractionJob(h.jobService)

    h.generation.enqueue(generationResponse(ACCURATE_PAYLOAD))
    h.faults.armTransitionFailure()
    const failed = await h.worker.runOnce(SCOPE_A, EDITOR_CTX)
    expect(failed.disposition).toBe('failed')
    expect(failed.stage).toBe('extracted')

    const afterFailure = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    expect(afterFailure.failedStage).toBe('extracted')
    const beforeRetry = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(beforeRetry).toHaveLength(3)
    const callsBeforeRetry = h.generation.callCount

    await h.jobService.retryJob(
      {
        jobId: JOB_ID,
        failedStage: 'extracted',
        idempotencyKey: 'extraction-retry-key-0002',
        expectedRevision: afterFailure.revision,
      },
      EDITOR_CTX,
    )
    await h.worker.runUntilIdle(SCOPE_A, EDITOR_CTX)

    const finalJob = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    expect(finalJob.stage).toBe('awaiting_review')
    const afterRetry = await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
    expect(afterRetry).toHaveLength(3)
    // Extraction was not redone: the model was not called again and no duplicate was written.
    expect(h.generation.callCount).toBe(callsBeforeRetry)
    expect(afterRetry.every((candidate: CandidateRecord) => candidate.state === 'pending_review')).toBe(true)
  })
})
