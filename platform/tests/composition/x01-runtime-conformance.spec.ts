import { describe, expect, it } from 'vitest'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import type {
  BudgetPort,
  PlanSpec,
  ResourceRef,
  RuntimeDependencies,
  RuntimeEvent,
  ToolCall,
  ToolContext,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { GATEWAY_LEDGER, RecordingHandler, buildGateway, observation, openGatewayLedger } from '../unit/tool-gateway-fixtures'
import {
  RUN_ID,
  SCOPE,
  StaticPlanResolver,
  collect,
  forbiddenGeneration,
  publishedPlan,
  runtimeInput,
  runtimeManifest,
  templateContext,
  InMemoryCheckpoints,
} from '../unit/template-runtime-fixtures'
import {
  ScriptedGeneration,
  completedEvent,
  events,
  forbiddenDecision,
  piConfig,
  toolCallDelta,
} from '../unit/pi-runtime-fixtures'

/**
 * X-01 — Pi vs Template runtime on the same scenario.
 *
 * Both runtimes are the real adapters (LOCAL-017/018) and both drive the real
 * `ToolGatewayService` (validate → reserve → intent → execute → evidence → settle), so the
 * comparison is over real gateway semantics, not a mock. The only substitute is the model:
 * the Pi runtime is fed a controlled, deterministic generation double (no model is called),
 * which the contract suite marks explicitly. Evidence, arguments and budget semantics must
 * be equal.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`

function lookupHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: {
      items: [{ kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: DIGEST }, label: 'backup' }],
      gaps: [],
      definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST },
      autoPublished: false,
    },
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

function searchHandler(): RecordingHandler {
  return new RecordingHandler('document_search', {
    payload: {
      spans: [],
      scoreKind: 'bm25',
      indexVersion: {
        indexRef: { id: 'home-energy-index', version: '1.0.0', digest: DIGEST },
        generation: 1,
        builtAt: '2026-09-21T00:00:00Z',
      },
      completeness: 'complete',
    },
    status: 'empty',
    coverage: { returned: 0, truncated: false },
    sources: [observation()],
  })
}

/** The same two-step scenario, authored once as a published plan and once as Pi tool calls. */
function conformancePlan(): PlanSpec {
  return {
    planRef: {
      id: 'plan-x01-conformance',
      version: '1.0.0',
      digest: sha256DigestOf('plan-x01-conformance'),
      kind: 'plan',
    },
    steps: [
      {
        stepId: 'lookup',
        toolId: 'ontology_lookup',
        readOnly: true,
        args: [
          { name: 'scopeRef', required: true, source: { kind: 'literal', value: SCOPE } },
          { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
        ],
        dependsOn: [],
        failureBehaviour: 'abort',
      },
      {
        stepId: 'search',
        toolId: 'document_search',
        readOnly: true,
        args: [
          {
            name: 'query',
            required: true,
            source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/label' },
          },
          {
            name: 'allowedCollectionRefs',
            required: true,
            source: { kind: 'literal', value: ['home-energy/manuals'] },
          },
          { name: 'mode', required: true, source: { kind: 'literal', value: 'keyword' } },
        ],
        dependsOn: ['lookup'],
        failureBehaviour: 'abort',
      },
    ],
  }
}

function runtimeBudget(read: () => Promise<number>): BudgetPort {
  return {
    reserve: () => Promise.reject(new Error('the runtime must not reserve budget directly')),
    settle: () => Promise.reject(new Error('the runtime must not settle budget directly')),
    remaining: async () => ({
      deadline: '2030-01-01T00:00:00Z',
      toolCallsRemaining: await read(),
      repairAttemptsRemaining: 2,
      parallelToolLimit: 4,
    }),
  }
}

function evidenceOf(runtimeEvents: readonly RuntimeEvent[]): ResourceRef[] {
  return runtimeEvents
    .filter((event): event is Extract<RuntimeEvent, { type: 'evidence_added' }> => event.type === 'evidence_added')
    .flatMap((event) => event.evidenceRefs)
}

function completionOf(runtimeEvents: readonly RuntimeEvent[]): Extract<RuntimeEvent, { type: 'collection_complete' }> {
  const complete = runtimeEvents.find(
    (event): event is Extract<RuntimeEvent, { type: 'collection_complete' }> =>
      event.type === 'collection_complete',
  )
  if (complete === undefined) throw new Error('the run did not complete')
  return complete
}

interface RuntimeRun {
  readonly toolIds: readonly string[]
  readonly calls: readonly ToolCall[]
  readonly events: readonly RuntimeEvent[]
  readonly archivedEvidenceCount: number
  readonly budgetConsumed: number
}

async function runTemplate(): Promise<RuntimeRun> {
  const ctx: ToolContext = templateContext({ runId: RUN_ID })
  const lookup = lookupHandler()
  const search = searchHandler()
  const harness = buildGateway({ handlers: [lookup, search], ctx })
  await openGatewayLedger(harness, ctx)
  const initialRemaining = (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining
  const adapter = new TemplateRuntimeAdapter({
    manifest: runtimeManifest(),
    plans: new StaticPlanResolver(publishedPlan(conformancePlan())),
  })
  const dependencies: RuntimeDependencies = {
    ctx,
    gateway: harness.gateway,
    generation: forbiddenGeneration,
    decision: forbiddenDecision,
    checkpoints: new InMemoryCheckpoints(),
    budget: runtimeBudget(
      async () => (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining,
    ),
    signal: new AbortController().signal,
  }
  const runtimeEvents = await collect(adapter.start(runtimeInput({ runId: RUN_ID }), dependencies))
  return {
    toolIds: [...lookup.calls.map((call) => call.toolId), ...search.calls.map((call) => call.toolId)],
    calls: [...lookup.calls, ...search.calls],
    events: runtimeEvents,
    archivedEvidenceCount: harness.evidence.records.length,
    budgetConsumed:
      initialRemaining - (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining,
  }
}

async function runPi(): Promise<RuntimeRun> {
  const ctx: ToolContext = templateContext({ runId: RUN_ID })
  const lookup = lookupHandler()
  const search = searchHandler()
  const harness = buildGateway({ handlers: [lookup, search], ctx })
  await openGatewayLedger(harness, ctx)
  const initialRemaining = (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining
  const generation = new ScriptedGeneration(
    [
      events(
        toolCallDelta('pi-c1', 'ontology_lookup', { scopeRef: SCOPE, intent: 'definitions' }),
        completedEvent('tool_calls'),
      ),
      events(
        toolCallDelta('pi-c2', 'document_search', {
          query: 'backup',
          allowedCollectionRefs: ['home-energy/manuals'],
          mode: 'keyword',
        }),
        completedEvent('tool_calls'),
      ),
      events(completedEvent('stop')),
    ],
    { signal: new AbortController().signal },
  )
  const adapter = new PiRuntimeAdapter(piConfig())
  const dependencies: RuntimeDependencies = {
    ctx,
    gateway: harness.gateway,
    generation,
    decision: forbiddenDecision,
    checkpoints: new InMemoryCheckpoints(),
    budget: runtimeBudget(
      async () => (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining,
    ),
    signal: new AbortController().signal,
  }
  const runtimeEvents = await collect(adapter.start(runtimeInput({ runId: RUN_ID }), dependencies))
  return {
    toolIds: [...lookup.calls.map((call) => call.toolId), ...search.calls.map((call) => call.toolId)],
    calls: [...lookup.calls, ...search.calls],
    events: runtimeEvents,
    archivedEvidenceCount: harness.evidence.records.length,
    budgetConsumed:
      initialRemaining - (await harness.budget.remaining(GATEWAY_LEDGER, ctx)).remaining.toolCallsRemaining,
  }
}

describe('X-01 — Pi and Template runtimes conform to the same evidence/budget contract', () => {
  it('produces the same tool sequence, arguments, evidence and completion through the real gateway', async () => {
    const template = await runTemplate()
    const pi = await runPi()

    // Same tool sequence, in the same order, through the real gateway.
    expect(template.toolIds).toEqual(['ontology_lookup', 'document_search'])
    expect(pi.toolIds).toEqual(template.toolIds)

    // The predecessor-bound argument (template) equals the scripted argument (Pi double).
    expect(template.calls[1]?.arguments).toEqual({
      query: 'backup',
      allowedCollectionRefs: ['home-energy/manuals'],
      mode: 'keyword',
    })
    expect(pi.calls[1]?.arguments).toEqual(template.calls[1]?.arguments)

    // Evidence contract: both runtimes emit the same number of evidence refs, both
    // archived by the real gateway. Evidence ids/digests are per-run and may differ.
    expect(evidenceOf(pi.events)).toHaveLength(2)
    expect(evidenceOf(template.events)).toHaveLength(2)
    expect(pi.archivedEvidenceCount).toBe(2)
    expect(template.archivedEvidenceCount).toBe(2)

    // Both read the one shared ledger and never reset it; the gateway consumed two calls.
    expect(pi.budgetConsumed).toBe(2)
    expect(template.budgetConsumed).toBe(2)

    // Both terminate at collection_complete; neither runtime publishes an answer.
    expect(completionOf(pi.events).evidenceCount).toBe(completionOf(template.events).evidenceCount)
    expect(completionOf(pi.events).draftAllowed).toBe(true)
    expect(template.events.at(-1)?.type).toBe('collection_complete')
    expect(pi.events.at(-1)?.type).toBe('collection_complete')
  })
})
