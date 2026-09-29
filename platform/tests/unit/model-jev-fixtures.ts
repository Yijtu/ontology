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
  ResourceKind,
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
  JevActualState,
  JevActualStateResolver,
  JevAdapterLogRecord,
  JevAdapterLogger,
  JevFallbackPolicy,
} from '@ontology/adapter-model-jev'
import { jevActualStateDigest } from '@ontology/adapter-model-jev'
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

export function actualDecisionState(): JevActualState {
  return {
    question: 'Which strategy should be used?',
    candidates: [
      { id: 'self_consumption', label: 'Self consumption', route: 'use-local-generation' },
      { id: 'reserve_first', label: 'Reserve first', route: 'preserve-storage-reserve' },
    ],
    confirmedSemantics: { priority: 'site resilience', siteId: 'site-test-01' },
    evidence: [
      { ref: 'evidence-test-01', excerpt: 'Local generation should serve current site demand when available.' },
      { ref: 'evidence-test-02', excerpt: 'Keep enough stored energy for the configured backup period.' },
    ],
    rubric: { reference: 'home-energy.strategy-rubric@1.0.0', levels: '0 to 10, higher is better' },
  }
}

export function actualStateResolver(state: JevActualState = actualDecisionState()): JevActualStateResolver {
  return {
    resolve: (input, ctx) => {
      if (!ctx.allowedResources.resourceKinds.includes(input.stateRef.kind)) {
        return Promise.reject(new Error('state scope mismatch'))
      }
      return Promise.resolve({ state, resolvedRef: input.stateRef, complete: true })
    },
  }
}

export const CHOICE_QUESTION_ID = '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
export const SCORE_QUESTION_ID = '1f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
export const NOUL_QUESTION_ID = '2f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

export interface RecordedJevRequest {
  readonly vendorModel: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
  readonly method: string
  readonly path: string | undefined
}

export interface JevServer {
  readonly baseUrl: string
  readonly requests: RecordedJevRequest[]
  readonly abortedResponses: number[]
  close(): Promise<void>
}

interface WireQuestion {
  readonly id: string
  readonly type: string
  readonly instructions: unknown
  readonly criteria: unknown
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
    requests.push({
      vendorModel,
      authorization: request.headers.authorization,
      body,
      method: request.method ?? '',
      path: request.url,
    })
    response.on('close', () => {
      if (!response.writableEnded) abortedResponses.push(1)
    })
    if (request.method !== 'POST' || request.url !== '/v1/systemone') {
      return json(response, 404, { error: 'System One requires POST /v1/systemone' })
    }
    respond(vendorModel, body, response, requests)
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    abortedResponses,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
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
  if (!isRecord(raw)) return []
  return Object.entries(raw).flatMap(([id, value]) => {
    if (!isRecord(value) || typeof value['type'] !== 'string') return []
    return [{ id, type: value['type'], instructions: value['instructions'], criteria: value['criteria'] }]
  })
}

function normalAnswer(question: WireQuestion): Record<string, unknown> {
  switch (question.type) {
    case 'choice': {
      const criteria = isRecord(question.criteria) ? question.criteria : {}
      const options = Object.keys(criteria)
      const first = options[0]
      const remainder = options.slice(1)
      const probabilities: Record<string, number> = {}
      for (const [index, option] of options.entries()) {
        probabilities[option] = index === 0 ? 0.7 : 0.3 / Math.max(1, remainder.length)
      }
      return { type: 'choice', choice: first ?? '', probabilities, confidence: 0.7 }
    }
    case 'score': {
      const criteria = Array.isArray(question.criteria) ? question.criteria.filter((item): item is string => typeof item === 'string') : []
      const instructions = isRecord(question.instructions) ? question.instructions : {}
      const candidate = isRecord(instructions['candidate']) ? instructions['candidate'] : {}
      const optionId = candidate['id']
      const target = optionId === 'self_consumption' ? criteria.length - 1 : (criteria.length - 1) / 2
      const lower = Math.floor(target)
      const upper = Math.ceil(target)
      const probabilities = Object.fromEntries(criteria.map((_criterion, index) => [
        String(index), index === lower && index === upper ? 1 : index === lower ? upper - target : index === upper ? target - lower : 0,
      ]))
      const score = Object.entries(probabilities).reduce((total, [index, probability]) => total + Number(index) * Number(probability), 0)
      return {
        type: 'score',
        score,
        legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
        probabilities,
        confidence: 0.8,
      }
    }
    default:
      return { type: 'noul', noul: 0.9 }
  }
}

function okResponse(answers: Record<string, unknown>, usage?: Record<string, number>): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers,
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
  const allAnswers = Object.fromEntries(questions.map((question) => [question.id, normalAnswer(question)]))
  const firstAnswer = first === undefined ? undefined : normalAnswer(first)
  const sendAnswers = (answers: Record<string, unknown>, usage?: Record<string, number>): void => {
    json(response, 200, okResponse(answers, usage))
  }
  const error = (status: number, message: string, headers?: Record<string, string>): void => {
    json(response, status, { error: message }, headers)
  }

  switch (fixture) {
    case 'choice':
    case 'score':
    case 'noul':
    case 'mixed':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers(fixture === 'score' || fixture === 'mixed' ? allAnswers : { [first.id]: firstAnswer })
    case 'out_of_range': {
      if (first === undefined || firstAnswer === undefined || !isRecord(firstAnswer['probabilities'])) return error(422, 'no question')
      const probabilities = { ...firstAnswer['probabilities'] }
      const firstOption = Object.keys(probabilities)[0]
      if (firstOption !== undefined) probabilities[firstOption] = 1.5
      return sendAnswers({ [first.id]: { ...firstAnswer, probabilities } })
    }
    case 'non_normalised': {
      if (first === undefined || firstAnswer === undefined || !isRecord(firstAnswer['probabilities'])) return error(422, 'no question')
      const probabilities = Object.fromEntries(Object.keys(firstAnswer['probabilities']).map((key, index) => [key, index === 0 ? 0.5 : 0.1]))
      return sendAnswers({ [first.id]: { ...firstAnswer, probabilities } })
    }
    case 'missing_option': {
      if (first === undefined || firstAnswer === undefined || !isRecord(firstAnswer['probabilities'])) return error(422, 'no question')
      const probabilities = { ...firstAnswer['probabilities'] }
      delete probabilities[Object.keys(probabilities).at(-1) ?? '']
      return sendAnswers({ [first.id]: { ...firstAnswer, probabilities } })
    }
    case 'mismatched_option': {
      if (first === undefined || firstAnswer === undefined || !isRecord(firstAnswer['probabilities'])) return error(422, 'no question')
      const probabilities = { ...firstAnswer['probabilities'] }
      delete probabilities[Object.keys(probabilities)[0] ?? '']
      probabilities['not-in-the-question'] = 0.7
      return sendAnswers({ [first.id]: { ...firstAnswer, probabilities } })
    }
    case 'unknown_choice':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, choice: 'not-in-the-question' } })
    case 'unknown_question_type':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, type: 'ranking' } })
    case 'wrong_definition_version':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, definition_version: '9.9.9' } })
    case 'score_out_of_scale':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, score: 99 } })
    case 'score_mean_mismatch':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, score: 0.2 } })
    case 'noul_with_options':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, confidence: 0.9 } })
    case 'missing_question':
      return sendAnswers({})
    case 'extra_question':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: firstAnswer, unasked: { type: 'noul', noul: 0.5 } })
    case 'low_confidence':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: { ...firstAnswer, confidence: 0.2 } })
    case 'partial_usage':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return sendAnswers({ [first.id]: firstAnswer }, { input_tokens: 11 })
    case 'no_usage':
      if (first === undefined || firstAnswer === undefined) return error(422, 'no question')
      return json(response, 200, { model: 'jev-1.13.0', answers: { [first.id]: firstAnswer } })
    case 'malformed_json':
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"model":"jev-1.13.0","answers":{')
      return
    case 'not_json':
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('def choose(): pass')
      return
    case 'leak_error':
      return error(401, `invalid credential ${TEST_SECRET}`)
    case 'http_401':
      return error(401, 'invalid API key')
    case 'http_422':
      return error(422, 'request validation failed')
    case 'http_429':
      return error(429, 'rate limited', { 'retry-after': '2' })
    case 'http_529':
      return error(529, 'provider overloaded', { 'retry-after': '0' })
    case 'http_503':
      return error(503, 'JEV unavailable')
    case 'http_504':
      return error(504, 'gateway timeout')
    case 'http_500':
      return error(500, 'internal provider error')
    case 'http_403':
      return error(403, 'forbidden')
    case 'flaky_503':
    case 'flaky_529': {
      const status = fixture === 'flaky_529' ? 529 : 503
      const attempts = requests.filter((request) => request.vendorModel === fixture).length
      if (attempts <= 1) return error(status, 'JEV temporarily unavailable')
      return sendAnswers(allAnswers)
    }
    case 'drop':
      response.socket?.destroy()
      return
    case 'slow_no_output':
      response.writeHead(200, { 'content-type': 'application/json' })
      return
    default:
      return error(500, `unknown fixture ${fixture}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export function modelContext(
  deadline = new Date(Date.now() + 60_000).toISOString(),
  resourceKinds: readonly ResourceKind[] = ['run'],
): ToolContext {
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
      resourceKinds: [...resourceKinds],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-model-jev',
  })
}

export function stateRef(): ResourceRef {
  return { id: RUN_A, version: '1.0.0', digest: jevActualStateDigest(actualDecisionState()), kind: 'run' }
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
  readonly stateResolver?: JevActualStateResolver
  readonly noStateResolver?: boolean
  readonly maxStateBytes?: number
  readonly maxStateRecords?: number
}

export function makeAdapter(options: AdapterOptions): JevDecisionAdapter {
  const config: JevAdapterConfig = {
    baseUrl: options.server.baseUrl,
    secretRef: SECRET_REF,
    models: { [PLATFORM_MODEL_ID]: { vendorModel: options.fixture } },
    ...(options.noStateResolver === true
      ? {}
      : { stateResolver: options.stateResolver ?? actualStateResolver() }),
    ...(options.maxStateBytes === undefined ? {} : { maxStateBytes: options.maxStateBytes }),
    ...(options.maxStateRecords === undefined ? {} : { maxStateRecords: options.maxStateRecords }),
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
