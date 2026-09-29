import { describe, expect, it } from 'vitest'
import type { ConfirmedContext, DecisionPort, DecisionResult, ResourceRef, RunPreferences } from '@ontology/contracts'
import { canonicalJson, RunPlanner, sha256DigestOf, WorkflowControllerError } from '@ontology/application'
import type { DecisionStateRefProvider } from '@ontology/application'
import { randomUUID } from 'node:crypto'
import { MAPPING_JOIN } from '../fixtures/semantic-mapping'
import {
  VOCAB_DEFINITION_REF,
  publishedVocabularyDefinition,
  vocabularyService,
} from '../fixtures/schema-vocabulary'
import { gatewayContext } from './tool-gateway-fixtures'
import {
  CountingCompiler,
  CountingDecision,
  CountingGeneration,
  PLANNING_RUN,
  fixedPlan,
  multiHopPlan,
  multiHopPlanJson,
} from './workflow-planning-fixtures'

const CTX = gatewayContext({ runId: PLANNING_RUN })
const CONTEXT: ConfirmedContext = { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' }
const PREFERENCES: RunPreferences = { route: 'auto', allowWeb: false }
const VOCABULARY = vocabularyService([MAPPING_JOIN], [publishedVocabularyDefinition()])
function routeStateRef(state: unknown): ResourceRef {
  return {
    id: randomUUID(),
    version: '1.0.0',
    digest: sha256DigestOf(canonicalJson(state)),
    kind: 'artifact',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stateRefProvider() {
  const archived: Parameters<DecisionStateRefProvider['archive']>[0][] = []
  const refs: ResourceRef[] = []
  const provider: DecisionStateRefProvider = {
    async archive(input) {
      archived.push(input)
      const ref = routeStateRef(input.state)
      refs.push(ref)
      return ref
    },
  }
  return { archived, refs, provider }
}

function decisionResultFor(request: Parameters<DecisionPort['decide']>[0], overrides: Partial<DecisionResult> = {}): DecisionResult {
  const question = request.questions[0]
  if (question === undefined) throw new Error('the planner did not include its route question')
  return {
    questionId: question.questionId,
    questionType: question.type,
    definitionVersion: question.definitionVersion,
    optionSetHash: question.type === 'noul' ? sha256DigestOf(question.questionId) : question.optionSetHash,
    ...overrides,
  }
}

function request(overrides?: {
  readonly question?: string
  readonly fixedPlan?: ReturnType<typeof fixedPlan>
  readonly candidatePlan?: ReturnType<typeof multiHopPlan>
  readonly signals?: { readonly ambiguous?: boolean; readonly routeAmbiguous?: boolean }
}) {
  return {
    runId: PLANNING_RUN,
    question: overrides?.question ?? 'which meters consumed the most energy and which site do they belong to',
    context: CONTEXT,
    preferences: PREFERENCES,
    mappingRefs: [MAPPING_JOIN.mappingRef],
    definitionRefs: [VOCAB_DEFINITION_REF],
    ...(overrides?.fixedPlan === undefined ? {} : { fixedPlan: overrides.fixedPlan }),
    ...(overrides?.candidatePlan === undefined ? {} : { candidatePlan: overrides.candidatePlan }),
    ...(overrides?.signals === undefined ? {} : { signals: overrides.signals }),
  }
}

describe('routing', () => {
  it('does not force a JEV decision on a clearly specified path', async () => {
    const decision = new CountingDecision()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), decision })
    const fixed = fixedPlan()

    const routed = await planner.route(request({ fixedPlan: fixed }), CTX)

    expect(routed.route).toBe('fixed_path')
    expect(routed.plan).toEqual(fixed)
    expect(decision.calls).toHaveLength(0)
  })

  it('gives an ordinary complex question one executable small plan by default', async () => {
    const generation = new CountingGeneration()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), generation })

    const routed = await planner.route(request(), CTX)

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(false)
    // At most one proposal for the whole question; a bounded default plan when it is empty.
    expect(generation.calls).toHaveLength(1)
  })

  it('clarifies a concrete ambiguity first without consulting JEV', async () => {
    const decision = new CountingDecision()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), decision })

    const routed = await planner.route(request({ signals: { ambiguous: true } }), CTX)

    expect(routed.route).toBe('clarify')
    expect(routed.clarification).toBeDefined()
    expect(routed.plan).toBeUndefined()
    expect(decision.calls).toHaveLength(0)
  })

  it('consults JEV only for genuine route ambiguity and falls back to clarification', async () => {
    const decision = new CountingDecision()
    decision.selected = 'small_plan'
    const routeState = stateRefProvider()
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: routeState.provider,
    })

    const chosen = await planner.route(request({ signals: { routeAmbiguous: true } }), CTX)
    expect(chosen.route).toBe('small_plan')
    expect(decision.calls).toHaveLength(1)
    expect(decision.calls[0]?.stateRef).toEqual(routeState.refs[0])
    expect(routeState.archived).toHaveLength(1)
    expect(routeState.archived[0]).toMatchObject({
      runId: PLANNING_RUN,
      resolvedProfileHash: CTX.resolvedProfileHash,
      state: {
        kind: 'core_run_route_decision',
        question: request().question,
        context: CONTEXT,
        candidateRoutes: [
          { optionId: 'small_plan', toolIds: ['data_query', 'ontology_lookup'] },
          { optionId: 'clarify', toolIds: [] },
        ],
        confirmedSchema: {
          mappingRefs: [MAPPING_JOIN.mappingRef],
          definitionRefs: [VOCAB_DEFINITION_REF],
        },
      },
    })
    const archivedState = routeState.archived[0]?.state
    if (!isRecord(archivedState) || !isRecord(archivedState['confirmedSchema'])) {
      throw new Error('the planner did not archive the actual confirmed route state')
    }
    expect(archivedState['confirmedSchema']['vocabularyRef']).toMatchObject({
      id: expect.any(String),
      version: expect.any(String),
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    })
    expect(archivedState['confirmedSchema']['sources']).toEqual(expect.arrayContaining([
      MAPPING_JOIN.mappingRef,
      VOCAB_DEFINITION_REF,
    ]))

    decision.fail = true
    const failed = await planner.route(request({ signals: { routeAmbiguous: true } }), CTX)
    expect(failed.route).toBe('clarify')
    expect(failed.fallback).toBe('jev_failed:MODEL_UNAVAILABLE')
  })

  it('refuses to call JEV when the trusted route-state archive is not configured', async () => {
    const decision = new CountingDecision()
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
    })

    const routed = await planner.route(request({ signals: { routeAmbiguous: true } }), CTX)

    expect(routed.route).toBe('clarify')
    expect(routed.fallback).toBe('jev_state_not_configured')
    expect(decision.calls).toHaveLength(0)
  })

  it('does not archive or call JEV when the bounded actual route state would be too large', async () => {
    const decision = new CountingDecision()
    const routeState = stateRefProvider()
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: routeState.provider,
    })

    const routed = await planner.route(request({
      question: 'q'.repeat(70_000),
      signals: { routeAmbiguous: true },
    }), CTX)

    expect(routed.route).toBe('clarify')
    expect(routed.fallback).toBe('jev_state_too_large')
    expect(routeState.archived).toHaveLength(0)
    expect(decision.calls).toHaveLength(0)
  })

  it('propagates state archive failures and rejects incomplete refs before JEV', async () => {
    const archiveFailure = new Error('decision state registration failed')
    const decision = new CountingDecision()
    const failingProvider: DecisionStateRefProvider = {
      archive: () => Promise.reject(archiveFailure),
    }
    const failingPlanner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: failingProvider,
    })
    await expect(failingPlanner.route(request({ signals: { routeAmbiguous: true } }), CTX)).rejects.toBe(archiveFailure)
    expect(decision.calls).toHaveLength(0)

    const invalidProvider: DecisionStateRefProvider = {
      archive: async (input) => ({ ...routeStateRef(input.state), kind: 'plan' }),
    }
    const invalidPlanner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: invalidProvider,
    })
    await expect(invalidPlanner.route(request({ signals: { routeAmbiguous: true } }), CTX)).rejects.toBeInstanceOf(WorkflowControllerError)
    expect(decision.calls).toHaveLength(0)
  })

  it('keeps JEV budget, evidence-persistence and deadline errors fatal while returning explicit provider fallbacks', async () => {
    const archived = stateRefProvider()
    const failures: unknown[] = [
      ...['BUDGET_EXHAUSTED', 'EVIDENCE_PERSIST_FAILED', 'DEADLINE_EXCEEDED', 'INTERNAL_ERROR'].map((code) =>
        Object.assign(new Error(`fatal ${code}`), { code })),
      new DOMException('route decision cancelled', 'AbortError'),
      new Error('unclassified state or settlement failure'),
    ]
    for (const failure of failures) {
      const decision: DecisionPort = { decide: () => Promise.reject(failure) }
      const planner = new RunPlanner({
        vocabulary: VOCABULARY,
        compiler: new CountingCompiler(),
        decision,
        decisionModelRef: { modelId: 'jev', version: '1.0.0' },
        decisionStateRefProvider: archived.provider,
      })
      await expect(planner.route(request({ signals: { routeAmbiguous: true } }), CTX)).rejects.toBe(failure)
    }

    const fallbackDecision: DecisionPort = {
      decide: async (decisionRequest) => decisionResultFor(decisionRequest, {
        fallback: {
          fallback: 'clarify',
          fallbackReason: 'provider unavailable',
          originalFailure: { code: 'MODEL_UNAVAILABLE', message: 'provider unavailable', retryable: true },
        },
      }),
    }
    const fallbackPlanner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision: fallbackDecision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: archived.provider,
    })
    const fallback = await fallbackPlanner.route(request({ signals: { routeAmbiguous: true } }), CTX)
    expect(fallback.route).toBe('clarify')
    expect(fallback.fallback).toBe('jev_provider_fallback:clarify')
  })
})

describe('small plan and single-SQL multi-hop', () => {
  it('compiles a three-hop question into one bounded query without a per-hop model call', async () => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    const routed = await planner.route(request({ candidatePlan: multiHopPlan() }), CTX)

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(true)
    expect(routed.plan?.steps[0]?.toolId).toBe('data_query')
    // One compilation for the whole multi-hop query, and the model is never called per hop.
    expect(compiler.calls).toHaveLength(1)
    expect(generation.calls).toHaveLength(0)
  })

  it('makes at most one generation proposal for a complex question, never one per hop', async () => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration().script([
      {
        type: 'tool_call_delta',
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        argumentsDelta: multiHopPlanJson(),
      },
      { type: 'completed', stopReason: 'tool_calls', candidateOnly: true },
    ])
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    const routed = await planner.route(request(), CTX)

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(true)
    expect(generation.calls).toHaveLength(1)
    expect(compiler.calls).toHaveLength(1)
  })
})
