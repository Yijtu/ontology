import { randomUUID } from 'node:crypto'
import { createToolContext } from '@ontology/contracts'
import type {
  DecisionQuestion,
  DecisionResult,
  GenerationEvent,
  GenerationRole,
  ModelRef,
  ResourceRef,
  ToolContext,
  ToolId,
  VersionRef,
} from '@ontology/contracts'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type {
  ModelAdapterLogRecord,
  ModelCallEvidenceRecorder,
  ModelCallEvidenceRequest,
  ResponseSchemaValidator,
} from '@ontology/adapter-model-company'
import { JevDecisionAdapter, isJevAdapterError } from '@ontology/adapter-model-jev'
import type {
  DecisionEvidenceRecorder,
  DecisionEvidenceRequest,
  JevAdapterLogRecord,
} from '@ontology/adapter-model-jev'
import { createEnvSecretResolver } from '@ontology/app-api'
import { DIGEST_A, RecordingControlRepository, SPACE_A, TENANT_A } from '../../unit/component-registry-fixtures'
import {
  latencySummaryOf,
  parseModelMapEntries,
  presenceOf,
  preview,
  redactValues,
  selectModelMapping,
  summarizeReport,
} from './live-report'
import type {
  LiveCallRecord,
  LiveOutcome,
  LiveStructuredResult,
  LiveToolCall,
  LiveUsage,
  LiveValidationReport,
  ModelMapRole,
} from './live-report'

/**
 * Operator-run live validation of the real company generation endpoint and the real JEV
 * endpoint (LOCAL-051, SPEC §11 / S17). It is NOT part of CI: CI keeps the deterministic
 * doubles. Nothing here fabricates a result — an unreachable endpoint, a rejected
 * credential or a missing endpoint is recorded as `blocked` with the real reason.
 *
 * Only variable NAMES and presence are recorded; a resolved secret value is never stored
 * in the report. The credential reaches the adapter exclusively through the production
 * `SecretResolver` port (`createEnvSecretResolver`), never as a literal.
 */

const COMPANY_SECRET_REF = 'env:ONTOLOGY_COMPANY_MODEL_API_KEY'
const JEV_SECRET_REF = 'env:ONTOLOGY_JEV_API_KEY'
const FIXED_MODEL_VERSION = '1.0.0'
const STRUCTURED_SCHEMA_REF: VersionRef = {
  id: 'live.validation.structured',
  version: '1.0.0',
  digest: `sha256:${'c'.repeat(64)}`,
}
const OPTION_SET_HASH = `sha256:${'d'.repeat(64)}`
const LIVE_TIMEOUT_MS = 60_000

const ENV_NAMES = [
  'ONTOLOGY_COMPANY_MODEL_BASE_URL',
  'ONTOLOGY_COMPANY_MODEL_ENDPOINT',
  'ONTOLOGY_COMPANY_MODEL_API_KEY',
  'ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS',
  'ONTOLOGY_JEV_BASE_URL',
  'ONTOLOGY_JEV_ENDPOINT',
  'ONTOLOGY_JEV_API_KEY',
] as const

export interface LiveValidationOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly secretsFile: string
  readonly modelMapRole: ModelMapRole
  readonly jevVendorModel?: string
  readonly fetchImpl?: typeof fetch
}

interface GenerationRun {
  readonly record: LiveCallRecord
}

interface DecisionRun {
  readonly record: LiveCallRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
}

function endpointPathOf(endpoint: string): string {
  try {
    return new URL(endpoint).pathname
  } catch {
    return endpoint
  }
}

/**
 * Join a base URL and an endpoint path without dropping a base path prefix. The provided
 * gateway is `https://host/v1` + `/chat/completions`; a plain `new URL(endpoint, base)`
 * would drop the `/v1` prefix, so the base is given a trailing slash and the endpoint a
 * relative form before it reaches the adapter's URL builder.
 */
function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  return new URL(path, base).toString()
}

function liveContext(): ToolContext {
  const deadline = new Date(Date.now() + LIVE_TIMEOUT_MS).toISOString()
  const runId = randomUUID()
  return createToolContext({
    principal: {
      tenantId: TENANT_A,
      subjectId: 'live-validation',
      roles: ['platform-admin'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST_A,
    policyVersion: '1.0.0',
    deadline,
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: new Date().toISOString(),
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
    traceId: 'trace-live-model-validation',
  })
}

async function openBudget(ctx: ToolContext): Promise<{ readonly service: BudgetService; readonly ledgerId: string }> {
  const ledgerId = randomUUID()
  const service = new BudgetService({
    store: new InMemoryBudgetLedgerStore(),
    control: new RecordingControlRepository(),
    newId: () => randomUUID(),
  })
  await service.openLedger(
    { ledgerId, kind: 'run', overrideLimits: { maxModelTokens: 8192, deadlineMs: LIVE_TIMEOUT_MS } },
    ctx,
  )
  return { service, ledgerId }
}

function generationEvidence(): {
  readonly recorder: ModelCallEvidenceRecorder
  readonly requests: ModelCallEvidenceRequest[]
} {
  const requests: ModelCallEvidenceRequest[] = []
  return {
    requests,
    recorder: {
      record: (request: ModelCallEvidenceRequest): Promise<ResourceRef> => {
        requests.push(request)
        return Promise.resolve(evidenceRef())
      },
    },
  }
}

function decisionEvidence(): {
  readonly recorder: DecisionEvidenceRecorder
  readonly requests: DecisionEvidenceRequest[]
} {
  const requests: DecisionEvidenceRequest[] = []
  return {
    requests,
    recorder: {
      record: (request: DecisionEvidenceRequest): Promise<ResourceRef> => {
        requests.push(request)
        return Promise.resolve(evidenceRef())
      },
    },
  }
}

function structuredValidator(): ResponseSchemaValidator {
  return {
    validate: (_ref: VersionRef, candidate: unknown): Promise<{ valid: boolean; errors?: readonly string[] }> => {
      if (!isRecord(candidate)) {
        return Promise.resolve({ valid: false, errors: ['/ must be a JSON object'] })
      }
      const errors: string[] = []
      if (typeof candidate['answer'] !== 'string') errors.push('/answer must be a string')
      const confidence = candidate['confidence']
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        errors.push('/confidence must be a number between 0 and 1')
      }
      return Promise.resolve(errors.length === 0 ? { valid: true } : { valid: false, errors })
    },
  }
}

async function collectGeneration(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const collected: GenerationEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

function accumulateToolCalls(events: readonly GenerationEvent[]): readonly LiveToolCall[] {
  const byCall = new Map<string, { toolId: string; args: string }>()
  for (const event of events) {
    if (event.type !== 'tool_call_delta') continue
    const existing = byCall.get(event.callId)
    if (existing === undefined) byCall.set(event.callId, { toolId: event.toolId, args: event.argumentsDelta })
    else existing.args += event.argumentsDelta
  }
  return [...byCall.entries()].map(([callId, value]) => {
    let argumentsJsonValid = false
    try {
      argumentsJsonValid = isRecord(JSON.parse(value.args))
    } catch {
      argumentsJsonValid = false
    }
    return { callId, toolId: value.toolId, argumentsJsonValid, argumentsPreview: preview(value.args, 200) }
  })
}

function attemptsFromLog(records: readonly ModelAdapterLogRecord[]): number {
  return records.filter((record) => record.message === 'retrying model call').length + 1
}

function classifyGenerationFailure(code: string, message: string): LiveOutcome {
  if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') return 'blocked'
  if (code === 'MODEL_UNAVAILABLE' && /interrupt/i.test(message)) return 'blocked'
  return 'error'
}

interface GenerationCallOptions {
  readonly name: string
  readonly role: GenerationRole
  readonly prompt: string
  readonly maxTokens: number
  readonly adapter: CompanyGenerationAdapter
  readonly ctx: ToolContext
  readonly logRecords: readonly ModelAdapterLogRecord[]
  readonly modelRef: ModelRef
  readonly vendorModel: string
  readonly endpointPath: string
  readonly responseSchemaRef?: VersionRef
  readonly validator?: ResponseSchemaValidator
  readonly toolSchemas?: readonly ToolId[]
}

async function runGenerationCall(options: GenerationCallOptions): Promise<GenerationRun> {
  const request = {
    role: options.role,
    messages: [{ role: 'user' as const, content: options.prompt }],
    evidenceRefs: [] as ResourceRef[],
    modelRef: options.modelRef,
    outputLimit: { maxTokens: options.maxTokens },
    ...(options.responseSchemaRef === undefined
      ? { toolSchemas: [...(options.toolSchemas ?? [])] }
      : { responseSchemaRef: options.responseSchemaRef }),
  }
  const started = Date.now()
  let events: GenerationEvent[]
  try {
    events = await collectGeneration(options.adapter.generate(request, options.ctx))
  } catch (error) {
    return {
      record: {
        name: options.name,
        port: 'generation',
        outcome: 'error',
        modelRef: options.modelRef.modelId,
        vendorModel: options.vendorModel,
        endpointPath: options.endpointPath,
        latencyMs: Date.now() - started,
        attempts: attemptsFromLog(options.logRecords),
        retryObserved: attemptsFromLog(options.logRecords) > 1,
        errorCode: 'INTERNAL_ERROR',
        errorMessage: error instanceof Error ? error.message : 'the adapter threw without a message',
        notes: ['the adapter threw instead of yielding a classified event'],
      },
    }
  }
  const latencyMs = Date.now() - started
  const text = events
    .filter((event): event is Extract<GenerationEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('')
  const usageEvent = events.find((event) => event.type === 'usage')
  const completed = events.find((event) => event.type === 'completed')
  const errorEvent = events.find((event) => event.type === 'error')
  const attempts = attemptsFromLog(options.logRecords)
  const toolCalls = accumulateToolCalls(events)
  const notes: string[] = []

  if (errorEvent !== undefined && errorEvent.type === 'error') {
    const message = errorEvent.error.safeMessage ?? errorEvent.error.message
    return {
      record: {
        name: options.name,
        port: 'generation',
        outcome: classifyGenerationFailure(errorEvent.error.code, message),
        modelRef: options.modelRef.modelId,
        vendorModel: options.vendorModel,
        endpointPath: options.endpointPath,
        latencyMs,
        attempts,
        retryObserved: attempts > 1,
        errorCode: errorEvent.error.code,
        errorMessage: message,
        ...(usageEvent !== undefined && usageEvent.type === 'usage'
          ? { usage: toLiveUsage(usageEvent.usage) }
          : {}),
        ...(text.length === 0 ? {} : { answer: preview(text) }),
        notes,
      },
    }
  }

  let structured: LiveStructuredResult | undefined
  if (options.responseSchemaRef !== undefined) {
    let valid = false
    let errors: string[] = []
    try {
      const parsed: unknown = JSON.parse(text)
      const result = await options.validator?.validate(options.responseSchemaRef, parsed, options.ctx)
      valid = result?.valid ?? false
      errors = result?.errors === undefined ? [] : [...result.errors]
    } catch {
      valid = false
      errors = ['the model answer was not valid JSON']
    }
    structured = { valid, errors, preview: preview(text) }
    if (!valid) notes.push('the structured candidate did not satisfy the declared schema')
  }
  if (options.toolSchemas !== undefined && options.toolSchemas.length > 0) {
    if (toolCalls.length === 0) notes.push('the model did not emit a tool call for this prompt')
    else if (!toolCalls.every((call) => call.argumentsJsonValid)) {
      notes.push('a tool call carried non-JSON arguments')
    }
  }

  const outcome: LiveOutcome = 'validated'
  return {
    record: {
      name: options.name,
      port: 'generation',
      outcome,
      modelRef: options.modelRef.modelId,
      vendorModel: options.vendorModel,
      endpointPath: options.endpointPath,
      latencyMs,
      attempts,
      retryObserved: attempts > 1,
      ...(completed !== undefined && completed.type === 'completed' ? { stopReason: completed.stopReason } : {}),
      ...(usageEvent !== undefined && usageEvent.type === 'usage' ? { usage: toLiveUsage(usageEvent.usage) } : {}),
      answer: preview(text),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(structured === undefined ? {} : { structured }),
      notes,
    },
  }
}

function toLiveUsage(usage: { inputTokens: number; outputTokens: number; usageUnknown?: boolean }): {
  inputTokens: number
  outputTokens: number
  usageUnknown: boolean
} {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usageUnknown: usage.usageUnknown === true }
}

function blockedGeneration(name: string, reason: string): GenerationRun {
  return {
    record: {
      name,
      port: 'generation',
      outcome: 'blocked',
      modelRef: 'n/a',
      vendorModel: 'n/a',
      endpointPath: 'n/a',
      latencyMs: 0,
      attempts: 0,
      retryObserved: false,
      blockedReason: reason,
      notes: ['no request was sent to the real endpoint'],
    },
  }
}

function blockedDecision(reason: string): DecisionRun {
  return {
    record: {
      name: 'jev_choice',
      port: 'decision',
      outcome: 'blocked',
      modelRef: 'n/a',
      vendorModel: 'n/a',
      endpointPath: 'n/a',
      latencyMs: 0,
      attempts: 0,
      retryObserved: false,
      blockedReason: reason,
      notes: ['no request was sent to the real endpoint'],
    },
  }
}

/** Fixed choice question used to probe the real JEV endpoint. */
function fixedJevQuestion(): DecisionQuestion {
  return {
    questionId: randomUUID(),
    type: 'choice',
    prompt: 'Which of the two options is the more likely outcome?',
    options: [
      { optionId: 'option-a', label: 'Outcome A' },
      { optionId: 'option-b', label: 'Outcome B' },
    ],
    optionSetHash: OPTION_SET_HASH,
    definitionVersion: FIXED_MODEL_VERSION,
  }
}

interface RawProbeResult {
  readonly status: number
  readonly contentType: string
  readonly content: string
  readonly modelVersion?: string
  readonly finishReason?: string
  readonly usage?: LiveUsage
  readonly toolCalls: readonly {
    readonly index: number
    readonly id?: string
    readonly name?: string
    readonly args: string
  }[]
}

/**
 * Raw wire-level request to the real endpoint. This deliberately does not go through the
 * platform adapter: it validates the endpoint's own fields (model version, answer,
 * structured output, tool call, usage) and is labelled `probe`, never presented as an
 * adapter-level result.
 */
async function rawProbe(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<RawProbeResult> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let content = ''
  let modelVersion: string | undefined
  let finishReason: string | undefined
  let usage: LiveUsage | undefined
  const toolByIndex = new Map<number, { id?: string; name?: string; args: string }>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const model = parsed['model']
    if (typeof model === 'string') modelVersion = model
    const choices = parsed['choices']
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!isRecord(choice)) continue
        const finish = choice['finish_reason']
        if (typeof finish === 'string') finishReason = finish
        const delta = choice['delta']
        if (!isRecord(delta)) continue
        const deltaContent = delta['content']
        if (typeof deltaContent === 'string') content += deltaContent
        const rawCalls = delta['tool_calls']
        if (Array.isArray(rawCalls)) {
          for (const rawCall of rawCalls) {
            if (!isRecord(rawCall)) continue
            const index = typeof rawCall['index'] === 'number' ? rawCall['index'] : 0
            const existing = toolByIndex.get(index) ?? { args: '' }
            const id = rawCall['id']
            if (typeof id === 'string') existing.id = id
            const fn = rawCall['function']
            if (isRecord(fn)) {
              if (typeof fn['name'] === 'string') existing.name = fn['name']
              if (typeof fn['arguments'] === 'string') existing.args += fn['arguments']
            }
            toolByIndex.set(index, existing)
          }
        }
      }
    }
    const rawUsage = parsed['usage']
    if (isRecord(rawUsage)) {
      const prompt = rawUsage['prompt_tokens']
      const completion = rawUsage['completion_tokens']
      if (typeof prompt === 'number' && typeof completion === 'number') {
        usage = { inputTokens: prompt, outputTokens: completion, usageUnknown: false }
      }
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    content,
    ...(modelVersion === undefined ? {} : { modelVersion }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    toolCalls: [...toolByIndex.entries()].map(([index, value]) => ({ index, ...value })),
  }
}

function argumentsAreJsonObject(text: string): boolean {
  try {
    return isRecord(JSON.parse(text))
  } catch {
    return false
  }
}

/**
 * Wire-level validation of the real endpoint. It records the endpoint's model version,
 * natural-language answer, structured-output fields, tool-call fields and usage. A probe
 * that cannot run (missing credential) is `blocked`; a probe that ran but did not carry
 * the expected field is `error`.
 */
async function runCompanyEndpointProbe(
  options: LiveValidationOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly LiveCallRecord[]> {
  const baseUrl = env['ONTOLOGY_COMPANY_MODEL_BASE_URL']
  const endpoint = env['ONTOLOGY_COMPANY_MODEL_ENDPOINT']
  const mapping = selectModelMapping(
    parseModelMapEntries(env['ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS']),
    options.modelMapRole,
  )
  if (
    baseUrl === undefined ||
    baseUrl.length === 0 ||
    endpoint === undefined ||
    endpoint.length === 0 ||
    mapping === undefined
  ) {
    return []
  }
  const url = joinUrl(baseUrl, endpoint)
  const endpointPath = endpointPathOf(endpoint)
  const model = mapping.vendorModel
  const ctx = liveContext()
  let apiKey: string
  let redact: (text: string) => string
  try {
    const secret = await createEnvSecretResolver({ env }).resolve(COMPANY_SECRET_REF, ctx)
    apiKey = secret.reveal()
    redact = (text: string): string => secret.redact(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the company credential could not be resolved'
    return ['wire_natural_language', 'wire_structured_output', 'wire_tool_call'].map((name) => ({
      name,
      port: 'probe' as const,
      outcome: 'blocked' as const,
      modelRef: 'n/a',
      vendorModel: model,
      endpointPath,
      latencyMs: 0,
      attempts: 0,
      retryObserved: false,
      blockedReason: reason,
      notes: ['no request was sent to the real endpoint'],
    }))
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const probes: LiveCallRecord[] = []

  const nlStarted = Date.now()
  const nl = await rawProbe(
    url,
    apiKey,
    {
      model,
      messages: [{ role: 'user', content: 'In one short sentence, state what an electricity tariff is.' }],
      max_tokens: 128,
      stream: true,
    },
    fetchImpl,
  )
  const nlOk = nl.status === 200 && nl.content.length > 0
  probes.push({
    name: 'wire_natural_language',
    port: 'probe',
    outcome: nlOk ? 'validated' : 'error',
    modelRef: 'n/a',
    vendorModel: model,
    endpointPath,
    latencyMs: Date.now() - nlStarted,
    attempts: 1,
    retryObserved: false,
    ...(nl.modelVersion === undefined ? {} : { modelVersion: nl.modelVersion }),
    ...(nl.finishReason === undefined ? {} : { stopReason: nl.finishReason }),
    ...(nl.usage === undefined ? {} : { usage: nl.usage }),
    answer: preview(redact(nl.content)),
    ...(nl.status >= 400
      ? { errorCode: 'MODEL_UNAVAILABLE', errorMessage: `the endpoint responded with HTTP ${String(nl.status)}` }
      : {}),
    notes: ['raw wire-level probe; not routed through the platform adapter'],
  })

  const structuredStarted = Date.now()
  const structured = await rawProbe(
    url,
    apiKey,
    {
      model,
      messages: [
        {
          role: 'user',
          content:
            'Return only a JSON object with an "answer" string (one sentence about electricity tariffs) and a "confidence" number between 0 and 1.',
        },
      ],
      max_tokens: 256,
      stream: true,
      response_format: { type: 'json_object' },
    },
    fetchImpl,
  )
  const structuredErrors: string[] = []
  if (structured.status !== 200) structuredErrors.push(`HTTP ${String(structured.status)}`)
  let structuredJson: unknown
  try {
    structuredJson = JSON.parse(structured.content)
  } catch {
    structuredErrors.push('the model answer was not valid JSON')
  }
  if (isRecord(structuredJson)) {
    if (typeof structuredJson['answer'] !== 'string') structuredErrors.push('/answer must be a string')
    const confidence = structuredJson['confidence']
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      structuredErrors.push('/confidence must be a number between 0 and 1')
    }
  } else if (structuredErrors.length === 0) {
    structuredErrors.push('the model answer was not a JSON object')
  }
  probes.push({
    name: 'wire_structured_output',
    port: 'probe',
    outcome: structuredErrors.length === 0 ? 'validated' : 'error',
    modelRef: 'n/a',
    vendorModel: model,
    endpointPath,
    latencyMs: Date.now() - structuredStarted,
    attempts: 1,
    retryObserved: false,
    ...(structured.modelVersion === undefined ? {} : { modelVersion: structured.modelVersion }),
    ...(structured.usage === undefined ? {} : { usage: structured.usage }),
    structured: { valid: structuredErrors.length === 0, errors: structuredErrors, preview: preview(redact(structured.content)) },
    ...(structuredErrors.length === 0
      ? {}
      : { errorCode: 'INVALID_SCHEMA', errorMessage: structuredErrors.join('; ') }),
    notes: ['raw wire-level probe with response_format=json_object'],
  })

  const toolStarted = Date.now()
  const tool = await rawProbe(
    url,
    apiKey,
    {
      model,
      messages: [{ role: 'user', content: 'Call the data_query tool with the arguments {"kind":"describe"} and nothing else.' }],
      max_tokens: 128,
      stream: true,
      tools: [
        {
          type: 'function',
          function: { name: 'data_query', description: 'Platform data query tool', parameters: { type: 'object' } },
        },
      ],
    },
    fetchImpl,
  )
  const toolCalls: LiveToolCall[] = tool.toolCalls.map((call) => ({
    callId: call.id ?? '(none)',
    toolId: call.name ?? '(none)',
    argumentsJsonValid: argumentsAreJsonObject(call.args),
    argumentsPreview: preview(redact(call.args), 200),
  }))
  const first = toolCalls[0]
  const toolOk =
    tool.status === 200 &&
    first !== undefined &&
    first.toolId === 'data_query' &&
    first.argumentsJsonValid
  probes.push({
    name: 'wire_tool_call',
    port: 'probe',
    outcome: toolOk ? 'validated' : 'error',
    modelRef: 'n/a',
    vendorModel: model,
    endpointPath,
    latencyMs: Date.now() - toolStarted,
    attempts: 1,
    retryObserved: false,
    ...(tool.modelVersion === undefined ? {} : { modelVersion: tool.modelVersion }),
    ...(tool.finishReason === undefined ? {} : { stopReason: tool.finishReason }),
    ...(tool.usage === undefined ? {} : { usage: tool.usage }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(toolOk
      ? {}
      : { errorCode: 'INVALID_SCHEMA', errorMessage: 'the endpoint did not return a valid data_query tool call' }),
    notes: [
      'raw wire-level probe; the endpoint returns OpenAI-style tool-call ids that are not canonical UUIDs, which the model-company adapter does not model',
    ],
  })

  return probes
}

async function runCompanyLive(
  options: LiveValidationOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly LiveCallRecord[]> {
  const baseUrl = env['ONTOLOGY_COMPANY_MODEL_BASE_URL']
  const endpoint = env['ONTOLOGY_COMPANY_MODEL_ENDPOINT']
  const apiKey = env['ONTOLOGY_COMPANY_MODEL_API_KEY']
  const mapping = selectModelMapping(parseModelMapEntries(env['ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS']), options.modelMapRole)

  const blockedReason =
    baseUrl === undefined || baseUrl.length === 0
      ? 'ONTOLOGY_COMPANY_MODEL_BASE_URL is not configured'
      : endpoint === undefined || endpoint.length === 0
        ? 'ONTOLOGY_COMPANY_MODEL_ENDPOINT is not configured'
        : apiKey === undefined || apiKey.length === 0
          ? 'ONTOLOGY_COMPANY_MODEL_API_KEY is not configured'
          : mapping === undefined
            ? 'ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS did not yield a model mapping'
            : undefined

  if (blockedReason !== undefined || mapping === undefined || baseUrl === undefined || endpoint === undefined) {
    const reason = blockedReason ?? 'the company endpoint configuration was incomplete'
    return [
      blockedGeneration('natural_language', reason).record,
      blockedGeneration('structured_output', reason).record,
      blockedGeneration('tool_call', reason).record,
    ]
  }

  const ctx = liveContext()
  const { service: budget, ledgerId } = await openBudget(ctx)
  const logRecords: ModelAdapterLogRecord[] = []
  // The adapter builds `new URL(endpoint, baseUrl)`; give it a base with a trailing slash
  // and a relative endpoint so a base path prefix (`/v1`) is preserved.
  const adapterBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const adapterEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  const adapter = new CompanyGenerationAdapter({
    baseUrl: adapterBase,
    endpoint: adapterEndpoint,
    secretRef: COMPANY_SECRET_REF,
    models: { [mapping.platformModelId]: { vendorModel: mapping.vendorModel } },
    secrets: createEnvSecretResolver({ env }),
    budget,
    ledgerId,
    evidence: generationEvidence().recorder,
    schemaValidator: structuredValidator(),
    maxAttempts: 3,
    retryBaseDelayMs: 250,
    log: (record) => logRecords.push(record),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  const modelRef: ModelRef = { modelId: mapping.platformModelId, version: FIXED_MODEL_VERSION }
  const endpointPath = endpointPathOf(endpoint)

  const natural = await runGenerationCall({
    name: 'natural_language',
    role: 'draft_writer',
    prompt: 'In one short sentence, state what an electricity tariff is.',
    maxTokens: 128,
    adapter,
    ctx,
    logRecords,
    modelRef,
    vendorModel: mapping.vendorModel,
    endpointPath,
  })

  const structured = await runGenerationCall({
    name: 'structured_output',
    role: 'draft_writer',
    prompt:
      'Return only a JSON object with an "answer" string (one sentence about electricity tariffs) and a "confidence" number between 0 and 1.',
    maxTokens: 256,
    adapter,
    ctx,
    logRecords,
    modelRef,
    vendorModel: mapping.vendorModel,
    endpointPath,
    responseSchemaRef: STRUCTURED_SCHEMA_REF,
    validator: structuredValidator(),
  })

  const toolCall = await runGenerationCall({
    name: 'tool_call',
    role: 'draft_writer',
    prompt: 'Call the data_query tool with the arguments {"kind":"describe"} and nothing else.',
    maxTokens: 128,
    adapter,
    ctx,
    logRecords,
    modelRef,
    vendorModel: mapping.vendorModel,
    endpointPath,
    toolSchemas: ['data_query'],
  })

  return [natural.record, structured.record, toolCall.record]
}

async function runJevLive(
  options: LiveValidationOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DecisionRun> {
  const baseUrl = env['ONTOLOGY_JEV_BASE_URL']
  const endpoint = env['ONTOLOGY_JEV_ENDPOINT']
  const apiKey = env['ONTOLOGY_JEV_API_KEY']

  if (baseUrl === undefined || baseUrl.length === 0 || endpoint === undefined || endpoint.length === 0) {
    const missing: string[] = []
    if (baseUrl === undefined || baseUrl.length === 0) missing.push('ONTOLOGY_JEV_BASE_URL')
    if (endpoint === undefined || endpoint.length === 0) missing.push('ONTOLOGY_JEV_ENDPOINT')
    const keyNote =
      apiKey === undefined || apiKey.length === 0
        ? 'the JEV api key is also not configured'
        : 'the JEV api key is present, but a key alone is not a passing validation'
    return blockedDecision(`missing ${missing.join(' and ')}; ${keyNote}`)
  }
  if (options.jevVendorModel === undefined || options.jevVendorModel.length === 0) {
    return blockedDecision('no JEV vendor model was supplied (--jev-vendor-model)')
  }

  const ctx = liveContext()
  const { service: budget, ledgerId } = await openBudget(ctx)
  const logRecords: JevAdapterLogRecord[] = []
  const adapter = new JevDecisionAdapter({
    baseUrl,
    endpoint,
    secretRef: JEV_SECRET_REF,
    models: { 'jev-model': { vendorModel: options.jevVendorModel } },
    fallbackPolicy: 'reject',
    secrets: createEnvSecretResolver({ env }),
    budget,
    ledgerId,
    evidence: decisionEvidence().recorder,
    maxAttempts: 3,
    retryBaseDelayMs: 250,
    log: (record) => logRecords.push(record),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })

  const started = Date.now()
  try {
    const result: DecisionResult = await adapter.decide(
      { stateRef: evidenceRef(), questions: [fixedJevQuestion()], modelRef: { modelId: 'jev-model', version: FIXED_MODEL_VERSION } },
      ctx,
    )
    const latencyMs = Date.now() - started
    return {
      record: {
        name: 'jev_choice',
        port: 'decision',
        outcome: 'validated',
        modelRef: 'jev-model',
        vendorModel: options.jevVendorModel,
        endpointPath: endpointPathOf(endpoint),
        latencyMs,
        attempts: logRecords.filter((record) => record.message === 'retrying decision call').length + 1,
        retryObserved: logRecords.some((record) => record.message === 'retrying decision call'),
        ...(result.distribution === undefined
          ? {}
          : { probabilities: result.distribution.entries.map((entry) => ({ optionId: entry.optionId, probability: entry.probability })) }),
        ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
        notes: ['the decision result carried a probability distribution; no generated text is expected from DecisionPort'],
      },
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const code = isJevAdapterError(error) ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : 'the JEV adapter threw without a message'
    const outcome: LiveOutcome =
      code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' || (code === 'MODEL_UNAVAILABLE' && /interrupt/i.test(message))
        ? 'blocked'
        : 'error'
    return {
      record: {
        name: 'jev_choice',
        port: 'decision',
        outcome,
        modelRef: 'jev-model',
        vendorModel: options.jevVendorModel,
        endpointPath: endpointPathOf(endpoint),
        latencyMs,
        attempts: logRecords.filter((record) => record.message === 'retrying decision call').length + 1,
        retryObserved: logRecords.some((record) => record.message === 'retrying decision call'),
        errorCode: code,
        errorMessage: message,
        notes: ['DecisionPort is a probability port; no free-text answer is recorded'],
      },
    }
  }
}

export async function runLiveValidation(options: LiveValidationOptions): Promise<LiveValidationReport> {
  const env = options.env
  const endpointProbes = await runCompanyEndpointProbe(options, env)
  const company = await runCompanyLive(options, env)
  const jev = await runJevLive(options, env)
  const all = [...endpointProbes, ...company, jev.record]
  const secretValues = [
    env['ONTOLOGY_COMPANY_MODEL_API_KEY'] ?? '',
    env['ONTOLOGY_JEV_API_KEY'] ?? '',
  ]
  return {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    secretsFile: options.secretsFile,
    envPresence: presenceOf(env, ENV_NAMES),
    endpointProbes: redactRecords(endpointProbes, secretValues),
    company: redactRecords(company, secretValues),
    jev: redactRecords([jev.record], secretValues)[0] ?? jev.record,
    latency: latencySummaryOf(all),
    summary: summarizeReport(all),
  }
}

function redactRecords(calls: readonly LiveCallRecord[], values: readonly string[]): readonly LiveCallRecord[] {
  return calls.map((call) => ({
    ...call,
    ...(call.errorMessage === undefined ? {} : { errorMessage: redactValues(call.errorMessage, values) }),
    ...(call.answer === undefined ? {} : { answer: redactValues(call.answer, values) }),
    ...(call.blockedReason === undefined ? {} : { blockedReason: redactValues(call.blockedReason, values) }),
    notes: call.notes.map((note) => redactValues(note, values)),
  }))
}
