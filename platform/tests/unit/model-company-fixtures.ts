import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { createToolContext, SecretValue } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  GenerationMessage,
  GenerationRequest,
  GenerationRole,
  ModelRef,
  ResourceRef,
  SecretResolver,
  ToolContext,
  ToolId,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type {
  CompanyGenerationAdapterConfig,
  ModelAdapterLogRecord,
  ModelAdapterLogger,
  ModelCallEvidenceRecorder,
  ModelCallEvidenceRequest,
  ResponseSchemaValidator,
} from '@ontology/adapter-model-company'
import { RecordingControlRepository, DIGEST_A, RESERVATION_ID, RUN_A, SPACE_A, TENANT_A } from './component-registry-fixtures'

/**
 * Controlled company API used by every generation-adapter test. No real or paid model
 * is ever contacted: each fixture is a deterministic in-process HTTP response selected
 * by the vendor model id the adapter sends.
 */

export const TEST_SECRET = 'sk-test-company-abc123'
export const PLATFORM_MODEL_ID = 'company-llm'
export const SECRET_REF = 'sources/company-model/credential'

export interface RecordedRequest {
  readonly vendorModel: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
}

export interface CompanyServer {
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  readonly abortedResponses: number[]
  close(): Promise<void>
}

export async function startCompanyServer(): Promise<CompanyServer> {
  const requests: RecordedRequest[] = []
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

  async function handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const body = await readJson(request)
    const vendorModel = String(body['model'] ?? '')
    requests.push({ vendorModel, authorization: request.headers.authorization, body })
    response.on('close', () => {
      if (!response.writableEnded) abortedResponses.push(1)
    })
    respond(vendorModel, response, abortedResponses)
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

async function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
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

function writeSse(
  response: import('node:http').ServerResponse,
  chunks: readonly Record<string, unknown>[],
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

function respond(
  fixture: string,
  response: import('node:http').ServerResponse,
  abortedResponses: number[],
): void {
  const text = (value: string): Record<string, unknown> => ({ type: 'text_delta', text: value })
  switch (fixture) {
    case 'normal':
      writeSse(response, [
        text('Hello '),
        text('world'),
        { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 7 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
      return
    case 'tool_calls':
      writeSse(response, [
        {
          type: 'tool_call_delta',
          call_id: '7f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
          tool: 'data_query',
          args_delta: '{"kind":"describe"}',
        },
        { type: 'completed', finish_reason: 'tool_calls' },
      ])
      return
    case 'unregistered_tool':
      writeSse(response, [
        {
          type: 'tool_call_delta',
          call_id: '7f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
          tool: 'execute_sql',
          args_delta: 'select 1',
        },
        { type: 'completed', finish_reason: 'tool_calls' },
      ])
      return
    case 'structured_ok':
      writeSse(response, [
        text('{"site":"'),
        text('site-demo-a","plan":"reserve_first"}'),
        { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 9 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
      return
    case 'malformed_json':
      writeSse(response, [
        text('{"site": "site-demo-a",'),
        text('"plan": }'),
        { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 9 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
      return
    case 'schema_mismatch':
      writeSse(response, [
        text('{"site":"site-demo-a"}'),
        { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 9 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
      return
    case 'partial_usage':
      writeSse(response, [
        text('partial usage'),
        { type: 'usage', usage: { prompt_tokens: 11 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
      return
    case 'no_usage':
      writeSse(response, [text('no usage reported'), { type: 'completed', finish_reason: 'stop' }])
      return
    case 'interrupted':
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(text('before the drop '))}\n\n`)
      response.write(`data: ${JSON.stringify(text('still here'))}\n\n`)
      // Drop after the client has had a chance to read the deltas, so this fixture
      // deterministically proves "output already streamed => no retry".
      setTimeout(() => {
        response.socket?.destroy()
        abortedResponses.push(1)
      }, 30)
      return
    case 'interrupted_before_output':
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.socket?.destroy()
      abortedResponses.push(1)
      return
    case 'slow':
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(text('slow first delta'))}\n\n`)
      // Never ends: the adapter must abort on timeout/cancel instead of hanging.
      return
    case 'slow_usage':
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 3 } })}\n\n`,
      )
      // Never ends: used to prove a measured cancel settles the real usage.
      return
    case 'slow_no_output':
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Never sends anything: used for the timeout path.
      return
    case 'leak_text':
      writeSse(response, [
        text(`the credential is ${TEST_SECRET} and must not leak`),
        { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 5 } },
        { type: 'completed', finish_reason: 'stop' },
      ])
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
      response.end(JSON.stringify({ error: 'model overloaded' }))
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
    case 'vendor_error':
      writeSse(response, [{ type: 'error', error_code: 'overloaded', error_message: 'provider busy' }])
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
  readonly requests: ModelCallEvidenceRequest[]
  readonly recorder: ModelCallEvidenceRecorder
}

export function recordingEvidence(): EvidenceLog {
  const requests: ModelCallEvidenceRequest[] = []
  return {
    requests,
    recorder: {
      record: (request: ModelCallEvidenceRequest): Promise<ResourceRef> => {
        requests.push(request)
        return Promise.resolve({
          id: randomUUID(),
          version: '1.0.0',
          digest: `sha256:${'e'.repeat(64)}`,
          kind: 'evidence',
        })
      },
    },
  }
}

export interface CapturedLog {
  readonly records: ModelAdapterLogRecord[]
  readonly log: ModelAdapterLogger
}

export function capturingLog(): CapturedLog {
  const records: ModelAdapterLogRecord[] = []
  return { records, log: (record: ModelAdapterLogRecord) => records.push(record) }
}

export function acceptingValidator(): ResponseSchemaValidator {
  return { validate: () => Promise.resolve({ valid: true }) }
}

export function rejectingValidator(errors: readonly string[]): ResponseSchemaValidator {
  return { validate: () => Promise.resolve({ valid: false, errors }) }
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
  const ctx = modelContext(
    new Date(Date.now() + (options?.deadlineOffsetMs ?? 60_000)).toISOString(),
  )
  const limits = {
    ...(options?.maxModelTokens === undefined ? {} : { maxModelTokens: options.maxModelTokens }),
    ...(options?.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
    ...(options?.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  }
  await service.openLedger({ ledgerId, kind: 'run', overrideLimits: limits }, ctx)
  return { budget: service, store, ledgerId, ctx, limits }
}

export async function reservationsOf(
  harness: BudgetHarness,
): Promise<import('@ontology/contracts').BudgetReservationRecord[]> {
  return harness.store.listReservations(
    { tenantId: harness.ctx.principal.tenantId, spaceId: harness.ctx.allowedResources.spaceId },
    harness.ledgerId,
    harness.ctx,
  )
}

export function remainingOf(harness: BudgetHarness): Promise<import('@ontology/contracts').BudgetLedgerSnapshot> {
  return harness.budget.remaining(harness.ledgerId, harness.ctx)
}

export function modelContext(deadline = new Date(Date.now() + 60_000).toISOString()): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT_A,
      subjectId: 'model-test',
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
    traceId: 'trace-model-company',
  })
}

export interface AdapterOptions {
  readonly server: CompanyServer
  readonly fixture: string
  readonly harness: BudgetHarness
  readonly validator?: ResponseSchemaValidator
  readonly evidence?: ModelCallEvidenceRecorder
  readonly log?: ModelAdapterLogger
  readonly maxAttempts?: number
  readonly requestTimeoutMs?: number
  readonly signal?: AbortSignal
  readonly retryBaseDelayMs?: number
}

export function makeAdapter(options: AdapterOptions): CompanyGenerationAdapter {
  const config: CompanyGenerationAdapterConfig = {
    baseUrl: options.server.baseUrl,
    secretRef: SECRET_REF,
    models: { [PLATFORM_MODEL_ID]: { vendorModel: options.fixture } },
    secrets: staticSecretResolver(),
    budget: options.harness.budget,
    ledgerId: options.harness.ledgerId,
    evidence: options.evidence ?? recordingEvidence().recorder,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 0,
    ...(options.validator === undefined ? {} : { schemaValidator: options.validator }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  return new CompanyGenerationAdapter(config)
}

export function generationRequest(overrides: {
  readonly role?: GenerationRole
  readonly messages?: GenerationMessage[]
  readonly evidenceRefs?: ResourceRef[]
  readonly responseSchemaRef?: VersionRef
  readonly toolSchemas?: ToolId[]
  readonly modelRef?: ModelRef
  readonly outputLimit?: { readonly maxTokens: number }
  readonly temperature?: number
} = {}): GenerationRequest {
  const base = {
    role: overrides.role ?? 'draft_writer',
    messages: overrides.messages ?? [{ role: 'user' as const, content: 'summarize the site plan' }],
    evidenceRefs: overrides.evidenceRefs ?? [],
    modelRef: overrides.modelRef ?? { modelId: PLATFORM_MODEL_ID, version: '1.0.0' },
    outputLimit: overrides.outputLimit ?? { maxTokens: 256 },
    ...(overrides.temperature === undefined ? {} : { temperature: overrides.temperature }),
  }
  if (overrides.responseSchemaRef !== undefined) {
    return { ...base, responseSchemaRef: overrides.responseSchemaRef }
  }
  return { ...base, toolSchemas: overrides.toolSchemas ?? ['data_query'] }
}

export async function collect(events: AsyncIterable<import('@ontology/contracts').GenerationEvent>): Promise<
  import('@ontology/contracts').GenerationEvent[]
> {
  const collected: import('@ontology/contracts').GenerationEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

/** Poll a server-side fact that becomes true asynchronously (e.g. a closed socket). */
export async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const STRUCTURED_SCHEMA_REF: VersionRef = {
  id: 'home-energy.answer-draft',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}
