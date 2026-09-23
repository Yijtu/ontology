import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore, sha256DigestOf } from '@ontology/core'
import type {
  BudgetLedgerPort,
  ConfirmedContext,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  ResourceRef,
  RunPreferences,
  ToolContext,
} from '@ontology/contracts'
import { BoundedQuestionRewriter, RunPlanner, parseQuestionRewrite } from '@ontology/application'
import { MAPPING_JOIN } from '../fixtures/semantic-mapping'
import {
  VOCAB_DEFINITION_REF,
  publishedVocabularyDefinition,
  vocabularyService,
} from '../fixtures/schema-vocabulary'
import { gatewayContext } from './tool-gateway-fixtures'
import { RecordingControlRepository } from './component-registry-fixtures'
import {
  CountingCompiler,
  PLANNING_RUN,
  multiHopPlanJson,
} from './workflow-planning-fixtures'

const CTX = gatewayContext({ runId: PLANNING_RUN })
const CONTEXT: ConfirmedContext = { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' }
const PREFERENCES: RunPreferences = { route: 'auto', allowWeb: false }
const MODEL_REF = { modelId: 'rewrite-model', version: '1.0.0' }
const PLANNER_VOCABULARY = vocabularyService([MAPPING_JOIN], [publishedVocabularyDefinition()])
const PLAN_SOURCES = { mappingRefs: [MAPPING_JOIN.mappingRef], definitionRefs: [VOCAB_DEFINITION_REF] }

const ORIGINAL = 'which meters used the most energy and which site do they belong to'
const REWRITTEN =
  'List the meters with the highest total energy_kwh and their site names for the current billing period'

function rewriteText(question: string): GenerationEvent {
  return {
    type: 'text_delta',
    text: JSON.stringify({ status: 'rewritten', question }),
  }
}

function clarifyText(reason: string): GenerationEvent {
  return { type: 'text_delta', text: JSON.stringify({ status: 'clarify', reason }) }
}

function completed(): GenerationEvent {
  return { type: 'completed', stopReason: 'stop', candidateOnly: true }
}

function modelUnavailable(): GenerationEvent {
  return {
    type: 'error',
    error: { code: 'MODEL_UNAVAILABLE', message: 'the model is unavailable', retryable: true },
  }
}

/** Yields one scripted stream per `generate` call and records every request. */
class ScriptedGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  readonly #scripts: GenerationEvent[][]

  constructor(scripts: readonly (readonly GenerationEvent[])[]) {
    this.#scripts = scripts.map((script) => [...script])
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    this.calls.push(request)
    for (const event of this.#scripts.shift() ?? []) yield event
  }
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
}

/**
 * A generation double backed by a real shared budget ledger. Each `generate` reserves a
 * parallel slot and its token estimate from the one ledger, yields its script, then settles.
 * It proves the rewrite attempts and the later SQL proposal draw from the same monotonic
 * counters: nothing here opens or resets a ledger.
 */
class BudgetedGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  readonly tokensRemainingAfter: number[] = []
  readonly #budget: BudgetLedgerPort
  readonly #ledgerId: string
  readonly #scripts: GenerationEvent[][]
  #counter = 0

  constructor(
    budget: BudgetLedgerPort,
    ledgerId: string,
    scripts: readonly (readonly GenerationEvent[])[],
  ) {
    this.#budget = budget
    this.#ledgerId = ledgerId
    this.#scripts = scripts.map((script) => [...script])
  }

  async *generate(request: GenerationRequest, ctx: ToolContext): AsyncIterable<GenerationEvent> {
    this.calls.push(request)
    this.#counter += 1
    const outcome = await this.#budget.reserve(
      {
        ledgerId: this.#ledgerId,
        idempotencyKey: `budgeted-generation-${String(this.#counter).padStart(4, '0')}`,
        parallel: true,
        modelTokens: request.outputLimit.maxTokens,
        requestedDeadline: ctx.deadline,
      },
      ctx,
    )
    if (!outcome.granted || outcome.reservation === undefined) {
      throw new Error(`the shared budget denied the generation call: ${outcome.denial?.code ?? 'unknown'}`)
    }
    for (const event of this.#scripts.shift() ?? []) yield event
    await this.#budget.settle(
      {
        ledgerId: this.#ledgerId,
        reservationId: outcome.reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 1, modelTokens: 10 },
        evidenceRefs: [evidenceRef()],
      },
      ctx,
    )
    const remaining = await this.#budget.remaining(this.#ledgerId, ctx)
    this.tokensRemainingAfter.push(remaining.remaining.tokensRemaining ?? -1)
  }
}

function request(question = ORIGINAL) {
  return {
    runId: PLANNING_RUN,
    question,
    context: CONTEXT,
    preferences: PREFERENCES,
    ...PLAN_SOURCES,
  }
}

describe('parseQuestionRewrite', () => {
  it('accepts only a well-formed rewrite or clarification', () => {
    expect(parseQuestionRewrite(JSON.stringify({ status: 'rewritten', question: 'q' }))).toEqual({
      status: 'rewritten',
      question: 'q',
    })
    expect(parseQuestionRewrite(JSON.stringify({ status: 'clarify', reason: 'r' }))).toEqual({
      status: 'clarify',
      reason: 'r',
    })
    expect(parseQuestionRewrite('not json')).toBeUndefined()
    expect(parseQuestionRewrite(JSON.stringify({ status: 'rewritten', question: '' }))).toBeUndefined()
    expect(parseQuestionRewrite(JSON.stringify({ status: 'rewritten' }))).toBeUndefined()
    expect(parseQuestionRewrite(JSON.stringify({ status: 'guess', question: 'q' }))).toBeUndefined()
    expect(parseQuestionRewrite(JSON.stringify({ status: 'clarify' }))).toBeUndefined()
  })
})

describe('question rewriting before SQL generation', () => {
  it('rewrites the question and routes the rewritten one into the SQL proposal', async () => {
    const generation = new ScriptedGeneration([
      [rewriteText(REWRITTEN), completed()],
      [
        {
          type: 'tool_call_delta',
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDelta: multiHopPlanJson(),
        },
        completed(),
      ],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    const decision = await planner.route(request(), CTX)

    expect(decision.route).toBe('small_plan')
    expect(decision.plan?.singleQuery).toBe(true)
    // The rewrite is one bounded call; the SQL proposal is the second.
    expect(generation.calls).toHaveLength(2)
    expect(generation.calls[0]?.role).toBe('planner')
    expect(generation.calls[0]?.messages.at(-1)?.content).toBe(ORIGINAL)
    // The SQL proposal never sees the original: only the rewritten question.
    expect(generation.calls[1]?.role).toBe('sql_proposer')
    expect(generation.calls[1]?.messages.at(-1)?.content).toBe(REWRITTEN)
  })

  it('records a replayable original -> rewrite trace on the decision', async () => {
    const generation = new ScriptedGeneration([[rewriteText(REWRITTEN), completed()]])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    const decision = await planner.route(request(), CTX)
    const rewrite = decision.rewrite

    expect(rewrite).toBeDefined()
    expect(rewrite?.runId).toBe(PLANNING_RUN)
    expect(rewrite?.version).toBe('1.0.0')
    expect(rewrite?.originalQuestion).toBe(ORIGINAL)
    expect(rewrite?.rewrittenQuestion).toBe(REWRITTEN)
    expect(rewrite?.originalDigest).toBe(sha256DigestOf(JSON.stringify({ question: ORIGINAL })))
    expect(rewrite?.rewrittenDigest).toBe(sha256DigestOf(JSON.stringify({ question: REWRITTEN })))
    expect(rewrite?.originalDigest).not.toBe(rewrite?.rewrittenDigest)
    expect(rewrite?.modelRef).toEqual(MODEL_REF)
    expect(rewrite?.rewriteId.length).toBeGreaterThan(0)
  })

  it('clarifies an ambiguous question without guessing a value or proposing SQL', async () => {
    const generation = new ScriptedGeneration([
      [clarifyText('the billing period is not specified'), completed()],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    const decision = await planner.route(request('compare the energy strategies'), CTX)

    expect(decision.route).toBe('clarify')
    expect(decision.clarification?.prompt).toContain('billing period')
    expect(decision.plan).toBeUndefined()
    expect(decision.rewrite).toBeUndefined()
    // Only the rewrite ran; no value was guessed and no SQL proposal was made.
    expect(generation.calls).toHaveLength(1)
  })

  it('surfaces an explicit failure when the rewrite model is unavailable', async () => {
    const generation = new ScriptedGeneration([[modelUnavailable()]])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    await expect(planner.route(request(), CTX)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    // The original question is never passed through as if it had been rewritten.
    expect(generation.calls).toHaveLength(1)
  })

  it('fails explicitly and boundedly when the rewrite output stays malformed', async () => {
    const generation = new ScriptedGeneration([
      [{ type: 'text_delta', text: 'not a rewrite' }, completed()],
      [{ type: 'text_delta', text: '{"status":"guess"}' }, completed()],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF, maxAttempts: 2 })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    await expect(planner.route(request(), CTX)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    // Bounded retries: exactly the configured attempts, then an explicit failure.
    expect(generation.calls).toHaveLength(2)
  })

  it('draws rewrite retries and the SQL proposal from one shared budget without resetting it', async () => {
    const budgetStore = new InMemoryBudgetLedgerStore()
    const budget = new BudgetService({
      store: budgetStore,
      control: new RecordingControlRepository(),
      newId: () => randomUUID(),
    })
    const ledgerId = randomUUID()
    await budget.openLedger(
      { ledgerId, kind: 'run', runId: PLANNING_RUN, overrideLimits: { maxModelTokens: 4096 } },
      CTX,
    )
    const generation = new BudgetedGeneration(budget, ledgerId, [
      [{ type: 'text_delta', text: 'malformed' }, completed()],
      [rewriteText(REWRITTEN), completed()],
      [
        {
          type: 'tool_call_delta',
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDelta: multiHopPlanJson(),
        },
        completed(),
      ],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF, maxAttempts: 2 })
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
      rewriter,
    })

    const decision = await planner.route(request(), CTX)

    expect(decision.route).toBe('small_plan')
    // rewrite (malformed), rewrite retry, SQL proposal: three calls on the same ledger.
    expect(generation.calls).toHaveLength(3)
    expect(generation.tokensRemainingAfter).toHaveLength(3)
    const [first = -1, second = -1, third = -1] = generation.tokensRemainingAfter
    expect(second).toBeLessThan(first)
    expect(third).toBeLessThan(second)
  })

  it('does not run a rewrite step when none is configured', async () => {
    const generation = new ScriptedGeneration([
      [
        {
          type: 'tool_call_delta',
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDelta: multiHopPlanJson(),
        },
        completed(),
      ],
    ])
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new CountingCompiler(),
      generation,
    })

    const decision = await planner.route(request(), CTX)

    expect(decision.route).toBe('small_plan')
    expect(decision.rewrite).toBeUndefined()
    expect(generation.calls).toHaveLength(1)
  })
})
