import { describe, expect, it, vi } from 'vitest'
import type {
  ToolContext,
  Uuid,
  WorkflowDispatchFence,
  WorkflowDispatchLease,
  WorkflowDispatchPort,
} from '@ontology/contracts'
import type { WorkflowController } from '@ontology/application'
import { WorkflowDispatchWorker } from '@ontology/app-worker'
import { toolContext } from './component-registry-fixtures'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const OWNER_ID = '44444444-4444-4444-8444-444444444444'
const DISPATCH_ID = '55555555-5555-4555-8555-555555555555'

function lease(revision = '2'): WorkflowDispatchLease {
  return {
    dispatchId: DISPATCH_ID,
    runId: RUN_ID,
    actionKind: 'drive_run',
    logicalActionId: 'initial-drive',
    payload: { runId: RUN_ID },
    payloadDigest: `sha256:${'a'.repeat(64)}`,
    state: 'leased',
    attempt: '1',
    revision,
    availableAt: '2026-09-28T00:00:00.000Z',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    leaseOwnerId: OWNER_ID,
    leaseExpiresAt: '2026-09-28T00:01:00.000Z',
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function context(): ToolContext {
  return toolContext(undefined, undefined, ['operator'], 'dispatch-worker', RUN_ID)
}

describe('WorkflowDispatchWorker', () => {
  it('renews long controller work and completes with the latest durable fence', async () => {
    const finished = deferred<{ runId: string; state: 'published' }>()
    const initial = lease()
    let claimed = false
    let renewed: WorkflowDispatchLease | undefined
    let completedFence: WorkflowDispatchFence | undefined
    const dispatch: WorkflowDispatchPort = {
      enqueue: vi.fn(),
      reconcileOpenRuns: vi.fn(async () => 0),
      get: vi.fn(),
      claimNext: vi.fn(async () => {
        if (claimed) return undefined
        claimed = true
        return initial
      }),
      renew: vi.fn(async (input) => {
        renewed = { ...lease('3'), attempt: input.attempt }
        return renewed
      }),
      complete: vi.fn(async (input: WorkflowDispatchFence) => {
        completedFence = input
        const record = lease('4')
        return {
          dispatchId: record.dispatchId,
          runId: record.runId,
          actionKind: record.actionKind,
          logicalActionId: record.logicalActionId,
          payload: record.payload,
          payloadDigest: record.payloadDigest,
          state: 'completed' as const,
          attempt: record.attempt,
          revision: record.revision,
          availableAt: record.availableAt,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      }),
      fail: vi.fn(),
      cancel: vi.fn(),
      cancelRun: vi.fn(),
    }
    const controller = {
      drivePersistedRun: vi.fn(() => finished.promise),
      abortActiveWork: vi.fn(),
    } as unknown as WorkflowController
    const worker = new WorkflowDispatchWorker({
      dispatch,
      controller,
      dispatchContext: context(),
      contextForRun: async () => context(),
      ownerId: OWNER_ID,
      leaseDurationMs: 1000,
      idlePollMs: 10,
    })
    const running = worker.tick()
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(dispatch.renew).toHaveBeenCalledOnce()
    expect(renewed?.revision).toBe('3')
    finished.resolve({ runId: RUN_ID, state: 'published' })
    await running
    expect(completedFence).toEqual({
      dispatchId: DISPATCH_ID,
      ownerId: OWNER_ID,
      attempt: '1',
      expectedRevision: '3',
    })
    expect(dispatch.fail).not.toHaveBeenCalled()
  })

  it('aborts active controller work and never completes a lost lease', async () => {
    const finished = deferred<{ runId: string; state: 'blocked' }>()
    let claimed = false
    const dispatch: WorkflowDispatchPort = {
      enqueue: vi.fn(),
      reconcileOpenRuns: vi.fn(async () => 0),
      get: vi.fn(),
      claimNext: vi.fn(async () => {
        if (claimed) return undefined
        claimed = true
        return lease()
      }),
      renew: vi.fn(async () => { throw Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' }) }),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
      cancelRun: vi.fn(),
    }
    const abortActiveWork = vi.fn()
    const controller = {
      drivePersistedRun: vi.fn(() => finished.promise),
      abortActiveWork,
    } as unknown as WorkflowController
    const worker = new WorkflowDispatchWorker({
      dispatch,
      controller,
      dispatchContext: context(),
      contextForRun: async () => context(),
      ownerId: OWNER_ID,
      leaseDurationMs: 1000,
      idlePollMs: 10,
      onError: () => undefined,
    })
    const running = worker.tick()
    await new Promise((resolve) => setTimeout(resolve, 550))
    finished.resolve({ runId: RUN_ID, state: 'blocked' })
    await running
    expect(abortActiveWork).toHaveBeenCalledWith(RUN_ID, 'durable workflow lease was lost')
    expect(dispatch.complete).not.toHaveBeenCalled()
    expect(dispatch.fail).not.toHaveBeenCalled()
  })

  it('passes the claimed recovery attempt and logical clarification action to the controller', async () => {
    const clarificationId = '66666666-6666-4666-8666-666666666666'
    const recovered = { ...lease('3'), attempt: '2', logicalActionId: `clarification-response:${clarificationId}:7` }
    let claimed = false
    const dispatch: WorkflowDispatchPort = {
      enqueue: vi.fn(),
      reconcileOpenRuns: vi.fn(async () => 0),
      get: vi.fn(),
      claimNext: vi.fn(async () => {
        if (claimed) return undefined
        claimed = true
        return recovered
      }),
      renew: vi.fn(),
      complete: vi.fn(async () => ({ ...recovered, state: 'completed' as const })),
      fail: vi.fn(),
      cancel: vi.fn(),
      cancelRun: vi.fn(),
    }
    const driveInputs: { readonly runId: Uuid; readonly recoveredAttempt: boolean; readonly logicalActionId: string }[] = []
    const drivePersistedRun = vi.fn(async (
      runId: Uuid,
      runContext: ToolContext,
      recoveredAttempt: boolean,
      logicalActionId: string,
    ) => {
      driveInputs.push({ runId, recoveredAttempt, logicalActionId: `${logicalActionId}:${runContext.runId}` })
      return { runId, state: 'published' as const }
    })
    const controller = { drivePersistedRun, abortActiveWork: vi.fn() } as unknown as WorkflowController
    const worker = new WorkflowDispatchWorker({
      dispatch,
      controller,
      dispatchContext: context(),
      contextForRun: async () => context(),
      ownerId: OWNER_ID,
      leaseDurationMs: 1000,
      idlePollMs: 10,
    })

    await worker.tick()
    expect(driveInputs).toEqual([{
      runId: RUN_ID,
      recoveredAttempt: true,
      logicalActionId: `${recovered.logicalActionId}:${RUN_ID}`,
    }])
  })

  it('marks a run terminal before making a failed dispatch unclaimable', async () => {
    let claimed = false
    const dispatch: WorkflowDispatchPort = {
      enqueue: vi.fn(),
      reconcileOpenRuns: vi.fn(async () => 0),
      get: vi.fn(),
      claimNext: vi.fn(async () => {
        if (claimed) return undefined
        claimed = true
        return lease()
      }),
      renew: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(async () => ({ ...lease('3'), state: 'failed' as const, failureCode: 'runtime_failed' })),
      cancel: vi.fn(),
      cancelRun: vi.fn(),
    }
    const failure = Object.assign(new Error('provider failure'), { code: 'runtime_failed' })
    const drivePersistedRun = vi.fn(async () => { throw failure })
    const failPersistedRun = vi.fn(async () => ({ runId: RUN_ID, state: 'failed' as const }))
    const controller = {
      drivePersistedRun,
      failPersistedRun,
      abortActiveWork: vi.fn(),
    } as unknown as WorkflowController
    const worker = new WorkflowDispatchWorker({
      dispatch,
      controller,
      dispatchContext: context(),
      contextForRun: async () => context(),
      ownerId: OWNER_ID,
      leaseDurationMs: 1000,
      idlePollMs: 10,
    })

    await worker.tick()
    expect(failPersistedRun).toHaveBeenCalledWith(RUN_ID, 'runtime_failed', expect.anything())
    expect(dispatch.fail).toHaveBeenCalledOnce()
  })
})
