import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { sha256DigestOf } from '@ontology/core'
import type { GenerationEvent } from '@ontology/contracts'
import { createAjv, expectValid, validator } from '../contracts/helpers'
import {
  acceptingValidator,
  budgetHarness,
  capturingLog,
  collect,
  generationRequest,
  makeAdapter,
  recordingEvidence,
  rejectingValidator,
  startCompanyServer,
  STRUCTURED_SCHEMA_REF,
  TEST_SECRET,
  type CompanyServer,
} from './model-company-fixtures'

let ajv: Ajv2020
let validateEvent: ValidateFunction
const servers: CompanyServer[] = []

beforeAll(() => {
  ajv = createAjv()
  validateEvent = validator(ajv, 'model.schema.json', 'GenerationEvent')
})

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

async function server(): Promise<CompanyServer> {
  const started = await startCompanyServer()
  servers.push(started)
  return started
}

describe('company generation adapter — unified event stream', () => {
  it('emits text, usage and a candidate-only completion through the one event union', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events).toEqual<GenerationEvent[]>([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } },
      {
        type: 'completed',
        stopReason: 'stop',
        candidateOnly: true,
        outputDigest: sha256DigestOf('Hello world'),
      },
    ])
    for (const event of events) expectValid(validateEvent, event, `canonical event ${event.type}`)
  })

  it('forwards evidence refs to the provider without silently dropping them', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })
    const evidenceRef = {
      id: '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      kind: 'evidence' as const,
    }

    await collect(adapter.generate(generationRequest({ evidenceRefs: [evidenceRef] }), harness.ctx))

    expect(api.requests[0]?.body['evidence_refs']).toEqual([
      {
        id: evidenceRef.id,
        version: evidenceRef.version,
        digest: evidenceRef.digest,
        kind: evidenceRef.kind,
      },
    ])
  })

  it('surfaces a tool call only as a proposal and never executes it', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const evidence = recordingEvidence()
    const adapter = makeAdapter({
      server: api,
      fixture: 'tool_calls',
      harness,
      evidence: evidence.recorder,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events[0]).toEqual({
      type: 'tool_call_delta',
      callId: '7f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      toolId: 'data_query',
      argumentsDelta: '{"kind":"describe"}',
    })
    expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'tool_calls' })
    // The proposal was declared to the provider but never executed by the adapter: there is
    // no tool result, no error and no event type outside the canonical generation union.
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.every((event) => validateEvent(event))).toBe(true)
    const declaredTools = api.requests[0]?.body['tools']
    expect(Array.isArray(declaredTools)).toBe(true)
    // The only persisted artifact is the model-output evidence; nothing executed a tool.
    expect(evidence.requests).toHaveLength(1)
  })

  it('rejects an unregistered tool proposal instead of silently dropping it', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({ server: api, fixture: 'unregistered_tool', harness, maxAttempts: 1 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.some((event) => event.type === 'tool_call_delta')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'INVALID_ARGUMENT', retryable: false },
    })
  })

  it('validates a structured candidate against its published schema', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'structured_ok',
      harness,
      validator: acceptingValidator(),
    })

    const events = await collect(
      adapter.generate(generationRequest({ responseSchemaRef: STRUCTURED_SCHEMA_REF }), harness.ctx),
    )

    const completed = events.at(-1)
    expect(completed).toMatchObject({ type: 'completed', stopReason: 'stop' })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expectValid(validateEvent, completed, 'structured completion')
  })

  it('reports malformed structured JSON explicitly and never completes', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'malformed_json',
      harness,
      validator: acceptingValidator(),
    })

    const events = await collect(
      adapter.generate(generationRequest({ responseSchemaRef: STRUCTURED_SCHEMA_REF }), harness.ctx),
    )

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    const error = events.at(-1)
    expect(error).toMatchObject({ type: 'error', error: { code: 'INVALID_SCHEMA' } })
    if (error?.type === 'error') expect(error.error.message).toMatch(/valid JSON/)
  })

  it('reports a schema-mismatched candidate with the validator detail', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'schema_mismatch',
      harness,
      validator: rejectingValidator(['/plan is required']),
    })

    const events = await collect(
      adapter.generate(generationRequest({ responseSchemaRef: STRUCTURED_SCHEMA_REF }), harness.ctx),
    )

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    const error = events.at(-1)
    expect(error).toMatchObject({ type: 'error', error: { code: 'INVALID_SCHEMA' } })
    if (error?.type === 'error') expect(error.error.message).toContain('/plan is required')
  })
})

describe('company generation adapter — usage and failure fixtures', () => {
  it('marks a partial usage event as unknown instead of rounding it to zero', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'partial_usage', harness })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    const usage = events.find((event) => event.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 11, outputTokens: 0, usageUnknown: true },
    })
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
    const reservations = await harness.store.listReservations(
      { tenantId: harness.ctx.principal.tenantId, spaceId: harness.ctx.allowedResources.spaceId },
      harness.ledgerId,
      harness.ctx,
    )
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('synthesises an explicit unknown usage when the provider reports none', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'no_usage', harness })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events).toEqual<GenerationEvent[]>([
      { type: 'text_delta', text: 'no usage reported' },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, usageUnknown: true } },
      {
        type: 'completed',
        stopReason: 'stop',
        candidateOnly: true,
        outputDigest: sha256DigestOf('no usage reported'),
      },
    ])
  })

  it('classifies HTTP 429 with the retry-after it was given', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({ server: api, fixture: 'http_429', harness, maxAttempts: 1 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    const error = events.at(-1)
    expect(error).toMatchObject({
      type: 'error',
      error: { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 2_000 },
    })
  })

  it('classifies HTTP 503, 504 and 500 through the canonical catalogue', async () => {
    const cases = [
      { fixture: 'http_503', code: 'MODEL_UNAVAILABLE', retryable: true, remoteStateUnknown: false },
      { fixture: 'http_504', code: 'DEADLINE_EXCEEDED', retryable: false, remoteStateUnknown: true },
      { fixture: 'http_500', code: 'INTERNAL_ERROR', retryable: false, remoteStateUnknown: false },
      { fixture: 'http_403', code: 'FORBIDDEN', retryable: false, remoteStateUnknown: false },
    ] as const
    for (const testCase of cases) {
      const api = await server()
      const harness = await budgetHarness()
      const adapter = makeAdapter({ server: api, fixture: testCase.fixture, harness, maxAttempts: 1 })
      const events = await collect(adapter.generate(generationRequest(), harness.ctx))
      const last = events.at(-1)
      expect(last, testCase.fixture).toMatchObject({
        type: 'error',
        error: { code: testCase.code, retryable: testCase.retryable },
      })
      if (last?.type === 'error') {
        expect(last.error.remoteStateUnknown ?? false, testCase.fixture).toBe(
          testCase.remoteStateUnknown,
        )
      }
    }
  })

  it('never hangs or silently succeeds when the stream is interrupted', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'interrupted', harness, maxAttempts: 1 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'MODEL_UNAVAILABLE' } })
    const reservations = await harness.store.listReservations(
      { tenantId: harness.ctx.principal.tenantId, spaceId: harness.ctx.allowedResources.spaceId },
      harness.ledgerId,
      harness.ctx,
    )
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('maps a vendor error chunk onto the canonical taxonomy', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({ server: api, fixture: 'vendor_error', harness, maxAttempts: 1 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'MODEL_UNAVAILABLE' } })
  })

  it('fails explicitly when no company model binding exists', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })
    const request = generationRequest({
      modelRef: { modelId: 'unknown-model', version: '1.0.0' },
    })

    const events = await collect(adapter.generate(request, harness.ctx))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'INVALID_ARGUMENT', retryable: false },
    })
    expect(api.requests).toHaveLength(0)
  })
})

describe('company generation adapter — no secret reaches an event or a log', () => {
  it('redacts a credential the provider echoes in streamed text', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const log = capturingLog()
    const adapter = makeAdapter({ server: api, fixture: 'leak_text', harness, log: log.log })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    expect(JSON.stringify(log.records)).not.toContain(TEST_SECRET)
    const text = events.find((event) => event.type === 'text_delta')
    if (text?.type === 'text_delta') expect(text.text).toContain('[redacted]')
  })

  it('redacts a credential the provider echoes in an HTTP error body', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const log = capturingLog()
    const adapter = makeAdapter({
      server: api,
      fixture: 'leak_error',
      harness,
      log: log.log,
      maxAttempts: 1,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    expect(JSON.stringify(log.records)).not.toContain(TEST_SECRET)
    const error = events.at(-1)
    expect(error).toMatchObject({ type: 'error', error: { code: 'UNAUTHENTICATED' } })
    if (error?.type === 'error') {
      expect(error.error.message).toContain('[redacted]')
      expect(error.error.safeMessage ?? '').not.toContain(TEST_SECRET)
    }
    // The credential really was injected, but only into the request header.
    expect(api.requests[0]?.authorization).toBe(`Bearer ${TEST_SECRET}`)
  })
})
