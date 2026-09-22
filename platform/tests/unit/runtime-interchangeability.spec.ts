import { describe, expect, it } from 'vitest'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import type { PlanSpec, ResourceRef, RuntimeEvent } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  RUN_ID,
  StaticPlanResolver,
  buildDependencies,
  collect,
  evidenceRef,
  okResult,
  publishedPlan,
  runtimeInput,
  runtimeManifest,
  templateContext,
} from './template-runtime-fixtures'
import {
  buildPiDependencies,
  completedEvent,
  events,
  piConfig,
  toolCallDelta,
} from './pi-runtime-fixtures'

function templatePlan(): PlanSpec {
  return {
    planRef: {
      id: 'plan-interchange',
      version: '1.0.0',
      digest: sha256DigestOf('plan-interchange'),
      kind: 'plan',
    },
    steps: [
      {
        stepId: 'lookup',
        toolId: 'ontology_lookup',
        readOnly: true,
        args: [],
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
        ],
        dependsOn: ['lookup'],
        failureBehaviour: 'abort',
      },
    ],
  }
}

function evidenceOf(events: readonly RuntimeEvent[]): ResourceRef[] {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: 'evidence_added' }> => event.type === 'evidence_added')
    .flatMap((event) => event.evidenceRefs)
}

function completionOf(events: readonly RuntimeEvent[]): Extract<RuntimeEvent, { type: 'collection_complete' }> {
  const complete = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'collection_complete' }> =>
      event.type === 'collection_complete',
  )
  if (complete === undefined) throw new Error('the run did not complete')
  return complete
}

/**
 * X-01: the same scenario runs on both runtimes against the same gateway contract and
 * yields the same evidence, budget and completion semantics. The text differs (one plan,
 * one model loop), but the contract outcomes must match so the runtimes are interchangeable.
 */
describe('X-01 — Pi and Template runtimes are interchangeable on the same scenario', () => {
  it('produces the same tool sequence, evidence refs, budget reads and completion', async () => {
    // Template runtime: a published two-step plan.
    const templateHarness = buildDependencies({ ctx: templateContext({ runId: RUN_ID }) })
    templateHarness.gateway.on('ontology_lookup', (call) =>
      okResult(call.callId, { items: [{ label: 'backup' }] }, [evidenceRef('ontology_lookup')]),
    )
    templateHarness.gateway.on('document_search', (call) =>
      okResult(call.callId, { spans: [] }, [evidenceRef('document_search')]),
    )
    const templateAdapter = new TemplateRuntimeAdapter({
      manifest: runtimeManifest(),
      plans: new StaticPlanResolver(publishedPlan(templatePlan())),
    })
    const templateEvents = await collect(
      templateAdapter.start(runtimeInput({ runId: RUN_ID }), templateHarness.dependencies),
    )

    // Pi runtime: the same tools, driven by a deterministic generation double.
    const piHarness = buildPiDependencies({
      scripts: [
        events(
          toolCallDelta('c1', 'ontology_lookup', { intent: 'definitions' }),
          completedEvent('tool_calls'),
        ),
        events(toolCallDelta('c2', 'document_search', { query: 'backup' }), completedEvent('tool_calls')),
        events(completedEvent('stop')),
      ],
    })
    piHarness.gateway.on('ontology_lookup', (call) =>
      okResult(call.callId, { items: [{ label: 'backup' }] }, [evidenceRef('ontology_lookup')]),
    )
    piHarness.gateway.on('document_search', (call) =>
      okResult(call.callId, { spans: [] }, [evidenceRef('document_search')]),
    )
    const piAdapter = new PiRuntimeAdapter(piConfig())
    const piEvents = await collect(piAdapter.start(runtimeInput({ runId: RUN_ID }), piHarness.dependencies))

    // Same tool sequence, in the same order, with the same predecessor-bound argument.
    const templateToolIds = templateHarness.gateway.calls.map((call) => call.toolId)
    const piToolIds = piHarness.gateway.calls.map((call) => call.toolId)
    expect(piToolIds).toEqual(templateToolIds)
    expect(piToolIds).toEqual(['ontology_lookup', 'document_search'])
    expect(piHarness.gateway.calls[1]?.arguments.query).toBe('backup')
    expect(templateHarness.gateway.calls[1]?.arguments.query).toBe('backup')

    // Same evidence contract: identical evidence refs and counts.
    expect(evidenceOf(piEvents)).toEqual(evidenceOf(templateEvents))
    expect(evidenceOf(piEvents)).toHaveLength(2)
    expect(completionOf(piEvents).evidenceCount).toBe(completionOf(templateEvents).evidenceCount)
    expect(completionOf(piEvents).draftAllowed).toBe(true)

    // Both read the one shared budget projection for the run and never reset it.
    expect([...new Set(piHarness.budget.remainingCalls)]).toEqual([RUN_ID])
    expect([...new Set(templateHarness.budget.remainingCalls)]).toEqual([RUN_ID])

    // Neither runtime publishes an answer: both terminate at collection_complete.
    expect(templateEvents.at(-1)?.type).toBe('collection_complete')
    expect(piEvents.at(-1)?.type).toBe('collection_complete')
    for (const events of [templateEvents, piEvents]) {
      expect(events.map((event) => event.type)).not.toContain('answer_published')
    }
  })
})
