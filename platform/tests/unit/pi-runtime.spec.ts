import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PI_AGENT_CORE_VERSION,
  PiRuntimeAdapter,
  type PiRuntimeConfig,
} from '@ontology/adapter-runtime-pi'
import type { RuntimeEvent, RuntimeCheckpointRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  BLOCK,
  RUN_ID,
  SCOPE,
  buildPiDependencies,
  completedEvent,
  events,
  piConfig,
  piContext,
  runtimeInput,
  textDelta,
  toolCallDelta,
  usageEvent,
} from './pi-runtime-fixtures'
import {
  InMemoryCheckpoints,
  collect,
  errorResult,
  okResult,
  resumeInput,
  waitFor,
} from './template-runtime-fixtures'

function eventsOfType<T extends RuntimeEvent['type']>(
  events: readonly RuntimeEvent[],
  type: T,
): Extract<RuntimeEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type)
}

function adapterFor(overrides?: Partial<PiRuntimeConfig>): PiRuntimeAdapter {
  return new PiRuntimeAdapter(piConfig(overrides))
}

describe('PiRuntimeAdapter — collection loop (SPEC §4.2, C2, D7)', () => {
  it('drives a normal collection loop and translates start into the unified RuntimeEvent stream', async () => {
    const harness = buildPiDependencies({
      scripts: [
        events(
          toolCallDelta('call-1', 'ontology_lookup', { scopeRef: SCOPE, intent: 'definitions' }),
          completedEvent('tool_calls'),
        ),
        events(textDelta('candidate draft text'), completedEvent('stop')),
      ],
    })
    harness.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [{ id: 'x-1' }] }))

    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))

    // The model-proposed call went through the gateway and produced evidence.
    expect(harness.gateway.calls.map((call) => call.toolId)).toEqual(['ontology_lookup'])
    expect(harness.generation.requests).toHaveLength(2)
    expect(harness.generation.requests[0]?.role).toBe('planner')
    expect(harness.generation.requests[0]?.toolSchemas).toEqual(['ontology_lookup', 'document_search'])
    // The second turn sees the evidence the first turn's gateway call produced.
    expect(harness.generation.requests[1]?.evidenceRefs).toHaveLength(1)

    expect(eventsOfType(runtimeEvents, 'plan_proposed')).toHaveLength(1)
    const started = eventsOfType(runtimeEvents, 'step_started')
    expect(started.map((event) => event.toolId)).toEqual(['ontology_lookup'])
    const added = eventsOfType(runtimeEvents, 'evidence_added')
    expect(added).toHaveLength(1)
    expect(added[0]?.evidenceRefs).toHaveLength(1)
    expect(added[0]?.evidenceRefs[0]?.kind).toBe('evidence')
    expect(eventsOfType(runtimeEvents, 'checkpoint_ready').length).toBeGreaterThanOrEqual(1)
    // The terminal event is `collection_complete`, which only means a draft may be attempted.
    const terminal = runtimeEvents.at(-1)
    expect(terminal?.type).toBe('collection_complete')
    if (terminal?.type === 'collection_complete') {
      expect(terminal.draftAllowed).toBe(true)
      expect(terminal.evidenceCount).toBe(1)
    }
    expect(runtimeEvents.map((event) => event.type)).not.toContain('answer_published')
  })

  it('stamps every event with run_id, a fresh event_id and a monotonic sequence', async () => {
    const harness = buildPiDependencies({
      scripts: [events(completedEvent('stop'))],
    })
    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))
    expect(runtimeEvents.map((event) => event.sequence)).toEqual(runtimeEvents.map((_, index) => index))
    for (const event of runtimeEvents) {
      expect(event.runId).toBe(RUN_ID)
      expect(event.eventId.length).toBeGreaterThan(0)
    }
  })

  it('routes every execute wrapper through the gateway and never authorizes by itself', async () => {
    const harness = buildPiDependencies({
      scripts: [
        events(toolCallDelta('call-1', 'ontology_lookup', {}), completedEvent('tool_calls')),
        events(completedEvent('stop')),
      ],
    })
    // The gateway rejects the call. The runtime must surface that decision, not override it:
    // it cannot decide authorization, and it never executes the tool itself.
    harness.gateway.on('ontology_lookup', (call) => errorResult(call.callId, 'FORBIDDEN'))

    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))

    expect(harness.gateway.calls).toHaveLength(1)
    expect(eventsOfType(runtimeEvents, 'evidence_added')).toHaveLength(0)
  })

  it('does not expose tools outside the host-authorized surface to the model', async () => {
    const harness = buildPiDependencies({
      scripts: [
        events(toolCallDelta('call-1', 'data_query', {}), completedEvent('tool_calls')),
        events(completedEvent('stop')),
      ],
    })
    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))
    // data_query is not in the configured surface, so it never reaches the gateway.
    expect(harness.gateway.calls).toHaveLength(0)
    expect(eventsOfType(runtimeEvents, 'evidence_added')).toHaveLength(0)
  })

  it('stops through the finishTurn hook when the shared budget is exhausted, without a second model call', async () => {
    const harness = buildPiDependencies({
      scripts: [
        events(toolCallDelta('call-1', 'ontology_lookup', {}), completedEvent('tool_calls')),
        events(completedEvent('stop')),
      ],
    })
    harness.gateway.on('ontology_lookup', (call) => {
      // The first call consumes the last allowance; the next turn's stop hook must end the run.
      harness.budget.remainingValue = { ...harness.budget.remainingValue, toolCallsRemaining: 0 }
      return okResult(call.callId, { items: [] })
    })

    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))

    expect(harness.generation.requests).toHaveLength(1)
    const failed = eventsOfType(runtimeEvents, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.error.code).toBe('BUDGET_EXHAUSTED')
    expect(runtimeEvents.some((event) => event.type === 'collection_complete')).toBe(false)
  })

  it('stops when the host aborts the injected signal and closes the generation call as usage_unknown', async () => {
    const harness = buildPiDependencies({ scripts: [BLOCK] })
    const runtimeEventsPromise = collect(adapterFor().start(runtimeInput(), harness.dependencies))
    await waitFor(() => harness.generation.requests.length === 1)

    harness.controller.abort(new Error('host abort'))
    const runtimeEvents = await runtimeEventsPromise

    expect(eventsOfType(runtimeEvents, 'cancelled')).toHaveLength(1)
    expect(runtimeEvents.some((event) => event.type === 'collection_complete')).toBe(false)
    // A remote call may already have been billed: the closed generator settles usage_unknown.
    expect(harness.generation.settlements).toEqual(['usage_unknown'])
  })

  it('reads the shared ledger and honours a zero remaining budget before any model call', async () => {
    const harness = buildPiDependencies({
      scripts: [events(completedEvent('stop'))],
      budget: { toolCallsRemaining: 0 },
    })
    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))

    expect(harness.generation.requests).toHaveLength(0)
    expect(harness.budget.remainingCalls).toEqual([RUN_ID])
    expect(eventsOfType(runtimeEvents, 'failed')[0]?.error.code).toBe('BUDGET_EXHAUSTED')
  })

  it('propagates the trusted deadline and refuses to start after it has passed', async () => {
    const harness = buildPiDependencies({
      ctx: piContext({ deadline: '2000-01-01T00:00:00Z' }),
      scripts: [events(completedEvent('stop'))],
    })
    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))

    expect(harness.generation.requests).toHaveLength(0)
    expect(eventsOfType(runtimeEvents, 'failed')[0]?.error.code).toBe('DEADLINE_EXCEEDED')
  })

  it('forwards the model usage reported by the generation port into the Pi transcript', async () => {
    const harness = buildPiDependencies({
      scripts: [events(usageEvent(11, 7), completedEvent('stop'))],
    })
    const runtimeEvents = await collect(adapterFor().start(runtimeInput(), harness.dependencies))
    expect(runtimeEvents.at(-1)?.type).toBe('collection_complete')
    expect(harness.generation.requests).toHaveLength(1)
  })

  it('enforces the trusted context run binding', async () => {
    const harness = buildPiDependencies({
      ctx: piContext({ runId: '44444444-4444-4444-8444-444444444444' }),
      scripts: [events(completedEvent('stop'))],
    })
    await expect(
      collect(adapterFor().start(runtimeInput(), harness.dependencies)),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_DEPENDENCIES' })
  })

  it('reports not_found when cancelling an unknown run', async () => {
    const receipt = await adapterFor().cancel(RUN_ID, 'nobody is running')
    expect(receipt.status).toBe('not_found')
  })

  it('exposes only the host-injected restricted dependency closure', () => {
    const harness = buildPiDependencies()
    expect(Object.keys(harness.dependencies).sort()).toEqual([
      'budget',
      'checkpoints',
      'ctx',
      'decision',
      'gateway',
      'generation',
      'signal',
    ])
    for (const forbidden of ['store', 'database', 'db', 'pool', 'blob', 'fs', 'client', 'control']) {
      expect(Object.prototype.hasOwnProperty.call(harness.dependencies, forbidden)).toBe(false)
    }
  })
})

describe('PiRuntimeAdapter — checkpoint compatibility', () => {
  it('resumes from a checkpoint written by the same runtime and locked SDK version', async () => {
    const checkpoints = new InMemoryCheckpoints()
    const first = buildPiDependencies({
      checkpoints,
      scripts: [
        events(toolCallDelta('call-1', 'ontology_lookup', {}), completedEvent('tool_calls')),
        BLOCK,
      ],
    })
    first.gateway.on('ontology_lookup', (call) => okResult(call.callId, { items: [] }))

    const adapter = adapterFor()
    const firstEventsPromise = collect(adapter.start(runtimeInput(), first.dependencies))
    await waitFor(() => first.generation.requests.length === 2)
    const checkpoint = checkpoints.latest()
    if (checkpoint === undefined) throw new Error('no checkpoint was saved')
    first.controller.abort(new Error('pause the run'))
    const firstEvents = await firstEventsPromise
    expect(firstEvents.some((event) => event.type === 'cancelled')).toBe(true)

    const second = buildPiDependencies({
      checkpoints,
      scripts: [events(textDelta('resumed'), completedEvent('stop'))],
    })
    const resumed = await collect(adapter.resume(resumeInput(checkpoint.ref), second.dependencies))

    expect(resumed.at(-1)?.type).toBe('collection_complete')
    expect(second.generation.requests).toHaveLength(1)
    // The restored checkpoint's transcript is replayed into the resumed generation request.
    expect(second.generation.requests[0]?.messages.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses a checkpoint written by a different locked SDK version', async () => {
    const checkpoints = new InMemoryCheckpoints()
    const writer = adapterFor()
    await collect(
      writer.start(runtimeInput(), buildPiDependencies({ checkpoints, scripts: [events(completedEvent('stop'))] }).dependencies),
    )
    const checkpoint = checkpoints.latest()
    if (checkpoint === undefined) throw new Error('no checkpoint was saved')

    const upgraded = adapterFor({ sdkVersion: '0.0.1' })
    await expect(
      collect(
        upgraded.resume(
          resumeInput(checkpoint.ref),
          buildPiDependencies({ checkpoints, scripts: [events(completedEvent('stop'))] }).dependencies,
        ),
      ),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' })
  })

  it('refuses a checkpoint whose public runtime kind/version do not match, before loading it', async () => {
    const adapter = adapterFor()
    const foreign: RuntimeCheckpointRef = {
      checkpointId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      runId: RUN_ID,
      runtimeKind: 'runtime-template',
      runtimeVersion: '1.0.0',
      stateDigest: sha256DigestOf('whatever'),
      createdAt: '2026-09-21T00:00:00Z',
    }
    await expect(
      collect(adapter.resume(resumeInput(foreign), buildPiDependencies().dependencies)),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INCOMPATIBLE' })
  })

  it('records the SDK/adapter version inside the private checkpoint', async () => {
    const checkpoints = new InMemoryCheckpoints()
    const adapter = adapterFor()
    await collect(
      adapter.start(
        runtimeInput(),
        buildPiDependencies({ checkpoints, scripts: [events(completedEvent('stop'))] }).dependencies,
      ),
    )
    const checkpoint = checkpoints.latest()
    if (checkpoint === undefined) throw new Error('no checkpoint was saved')
    const decoded = JSON.parse(new TextDecoder().decode(checkpoint.payload)) as Record<string, unknown>
    expect(decoded.sdkVersion).toBe(PI_AGENT_CORE_VERSION)
    expect(decoded.adapterVersion).toBe('1.0.0')
    expect(decoded.runtimeKind).toBe('runtime-pi')
  })

  it('pins the installed Pi SDK to the version the adapter was compiled against', async () => {
    const packageJsonPath = fileURLToPath(
      new URL('../../packages/adapters/runtime-pi/package.json', import.meta.url),
    )
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(parsed.dependencies?.['@earendil-works/pi-agent-core']).toBe(PI_AGENT_CORE_VERSION)
  })
})

describe('PiRuntimeAdapter — no publication path', () => {
  it('exposes only manifest/start/resume/cancel and terminates at collection_complete', async () => {
    const adapter = adapterFor()
    expect(Object.keys(adapter)).toEqual(['manifest'])
    const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort()
    expect(prototype).toEqual(['cancel', 'constructor', 'resume', 'start'])

    const harness = buildPiDependencies({ scripts: [events(completedEvent('stop'))] })
    const runtimeEvents = await collect(adapter.start(runtimeInput(), harness.dependencies))
    expect(runtimeEvents.at(-1)?.type).toBe('collection_complete')
    expect(runtimeEvents.map((event) => event.type)).not.toContain('answer_published')
  })

  it('has no store, driver, filesystem or publication token in its source', async () => {
    const base = new URL('../../packages/adapters/runtime-pi/src/', import.meta.url)
    const files = ['runtime.ts', 'stream.ts', 'tools.ts', 'checkpoint.ts', 'types.ts', 'errors.ts']
    for (const file of files) {
      const source = await readFile(fileURLToPath(new URL(file, base)), 'utf8')
      for (const forbidden of [
        'answer_published',
        'final_answer',
        'verify_result',
        "from 'pg'",
        'node:fs',
        'node:net',
        'duckdb',
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden)
      }
    }
    const toolsSource = await readFile(fileURLToPath(new URL('tools.ts', base)), 'utf8')
    expect(toolsSource).toContain('gateway.invoke')
  })
})

describe('PiRuntimeAdapter — gateway cancellation receipt', () => {
  it('quarantines an in-flight attempt and notifies the gateway on cancel', async () => {
    const harness = buildPiDependencies({
      scripts: [events(toolCallDelta('call-1', 'ontology_lookup', {}), completedEvent('tool_calls'))],
    })
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.gateway.on('ontology_lookup', async (call) => {
      await pending
      return okResult(call.callId, { items: [] })
    })

    const adapter = adapterFor()
    const runtimeEventsPromise = collect(adapter.start(runtimeInput(), harness.dependencies))
    await waitFor(() => harness.gateway.calls.length === 1)

    const receipt = await adapter.cancel(RUN_ID, 'user cancelled')
    expect(receipt.status).toBe('cancelling')
    expect(receipt.abandonedAttempts).toHaveLength(1)

    release?.()
    const runtimeEvents = await runtimeEventsPromise
    const cancelled = eventsOfType(runtimeEvents, 'cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.reason).toBe('user cancelled')
    expect(cancelled[0]?.abandonedAttempts).toHaveLength(1)
    expect(harness.gateway.cancellations).toHaveLength(1)
    expect(runtimeEvents.some((event) => event.type === 'collection_complete')).toBe(false)
  })
})
