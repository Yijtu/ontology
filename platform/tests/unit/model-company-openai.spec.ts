import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { sha256DigestOf } from '@ontology/core'
import type { GenerationEvent } from '@ontology/contracts'
import { createAjv, expectValid, validator } from '../contracts/helpers'
import {
  acceptingValidator,
  budgetHarness,
  collect,
  generationRequest,
  makeAdapter,
  startCompanyServer,
  STRUCTURED_SCHEMA_REF,
  type CompanyServer,
} from './model-company-fixtures'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

function toolCallEvents(events: readonly GenerationEvent[]): Extract<GenerationEvent, { type: 'tool_call_delta' }>[] {
  return events.filter(
    (event): event is Extract<GenerationEvent, { type: 'tool_call_delta' }> => event.type === 'tool_call_delta',
  )
}

describe('company generation adapter — OpenAI-compatible codec', () => {
  it('decodes data: text deltas, a trailing usage chunk and [DONE] into the canonical union', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'openai_normal', harness, protocol: 'openai-compatible' })

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

  it('accumulates fragmented tool-call arguments and emits one complete candidate with a normalised id', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_fragmented_tool_call',
      harness,
      protocol: 'openai-compatible',
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    const calls = toolCallEvents(events)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.callId).toMatch(UUID_PATTERN)
    expect(call?.toolId).toBe('data_query')
    // The complete JSON object is emitted once, never the raw `{"kind":` fragment.
    expect(call?.argumentsDelta).toBe('{"kind":"describe"}')
    expect(JSON.stringify(events)).not.toContain('call_abc123')
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      stopReason: 'tool_calls',
      outputDigest: sha256DigestOf('{"kind":"describe"}'),
    })
    for (const event of events) expectValid(validateEvent, event, `canonical event ${event.type}`)

    // The declared tool must be a self-contained object schema: an OpenAI-compatible
    // gateway rejects the catalogue's `$ref`-only input schema.
    const declared = api.requests[0]?.body['tools']
    expect(Array.isArray(declared)).toBe(true)
    expect(Array.isArray(declared) ? declared[0] : undefined).toMatchObject({
      type: 'function',
      function: { name: 'data_query', parameters: { type: 'object' } },
    })
  })

  it('maps distinct non-UUID ids to distinct, stable UUIDs ordered by tool-call index', async () => {
    const first = await server()
    const harnessA = await budgetHarness({ maxModelTokens: 1_000 })
    const adapterA = makeAdapter({
      server: first,
      fixture: 'openai_two_tool_calls',
      harness: harnessA,
      protocol: 'openai-compatible',
    })
    const eventsA = await collect(adapterA.generate(generationRequest(), harnessA.ctx))
    const callsA = toolCallEvents(eventsA)

    expect(callsA.map((call) => call.toolId)).toEqual(['data_query', 'document_search'])
    const [callA, callB] = callsA
    expect(callA?.callId).toMatch(UUID_PATTERN)
    expect(callB?.callId).toMatch(UUID_PATTERN)
    expect(callA?.callId).not.toBe(callB?.callId)

    // Same vendor ids on a second call must yield the same platform ids (deterministic).
    const second = await server()
    const harnessB = await budgetHarness({ maxModelTokens: 1_000 })
    const adapterB = makeAdapter({
      server: second,
      fixture: 'openai_two_tool_calls',
      harness: harnessB,
      protocol: 'openai-compatible',
    })
    const callsB = toolCallEvents(await collect(adapterB.generate(generationRequest(), harnessB.ctx)))
    expect(callsB.map((call) => call.callId)).toEqual(callsA.map((call) => call.callId))
  })

  it('maps finish_reason length to the canonical stop reason', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'openai_length', harness, protocol: 'openai-compatible' })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'length' })
  })

  it('validates a structured OpenAI candidate against its published schema', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_structured',
      harness,
      protocol: 'openai-compatible',
      validator: acceptingValidator(),
    })

    const events = await collect(
      adapter.generate(generationRequest({ responseSchemaRef: STRUCTURED_SCHEMA_REF }), harness.ctx),
    )

    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'stop' })
  })

  it('reports a payload that is not an OpenAI chunk as an upstream protocol fault', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_malformed_chunk',
      harness,
      protocol: 'openai-compatible',
      maxAttempts: 1,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'INTERNAL_ERROR' } })
  })

  it('never emits a tool call whose arguments never became complete JSON', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_incomplete_tool_call',
      harness,
      protocol: 'openai-compatible',
      maxAttempts: 1,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(toolCallEvents(events)).toHaveLength(0)
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    const error = events.at(-1)
    expect(error).toMatchObject({ type: 'error', error: { code: 'INTERNAL_ERROR' } })
    if (error?.type === 'error') expect(error.error.message).toMatch(/incomplete/)
  })

  it('classifies an in-stream OpenAI error chunk through the canonical catalogue', async () => {
    const api = await server()
    const harness = await budgetHarness()
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_error_chunk',
      harness,
      protocol: 'openai-compatible',
      maxAttempts: 1,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMITED' } })
  })

  it('settles a possibly-billed interrupted stream as usage_unknown', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'openai_interrupted',
      harness,
      protocol: 'openai-compatible',
      maxAttempts: 1,
    })

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

  it('maps HTTP 429/503/504 onto the catalogue for the OpenAI path too', async () => {
    const cases = [
      { fixture: 'http_429', code: 'RATE_LIMITED' },
      { fixture: 'http_503', code: 'MODEL_UNAVAILABLE' },
      { fixture: 'http_504', code: 'DEADLINE_EXCEEDED' },
    ] as const
    for (const testCase of cases) {
      const api = await server()
      const harness = await budgetHarness()
      const adapter = makeAdapter({
        server: api,
        fixture: testCase.fixture,
        harness,
        protocol: 'openai-compatible',
        maxAttempts: 1,
      })
      const events = await collect(adapter.generate(generationRequest(), harness.ctx))
      expect(events.at(-1), testCase.fixture).toMatchObject({
        type: 'error',
        error: { code: testCase.code },
      })
    }
  })

  it('still decodes the original private protocol when selected explicitly', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness, protocol: 'private' })

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
  })
})
