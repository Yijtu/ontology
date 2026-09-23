import { describe, expect, it } from 'vitest'
import type { EvidenceCall, ExecutablePlan, ExecutablePlanStep, ToolId } from '@ontology/contracts'
import { NoProgressGuard, SmallPlanExecutor } from '@ontology/application'
import { gatewayContext } from './tool-gateway-fixtures'
import {
  PLANNING_RUN,
  QueuedGateway,
  SOURCE_VERSION,
  budgetWith,
  toolResult,
} from './workflow-planning-fixtures'

const CTX = gatewayContext({ runId: PLANNING_RUN })

function plan(steps: readonly ExecutablePlanStep[]): ExecutablePlan {
  return {
    planRef: { id: 'plan-loop', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'plan' },
    steps,
    singleQuery: false,
  }
}

function step(
  stepId: string,
  toolId: ToolId,
  args: Record<string, unknown>,
  sourceVersion = SOURCE_VERSION,
): ExecutablePlanStep {
  return { stepId, toolId, arguments: args, dependsOn: [], sourceVersion }
}

function executorWith(
  gateway: QueuedGateway,
  remaining = budgetWith({}),
): SmallPlanExecutor {
  return new SmallPlanExecutor({
    gateway,
    guard: new NoProgressGuard({ maxRounds: 8 }),
    remaining: () => Promise.resolve(remaining),
  })
}

describe('repeat key', () => {
  it('includes the tool, canonical arguments and the source version', () => {
    const guard = new NoProgressGuard({ maxRounds: 8 })
    const base: EvidenceCall = {
      toolId: 'data_query',
      arguments: { b: 2, a: 1 },
      sourceVersion: SOURCE_VERSION,
    }
    const reordered: EvidenceCall = {
      toolId: 'data_query',
      arguments: { a: 1, b: 2 },
      sourceVersion: SOURCE_VERSION,
    }
    const otherSource: EvidenceCall = {
      ...base,
      sourceVersion: { ...SOURCE_VERSION, version: '2.0.0' },
    }
    const otherTool: EvidenceCall = { ...base, toolId: 'ontology_lookup' }

    // Canonical: argument key order does not change the key.
    expect(guard.keyFor(base)).toBe(guard.keyFor(reordered))
    // The source version is part of the key.
    expect(guard.keyFor(otherSource)).not.toBe(guard.keyFor(base))
    // The tool is part of the key.
    expect(guard.keyFor(otherTool)).not.toBe(guard.keyFor(base))
  })

  it('treats the same tool and arguments against a new source version as new work', () => {
    const guard = new NoProgressGuard({ maxRounds: 8 })
    const call: EvidenceCall = { toolId: 'data_query', arguments: { x: 1 }, sourceVersion: SOURCE_VERSION }
    guard.observe(call, toolResult({ status: 'ok', evidenceSeed: 'one' }), budgetWith({}))

    expect(guard.previousResult(call)).toBeDefined()
    expect(
      guard.previousResult({ ...call, sourceVersion: { ...SOURCE_VERSION, digest: `sha256:${'d'.repeat(64)}` } }),
    ).toBeUndefined()
  })
})

describe('bounded loop only on new information', () => {
  it('executes each genuinely new step and does not stop', async () => {
    const gateway = new QueuedGateway()
      .queue(toolResult({ status: 'ok', evidenceSeed: 'one' }))
      .queue(toolResult({ status: 'ok', evidenceSeed: 'two' }))
    const executor = executorWith(gateway)

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'ontology_lookup', { y: 2 })]),
      CTX,
    )

    expect(gateway.calls).toHaveLength(2)
    expect(result.executedStepIds).toEqual(['s1', 's2'])
    expect(result.stopped).toBe(false)
    expect(result.stopCode).toBeUndefined()
  })

  it('detects an identical repeat and does not re-execute it', async () => {
    const gateway = new QueuedGateway().queue(toolResult({ status: 'ok', evidenceSeed: 'one' }))
    const executor = executorWith(gateway)

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'data_query', { x: 1 })]),
      CTX,
    )

    expect(gateway.calls).toHaveLength(1)
    expect(result.executedStepIds).toEqual(['s1'])
    expect(result.skippedStepIds).toEqual(['s2'])
    expect(result.stopCode).toBe('NO_PROGRESS')
    expect(result.decisions.at(-1)?.reason).toBe('duplicate')
  })

  it('stops when a different call returns no new information', async () => {
    const gateway = new QueuedGateway()
      .queue(toolResult({ status: 'ok', evidenceSeed: 'shared' }))
      .queue(toolResult({ status: 'ok', evidenceSeed: 'shared' }))
    const executor = executorWith(gateway)

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'ontology_lookup', { y: 2 })]),
      CTX,
    )

    expect(result.executedStepIds).toEqual(['s1', 's2'])
    expect(result.stopCode).toBe('NO_PROGRESS')
    expect(result.decisions.at(-1)?.reason).toBe('no_new_information')
  })

  it('is bounded by the round limit', () => {
    const guard = new NoProgressGuard({ maxRounds: 1 })
    const first = guard.observe(
      { toolId: 'data_query', arguments: { x: 1 } },
      toolResult({ status: 'ok', evidenceSeed: 'one' }),
      budgetWith({}),
    )
    const second = guard.observe(
      { toolId: 'ontology_lookup', arguments: { y: 2 } },
      toolResult({ status: 'ok', evidenceSeed: 'two' }),
      budgetWith({}),
    )

    expect(first.action).toBe('continue')
    expect(second.action).toBe('stop')
    expect(second.reason).toBe('round_limit')
    expect(second.stopCode).toBe('NO_PROGRESS')
  })
})

describe('explicit stops and failure classification', () => {
  it('stops with NO_PROGRESS on an empty result', async () => {
    const gateway = new QueuedGateway().queue(toolResult({ status: 'empty' }))
    const executor = executorWith(gateway)

    const result = await executor.execute(plan([step('s1', 'data_query', { x: 1 })]), CTX)

    expect(result.stopCode).toBe('NO_PROGRESS')
    expect(result.decisions[0]?.reason).toBe('empty')
    expect(result.decisions[0]?.failure).toBeUndefined()
  })

  it('stops with BUDGET_EXHAUSTED before executing when the shared budget is spent', async () => {
    const gateway = new QueuedGateway().queue(toolResult({ status: 'ok', evidenceSeed: 'one' }))
    const executor = executorWith(gateway, budgetWith({ toolCallsRemaining: 0 }))

    const result = await executor.execute(plan([step('s1', 'data_query', { x: 1 })]), CTX)

    expect(gateway.calls).toHaveLength(0)
    expect(result.executedStepIds).toEqual([])
    expect(result.stopCode).toBe('BUDGET_EXHAUSTED')
    expect(result.decisions[0]?.reason).toBe('budget_exhausted')
  })

  it('reports a tool failure as a failure, never as an empty result', async () => {
    const gateway = new QueuedGateway().queue(
      toolResult({ status: 'error', errorCode: 'SOURCE_UNAVAILABLE' }),
    )
    const executor = executorWith(gateway)

    const result = await executor.execute(plan([step('s1', 'data_query', { x: 1 })]), CTX)

    expect(result.decisions[0]?.reason).toBe('failed')
    expect(result.decisions[0]?.reason).not.toBe('empty')
    expect(result.decisions[0]?.failure?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.decisions[0]?.stopCode).toBeUndefined()
    expect(result.failure?.code).toBe('SOURCE_UNAVAILABLE')
  })
})

describe('bounded failure repair in the deterministic loop (FR-29)', () => {
  function repairExecutor(
    gateway: QueuedGateway,
    options: { readonly maxFailureRepairs: number; readonly remaining?: ReturnType<typeof budgetWith> },
  ): SmallPlanExecutor {
    return new SmallPlanExecutor({
      gateway,
      guard: new NoProgressGuard({ maxRounds: 8, maxFailureRepairs: options.maxFailureRepairs }),
      remaining: () => Promise.resolve(options.remaining ?? budgetWith({})),
    })
  }

  it('continues past a failed round instead of stopping immediately', async () => {
    const gateway = new QueuedGateway()
      .queue(toolResult({ status: 'error', errorCode: 'SOURCE_UNAVAILABLE' }))
      .queue(toolResult({ status: 'ok', evidenceSeed: 'recovered' }))
    const executor = repairExecutor(gateway, { maxFailureRepairs: 1 })

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'ontology_lookup', { y: 2 })]),
      CTX,
    )

    expect(gateway.calls).toHaveLength(2)
    expect(result.executedStepIds).toEqual(['s1', 's2'])
    expect(result.stopped).toBe(false)
    // The failure is still surfaced even though a repair round ran.
    expect(result.failure?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.decisions[0]?.action).toBe('continue')
    expect(result.decisions[0]?.reason).toBe('failed')
  })

  it('stops once the failure-repair budget is exhausted', async () => {
    const gateway = new QueuedGateway()
      .queue(toolResult({ status: 'error', errorCode: 'SOURCE_UNAVAILABLE' }))
      .queue(toolResult({ status: 'error', errorCode: 'SOURCE_UNAVAILABLE' }))
    const executor = repairExecutor(gateway, { maxFailureRepairs: 1 })

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'ontology_lookup', { y: 2 })]),
      CTX,
    )

    expect(gateway.calls).toHaveLength(2)
    expect(result.stopped).toBe(true)
    expect(result.decisions.at(-1)?.action).toBe('stop')
    expect(result.decisions.at(-1)?.reason).toBe('failed')
    expect(result.failure?.code).toBe('SOURCE_UNAVAILABLE')
  })

  it('never re-executes the failed call: a repeat is still a duplicate', async () => {
    const gateway = new QueuedGateway().queue(
      toolResult({ status: 'error', errorCode: 'SOURCE_UNAVAILABLE' }),
    )
    const executor = repairExecutor(gateway, { maxFailureRepairs: 1 })

    const result = await executor.execute(
      plan([step('s1', 'data_query', { x: 1 }), step('s2', 'data_query', { x: 1 })]),
      CTX,
    )

    expect(gateway.calls).toHaveLength(1)
    expect(result.executedStepIds).toEqual(['s1'])
    expect(result.skippedStepIds).toEqual(['s2'])
  })

  it('rejects a negative failure-repair budget', () => {
    expect(() => new NoProgressGuard({ maxRounds: 4, maxFailureRepairs: -1 })).toThrow()
  })
})
