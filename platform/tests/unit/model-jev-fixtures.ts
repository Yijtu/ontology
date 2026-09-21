import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { BudgetService, InMemoryBudgetLedgerStore, sha256DigestOf } from '@ontology/core'
import { createToolContext, SecretValue } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  BudgetLedgerSnapshot,
  BudgetReservationRecord,
  ChoiceQuestion,
  DecisionQuestion,
  DecisionRequest,
  ModelRef,
  NoulQuestion,
  ResourceRef,
  ScoreQuestion,
  SecretResolver,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { JevDecisionAdapter } from '@ontology/adapter-model-jev'
import type {
  DecisionEvidenceRecorder,
  DecisionEvidenceRequest,
  GenerativeClassificationFallback,
  GenerativeClassificationOutput,
  JevAdapterConfig,
  JevAdapterLogRecord,
  JevAdapterLogger,
  JevFallbackPolicy,
} from '@ontology/adapter-model-jev'
import { RecordingControlRepository, DIGEST_A, RESERVATION_ID, RUN_A, SPACE_A, TENANT_A } from './component-registry-fixtures'

/**
 * Controlled JEV API used by every decision-adapter test. No real or paid model is ever
 * contacted: each fixture is a deterministic in-process HTTP response selected by the
 * vendor model id the adapter sends.
 */

export const TEST_SECRET = 'sk-test-jev-abc123'
export const PLATFORM_MODEL_ID = 'jev-decision'
export const SECRET_REF = 'sources/jev/credential'
export const OPTION_SET_HASH = `sha256:${'a'.repeat(64)}`
export const OTHER_OPTION_SET_HASH = `sha256:${'b'.repeat(64)}`
export const RUBRIC_DIGEST = `sha256:${'c'.repeat(64)}`

export const CHOICE_QUESTION_ID = '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
export const SCORE_QUESTION_ID = '1f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
export const NOUL_QUESTION_ID = '2f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

export interface RecordedJevRequest {
  readonly vendorModel: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
}

export interface JevServer {
  readonly baseUrl: string
  readonly requests: RecordedJevRequest[]
  readonly abortedResponses: number[]
  close(): Promise<void>
}

interface WireQuestion {
  readonly question_id: string
  readonly type: string
  readonly definition_version: string
  readonly option_set_hash?: string
  readonly options?: readonly { readonly option_id: string; readonly label: string }[]
  readonly scale?: { readonly min: number; readonly max: number }
}

export async function startJevServer(): Promise<JevServer> {
  const requests: RecordedJevRequest[] = []
  const abortedResponses: number[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request)
    const vendorModel = String(body['model'] ?? '')
    requests.push({ vendorModel, authorization: request.headers.authorization, body })
    response.on('close', () => {
      if (!response.writableEnded) abortedResponses.push(1)
    })
    respond(vendorModel, body, response, requests)
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    abortedResponses,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          resolve()
        })
      }),
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) })
  response.end(JSON.stringify(body))
}

function asQuestions(body: Record<string, unknown>): WireQuestion[] {
  const raw = body['questions']
  if (!Array.isArray(raw)) return []
  const out: WireQuestion[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const questionId = record['question_id']
    const type = record['type']
    const definitionVersion = record['definition_version']
    if (typeof questionId !== 'string' || typeof type !== 'string' || typeof definitionVersion !== 'string') {
      continue
    }
    const optionsRaw = record['options']
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.flatMap((option) => {
          if (typeof option !== 'object' || option === null) return []
          const optionRecord = option as Record<string, unknown>
          const id = optionRecord['option_id']
          const label = optionRecord['label']
          return typeof id === 'string' && typeof label === 'string' ? [{ option_id: id, label }] : []
        })
      : undefined
    const optionSetHash = record['option_set_hash']
    const scaleRaw = record['scale']
    const scale =
      typeof scaleRaw === 'object' && scaleRaw !== null
        ? (scaleRaw as Record<string, unknown>)
        : undefined
    const min = scale?.['min']
    const max = scale?.['max']
    out.push({
      question_id: questionId,
      type,
      definition_version: definitionVersion,
      ...(typeof optionSetHash === 'string' ? { option_set_hash: optionSetHash } : {}),
      ...(options === undefined ? {} : { options }),
      ...(typeof min === 'number' && typeof max === 'number' ? { scale: { min, max } } : {}),
    })
  }
  return out
}

interface WireDistribution {
  readonly option_set_hash: string
  readonly entries: readonly { readonly option_id: string; readonly probability: number }[]
}

interface WireResult {
  readonly question_id: string
  readonly question_type: string
  readonly definition_version: string
  readonly option_set_hash: string
  readonly selected_option_id?: string
  readonly distribution?: WireDistribution
  readonly scores?: readonly { readonly option_id: string; readonly score: number; readonly confidence?: number }[]
  readonly confidence?: number
}

function distributionFor(question: WireQuestion): WireDistribution {
  const options = question.options ?? []
  const optionSetHash = question.option_set_hash ?? OPTION_SET_HASH
  const rest = Math.max(1, options.length - 1)
  return {
    option_set_hash: optionSetHash,
    entries: options.map((option, index) => ({
      option_id: option.option_id,
      probability: index === 0 ? 0.7 : 0.3 / rest,
    })),
  }
}

function choiceResult(question: WireQuestion): WireResult {
  const first = question.options?.[0]
  return {
    question_id: question.question_id,
    question_type: 'choice',
    definition_version: question.definition_version,
    option_set_hash: question.option_set_hash ?? OPTION_SET_HASH,
    ...(first === undefined ? {} : { selected_option_id: first.option_id }),
    distribution: distributionFor(question),
    confidence: 0.7,
  }
}

function scoreResult(question: WireQuestion): WireResult {
  const min = question.scale?.min ?? 0
  const max = question.scale?.max ?? 1
  const span = max - min
  return {
    question_id: question.question_id,
    question_type: 'score',
    definition_version: question.definition_version,
    option_set_hash: question.option_set_hash ?? OPTION_SET_HASH,
    scores: (question.options ?? []).map((option, index) => ({
      option_id: option.option_id,
      score: min + span * (index === 0 ? 1 : 0.5),
      confidence: 0.8,
    })),
    confidence: 0.8,
  }
}

function noulResult(question: WireQuestion): WireResult {
  return {
    question_id: question.question_id,
    question_type: 'noul',
    definition_version: question.definition_version,
    option_set_hash: OPTION_SET_HASH,
    confidence: 0.9,
  }
}

function normalResult(question: WireQuestion): WireResult {
  switch (question.type) {
    case 'choice':
      return choiceResult(question)
    case 'score':
      return scoreResult(question)
    default:
      return noulResult(question)
  }
}

function okResponse(results: readonly WireResult[], usage?: Record<string, number>): Record<string, unknown> {
  return {
    model_version: 'jev-2026-09',
    results,
    usage: usage ?? { input_tokens: 20, output_tokens: 5 },
  }
}

function respond(
  fixture: string,
  body: Record<string, unknown>,
  response: ServerResponse,
  requests: readonly RecordedJevRequest[],
): void {
  const questions = asQuestions(body)
  const first = questions[0]
  const all = questions.map(normalResult)

  switch (fixture) {
    case 'choice':
    case 'score':
    case 'noul':
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, okResponse([normalResult(first)]))
    case 'mixed':
      return json(response, 200, okResponse(all))
    case 'out_of_range': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = choiceResult(first)
      return json(
        response,
        200,
        okResponse([
          {
            ...result,
            distribution: {
              option_set_hash: result.option_set_hash,
              entries: (result.distribution?.entries ?? []).map((entry, index) => ({
                option_id: entry.option_id,
                probability: index === 0 ? 1.5 : entry.probability,
              })),
            },
          },
        ]),
      )
    }
    case 'non_normalised': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = choiceResult(first)
      return json(
        response,
        200,
        okResponse([
          {
            ...result,
            distribution: {
              option_set_hash: result.option_set_hash,
              entries: (result.distribution?.entries ?? []).map((entry, index) => ({
                option_id: entry.option_id,
                probability: index === 0 ? 0.5 : 0.1,
              })),
            },
          },
        ]),
      )
    }
    case 'missing_option': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = choiceResult(first)
      const entries = (result.distribution?.entries ?? []).slice(0, 1)
      return json(
        response,
        200,
        okResponse([
          {
            ...result,
            distribution: { option_set_hash: result.option_set_hash, entries },
          },
        ]),
      )
    }
    case 'mismatched_option': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = choiceResult(first)
      const entries = [
        ...(result.distribution?.entries ?? []).slice(1),
        { option_id: 'not-in-the-question', probability: 0.7 },
      ]
      return json(
        response,
        200,
        okResponse([
          {
            ...result,
            distribution: { option_set_hash: result.option_set_hash, entries },
          },
        ]),
      )
    }
    case 'unknown_question_type': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, okResponse([{ ...normalResult(first), question_type: 'ranking' }]))
    }
    case 'wrong_definition_version': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(
        response,
        200,
        okResponse([{ ...normalResult(first), definition_version: '9.9.9' }]),
      )
    }
    case 'score_out_of_scale': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = scoreResult(first)
      const scores = (result.scores ?? []).map((score) => ({ ...score, score: (first.scale?.max ?? 1) + 5 }))
      return json(response, 200, okResponse([{ ...result, scores }]))
    }
    case 'noul_with_options': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      const result = noulResult(first)
      return json(
        response,
        200,
        okResponse([
          {
            ...result,
            distribution: { option_set_hash: OPTION_SET_HASH, entries: [{ option_id: 'x', probability: 1 }] },
          },
        ]),
      )
    }
    case 'missing_question':
      return json(response, 200, okResponse([]))
    case 'extra_question': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(
        response,
        200,
        okResponse([
          normalResult(first),
          {
            question_id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
            question_type: 'noul',
            definition_version: '1.0.0',
            option_set_hash: OPTION_SET_HASH,
            confidence: 0.5,
          },
        ]),
      )
    }
    case 'low_confidence': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, okResponse([{ ...normalResult(first), confidence: 0.2 }]))
    }
    case 'partial_usage': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, okResponse([normalResult(first)], { input_tokens: 11 }))
    }
    case 'no_usage': {
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, { model_version: 'jev-2026-09', results: [normalResult(first)] })
    }
    case 'malformed_json':
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"model_version": "jev-2026-09", "results": [')
      return
    case 'not_json':
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('def choose(): pass')
      return
    case 'leak_error':
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `invalid credential ${TEST_SECRET}` }))
      return
    case 'http_429':
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
      response.end(JSON.stringify({ error: 'rate limited' }))
      return
    case 'http_503':
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'JEV overloaded' }))
      return
    case 'http_504':
      response.writeHead(504, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'gateway timeout' }))
      return
    case 'http_500':
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'internal provider error' }))
      return
    case 'http_403':
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'forbidden' }))
      return
    case 'flaky_503': {
      const attempts = requests.filter((request) => request.vendorModel === 'flaky_503').length
      if (attempts <= 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'JEV overloaded' }))
        return
      }
      if (first === undefined) return json(response, 400, { error: 'no question' })
      return json(response, 200, okResponse([normalResult(first)]))
    }
    case 'drop':
      response.socket?.destroy()
      return
    case 'slow_no_output':
      response.writeHead(200, { 'content-type': 'application/json' })
      return
    default:
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `unknown fixture ${fixture}` }))
  }
}

/** Server-side resolver double. Returns a real `SecretValue`, so redaction is exercised. */
export function staticSecretResolver(value: string = TEST_SECRET): SecretResolver {
  return {
    resolve: (): Promise<SecretValue> => Promise.resolve(new SecretValue(value)),
  }
}

export interface EvidenceLog {
  readonly requests: DecisionEvidenceRequest[]
  readonly recorder: DecisionEvidenceRecorder
}

export function recordingEvidence(): EvidenceLog {
  const requests: DecisionEvidenceRequest[] = []
  return {
    requests,
    recorder: {
      record: (request: DecisionEvidenceRequest): Promise<ResourceRef> => {
        requests.push(request)
        return Promise.resolve({
          id: randomUUID(),
          version: '1.0.0',
          digest: sha256DigestOf(JSON.stringify(request)),
          kind: 'evidence',
        })
      },
    },
  }
}

export interface CapturedLog {
  readonly records: JevAdapterLogRecord[]
  readonly log: JevAdapterLogger
}

export function capturingLog(): CapturedLog {
  const records: JevAdapterLogRecord[] = []
  return { records, log: (record: JevAdapterLogRecord) => records.push(record) }
}

export function fixedClassifier(output: GenerativeClassificationOutput): GenerativeClassificationFallback {
  return { classify: (): Promise<GenerativeClassificationOutput> => Promise.resolve(output) }
}

export interface BudgetHarness {
  readonly budget: BudgetLedgerPort
  readonly store: InMemoryBudgetLedgerStore
  readonly ledgerId: Uuid
  readonly ctx: ToolContext
  readonly limits: { readonly maxModelTokens?: number; readonly maxToolCalls?: number }
}

export async function budgetHarness(options?: {
  readonly maxModelTokens?: number
  readonly maxToolCalls?: number
  readonly deadlineMs?: number
  readonly deadlineOffsetMs?: number
}): Promise<BudgetHarness> {
  const store = new InMemoryBudgetLedgerStore()
  const service = new BudgetService({ store, control: new RecordingControlRepository() })
  const ledgerId = randomUUID()
  const ctx = modelContext(new Date(Date.now() + (options?.deadlineOffsetMs ?? 60_000)).toISOString())
  const limits = {
    ...(options?.maxModelTokens === undefined ? {} : { maxModelTokens: options.maxModelTokens }),
    ...(options?.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
    ...(options?.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  }
  await service.openLedger({ ledgerId, kind: 'run', overrideLimits: limits }, ctx)
  return { budget: service, store, ledgerId, ctx, limits }
}

export async function reservationsOf(harness: BudgetHarness): Promise<BudgetReservationRecord[]> {
  return harness.store.listReservations(
    { tenantId: harness.ctx.principal.tenantId, spaceId: harness.ctx.allowedResources.spaceId },
    harness.ledgerId,
    harness.ctx,
  )
}

export function remainingOf(harness: BudgetHarness): Promise<BudgetLedgerSnapshot> {
  return harness.budget.remaining(harness.ledgerId, harness.ctx)
}

export function modelContext(deadline = new Date(Date.now() + 60_000).toISOString()): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT_A,
      subjectId: 'jev-test',
      roles: ['business-user'],
      scopes: [],
      authEpoch: 1,
    },
    runId: RUN_A,
    resolvedProfileHash: DIGEST_A,
    policyVersion: '1.0.0',
    deadline,
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId: RUN_A,
      grantedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: deadline,
    },
    allowedResources: {
      tenantId: TENANT_A,
      spaceId: SPACE_A,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-model-jev',
  })
}

export function stateRef(): ResourceRef {
  return { id: RUN_A, version: '1.0.0', digest: DIGEST_A, kind: 'run' }
}

export function choiceQuestion(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    questionId: CHOICE_QUESTION_ID,
    type: 'choice',
    prompt: 'Which strategy should be used?',
    options: [
      { optionId: 'self_consumption', label: 'Self consumption' },
      { optionId: 'reserve_first', label: 'Reserve first' },
    ],
    optionSetHash: OPTION_SET_HASH,
    definitionVersion: '1.0.0',
    ...overrides,
  }
}

export function scoreQuestion(overrides: Partial<ScoreQuestion> = {}): ScoreQuestion {
  return {
    questionId: SCORE_QUESTION_ID,
    type: 'score',
    prompt: 'Score each strategy on the rubric.',
    options: [
      { optionId: 'self_consumption', label: 'Self consumption' },
      { optionId: 'reserve_first', label: 'Reserve first' },
    ],
    rubricRef: { id: 'home-energy.strategy-rubric', version: '1.0.0', digest: RUBRIC_DIGEST },
    scale: { min: 0, max: 10 },
    optionSetHash: OPTION_SET_HASH,
    definitionVersion: '1.0.0',
    ...overrides,
  }
}

export function noulQuestion(overrides: Partial<NoulQuestion> = {}): NoulQuestion {
  return {
    questionId: NOUL_QUESTION_ID,
    type: 'noul',
    prompt: 'Is the backup requirement firm?',
    definitionVersion: '1.0.0',
    ...overrides,
  }
}

export function decisionRequest(questions: readonly DecisionQuestion[], overrides: { readonly modelRef?: ModelRef } = {}): DecisionRequest {
  return {
    stateRef: stateRef(),
    questions: [...questions],
    modelRef: overrides.modelRef ?? { modelId: PLATFORM_MODEL_ID, version: '1.0.0' },
  }
}

export interface AdapterOptions {
  readonly server: JevServer
  readonly fixture: string
  readonly harness: BudgetHarness
  readonly fallbackPolicy?: JevFallbackPolicy
  readonly minConfidence?: number
  readonly generativeClassification?: GenerativeClassificationFallback
  readonly evidence?: DecisionEvidenceRecorder
  readonly log?: JevAdapterLogger
  readonly maxAttempts?: number
  readonly requestTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly retryBaseDelayMs?: number
  readonly estimatedTokens?: number
  readonly endpoint?: string
}

export function makeAdapter(options: AdapterOptions): JevDecisionAdapter {
  const config: JevAdapterConfig = {
    baseUrl: options.server.baseUrl,
    secretRef: SECRET_REF,
    models: { [PLATFORM_MODEL_ID]: { vendorModel: options.fixture } },
    fallbackPolicy: options.fallbackPolicy ?? 'clarify',
    secrets: staticSecretResolver(),
    budget: options.harness.budget,
    ledgerId: options.harness.ledgerId,
    evidence: options.evidence ?? recordingEvidence().recorder,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 0,
    ...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
    ...(options.generativeClassification === undefined
      ? {}
      : { generativeClassification: options.generativeClassification }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.estimatedTokens === undefined ? {} : { estimatedTokens: options.estimatedTokens }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  }
  return new JevDecisionAdapter(config)
}

/** Poll a server-side fact that becomes true asynchronously (e.g. a closed socket). */
export async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
