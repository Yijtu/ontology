import { describe, expect, it } from 'vitest'
import type { ConfirmedContext, RunPreferences } from '@ontology/contracts'
import { RunPlanner } from '@ontology/application'
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

function request(overrides?: {
  readonly fixedPlan?: ReturnType<typeof fixedPlan>
  readonly candidatePlan?: ReturnType<typeof multiHopPlan>
  readonly signals?: { readonly ambiguous?: boolean; readonly routeAmbiguous?: boolean }
}) {
  return {
    runId: PLANNING_RUN,
    question: 'which meters consumed the most energy and which site do they belong to',
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
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
    })

    const chosen = await planner.route(request({ signals: { routeAmbiguous: true } }), CTX)
    expect(chosen.route).toBe('small_plan')
    expect(decision.calls).toHaveLength(1)

    decision.fail = true
    const failed = await planner.route(request({ signals: { routeAmbiguous: true } }), CTX)
    expect(failed.route).toBe('clarify')
    expect(failed.fallback).toBe('jev_failed')
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
