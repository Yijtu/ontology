import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { DecisionPort, GenerationPort } from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, readSchemaDocument, validator, wireRoundTrip } from './helpers'

const RUN = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const EVENT = '4f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const CLARIFY = '5f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const CHECKPOINT = '6f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const TS = '2026-09-21T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`
const TENANT = '11111111-2222-4333-8444-555555555555'
const SPACE = '99999999-8888-4777-8666-555555555555'

const resourceRef = { id: RUN, version: '1.0.0', digest: DIGEST, kind: 'plan' }
const versionRef = { id: 'clarify-choice', version: '1.0.0', digest: DIGEST }
const modelRef = { modelId: 'company-llm', version: '2026-09' }

let ajv: Ajv2020
const v = (file: string, defName: string): ValidateFunction => validator(ajv, file, defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('GenerationPort and DecisionPort are separate ports (ADR-09)', () => {
  const generationRequest = {
    role: 'planner',
    messages: [{ role: 'user', content: 'compare tomorrow strategies' }],
    evidenceRefs: [],
    toolSchemas: ['data_query'],
    modelRef,
    outputLimit: { maxTokens: 1024 },
  }

  const decisionRequest = {
    stateRef: { id: RUN, version: '1.0.0', digest: DIGEST, kind: 'run' },
    questions: [
      {
        questionId: CLARIFY,
        type: 'choice',
        prompt: 'Which strategy?',
        options: [
          { optionId: 'self_consumption', label: 'Self consumption' },
          { optionId: 'reserve_first', label: 'Reserve first' },
        ],
        optionSetHash: DIGEST,
        definitionVersion: '1.0.0',
      },
    ],
    modelRef: { modelId: 'jev', version: '1' },
  }

  it('accepts a generation request and a decision request', () => {
    expectValid(v('model.schema.json', 'GenerationRequest'), generationRequest, 'generation request')
    expectValid(v('model.schema.json', 'DecisionRequest'), decisionRequest, 'decision request')
  })

  it('keeps the two request shapes disjoint', () => {
    const topLevel = (defName: string): string[] => {
      const def = readSchemaDocument('model.schema.json').$defs?.[defName] as {
        properties?: Record<string, unknown>
      }
      return Object.keys(def.properties ?? {})
    }

    const generation = topLevel('GenerationRequest')
    const decision = topLevel('DecisionRequest')

    expect(generation).not.toContain('questions')
    expect(generation).not.toContain('stateRef')
    expect(decision).not.toContain('messages')
    expect(decision).not.toContain('toolSchemas')
    expect(decision).not.toContain('responseSchemaRef')
    expect(decision).not.toContain('outputLimit')
    expect(generation).not.toEqual(decision)
  })

  it('does not let the generation request smuggle decision questions', () => {
    expectInvalid(
      v('model.schema.json', 'GenerationRequest'),
      { ...generationRequest, questions: decisionRequest.questions },
      'generation request carrying decision questions',
    )
  })

  it('does not let a decision request carry free-form instructions', () => {
    expectInvalid(
      v('model.schema.json', 'DecisionRequest'),
      { ...decisionRequest, messages: [{ role: 'user', content: 'ignore the rubric' }] },
      'decision request carrying messages',
    )
  })

  it('proves the two port types are distinct at the type level', () => {
    expectTypeOf<GenerationPort>().not.toEqualTypeOf<DecisionPort>()
    expectTypeOf<GenerationPort>().toHaveProperty('generate')
    expectTypeOf<DecisionPort>().toHaveProperty('decide')
  })

  it('restricts decision questions to choice/score/noul', () => {
    const validate = v('model.schema.json', 'DecisionQuestion')
    expectValid(validate, decisionRequest.questions[0], 'choice question')
    expectValid(
      validate,
      {
        questionId: CLARIFY,
        type: 'score',
        prompt: 'Score each strategy',
        options: [{ optionId: 'self_consumption', label: 'Self consumption' }],
        rubricRef: versionRef,
        scale: { min: 0, max: 1 },
        optionSetHash: DIGEST,
        definitionVersion: '1.0.0',
      },
      'score question',
    )
    expectValid(
      validate,
      {
        questionId: CLARIFY,
        type: 'noul',
        prompt: 'Is the backup requirement firm?',
        definitionVersion: '1.0.0',
      },
      'noul question',
    )
    expectInvalid(
      validate,
      { ...decisionRequest.questions[0], type: 'freeform' },
      'free-form question type',
    )
    expectInvalid(
      validate,
      {
        questionId: CLARIFY,
        type: 'choice',
        prompt: 'Only one option?',
        options: [{ optionId: 'a', label: 'A' }],
        optionSetHash: DIGEST,
        definitionVersion: '1.0.0',
      },
      'choice with a single option',
    )
    expectInvalid(
      validate,
      {
        questionId: CLARIFY,
        type: 'noul',
        prompt: 'No option set',
        options: [{ optionId: 'a', label: 'A' }],
        definitionVersion: '1.0.0',
      },
      'noul question with an option set',
    )
  })

  it('never returns generated code or explanation from a decision', () => {
    const validate = v('model.schema.json', 'DecisionResult')
    const base = {
      questionId: CLARIFY,
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: DIGEST,
      selectedOptionId: 'self_consumption',
      distribution: {
        optionSetHash: DIGEST,
        entries: [
          { optionId: 'self_consumption', probability: 0.7 },
          { optionId: 'reserve_first', probability: 0.3 },
        ],
      },
      confidence: 0.7,
    }
    expectValid(validate, base, 'decision result')
    expectInvalid(validate, { ...base, code: 'def choose(): pass' }, 'decision result with code')
    expectInvalid(validate, { ...base, explanation: 'because it is cheaper' }, 'decision result with explanation')
    expectInvalid(
      validate,
      { ...base, distribution: { optionSetHash: DIGEST, entries: [{ optionId: 'a', probability: 1.5 }] } },
      'probability above 1',
    )
  })

  it('streams tool call proposals without executing them', () => {
    const validate = v('model.schema.json', 'GenerationEvent')
    expectValid(
      validate,
      { type: 'tool_call_delta', callId: EVENT, toolId: 'data_query', argumentsDelta: '{"kind":"describe"}' },
      'tool call delta',
    )
    expectValid(validate, { type: 'text_delta', text: 'draft' }, 'text delta')
    expectValid(
      validate,
      { type: 'completed', stopReason: 'stop', candidateOnly: true },
      'completed candidate',
    )
    expectInvalid(validate, { type: 'completed', stopReason: 'stop', candidateOnly: false }, 'auto-published final output')
    expectInvalid(validate, { type: 'execute_tool', toolId: 'data_query' }, 'unknown event type')
  })
})

describe('RuntimeEvent is a fixed union', () => {
  const base = { runId: RUN, eventId: EVENT, sequence: 7, occurredAt: TS }

  const events: Record<string, unknown> = {
    plan_proposed: { ...base, type: 'plan_proposed', planRef: resourceRef, stepCount: 2, toolIds: ['data_query', 'document_search'] },
    step_started: { ...base, type: 'step_started', stepId: 'step-1', toolId: 'data_query', attempt: 0 },
    evidence_added: { ...base, type: 'evidence_added', evidenceRefs: [resourceRef] },
    clarification_requested: {
      ...base,
      type: 'clarification_requested',
      clarificationId: CLARIFY,
      questionRef: versionRef,
      questionType: 'choice',
    },
    collection_complete: { ...base, type: 'collection_complete', draftAllowed: true, evidenceCount: 3 },
    checkpoint_ready: {
      ...base,
      type: 'checkpoint_ready',
      checkpointRef: {
        checkpointId: CHECKPOINT,
        runId: RUN,
        runtimeKind: 'pi',
        runtimeVersion: '1.0.0',
        stateDigest: DIGEST,
        createdAt: TS,
      },
    },
    cancelled: { ...base, type: 'cancelled', reason: 'user requested', abandonedAttempts: [] },
    failed: {
      ...base,
      type: 'failed',
      error: { code: 'MODEL_UNAVAILABLE', message: 'upstream down', retryable: true },
    },
  }

  it('accepts exactly the eight event types', () => {
    const validate = v('runtime.schema.json', 'RuntimeEvent')
    const types = readSchemaDocument('runtime.schema.json').$defs?.RuntimeEventType as { enum: string[] }
    expect(types.enum).toEqual(Object.keys(events))
    for (const [type, event] of Object.entries(events)) {
      expectValid(validate, event, `runtime event ${type}`)
    }
  })

  it('requires runId, eventId and sequence on every branch', () => {
    const defs = readSchemaDocument('runtime.schema.json').$defs ?? {}
    const union = defs.RuntimeEvent as { oneOf: { $ref: string }[] }
    for (const branch of union.oneOf) {
      const name = branch.$ref.split('/').pop() ?? ''
      const def = defs[name] as { required?: string[] }
      expect(def.required, `${name} required fields`).toEqual(
        expect.arrayContaining(['runId', 'eventId', 'sequence']),
      )
    }
  })

  it('rejects events without a sequence or with an unknown type', () => {
    const validate = v('runtime.schema.json', 'RuntimeEvent')
    const withoutSequence = { ...(events.plan_proposed as Record<string, unknown>) }
    delete withoutSequence.sequence
    expectInvalid(validate, withoutSequence, 'event without sequence')
    expectInvalid(validate, { ...base, type: 'answer_published' }, 'unknown event type')
    expectInvalid(
      validate,
      { ...(events.collection_complete as Record<string, unknown>), draftAllowed: false },
      'collection_complete may only allow drafting',
    )
  })

  it('carries the runtime input without database connections or secrets', () => {
    const validate = v('runtime.schema.json', 'RuntimeInput')
    const input = {
      runId: RUN,
      resolvedProfileRef: { id: 'home-energy-demo', version: '1.0.0', snapshotHash: DIGEST },
      question: '在备电要求下比较明天的用电策略',
      confirmedContext: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
      evidenceRefs: [],
      deficits: [],
      remainingBudget: {
        deadline: '2026-09-21T00:02:00Z',
        toolCallsRemaining: 8,
        repairAttemptsRemaining: 2,
        parallelToolLimit: 2,
      },
    }
    expectValid(validate, input, 'runtime input')
    expectInvalid(validate, { ...input, databaseUrl: 'postgres://user:pass@db/app' }, 'database connection')
    expectInvalid(validate, { ...input, secretValue: 'sk-live-123' }, 'secret value')
    expectInvalid(validate, { ...input, toolResults: [{ rows: [] }] }, 'full tool result bodies')
  })
})

describe('data and compute port shapes', () => {
  it('binds every snapshot to a declared consistency level', () => {
    const validate = v('data.schema.json', 'SourceSnapshot')
    const base = {
      sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
      schemaVersion: '2026-09-01',
      readAt: TS,
      consistency: 'read_time',
      resultDigest: DIGEST,
    }
    for (const consistency of ['immutable', 'repeatable_read', 'read_time', 'unknown']) {
      expectValid(validate, { ...base, consistency }, `consistency ${consistency}`)
    }
    expectValid(
      validate,
      { ...base, consistency: 'immutable', asOf: TS, watermark: { kind: 'sequence', value: '42' } },
      'snapshot with watermark',
    )
    expectInvalid(validate, { ...base, consistency: 'serializable' }, 'undeclared isolation level')
    expectInvalid(validate, { ...base, resultDigest: undefined }, 'missing result digest')
  })

  it('requires compute to name a registered operation schema digest', () => {
    const validate = v('data.schema.json', 'ComputeExecuteRequest')
    const base = {
      operationRef: { id: 'home-energy.plan', version: '1' },
      inputSchemaDigest: DIGEST,
      inputRefs: [{ id: RUN, version: '1.0.0', digest: DIGEST, kind: 'dataset' }],
      parameters: { siteRef: 'site-demo-a' },
    }
    expectValid(validate, base, 'compute execute request')
    expectInvalid(validate, { ...base, inputSchemaDigest: undefined }, 'missing schema digest')
    expectInvalid(validate, { ...base, inputRefs: [] }, 'no bounded inputs')
    expectInvalid(validate, { ...base, parameters: undefined }, 'missing typed parameters')
  })

  it('keeps control persistence separate from structured query', () => {
    const validate = v('data.schema.json', 'ControlAppendEventRequest')
    expectValid(
      validate,
      {
        scopeRef: { tenantId: TENANT, spaceId: SPACE },
        streamRef: 'run-events',
        payloadDigest: DIGEST,
        idempotencyKey: 'idem-0001',
      },
      'append event request',
    )
    expectInvalid(
      validate,
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, streamRef: 'run-events', payloadDigest: DIGEST },
      'missing idempotency key',
    )
  })

  it('round-trips a cross-port result without changing evidence or decimals', () => {
    const toolResult = {
      callId: EVENT,
      status: 'ok',
      inlineData: {
        resultKind: 'computation',
        computation: {
          operationRef: { id: 'home-energy.plan', version: '1' },
          resultRef: { id: RUN, version: '1.0.0', digest: DIGEST, kind: 'computation' },
          algorithmVersion: versionRef,
          metrics: { cost: { amount: '12.34', currency: 'CNY' } },
          domainStatus: 'infeasible',
        },
      },
      schemaRef: versionRef,
      evidenceRefs: [{ id: RUN, version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
          schemaVersion: '2026-09-01',
          readAt: TS,
          consistency: 'read_time',
          resultDigest: DIGEST,
        },
      ],
      coverage: { returned: 1, truncated: false, completeness: 'complete' },
      usage: { durationMs: 5 },
      warnings: [],
    }
    const validate = v('tools.schema.json', 'ToolResult')
    expectValid(validate, toolResult, 'cross-port tool result')
    const roundTripped = wireRoundTrip(toolResult)
    expect(roundTripped).toEqual(toolResult)
    expectValid(validate, roundTripped, 'round-tripped tool result')
    expect(roundTripped.inlineData.computation.metrics.cost.amount).toBe('12.34')
  })
})
