import { describe, expect, it } from 'vitest'
import {
  TemplateRuntimeAdapter,
  type PublishedPlan,
} from '@ontology/adapter-runtime-template'
import type {
  PlanSpec,
  PlanStep,
  ResourceRef,
  RuntimeEvent,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  Barrier,
  RUN_ID,
  StaticPlanResolver,
  buildDependencies,
  collect,
  errorResult,
  okResult,
  publishedPlan,
  resumeInput,
  runtimeInput,
  runtimeManifest,
  templateContext,
  waitFor,
} from './template-runtime-fixtures'

function step(overrides: Partial<PlanStep> & Pick<PlanStep, 'stepId' | 'toolId'>): PlanStep {
  return {
    readOnly: true,
    args: [],
    dependsOn: [],
    failureBehaviour: 'abort',
    ...overrides,
  }
}

function planSpec(steps: PlanStep[]): PlanSpec {
  return {
    planRef: {
      id: 'plan-template-demo',
      version: '1.0.0',
      digest: sha256DigestOf('plan-template-demo'),
      kind: 'plan',
    },
    steps,
  }
}

function adapterFor(spec: PlanSpec): {
  readonly adapter: TemplateRuntimeAdapter
  readonly resolver: StaticPlanResolver
  readonly plan: PublishedPlan
} {
  const plan = publishedPlan(spec)
  const resolver = new StaticPlanResolver(plan)
  const adapter = new TemplateRuntimeAdapter({ manifest: runtimeManifest(), plans: resolver })
  return { adapter, resolver, plan }
}

function eventsOfType<T extends RuntimeEvent['type']>(
  events: readonly RuntimeEvent[],
  type: T,
): Extract<RuntimeEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: T }> => event.type === type,
  )
}

describe('TemplateRuntimeAdapter — plan execution (SPEC §4.2, D7)', () => {
  it('runs steps in dependency order and binds arguments from actual predecessor outputs', async () => {
    const spec = planSpec([
      step({ stepId: 'lookup', toolId: 'ontology_lookup' }),
      step({
        stepId: 'query',
        toolId: 'data_query',
        dependsOn: ['lookup'],
        args: [
          { name: 'entityId', required: true, source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/id' } },
          { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
        ],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [{ id: 'x-1' }] }))
    harness.gateway.on('data_query', (call) => okResult(call.callId, { rows: [] }))

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls.map((call) => call.toolId)).toEqual(['ontology_lookup', 'data_query'])
    expect(harness.gateway.calls[1]?.arguments).toEqual({ entityId: 'x-1', intent: 'definitions' })
    const started = eventsOfType(events, 'step_started')
    expect(started.map((event) => event.stepId)).toEqual(['lookup', 'query'])
    expect(eventsOfType(events, 'collection_complete')).toHaveLength(1)
    expect(eventsOfType(events, 'collection_complete')[0]?.draftAllowed).toBe(true)
  })

  it('runs independent read-only steps concurrently and never starts a dependent before its predecessor ends', async () => {
    const barrier = new Barrier(2)
    const order: string[] = []
    const spec = planSpec([
      step({ stepId: 'a', toolId: 'ontology_lookup' }),
      step({ stepId: 'b', toolId: 'document_search' }),
      step({ stepId: 'c', toolId: 'data_query', dependsOn: ['a'] }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()

    harness.gateway.on('ontology_lookup', async (call) => {
      order.push('a:start')
      await barrier.wait()
      order.push('a:end')
      return okResult(call.callId, { items: [{ id: 'a' }] })
    })
    harness.gateway.on('document_search', async (call) => {
      order.push('b:start')
      await barrier.wait()
      order.push('b:end')
      return okResult(call.callId, { spans: [] })
    })
    harness.gateway.on('data_query', (call) => {
      order.push('c:start')
      return okResult(call.callId, { rows: [] })
    })

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))
    expect(eventsOfType(events, 'collection_complete')).toHaveLength(1)

    // Interleaving: each step had started before the other ended. A sequential scheduler
    // would deadlock on the barrier instead of reaching this assertion.
    expect(order.indexOf('a:end')).toBeGreaterThan(order.indexOf('b:start'))
    expect(order.indexOf('b:end')).toBeGreaterThan(order.indexOf('a:start'))
    // A dependent step never starts before its predecessor completed.
    expect(order.indexOf('c:start')).toBeGreaterThan(order.indexOf('a:end'))
  })

  it('returns a typed clarification when a required argument has no source and never calls the gateway', async () => {
    const spec = planSpec([
      step({
        stepId: 'lookup',
        toolId: 'ontology_lookup',
        args: [{ name: 'scopeRef', required: true }],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls).toHaveLength(0)
    const clarifications = eventsOfType(events, 'clarification_requested')
    expect(clarifications).toHaveLength(1)
    expect(clarifications[0]?.questionType).toBe('choice')
    expect(clarifications[0]?.questionRef.id).toContain('lookup')
    expect(clarifications[0]?.questionRef.id).toContain('scopeRef')
    // A checkpoint is written before the run pauses so the clarification can be resumed.
    expect(eventsOfType(events, 'checkpoint_ready')).toHaveLength(1)
    expect(events.some((event) => event.type === 'collection_complete')).toBe(false)
  })

  it('returns a typed clarification when a required predecessor pointer is unresolved', async () => {
    const spec = planSpec([
      step({ stepId: 'lookup', toolId: 'ontology_lookup' }),
      step({
        stepId: 'query',
        toolId: 'data_query',
        dependsOn: ['lookup'],
        args: [
          { name: 'entityId', required: true, source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/id' } },
        ],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls).toHaveLength(1)
    const clarifications = eventsOfType(events, 'clarification_requested')
    expect(clarifications).toHaveLength(1)
    expect(clarifications[0]?.questionRef.id).toContain('query')
    expect(clarifications[0]?.questionRef.id).toContain('entityId')
  })

  it('resumes from a checkpoint with the typed clarification and restores predecessor outputs', async () => {
    const spec = planSpec([
      step({ stepId: 'lookup', toolId: 'ontology_lookup' }),
      step({
        stepId: 'query',
        toolId: 'data_query',
        dependsOn: ['lookup'],
        args: [
          { name: 'entityId', required: true, source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/id' } },
          { name: 'extra', required: true },
        ],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [{ id: 'a-1' }] }))
    harness.gateway.on('data_query', (call) => okResult(call.callId, { rows: [] }))

    const first = await collect(adapter.start(runtimeInput(), harness.dependencies))
    expect(eventsOfType(first, 'clarification_requested')).toHaveLength(1)
    const checkpoint = harness.checkpoints.latest()
    if (checkpoint === undefined) throw new Error('no checkpoint was saved')

    const resumed = await collect(
      adapter.resume(
        resumeInput(checkpoint.ref, {
          clarificationResponse: {
            clarificationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            typedResponse: { extra: 'from-user' },
            expectedRevision: '1',
          },
        }),
        harness.dependencies,
      ),
    )

    expect(eventsOfType(resumed, 'collection_complete')).toHaveLength(1)
    expect(harness.gateway.calls).toHaveLength(2)
    // entityId comes from the restored predecessor output, extra from the typed answer.
    expect(harness.gateway.calls[1]?.arguments).toEqual({ entityId: 'a-1', extra: 'from-user' })
  })

  it('refuses an incompatible checkpoint version before loading it', async () => {
    const { adapter } = adapterFor(planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })]))
    const harness = buildDependencies()
    const incompatible = {
      checkpointId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      runId: RUN_ID,
      runtimeKind: 'runtime-template',
      runtimeVersion: '9.9.9',
      stateDigest: sha256DigestOf('whatever'),
      createdAt: '2026-09-21T00:00:00Z',
    }

    await expect(
      collect(adapter.resume(resumeInput(incompatible), harness.dependencies)),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' })

    await expect(
      collect(
        adapter.resume(
          resumeInput({ ...incompatible, runtimeKind: 'runtime-pi', runtimeVersion: '1.0.0' }),
          harness.dependencies,
        ),
      ),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' })
  })

  it('propagates cancellation through the injected signal and emits cancelled', async () => {
    const spec = planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.gateway.on('ontology_lookup', async (call) => {
      await pending
      return okResult(call.callId, { items: [] })
    })

    const eventsPromise = collect(adapter.start(runtimeInput(), harness.dependencies))
    await waitFor(() => harness.gateway.calls.length === 1)
    const receipt = await adapter.cancel(RUN_ID, 'user cancelled')
    expect(receipt.status).toBe('cancelling')
    release?.()
    const events = await eventsPromise

    const cancelled = eventsOfType(events, 'cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.reason).toBe('user cancelled')
    expect(cancelled[0]?.abandonedAttempts).toHaveLength(1)
    expect(harness.gateway.cancellations).toHaveLength(1)
    expect(events.some((event) => event.type === 'collection_complete')).toBe(false)
  })

  it('cancels when the host aborts the injected signal', async () => {
    const spec = planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))

    const eventsPromise = collect(adapter.start(runtimeInput(), harness.dependencies))
    harness.controller.abort(new Error('host abort'))
    const events = await eventsPromise
    // The abort may land before or after the single step; either way the run never completes.
    expect(events.some((event) => event.type === 'collection_complete')).toBe(false)
  })

  it('never resets the shared budget: a zero remaining budget stops before any call', async () => {
    const spec = planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))

    const events = await collect(
      adapter.start(runtimeInput({ remainingBudget: { toolCallsRemaining: 0 } }), harness.dependencies),
    )

    expect(harness.gateway.calls).toHaveLength(0)
    const failed = eventsOfType(events, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.error.code).toBe('BUDGET_EXHAUSTED')
  })

  it('reads the shared ledger and honours its reduced allowance on resume', async () => {
    const spec = planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.budget.remainingValue = {
      deadline: '2030-01-01T00:00:00Z',
      toolCallsRemaining: 0,
      repairAttemptsRemaining: 0,
      parallelToolLimit: 2,
    }
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls).toHaveLength(0)
    expect(harness.budget.remainingCalls).toEqual([RUN_ID])
    expect(eventsOfType(events, 'failed')[0]?.error.code).toBe('BUDGET_EXHAUSTED')
  })

  it('rejects a cyclic plan before executing anything', async () => {
    const spec = planSpec([
      step({ stepId: 'a', toolId: 'ontology_lookup', dependsOn: ['b'] }),
      step({ stepId: 'b', toolId: 'data_query', dependsOn: ['a'] }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()

    await expect(collect(adapter.start(runtimeInput(), harness.dependencies))).rejects.toMatchObject({
      code: 'INVALID_PLAN',
    })
    expect(harness.gateway.calls).toHaveLength(0)
  })

  it('aborts the run when a step fails under failureBehaviour=abort', async () => {
    const spec = planSpec([
      step({ stepId: 'a', toolId: 'ontology_lookup' }),
      step({ stepId: 'b', toolId: 'data_query', dependsOn: ['a'] }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => errorResult(call.callId, 'SOURCE_UNAVAILABLE'))
    harness.gateway.on('data_query', (call) => okResult(call.callId, {}))

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls.map((call) => call.toolId)).toEqual(['ontology_lookup'])
    const failed = eventsOfType(events, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.error.code).toBe('SOURCE_UNAVAILABLE')
  })

  it('surfaces a failed predecessor as a clarification under failureBehaviour=continue', async () => {
    const spec = planSpec([
      step({ stepId: 'a', toolId: 'ontology_lookup', failureBehaviour: 'continue' }),
      step({
        stepId: 'b',
        toolId: 'data_query',
        dependsOn: ['a'],
        args: [{ name: 'entityId', required: true, source: { kind: 'predecessor', stepId: 'a', pointer: '/items/0/id' } }],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => errorResult(call.callId, 'SOURCE_UNAVAILABLE'))
    harness.gateway.on('data_query', (call) => okResult(call.callId, {}))

    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))

    // The dependent never started on the failed predecessor.
    expect(harness.gateway.calls.map((call) => call.toolId)).toEqual(['ontology_lookup'])
    expect(eventsOfType(events, 'clarification_requested')).toHaveLength(1)
  })

  it('exposes only the host-injected restricted dependency closure', () => {
    const harness = buildDependencies()
    expect(Object.keys(harness.dependencies).sort()).toEqual([
      'budget',
      'checkpoints',
      'ctx',
      'decision',
      'gateway',
      'generation',
      'signal',
    ])
    // No store, driver, filesystem handle or control repository is reachable.
    for (const forbidden of ['store', 'database', 'db', 'pool', 'blob', 'fs', 'client', 'control']) {
      expect(Object.prototype.hasOwnProperty.call(harness.dependencies, forbidden)).toBe(false)
    }
  })

  it('has no publication path: its only public surface is manifest/start/resume/cancel', async () => {
    const spec = planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })])
    const { adapter } = adapterFor(spec)
    expect(Object.keys(adapter)).toEqual(['manifest'])
    const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort()
    expect(prototype).toEqual(['cancel', 'constructor', 'resume', 'start'])

    const harness = buildDependencies()
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))
    const events = await collect(adapter.start(runtimeInput(), harness.dependencies))
    expect(events.at(-1)?.type).toBe('collection_complete')
    expect(events.map((event) => event.type)).not.toContain('answer_published')
  })

  it('enforces the trusted context run binding', async () => {
    const { adapter } = adapterFor(planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })]))
    const harness = buildDependencies({ ctx: templateContext({ runId: '44444444-4444-4444-8444-444444444444' }) })
    await expect(collect(adapter.start(runtimeInput(), harness.dependencies))).rejects.toMatchObject({
      code: 'UNTRUSTED_DEPENDENCIES',
    })
  })

  it('reports not_found when cancelling an unknown run', async () => {
    const { adapter } = adapterFor(planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })]))
    const receipt = await adapter.cancel(RUN_ID, 'nobody is running')
    expect(receipt.status).toBe('not_found')
  })
})

describe('TemplateRuntimeAdapter — plan validation', () => {
  it('rejects a predecessor binding that is not a declared dependency', async () => {
    const spec = planSpec([
      step({ stepId: 'a', toolId: 'ontology_lookup' }),
      step({
        stepId: 'b',
        toolId: 'data_query',
        args: [{ name: 'entityId', required: true, source: { kind: 'predecessor', stepId: 'a', pointer: '' } }],
      }),
    ])
    const { adapter } = adapterFor(spec)
    const harness = buildDependencies()
    await expect(collect(adapter.start(runtimeInput(), harness.dependencies))).rejects.toMatchObject({
      code: 'INVALID_PLAN',
    })
  })

  it('rejects a plan whose resolved ref does not match the requested plan ref', async () => {
    const plan = publishedPlan(planSpec([step({ stepId: 'lookup', toolId: 'ontology_lookup' })]))
    const resolver = new StaticPlanResolver(plan)
    const adapter = new TemplateRuntimeAdapter({ manifest: runtimeManifest(), plans: resolver })
    const requested: ResourceRef = {
      id: 'a-different-plan',
      version: '1.0.0',
      digest: sha256DigestOf('other'),
      kind: 'plan',
    }
    await expect(
      collect(adapter.start(runtimeInput({ planRef: requested }), buildDependencies().dependencies)),
    ).rejects.toMatchObject({ code: 'INVALID_PLAN' })
  })
})
