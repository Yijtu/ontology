import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { DecisionResult } from '@ontology/contracts'
import {
  assertDecisionRequest,
  comparableScoreSet,
  EMPTY_OPTION_SET_HASH,
  rankComparableScores,
} from '@ontology/adapter-model-jev'
import { createAjv, expectValid, validator } from '../contracts/helpers'
import {
  budgetHarness,
  capturingLog,
  choiceQuestion,
  decisionRequest,
  fixedClassifier,
  makeAdapter,
  noulQuestion,
  OPTION_SET_HASH,
  OTHER_OPTION_SET_HASH,
  recordingEvidence,
  scoreQuestion,
  startJevServer,
  TEST_SECRET,
  type JevServer,
} from './model-jev-fixtures'

let ajv: Ajv2020
let validateResult: ValidateFunction
const servers: JevServer[] = []

beforeAll(() => {
  ajv = createAjv()
  validateResult = validator(ajv, 'model.schema.json', 'DecisionResult')
})

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

async function server(): Promise<JevServer> {
  const started = await startJevServer()
  servers.push(started)
  return started
}

describe('JEV decision adapter — per question type result shape', () => {
  it('answers a choice question with options, a normalised distribution and confidence', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result).toEqual<DecisionResult>({
      questionId: '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: OPTION_SET_HASH,
      selectedOptionId: 'self_consumption',
      distribution: {
        optionSetHash: OPTION_SET_HASH,
        entries: [
          { optionId: 'self_consumption', probability: 0.7 },
          { optionId: 'reserve_first', probability: 0.3 },
        ],
      },
      confidence: 0.7,
    })
    expectValid(validateResult, result, 'choice decision result')
  })

  it('answers a score question with bounded scores per option', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'score', harness })

    const result = await adapter.decide(decisionRequest([scoreQuestion()]), harness.ctx)

    expect(result.questionType).toBe('score')
    expect(result.scores).toEqual([
      { optionId: 'self_consumption', score: 10, confidence: 0.8 },
      { optionId: 'reserve_first', score: 5, confidence: 0.8 },
    ])
    expect(result.distribution).toBeUndefined()
    expectValid(validateResult, result, 'score decision result')
  })

  it('answers a noul question with a confidence and no fabricated option set', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'noul', harness })

    const result = await adapter.decide(decisionRequest([noulQuestion()]), harness.ctx)

    expect(result).toEqual<DecisionResult>({
      questionId: '2f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      questionType: 'noul',
      definitionVersion: '1.0.0',
      optionSetHash: EMPTY_OPTION_SET_HASH,
      confidence: 0.9,
    })
    expectValid(validateResult, result, 'noul decision result')
  })

  it('answers a batch atomically with one result per question in order', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'mixed', harness })
    const request = decisionRequest([choiceQuestion(), scoreQuestion(), noulQuestion()])

    const results = await adapter.decideAll(request, harness.ctx)

    expect(results.map((result) => result.questionType)).toEqual(['choice', 'score', 'noul'])
    for (const result of results) expectValid(validateResult, result, `batch ${result.questionType}`)
    // The batch is one atomic call: a single reservation for the whole request.
    expect(api.requests).toHaveLength(1)
  })

  it('refuses a multi-question request through the single-result port method', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'mixed', harness })

    await expect(
      adapter.decide(decisionRequest([choiceQuestion(), scoreQuestion()]), harness.ctx),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })

  it('never emits generated code or free-form explanation', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    const keys = Object.keys(result).sort()
    expect(keys).toEqual([
      'confidence',
      'definitionVersion',
      'distribution',
      'optionSetHash',
      'questionId',
      'questionType',
      'selectedOptionId',
    ])
  })
})

describe('JEV decision adapter — strict output validation', () => {
  const cases: readonly { readonly fixture: string; readonly question: () => ReturnType<typeof choiceQuestion> }[] = [
    { fixture: 'out_of_range', question: choiceQuestion },
    { fixture: 'non_normalised', question: choiceQuestion },
    { fixture: 'missing_option', question: choiceQuestion },
    { fixture: 'mismatched_option', question: choiceQuestion },
  ]

  it('rejects an out-of-range, non-normalised, missing or mismatched probability', async () => {
    for (const testCase of cases) {
      const api = await server()
      const harness = await budgetHarness({ maxModelTokens: 1_000 })
      const adapter = makeAdapter({ server: api, fixture: testCase.fixture, harness })
      await expect(
        adapter.decide(decisionRequest([testCase.question()]), harness.ctx),
        testCase.fixture,
      ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    }
  })

  it('rejects an unknown question type returned by the provider', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'unknown_question_type', harness })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    })
  })

  it('rejects a definition-version mismatch', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'wrong_definition_version', harness })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    })
  })

  it('rejects a score outside the declared scale', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'score_out_of_scale', harness })

    await expect(adapter.decide(decisionRequest([scoreQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    })
  })

  it('rejects a noul result that fabricates an option set', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'noul_with_options', harness })

    await expect(adapter.decide(decisionRequest([noulQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    })
  })

  it('rejects malformed JSON and a non-JSON body', async () => {
    for (const fixture of ['malformed_json', 'not_json']) {
      const api = await server()
      const harness = await budgetHarness({ maxModelTokens: 1_000 })
      const adapter = makeAdapter({ server: api, fixture, harness, maxAttempts: 1 })
      await expect(
        adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx),
        fixture,
      ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    }
  })

  it('rejects a missing or unasked question', async () => {
    for (const fixture of ['missing_question', 'extra_question']) {
      const api = await server()
      const harness = await budgetHarness({ maxModelTokens: 1_000 })
      const adapter = makeAdapter({ server: api, fixture, harness })
      await expect(
        adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx),
        fixture,
      ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    }
  })

  it('rejects an unknown question type at the request boundary', () => {
    const raw = {
      stateRef: { id: 'run', version: '1.0.0', digest: 'sha256:x', kind: 'run' },
      questions: [
        {
          questionId: '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
          type: 'freeform',
          prompt: 'Write a plan',
          definitionVersion: '1.0.0',
        },
      ],
      modelRef: { modelId: 'jev-decision', version: '1.0.0' },
    }
    expect(() => assertDecisionRequest(raw)).toThrowError(/choice, score or noul/)
  })
})

describe('JEV decision adapter — explicit degradation', () => {
  it('clarifies when JEV is unavailable, keeping the fallback reason and failure evidence', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const evidence = recordingEvidence()
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'clarify',
      evidence: evidence.recorder,
      maxAttempts: 1,
    })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result.fallback?.fallback).toBe('clarify')
    expect(result.fallback?.fallbackReason).toContain('MODEL_UNAVAILABLE')
    expect(result.fallback?.originalFailure.code).toBe('MODEL_UNAVAILABLE')
    expect(result.fallback?.originalFailure.detailsRef).toBeDefined()
    expect(result.confidence).toBeUndefined()
    expect(result.distribution).toBeUndefined()
    expectValid(validateResult, result, 'clarify fallback result')
    expect(evidence.requests).toHaveLength(1)
    expect(evidence.requests[0]?.outcome).toBe('fallback')
  })

  it('uses a deterministic fallback that is not a probability judgement', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'deterministic',
      maxAttempts: 1,
    })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result.fallback?.fallback).toBe('deterministic')
    expect(result.selectedOptionId).toBe('self_consumption')
    expect(result.distribution).toBeUndefined()
    expect(result.confidence).toBeUndefined()
    expectValid(validateResult, result, 'deterministic fallback result')
  })

  it('marks a generative classification fallback and never labels its score as calibrated', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'generative_classification',
      generativeClassification: fixedClassifier({ selectedOptionId: 'reserve_first' }),
      maxAttempts: 1,
    })

    const choice = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)
    expect(choice.fallback?.fallback).toBe('generative_classification')
    expect(choice.selectedOptionId).toBe('reserve_first')
    expect(choice.distribution).toBeUndefined()
    expect(choice.confidence).toBeUndefined()
    expectValid(validateResult, choice, 'generative choice fallback')
  })

  it('carries a generative self-reported score in scores, never as a calibrated probability', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'generative_classification',
      generativeClassification: fixedClassifier({
        scores: [
          { optionId: 'self_consumption', score: 9 },
          { optionId: 'reserve_first', score: 2 },
        ],
      }),
      maxAttempts: 1,
    })

    const result = await adapter.decide(decisionRequest([scoreQuestion()]), harness.ctx)

    expect(result.fallback?.fallback).toBe('generative_classification')
    expect(result.scores).toEqual([
      { optionId: 'self_consumption', score: 9 },
      { optionId: 'reserve_first', score: 2 },
    ])
    expect(result.distribution).toBeUndefined()
    expect(result.confidence).toBeUndefined()
    expectValid(validateResult, result, 'generative score fallback')
  })

  it('rejects a generative fallback that selects an option outside the question option set', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'generative_classification',
      generativeClassification: fixedClassifier({ selectedOptionId: 'not-an-option' }),
      maxAttempts: 1,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    })
  })

  it('classifies a rate-limited response with the retry-after it was given', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_429',
      harness,
      fallbackPolicy: 'reject',
      maxAttempts: 1,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 2_000,
    })
  })

  it('degrades on low confidence with the profile policy and records the reason', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'low_confidence',
      harness,
      fallbackPolicy: 'clarify',
      minConfidence: 0.5,
    })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result.fallback?.fallback).toBe('clarify')
    expect(result.fallback?.originalFailure.code).toBe('INSUFFICIENT_DATA')
    expect(result.fallback?.fallbackReason).toContain('INSUFFICIENT_DATA')
    expect(result.confidence).toBeUndefined()
    expectValid(validateResult, result, 'low-confidence fallback result')
  })

  it('surfaces the classified failure instead of degrading when the policy is reject', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'reject',
      maxAttempts: 1,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    })
  })

  it('distinguishes calibrated output from fallback output with a distinct marker', async () => {
    const calibratedApi = await server()
    const calibratedHarness = await budgetHarness({ maxModelTokens: 1_000 })
    const calibrated = await makeAdapter({
      server: calibratedApi,
      fixture: 'choice',
      harness: calibratedHarness,
    }).decide(decisionRequest([choiceQuestion()]), calibratedHarness.ctx)

    const fallbackApi = await server()
    const fallbackHarness = await budgetHarness({ maxModelTokens: 1_000 })
    const fallback = await makeAdapter({
      server: fallbackApi,
      fixture: 'http_503',
      harness: fallbackHarness,
      fallbackPolicy: 'clarify',
      maxAttempts: 1,
    }).decide(decisionRequest([choiceQuestion()]), fallbackHarness.ctx)

    expect(calibrated.fallback).toBeUndefined()
    expect(calibrated.confidence).toBeDefined()
    expect(fallback.fallback).toBeDefined()
    expect(fallback.confidence).toBeUndefined()
    expect(fallback.distribution).toBeUndefined()
  })
})

describe('JEV decision adapter — cross-type score non-comparability', () => {
  function scoreResultWith(optionSetHash: string): DecisionResult {
    return {
      questionId: '1f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      questionType: 'score',
      definitionVersion: '1.0.0',
      optionSetHash,
      scores: [
        { optionId: 'a', score: 5 },
        { optionId: 'b', score: 9 },
      ],
    }
  }

  it('ranks scores that share one question type and option set', () => {
    const set = comparableScoreSet([scoreResultWith(OPTION_SET_HASH)])
    expect(rankComparableScores(set)).toEqual([
      { optionId: 'b', score: 9, rank: 1 },
      { optionId: 'a', score: 5, rank: 2 },
    ])
  })

  it('refuses to rank scores across different option sets', () => {
    expect(() => comparableScoreSet([scoreResultWith(OPTION_SET_HASH), scoreResultWith(OTHER_OPTION_SET_HASH)])).toThrowError(
      /different option sets/,
    )
  })

  it('refuses to rank scores across different question types', () => {
    const choice: DecisionResult = {
      questionId: '0f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: OPTION_SET_HASH,
      distribution: { optionSetHash: OPTION_SET_HASH, entries: [{ optionId: 'a', probability: 1 }] },
    }
    expect(() => comparableScoreSet([scoreResultWith(OPTION_SET_HASH), choice])).toThrowError(
      /different question types/,
    )
  })

  it('refuses to rank a fallback score as if it were calibrated', () => {
    const fallback: DecisionResult = {
      ...scoreResultWith(OPTION_SET_HASH),
      fallback: {
        fallback: 'deterministic',
        fallbackReason: 'JEV unavailable',
        originalFailure: { code: 'MODEL_UNAVAILABLE', message: 'down', retryable: true },
      },
    }
    expect(() => comparableScoreSet([fallback])).toThrowError(/self-reported/)
  })
})

describe('JEV decision adapter — no secret reaches a result, error or log', () => {
  it('redacts a credential the provider echoes in an HTTP error body', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const log = capturingLog()
    const adapter = makeAdapter({
      server: api,
      fixture: 'leak_error',
      harness,
      log: log.log,
      maxAttempts: 1,
    })

    let captured: unknown
    try {
      await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)
      throw new Error('expected the decision call to fail')
    } catch (error) {
      captured = error
    }

    expect(JSON.stringify(captured)).not.toContain(TEST_SECRET)
    expect(JSON.stringify(log.records)).not.toContain(TEST_SECRET)
    expect(captured).toMatchObject({ code: 'UNAUTHENTICATED' })
    if (captured instanceof Error) expect(captured.message).toContain('[redacted]')
    // The credential really was injected, but only into the request header.
    expect(api.requests[0]?.authorization).toBe(`Bearer ${TEST_SECRET}`)
  })

  it('never puts the credential into an emitted decision result', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(JSON.stringify(result)).not.toContain(TEST_SECRET)
    expect(JSON.stringify(result)).not.toContain('Bearer')
  })
})
