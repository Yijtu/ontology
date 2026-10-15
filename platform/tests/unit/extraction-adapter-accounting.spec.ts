import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type { DocumentChunkRecord, ToolContext, Uuid } from '@ontology/contracts'
import type { ModelCallEvidenceRecorder } from '@ontology/adapter-model-company'
import {
  CandidateValidationStageHandler,
  ExtractionError,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  InMemoryJobStore,
  JobService,
  JobWorker,
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
  encodeExtractionJobRef,
} from '@ontology/application'
import type { JobStageHandler } from '@ontology/application'
import { createCoreModelCapabilityFactory } from '../../apps/api/src/composition/core-model-capabilities'
import {
  acceptingValidator,
  recordingEvidence,
  staticSecretResolver,
} from './model-company-fixtures'
import {
  DEFINITION_REF,
  JOB_ID,
  PARSE_ID,
  PARSER_VERSION,
  StaticDocumentParseStore,
  buildIndustrySchema,
  chunkOf,
} from './extraction-fixtures'
import { createBudgetHarness, SCOPE_A } from './job-fixtures'

interface RecordedHttpRequest {
  readonly method: string
  readonly path: string | undefined
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
}

interface ControlledCompanyServer {
  readonly baseUrl: string
  readonly requests: RecordedHttpRequest[]
  readonly abortedResponses: number[]
  close(): Promise<void>
}

type ServerMode = 'success' | 'retry-once' | 'drop' | 'slow'

const servers: ControlledCompanyServer[] = []
const COMPANY_PLATFORM_MODEL = 'company-extractor'
const COMPANY_VENDOR_MODEL = 'fixture-extractor'
const VALID_CANDIDATE = JSON.stringify({
  entities: [{
    objectId: 'device',
    attributes: [
      { attributeId: 'device_native_id', value: 'D-1' },
      { attributeId: 'device_kind', value: 'charger' },
    ],
  }],
  relations: [],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

async function startCompanyServer(mode: ServerMode): Promise<ControlledCompanyServer> {
  const requests: RecordedHttpRequest[] = []
  const abortedResponses: number[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('controlled company server did not bind')

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request)
    requests.push({ method: request.method ?? '', path: request.url, authorization: request.headers.authorization, body })
    response.on('close', () => {
      if (!response.writableEnded) abortedResponses.push(1)
    })
    if (mode === 'retry-once' && requests.length === 1) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
      response.end(JSON.stringify({ error: 'transient local test fixture failure' }))
      return
    }
    if (mode === 'drop') {
      request.socket?.destroy()
      abortedResponses.push(1)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ type: 'text_delta', text: VALID_CANDIDATE })}\n\n`)
    if (mode === 'slow') return
    response.write(`data: ${JSON.stringify({ type: 'usage', usage: { prompt_tokens: 9, completion_tokens: 6 } })}\n\n`)
    response.write(`data: ${JSON.stringify({ type: 'completed', finish_reason: 'stop' })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    abortedResponses,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

function inputOf(chunks: readonly DocumentChunkRecord[]) {
  return {
    jobId: JOB_ID,
    parseId: PARSE_ID,
    parserVersion: PARSER_VERSION,
    pipelineVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
    chunks,
    truncatedChunkIds: [],
  }
}

async function jobBudget(ctx: ToolContext) {
  const harness = createBudgetHarness()
  await harness.budget.openLedger({ ledgerId: JOB_ID, kind: 'background' }, ctx)
  return harness
}

function jobContext(): ToolContext {
  const now = new Date()
  const deadline = new Date(now.getTime() + 5 * 60_000)
  const runId = randomUUID()
  return createToolContext({
    principal: {
      tenantId: SCOPE_A.tenantId,
      subjectId: 'adapter-owned-extraction-test',
      roles: ['data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '1.0.0',
    deadline: deadline.toISOString(),
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: now.toISOString(),
      expiresAt: deadline.toISOString(),
    },
    allowedResources: {
      tenantId: SCOPE_A.tenantId,
      spaceId: SCOPE_A.spaceId,
      resourceKinds: ['artifact', 'document', 'chunk', 'evidence', 'dataset', 'job'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-adapter-owned-extraction',
  })
}

function modelEnv(baseUrl: string, vendorModel = COMPANY_VENDOR_MODEL) {
  return {
    CORE_ENABLE_MODELS: 'true',
    CORE_ENABLE_JEV: 'false',
    CORE_COMPANY_MODEL_BASE_URL: baseUrl,
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_TEST_COMPANY_SECRET',
    CORE_COMPANY_MODEL_PLATFORM_ID: COMPANY_PLATFORM_MODEL,
    CORE_COMPANY_MODEL_VENDOR_MODEL: vendorModel,
    CORE_COMPANY_MODEL_PROTOCOL: 'private',
  }
}

function pipelineFor(args: {
  readonly baseUrl: string
  readonly budget: ReturnType<typeof createBudgetHarness>['budget']
  readonly generationEvidence: ModelCallEvidenceRecorder
  readonly observed?: (execution: { readonly jobId: Uuid; readonly ledgerId: Uuid; readonly ctxRunId: Uuid; readonly signal: AbortSignal }) => void
  readonly vendorModel?: string
}): ExtractionPipeline {
  const factory = createCoreModelCapabilityFactory({
    env: modelEnv(args.baseUrl, args.vendorModel),
    secrets: staticSecretResolver(),
    budget: args.budget,
    generationEvidence: args.generationEvidence,
    schemaValidator: acceptingValidator(),
  })
  return new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
    accountingOwner: 'adapter',
    generationForRun: (execution) => {
      args.observed?.({
        jobId: execution.jobId,
        ledgerId: execution.ledgerId,
        ctxRunId: execution.run.ctx.runId,
        signal: execution.signal,
      })
      return factory.forExecution({ ledgerId: execution.ledgerId, signal: execution.signal }).generation
    },
    candidates: new InMemoryCandidateStore(),
    budget: args.budget,
    modelRef: { modelId: COMPANY_PLATFORM_MODEL, version: '1.0.0' },
    outputLimit: { maxTokens: 512 },
  })
}

async function reservationsOf(budget: ReturnType<typeof createBudgetHarness>, ctx: ToolContext) {
  return budget.store.listReservations(SCOPE_A, JOB_ID, ctx)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('ExtractionPipeline adapter-owned attempt accounting', () => {
  it('uses the job ledger and charges one actual local HTTP attempt, not a pipeline-level duplicate', async () => {
    const server = await startCompanyServer('success')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    let observed: { readonly jobId: Uuid; readonly ledgerId: Uuid; readonly ctxRunId: Uuid; readonly signal: AbortSignal } | undefined
    const pipeline = pipelineFor({
      baseUrl: server.baseUrl,
      budget: budget.budget,
      generationEvidence: evidence.recorder,
      observed: (execution) => { observed = execution },
    })

    const result = await pipeline.extract(inputOf([chunkOf('unstructured extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: new AbortController().signal,
    })

    expect(result.modelCalls).toBe(1)
    expect(observed?.jobId).toBe(JOB_ID)
    expect(observed?.ledgerId).toBe(JOB_ID)
    expect(observed?.ctxRunId).toBe(ctx.runId)
    expect(observed?.ctxRunId).not.toBe(observed?.ledgerId)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/generate',
      body: { model: COMPANY_VENDOR_MODEL },
    })
    expect(evidence.requests).toHaveLength(1)
    const reservations = await reservationsOf(budget, ctx)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
    expect(reservations[0]?.actual?.modelTokens).toBe(15)
  })

  it('injects the fixed schema context (types, attributes, units, relations, rule grammar) into the actual request', async () => {
    const server = await startCompanyServer('success')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    const pipeline = pipelineFor({ baseUrl: server.baseUrl, budget: budget.budget, generationEvidence: evidence.recorder })

    await pipeline.extract(inputOf([chunkOf('unstructured extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: new AbortController().signal,
    })

    expect(server.requests).toHaveLength(1)
    const messages = server.requests[0]?.body['messages']
    expect(Array.isArray(messages)).toBe(true)
    const system = (Array.isArray(messages) ? messages : []).find(
      (message) =>
        isRecord(message) &&
        message['role'] === 'system' &&
        typeof message['content'] === 'string' &&
        message['content'].includes('extraction-schema-context@1'),
    )
    const content = isRecord(system) && typeof system['content'] === 'string' ? system['content'] : ''
    expect(content.length).toBeGreaterThan(0)
    // The fixed property types, attributes, units, relations and rule grammar are all present
    // in the request the controlled service actually received.
    expect(content).toContain('schemaDigest=sha256:')
    expect(content).toContain('rated_power')
    expect(content).toContain('"valueType":"quantity"')
    expect(content).toContain('"unitCode":"kW"')
    expect(content).toContain('"enumValues":["charger","inverter"]')
    expect(content).toContain('meter_monitors_device')
    expect(content).toContain('"fromObjectId":"meter"')
    expect(content).toContain('"ruleGrammar"')
    expect(content).toContain('"comparisonOperators"')
    expect(content).toContain('"decimal"')
  })

  it('records the prompt version and schema digest on every candidate input version', async () => {
    const server = await startCompanyServer('success')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    const candidates = new InMemoryCandidateStore()
    const factory = createCoreModelCapabilityFactory({
      env: modelEnv(server.baseUrl),
      secrets: staticSecretResolver(),
      budget: budget.budget,
      generationEvidence: evidence.recorder,
      schemaValidator: acceptingValidator(),
    })
    const pipeline = new ExtractionPipeline({
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
      accountingOwner: 'adapter',
      generationForRun: ({ ledgerId, signal }) =>
        factory.forExecution({ ledgerId, signal }).generation,
      candidates,
      budget: budget.budget,
      modelRef: { modelId: COMPANY_PLATFORM_MODEL, version: '1.0.0' },
      outputLimit: { maxTokens: 512 },
    })

    await pipeline.extract(inputOf([chunkOf('unstructured extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: new AbortController().signal,
    })

    const stored = await candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, ctx)
    expect(stored.length).toBeGreaterThan(0)
    for (const candidate of stored) {
      expect(candidate.inputVersion.promptVersion).toBe('extraction-schema-context@1')
      expect(candidate.inputVersion.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('creates one reservation per retry and never adds an aggregate pipeline settlement', async () => {
    const server = await startCompanyServer('retry-once')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    const pipeline = pipelineFor({ baseUrl: server.baseUrl, budget: budget.budget, generationEvidence: evidence.recorder })

    const result = await pipeline.extract(inputOf([chunkOf('retryable extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: new AbortController().signal,
    })

    expect(result.modelCalls).toBe(1)
    expect(server.requests).toHaveLength(2)
    const reservations = await reservationsOf(budget, ctx)
    expect(reservations).toHaveLength(2)
    expect(reservations.map((reservation) => reservation.status)).toEqual(['failed', 'settled'])
    expect(reservations[1]?.actual?.modelTokens).toBe(15)
  })

  it('retains usage_unknown for every possibly billed provider attempt without a second settlement', async () => {
    const server = await startCompanyServer('drop')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    const pipeline = pipelineFor({ baseUrl: server.baseUrl, budget: budget.budget, generationEvidence: evidence.recorder })

    await expect(pipeline.extract(inputOf([chunkOf('possibly billed extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ExtractionError)

    expect(server.requests).toHaveLength(3)
    const reservations = await reservationsOf(budget, ctx)
    expect(reservations).toHaveLength(3)
    expect(reservations.every((reservation) => reservation.status === 'usage_unknown')).toBe(true)
  })

  it('passes cancellation into the adapter and records the aborted attempt as usage_unknown', async () => {
    const server = await startCompanyServer('slow')
    servers.push(server)
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    const evidence = recordingEvidence()
    const controller = new AbortController()
    const pipeline = pipelineFor({ baseUrl: server.baseUrl, budget: budget.budget, generationEvidence: evidence.recorder })
    const extraction = pipeline.extract(inputOf([chunkOf('cancelled extraction text', 0)]), {
      ledgerId: JOB_ID,
      ctx,
      signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error)
    expect(await waitFor(() => server.requests.length > 0)).toBe(true)
    controller.abort()
    expect(await extraction).toBeInstanceOf(ExtractionError)

    expect(await waitFor(() => server.abortedResponses.length > 0)).toBe(true)
    const reservations = await reservationsOf(budget, ctx)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('keeps native extraction available without a model and fails prose before any reservation', async () => {
    const ctx = jobContext()
    const budget = await jobBudget(ctx)
    let bindingCalls = 0
    const candidates = new InMemoryCandidateStore()
    const pipeline = new ExtractionPipeline({
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
      accountingOwner: 'adapter',
      generationForRun: () => { bindingCalls += 1; return undefined },
      candidates,
      budget: budget.budget,
      modelRef: { modelId: COMPANY_PLATFORM_MODEL, version: '1.0.0' },
      outputLimit: { maxTokens: 512 },
    })
    const run = { ledgerId: JOB_ID, ctx, signal: new AbortController().signal }

    const native = await pipeline.extract(inputOf([chunkOf(JSON.stringify({
      device_native_id: 'D-NATIVE',
      device_kind: 'charger',
    }), 0)]), run)
    expect(native.modelCalls).toBe(0)
    expect(native.candidateIds).toHaveLength(1)
    expect(bindingCalls).toBe(0)

    await expect(pipeline.extract(inputOf([chunkOf('unstructured text without a configured model', 1)]), run))
      .rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(bindingCalls).toBe(1)
    expect(await reservationsOf(budget, ctx)).toHaveLength(0)
  })

  it('surfaces missing model configuration as non-retryable capability failure on the real job stage', async () => {
    const store = new InMemoryJobStore()
    const jobService = new JobService({ store })
    const ctx = jobContext()
    const budget = createBudgetHarness()
    const candidates = new InMemoryCandidateStore()
    const pipeline = new ExtractionPipeline({
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
      accountingOwner: 'adapter',
      generationForRun: () => undefined,
      candidates,
      budget: budget.budget,
      modelRef: { modelId: COMPANY_PLATFORM_MODEL, version: '1.0.0' },
      outputLimit: { maxTokens: 512 },
    })
    await jobService.createJob({
      jobId: JOB_ID,
      kind: 'ingestion',
      sourceRef: 'synthetic-source',
      documentRef: encodeExtractionJobRef({ parseId: PARSE_ID, parserVersion: PARSER_VERSION, definitionRef: DEFINITION_REF }),
      pipelineVersion: '1.0.0',
      idempotencyKey: 'adapter-owned-model-disabled-job',
    }, ctx)
    const received: JobStageHandler = {
      stage: 'received',
      run: async (context) => ({ nextStage: 'parsed', counts: context.job.counts }),
    }
    const parseStore = new StaticDocumentParseStore([chunkOf('prose requires a model', 0)])
    const worker = new JobWorker({
      store,
      handlers: createExtractionHandlerRegistry([
        received,
        new ExtractionStageHandler({ pipeline, parseStore }),
        new CandidateValidationStageHandler({ pipeline, parseStore }),
        new ReviewHandoffStageHandler(),
      ]),
      budget: budget.budget,
      workerId: 'model-disabled-test-worker',
    })

    const result = await worker.runOnce(SCOPE_A, ctx)
    const job = await jobService.getJob(JOB_ID, ctx)

    expect(result.disposition).toBe('failed')
    expect(job.lastError).toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED', retryable: false })
    expect(await budget.store.listReservations(SCOPE_A, JOB_ID, ctx)).toHaveLength(0)
  })
})
