import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DecisionPort,
  DecisionResult,
  GenerationEvent,
  GenerationPort,
  ToolContext,
} from '@ontology/contracts'
import { sampleProfileSpec } from '../unit/profile-resolver-fixtures'
import {
  budgetHarness as companyBudgetHarness,
  collect as collectGeneration,
  generationRequest,
  makeAdapter as makeCompanyAdapter,
  startCompanyServer,
  type CompanyServer,
} from '../unit/model-company-fixtures'
import {
  budgetHarness as jevBudgetHarness,
  choiceQuestion,
  decisionRequest,
  makeAdapter as makeJevAdapter,
  startJevServer,
  CHOICE_QUESTION_ID,
  OPTION_SET_HASH,
  type JevServer,
} from '../unit/model-jev-fixtures'

/**
 * X-05 — the company generation model and the JEV decision model are independent ports.
 *
 * Both adapters are real (LOCAL-008/ADR-09) but are pointed at controlled, deterministic
 * in-process HTTP doubles: no real or paid model is called. The suite marks that explicitly
 * and checks that the two roles never blur — generation emits text/tool/usage events, the
 * decision port returns only typed choice/score/noul results, errors stay typed, usage is
 * preserved and degradation is visible.
 */

let companyServer: CompanyServer
let jevServer: JevServer

beforeAll(async () => {
  companyServer = await startCompanyServer()
  jevServer = await startJevServer()
})

afterAll(async () => {
  await companyServer?.close().catch(() => undefined)
  await jevServer?.close().catch(() => undefined)
})

/** A controlled generation double (no model): it is the marked substitute, not a real call. */
const controlledGeneration: GenerationPort = {
  generate: (): AsyncIterable<GenerationEvent> =>
    (async function* (): AsyncGenerator<GenerationEvent, void, void> {
      yield { type: 'text_delta', text: 'controlled generation double' }
      yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
    })(),
}

/** A controlled decision double (no model): deterministic, typed and explicitly uncalibrated. */
const controlledDecision: DecisionPort = {
  decide: (): Promise<DecisionResult> =>
    Promise.resolve({
      questionId: CHOICE_QUESTION_ID,
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: OPTION_SET_HASH,
      selectedOptionId: 'self_consumption',
    }),
}

/** The same orchestrator code runs with either port implementation swapped independently. */
async function draftThenDecide(
  generation: GenerationPort,
  decision: DecisionPort,
  ctx: ToolContext,
): Promise<{ readonly generationEvents: readonly GenerationEvent[]; readonly decisionResult: DecisionResult }> {
  const generationEvents = await collectGeneration(generation.generate(generationRequest(), ctx))
  const decisionResult = await decision.decide(decisionRequest([choiceQuestion()]), ctx)
  return { generationEvents, decisionResult }
}

describe('X-05 — generation and decision are separate, typed model ports', () => {
  it('keeps the generation role free of probability output', async () => {
    const harness = await companyBudgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeCompanyAdapter({ server: companyServer, fixture: 'normal', harness })
    const events = await collectGeneration(adapter.generate(generationRequest(), harness.ctx))

    expect(events.some((event) => event.type === 'text_delta')).toBe(true)
    const usage = events.find((event) => event.type === 'usage')
    expect(usage?.type).toBe('usage')
    expect(events.at(-1)?.type).toBe('completed')
    expect(events.some((event) => event.type === 'error')).toBe(false)
    // The generation port never returns a calibrated distribution or confidence field.
    expect(JSON.stringify(events)).not.toContain('probability')
    expect(JSON.stringify(events)).not.toContain('distribution')
  })

  it('keeps the decision role to typed choice/score/noul fields only', async () => {
    const harness = await jevBudgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeJevAdapter({ server: jevServer, fixture: 'choice', harness })
    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(Object.keys(result).sort()).toEqual([
      'confidence',
      'definitionVersion',
      'distribution',
      'optionSetHash',
      'questionId',
      'questionType',
      'selectedOptionId',
    ])
    expect(result.questionType).toBe('choice')
    // No free-form explanation or generated code can appear on the decision port.
    expect(JSON.stringify(result)).not.toContain('text')
  })

  it('preserves typed errors and measured usage on both ports', async () => {
    const companyHarness = await companyBudgetHarness({ maxModelTokens: 1_000 })
    const company = makeCompanyAdapter({
      server: companyServer,
      fixture: 'http_503',
      harness: companyHarness,
      maxAttempts: 1,
    })
    const generationEvents = await collectGeneration(company.generate(generationRequest(), companyHarness.ctx))
    const failure = generationEvents.find((event) => event.type === 'error')
    expect(failure?.type === 'error' ? failure.error.code : undefined).toBe('MODEL_UNAVAILABLE')
    // The failed attempt still reports usage (here explicitly unknown, not silently dropped).
    const usage = generationEvents.find((event) => event.type === 'usage')
    expect(usage?.type).toBe('usage')

    const jevHarness = await jevBudgetHarness({ maxModelTokens: 1_000 })
    const jev = makeJevAdapter({
      server: jevServer,
      fixture: 'http_429',
      harness: jevHarness,
      fallbackPolicy: 'reject',
      maxAttempts: 1,
    })
    await expect(jev.decide(decisionRequest([choiceQuestion()]), jevHarness.ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 2_000,
    })
  })

  it('makes JEV degradation visible instead of fabricating calibrated output', async () => {
    const harness = await jevBudgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeJevAdapter({
      server: jevServer,
      fixture: 'http_503',
      harness,
      fallbackPolicy: 'clarify',
      maxAttempts: 1,
    })
    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result.fallback?.fallback).toBe('clarify')
    expect(result.fallback?.fallbackReason).toContain('MODEL_UNAVAILABLE')
    expect(result.confidence).toBeUndefined()
    expect(result.distribution).toBeUndefined()
  })
})

describe('X-05 — either model port can be replaced independently', () => {
  it('runs the same orchestrator with the real generation + stub decision and vice versa', async () => {
    const companyHarness = await companyBudgetHarness({ maxModelTokens: 1_000 })
    const realGeneration = makeCompanyAdapter({ server: companyServer, fixture: 'normal', harness: companyHarness })
    const jevHarness = await jevBudgetHarness({ maxModelTokens: 1_000 })
    const realDecision = makeJevAdapter({ server: jevServer, fixture: 'choice', harness: jevHarness })

    const realGenerationStubDecision = await draftThenDecide(realGeneration, controlledDecision, companyHarness.ctx)
    const stubGenerationRealDecision = await draftThenDecide(controlledGeneration, realDecision, jevHarness.ctx)

    for (const run of [realGenerationStubDecision, stubGenerationRealDecision]) {
      expect(run.generationEvents.length).toBeGreaterThan(0)
      expect(run.decisionResult.questionType).toBe('choice')
    }
    // The controlled doubles are marked; the profile binds the two roles independently.
    const spec = sampleProfileSpec()
    expect(spec.modelBindings.generation?.modelRef.id).toBe('company-llm')
    expect(spec.modelBindings.decision?.modelRef.id).toBe('company-jev')
    expect(spec.modelBindings.decision?.enabled).toBe(false)
  })
})
