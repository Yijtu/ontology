import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '@ontology/contracts'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import {
  CoreModelConfigurationError,
  createCoreModelCapabilityFactory,
} from '../../apps/api/src/composition/core-model-capabilities'
import {
  TEST_SECRET as COMPANY_TEST_SECRET,
  acceptingValidator,
  budgetHarness as companyBudgetHarness,
  collect,
  generationRequest,
  recordingEvidence as companyEvidence,
  reservationsOf as companyReservations,
  staticSecretResolver,
} from './model-company-fixtures'
import { RecordingControlRepository } from './component-registry-fixtures'
import {
  TEST_SECRET as JEV_TEST_SECRET,
  actualDecisionState,
  actualStateResolver,
  budgetHarness as jevBudgetHarness,
  choiceQuestion,
  decisionRequest,
  recordingEvidence as jevEvidence,
  reservationsOf as jevReservations,
  staticSecretResolver as jevSecretResolver,
  startJevServer,
  type JevServer,
} from './model-jev-fixtures'

interface RecordedLocalRequest {
  readonly method: string
  readonly path: string | undefined
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
}

interface LocalCompanyServer {
  readonly baseUrl: string
  readonly requests: RecordedLocalRequest[]
  readonly abortedResponses: number[]
  close(): Promise<void>
}

const servers: { close(): Promise<void> }[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function openAiChunk(
  choices: readonly Record<string, unknown>[],
  usage: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return { id: 'chatcmpl-core-test', object: 'chat.completion.chunk', created: 1, model: 'provider', choices, usage }
}

async function startCompanyServer(mode: 'success' | 'slow' = 'success'): Promise<LocalCompanyServer> {
  const requests: RecordedLocalRequest[] = []
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
  if (typeof address !== 'object' || address === null) throw new Error('the local model server did not bind a TCP port')

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await requestBody(request)
    requests.push({
      method: request.method ?? '',
      path: request.url,
      authorization: request.headers.authorization,
      body,
    })
    response.on('close', () => {
      if (!response.writableEnded) abortedResponses.push(1)
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const candidate = JSON.stringify({
      entities: [{ objectId: 'device', attributes: [{ attributeId: 'device_native_id', value: 'D-1' }, { attributeId: 'device_kind', value: 'charger' }] }],
      relations: [],
    })
    response.write(`data: ${JSON.stringify(openAiChunk([{ index: 0, delta: { content: candidate }, finish_reason: null }]))}\n\n`)
    if (mode === 'slow') return
    response.write(`data: ${JSON.stringify(openAiChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]))}\n\n`)
    response.write(`data: ${JSON.stringify(openAiChunk([], { prompt_tokens: 9, completion_tokens: 6 }))}\n\n`)
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

function companyEnvironment(baseUrl: string, mode: 'openai-compatible' | 'private' = 'openai-compatible') {
  return {
    CORE_ENABLE_MODELS: 'true',
    CORE_ENABLE_JEV: 'false',
    CORE_COMPANY_MODEL_BASE_URL: baseUrl,
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_TEST_COMPANY_SECRET',
    CORE_COMPANY_MODEL_PLATFORM_ID: 'company-llm',
    CORE_COMPANY_MODEL_VENDOR_MODEL: 'openai_normal',
    CORE_COMPANY_MODEL_PROTOCOL: mode,
  }
}

function decisionEnvironment(baseUrl: string) {
  return {
    CORE_ENABLE_MODELS: 'false',
    CORE_ENABLE_JEV: 'true',
    CORE_JEV_BASE_URL: baseUrl,
    CORE_JEV_SECRET_REF: 'env:CORE_TEST_JEV_SECRET',
    CORE_JEV_PLATFORM_MODEL_ID: 'jev-decision',
    CORE_JEV_VENDOR_MODEL: 'choice',
    CORE_JEV_FALLBACK_POLICY: 'reject',
  }
}

function contextOf(signal: AbortSignal) {
  return { ledgerId: '99999999-9999-4999-8999-999999999999', signal }
}

function modelDependencies(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<Parameters<typeof createCoreModelCapabilityFactory>[0]> = {},
) {
  const generation = companyEvidence()
  const decision = jevEvidence()
  return {
    env,
    secrets: staticSecretResolver(),
    budget: new BudgetService({ store: new InMemoryBudgetLedgerStore(), control: new RecordingControlRepository() }),
    generationEvidence: generation.recorder,
    decisionEvidence: decision.recorder,
    decisionStateResolver: actualStateResolver(),
    schemaValidator: acceptingValidator(),
    ...overrides,
  }
}

async function collectGeneration(port: NonNullable<ReturnType<ReturnType<typeof createCoreModelCapabilityFactory>['forExecution']>['generation']>, ctx: ToolContext) {
  return collect(port.generate(generationRequest({
    role: 'extractor',
    toolSchemas: [],
    modelRef: { modelId: 'company-llm', version: '1.0.0' },
    responseSchemaRef: { id: 'extractor.response', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
  }), ctx))
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('Core model capability factory', () => {
  it('keeps both capabilities disabled without resolving secrets or making a request', () => {
    let resolutions = 0
    const dependencies = modelDependencies({}, {
      secrets: { resolve: async () => { resolutions += 1; throw new Error('secret access is disabled') } },
    })
    const factory = createCoreModelCapabilityFactory(dependencies)
    const capabilities = factory.forExecution(contextOf(new AbortController().signal))

    expect(factory.generationEnabled).toBe(false)
    expect(factory.decisionEnabled).toBe(false)
    expect(capabilities).toEqual({})
    expect(resolutions).toBe(0)
  })

  it('classifies incomplete enabled configuration without resolving credentials', () => {
    let resolutions = 0
    const dependencies = modelDependencies({ CORE_ENABLE_MODELS: 'true' }, {
      secrets: { resolve: async () => { resolutions += 1; throw new Error('must not resolve at factory creation') } },
    })

    let thrown: unknown
    try {
      createCoreModelCapabilityFactory(dependencies)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CoreModelConfigurationError)
    expect(thrown).toMatchObject({ code: 'MISSING_SETTING', setting: 'CORE_COMPANY_MODEL_PLATFORM_ID' })
    expect(resolutions).toBe(0)
  })

  it('maps company platform model id to the vendor id and settles one actual local HTTP attempt', async () => {
    const server = await startCompanyServer()
    servers.push(server)
    const harness = await companyBudgetHarness({ maxModelTokens: 1_000 })
    const evidence = companyEvidence()
    const factory = createCoreModelCapabilityFactory({
      ...modelDependencies(companyEnvironment(server.baseUrl)),
      budget: harness.budget,
      generationEvidence: evidence.recorder,
    })
    const generation = factory.forExecution({ ledgerId: harness.ledgerId, signal: new AbortController().signal }).generation
    if (generation === undefined) throw new Error('enabled company generation port is missing')

    const events = await collectGeneration(generation, harness.ctx)
    const usage = events.find((event) => event.type === 'usage')

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/generate',
      authorization: `Bearer ${COMPANY_TEST_SECRET}`,
      body: { model: 'openai_normal', stream: true },
    })
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } })
    expect(evidence.requests).toHaveLength(1)
    const reservations = await companyReservations(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
    expect(reservations[0]?.actual?.modelTokens).toBe(15)
  })

  it('binds each company adapter to its execution signal and holds a cancelled attempt as usage_unknown', async () => {
    const server = await startCompanyServer('slow')
    servers.push(server)
    const harness = await companyBudgetHarness({ maxModelTokens: 1_000 })
    const controller = new AbortController()
    const factory = createCoreModelCapabilityFactory({
      ...modelDependencies(companyEnvironment(server.baseUrl)),
      budget: harness.budget,
    })
    const generation = factory.forExecution({ ledgerId: harness.ledgerId, signal: controller.signal }).generation
    if (generation === undefined) throw new Error('enabled company generation port is missing')

    const events = []
    for await (const event of generation.generate(generationRequest({
      role: 'extractor',
      toolSchemas: [],
      modelRef: { modelId: 'company-llm', version: '1.0.0' },
    }), harness.ctx)) {
      events.push(event)
      if (event.type === 'text_delta') controller.abort()
    }

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(server.requests).toHaveLength(1)
    expect(await waitFor(() => server.abortedResponses.length > 0)).toBe(true)
    const reservations = await companyReservations(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('keeps JEV independently optional and sends authorized actual state on the official System One wire', async () => {
    const server: JevServer = await startJevServer()
    servers.push(server)
    const harness = await jevBudgetHarness({ maxModelTokens: 1_000 })
    const evidence = jevEvidence()
    const factory = createCoreModelCapabilityFactory({
      ...modelDependencies(decisionEnvironment(server.baseUrl)),
      budget: harness.budget,
      secrets: jevSecretResolver(),
      decisionEvidence: evidence.recorder,
      decisionStateResolver: actualStateResolver(),
    })
    const capabilities = factory.forExecution({ ledgerId: harness.ledgerId, signal: new AbortController().signal })
    if (capabilities.decision === undefined) throw new Error('enabled JEV decision port is missing')
    const result = await capabilities.decision.decide(
      decisionRequest([choiceQuestion()]),
      harness.ctx,
    )

    expect(capabilities.generation).toBeUndefined()
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/systemone',
      authorization: `Bearer ${JEV_TEST_SECRET}`,
      body: { model: 'choice', state: actualDecisionState() },
    })
    expect(server.requests[0]?.body['state']).not.toMatchObject({ id: expect.any(String), digest: expect.any(String) })
    expect(result.selectedOptionId).toBe('self_consumption')
    expect(evidence.requests).toHaveLength(1)
    const reservations = await jevReservations(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}
