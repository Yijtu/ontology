import { describe, expect, it } from 'vitest'
import { TOOL_CATALOGUE } from '@ontology/contracts'
import type { ConfirmedContext, DecisionPort, DecisionResult, GenerationPort, ResourceRef, RunPreferences } from '@ontology/contracts'
import { canonicalJson, RunPlanner, sha256DigestOf, WorkflowControllerError } from '@ontology/application'
import type { DecisionStateRefProvider, PlanRequest } from '@ontology/application'
import { randomUUID } from 'node:crypto'
import { MAPPING_JOIN } from '../fixtures/semantic-mapping'
import {
  VOCAB_DEFINITION_REF,
  publishedVocabularyDefinition,
  vocabularyService,
} from '../fixtures/schema-vocabulary'
import { canonicalToolValidator, gatewayContext } from './tool-gateway-fixtures'
import {
  CountingCompiler,
  CountingDecision,
  CountingGeneration,
  PLANNING_RUN,
  fixedPlan,
  multiHopPlan,
  multiHopPlanJson,
} from './workflow-planning-fixtures'

function planningContext() {
  return gatewayContext({
    runId: PLANNING_RUN,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  })
}
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
  readonly routeClarification?: PlanRequest['routeClarification']
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
    ...(overrides?.routeClarification === undefined ? {} : { routeClarification: overrides.routeClarification }),
  }
}

describe('routing', () => {
  it('does not force a JEV decision on a clearly specified path', async () => {
    const decision = new CountingDecision()
    const generation = new CountingGeneration()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), decision, generation })
    const fixed = fixedPlan()

    const routed = await planner.route(request({ fixedPlan: fixed }), planningContext())

    expect(routed.route).toBe('fixed_path')
    expect(routed.plan).toEqual(fixed)
    expect(decision.calls).toHaveLength(0)
    expect(generation.calls).toHaveLength(0)
  })

  it('gives an ordinary complex question one compiled query after one completed proposal', async () => {
    const generation = new CountingGeneration().script([
      {
        type: 'tool_call_delta',
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        argumentsDelta: multiHopPlanJson(),
      },
      { type: 'completed', stopReason: 'tool_calls', candidateOnly: true },
    ])
    const compiler = new CountingCompiler()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    const routed = await planner.route(request(), planningContext())

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(true)
    // At most one proposal for the whole question and one semantic compile.
    expect(generation.calls).toHaveLength(1)
    expect(compiler.calls).toHaveLength(1)
    const stepArguments = routed.plan?.steps[0]?.arguments
    const dataQuery = TOOL_CATALOGUE.find((tool) => tool.toolId === 'data_query')
    const schemaRef = dataQuery?.inputSchema['$ref']
    if (stepArguments === undefined || typeof schemaRef !== 'string') {
      throw new Error('the planner did not produce a data_query step and tool contract')
    }
    expect(canonicalToolValidator().validateRef(schemaRef, stepArguments).valid).toBe(true)
  })

  it('reports missing generation as a structured capability failure instead of querying definitions', async () => {
    const compiler = new CountingCompiler()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler })

    await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(compiler.calls).toHaveLength(0)
  })

  it('stops before model preparation when the trusted context deadline has expired', async () => {
    const generation = new CountingGeneration()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), generation })
    const expired = gatewayContext({
      runId: PLANNING_RUN,
      deadline: new Date(Date.now() - 1_000).toISOString(),
    })

    await expect(planner.route(request(), expired)).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    expect(generation.calls).toHaveLength(0)
  })

  it.each(['MODEL_UNAVAILABLE', 'RATE_LIMITED'] as const)(
    'turns recoverable generation failure %s into explicit clarification, not a successful fallback plan',
    async (code) => {
      const compiler = new CountingCompiler()
      const generation = new CountingGeneration().script([{
        type: 'error',
        error: { code, message: `provider ${code}`, retryable: true },
      }])
      const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

      const routed = await planner.route(request(), planningContext())

      expect(routed.route).toBe('clarify')
      expect(routed.plan).toBeUndefined()
      expect(routed.fallback).toBe(`generation_failed:${code}`)
      expect(compiler.calls).toHaveLength(0)
    },
  )

  it.each(['BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'EVIDENCE_PERSIST_FAILED', 'INTERNAL_ERROR'] as const)(
    'preserves fatal generation event classification for %s',
    async (code) => {
      const generation = new CountingGeneration().script([{
        type: 'error',
        error: { code, message: `fatal ${code}`, retryable: false },
      }])
      const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), generation })

      await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code })
    },
  )

  it('propagates unknown, reserve/settlement, and AbortError exceptions without relabeling them', async () => {
    const failures: unknown[] = [
      new Error('unknown provider failure'),
      Object.assign(new Error('settlement failed'), { code: 'EVIDENCE_PERSIST_FAILED' }),
      new DOMException('generation cancelled', 'AbortError'),
    ]
    for (const failure of failures) {
      const generation: GenerationPort = {
        async *generate() {
          throw failure
        },
      }
      const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), generation })

      await expect(planner.route(request(), planningContext())).rejects.toBe(failure)
    }
  })

  it('rejects a partial generation stream even when it contains parseable arguments', async () => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration().script([{
      type: 'tool_call_delta',
      callId: '11111111-2222-4333-8444-555555555555',
      toolId: 'data_query',
      argumentsDelta: multiHopPlanJson(),
    }])
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    expect(compiler.calls).toHaveLength(0)
  })

  it('rejects a malformed completed proposal instead of substituting another plan', async () => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration().script([
      {
        type: 'tool_call_delta',
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        argumentsDelta: '{"queryPlan":{"mode":"semantic"}}',
      },
      { type: 'completed', stopReason: 'tool_calls', candidateOnly: true },
    ])
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
    expect(compiler.calls).toHaveLength(0)
  })

  it.each([
    ['oversized proposal JSON', { type: 'tool_call_delta', callId: '11111111-2222-4333-8444-555555555555', toolId: 'data_query', argumentsDelta: 'x'.repeat(65_537) }],
    ['oversized ignored text', { type: 'text_delta', text: 'x'.repeat(131_100) }],
  ] as const)('bounds %s before compiling or returning a plan', async (_label, event) => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration().script([event, { type: 'completed', stopReason: 'tool_calls', candidateOnly: true }])
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    expect(compiler.calls).toHaveLength(0)
  })

  it('caps the number of ignored stream events even when their payload is empty', async () => {
    const compiler = new CountingCompiler()
    const generation: GenerationPort = {
      async *generate() {
        for (let index = 0; index < 1_025; index += 1) yield { type: 'text_delta', text: '' }
      },
    }
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    await expect(planner.route(request(), planningContext())).rejects.toMatchObject({ code: 'INVALID_SCHEMA' })
    expect(compiler.calls).toHaveLength(0)
  })

  it('preserves an observable AbortSignal when generation ends before its completion event', async () => {
    const controller = new AbortController()
    const cancelled = new Error('cancelled by run controller')
    const generation: GenerationPort = {
      async *generate() {
        yield {
          type: 'tool_call_delta',
          callId: '11111111-2222-4333-8444-555555555555',
          toolId: 'data_query',
          argumentsDelta: multiHopPlanJson(),
        }
        controller.abort(cancelled)
      },
    }
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), generation })

    await expect(planner.route(request(), planningContext(), controller.signal)).rejects.toBe(cancelled)
  })

  it('re-routes from one host-verified clarification receipt and includes it in bounded JEV and proposal state', async () => {
    const routeClarification: NonNullable<PlanRequest['routeClarification']> = {
      receiptRef: {
        id: randomUUID(),
        version: '1.0.0',
        digest: sha256DigestOf('prior route receipt'),
        kind: 'artifact',
      },
      questionRef: {
        id: 'clarify:prior-route',
        version: '1.0.0',
        digest: sha256DigestOf('the site is not specified'),
      },
      clarificationId: randomUUID(),
      typedResponse: { site: 'site-demo-a', period: '2026-Q3' },
      expectedRevision: '7',
    }
    const decision = new CountingDecision()
    decision.selected = 'small_plan'
    const archived = stateRefProvider()
    const generation = new CountingGeneration().script([
      {
        type: 'tool_call_delta',
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        argumentsDelta: multiHopPlanJson(),
      },
      { type: 'completed', stopReason: 'tool_calls', candidateOnly: true },
    ])
    let rewriteCalls = 0
    const rewriter = {
      async rewrite() {
        rewriteCalls += 1
        return {
          status: 'failed' as const,
          error: { code: 'MODEL_UNAVAILABLE' as const, message: 'unexpected second rewrite', retryable: true },
        }
      },
    }
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: archived.provider,
      generation,
      rewriter,
    })

    const routed = await planner.route(request({
      signals: { routeAmbiguous: true },
      routeClarification,
    }), planningContext())

    expect(routed.route).toBe('small_plan')
    expect(archived.archived[0]?.state).toMatchObject({ routeClarification })
    expect(rewriteCalls).toBe(0)
    expect(generation.calls[0]?.messages.some((message) =>
      message.content.includes('<route_clarification_response untrusted="true">') &&
      message.content.includes('site-demo-a') && message.content.includes('2026-Q3'),
    )).toBe(true)
  })

  it('rejects a route clarification receipt supplied under another trusted run', async () => {
    const routeClarification: NonNullable<PlanRequest['routeClarification']> = {
      receiptRef: { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('receipt'), kind: 'artifact' },
      questionRef: { id: 'clarify:prior-route', version: '1.0.0', digest: sha256DigestOf('question') },
      clarificationId: randomUUID(),
      typedResponse: { site: 'site-demo-a' },
      expectedRevision: '7',
    }
    const decision = new CountingDecision()
    const generation = new CountingGeneration()
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: stateRefProvider().provider,
      generation,
    })

    await expect(planner.route(
      request({ routeClarification, signals: { routeAmbiguous: true } }),
      gatewayContext({ runId: '33333333-4444-4333-8444-555555555555', deadline: new Date(Date.now() + 60_000).toISOString() }),
    )).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    expect(decision.calls).toHaveLength(0)
    expect(generation.calls).toHaveLength(0)
  })

  it('clarifies a concrete ambiguity first without consulting JEV', async () => {
    const decision = new CountingDecision()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler: new CountingCompiler(), decision })

    const routed = await planner.route(request({ signals: { ambiguous: true } }), planningContext())

    expect(routed.route).toBe('clarify')
    expect(routed.clarification).toBeDefined()
    expect(routed.plan).toBeUndefined()
    expect(decision.calls).toHaveLength(0)
  })

  it('consults JEV only for genuine route ambiguity and falls back to clarification', async () => {
    const decision = new CountingDecision()
    decision.selected = 'small_plan'
    const generation = new CountingGeneration().script([
      {
        type: 'tool_call_delta',
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        argumentsDelta: multiHopPlanJson(),
      },
      { type: 'completed', stopReason: 'tool_calls', candidateOnly: true },
    ])
    const routeState = stateRefProvider()
    const planner = new RunPlanner({
      vocabulary: VOCABULARY,
      compiler: new CountingCompiler(),
      decision,
      generation,
      decisionModelRef: { modelId: 'jev', version: '1.0.0' },
      decisionStateRefProvider: routeState.provider,
    })

    const chosen = await planner.route(request({ signals: { routeAmbiguous: true } }), planningContext())
    expect(chosen.route).toBe('small_plan')
    expect(decision.calls).toHaveLength(1)
    expect(decision.calls[0]?.stateRef).toEqual(routeState.refs[0])
    expect(routeState.archived).toHaveLength(1)
    expect(routeState.archived[0]).toMatchObject({
      runId: PLANNING_RUN,
      resolvedProfileHash: planningContext().resolvedProfileHash,
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
    const failed = await planner.route(request({ signals: { routeAmbiguous: true } }), planningContext())
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

    const routed = await planner.route(request({ signals: { routeAmbiguous: true } }), planningContext())

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
    }), planningContext())

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
    await expect(failingPlanner.route(request({ signals: { routeAmbiguous: true } }), planningContext())).rejects.toBe(archiveFailure)
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
    await expect(invalidPlanner.route(request({ signals: { routeAmbiguous: true } }), planningContext())).rejects.toBeInstanceOf(WorkflowControllerError)
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
      await expect(planner.route(request({ signals: { routeAmbiguous: true } }), planningContext())).rejects.toBe(failure)
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
    const fallback = await fallbackPlanner.route(request({ signals: { routeAmbiguous: true } }), planningContext())
    expect(fallback.route).toBe('clarify')
    expect(fallback.fallback).toBe('jev_provider_fallback:clarify')
  })
})

describe('small plan and single-SQL multi-hop', () => {
  it('compiles a three-hop question into one bounded query without a per-hop model call', async () => {
    const compiler = new CountingCompiler()
    const generation = new CountingGeneration()
    const planner = new RunPlanner({ vocabulary: VOCABULARY, compiler, generation })

    const routed = await planner.route(request({ candidatePlan: multiHopPlan() }), planningContext())

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

    const routed = await planner.route(request(), planningContext())

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(true)
    expect(generation.calls).toHaveLength(1)
    expect(compiler.calls).toHaveLength(1)
  })
})
