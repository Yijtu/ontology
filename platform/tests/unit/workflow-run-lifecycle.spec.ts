import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '@ontology/contracts'
import {
  DIGEST,
  NOW,
  RUN_A,
  SCOPE_A,
  ScriptedRuntime,
  buildWorkflowHarness,
  clarificationEvent,
  collectionCompleteEvent,
  evidenceEvent,
  evidenceRef,
  failedEvent,
  ownerContext,
  planEvent,
  platformError,
  startInput,
} from './workflow-fixtures'

const OWNER = ownerContext()

/**
 * V03-039: the plan/loop lifecycle over the shared ledger.
 *
 * These cases pin the budget/cancel/no-progress/deadline stops to a durable reason, prove a
 * clarification/repair resume never resets the one ledger, and prove an incompatible
 * checkpoint is refused explicitly rather than by silently switching runtime version.
 */

function failingScript(code: 'BUDGET_EXHAUSTED' | 'DEADLINE_EXCEEDED' | 'NO_PROGRESS'): RuntimeEvent[] {
  return [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('a')]), failedEvent(RUN_A, platformError(code))]
}

describe('bounded stops persist their reason', () => {
  it.each(['BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED'] as const)(
    'persists %s from a runtime stop and never publishes',
    async (code) => {
      const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [failingScript(code)] }) })

      const view = await harness.controller.startRun(startInput(), OWNER)
      expect(view.state).toBe('failed')
      expect(view.cancelReason).toBe(code)
      expect(view.answer).toBeUndefined()
      expect(await harness.controller.getAnswer(RUN_A, OWNER)).toBeUndefined()

      const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
      expect(events.some((event) => event.event === 'run.failed')).toBe(true)
      expect(events.some((event) => event.event === 'answer.published')).toBe(false)
    },
  )

  it('stops with a persisted NO_PROGRESS after the bounded collection policy is exceeded', async () => {
    const runtime = new ScriptedRuntime({ scripts: [[planEvent(RUN_A)]] })
    const harness = buildWorkflowHarness({ runtime, limits: { maxCollectionRounds: 2 } })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('blocked')
    expect(view.cancelReason).toBe('NO_PROGRESS')
    expect(view.answer).toBeUndefined()
    // The bound is the policy value, not an unbounded loop: at most max+1 collection entries.
    expect(runtime.startCalls.length).toBeLessThanOrEqual(3)
  })
})

describe('one ledger is shared across clarification and repair', () => {
  it('resumes on the same ledger after a clarification and a bounded draft repair', async () => {
    const clarificationId = randomUUID()
    const runtime = new ScriptedRuntime({
      saveCheckpoint: true,
      scripts: [
        [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('first')]), clarificationEvent(RUN_A, clarificationId)],
        [evidenceEvent(RUN_A, [evidenceRef('second')]), collectionCompleteEvent(RUN_A, 2)],
      ],
    })
    const harness = buildWorkflowHarness({ runtime })
    // Force one bounded draft repair so both the resume and the repair draw from one ledger.
    harness.verifier.failOnce = true

    const waiting = await harness.controller.startRun(startInput(), OWNER)
    expect(waiting.state).toBe('awaiting_input')
    const pending = waiting.pendingClarificationId
    if (pending === undefined) throw new Error('the run did not wait on a clarification')

    const published = await harness.controller.respondToClarification(
      { runId: RUN_A, clarificationId: pending, typedResponse: { choice: 'a' }, expectedRevision: waiting.revision },
      OWNER,
    )
    expect(published.state).toBe('published')

    // One runtime, one ledger, two draft attempts: nothing reset the shared quotas.
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(published.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])
    expect(harness.selector.selected).toHaveLength(1)
    expect(runtime.startCalls).toHaveLength(1)
    expect(runtime.resumeCalls).toHaveLength(1)
    expect(harness.draftWriter.calls.map((call) => call.attempt)).toEqual([1, 2])
    const remaining = await harness.budgetService.remaining(published.budgetLedgerId, OWNER)
    expect(remaining.remaining.repairAttemptsRemaining).toBe(1)
  })
})

describe('checkpoint compatibility', () => {
  it('refuses an incompatible checkpoint with CHECKPOINT_INCOMPATIBLE instead of silently restarting', async () => {
    const clarificationId = randomUUID()
    const runtime = new ScriptedRuntime({
      saveCheckpoint: true,
      scripts: [
        [planEvent(RUN_A), clarificationEvent(RUN_A, clarificationId)],
        [collectionCompleteEvent(RUN_A)],
      ],
    })
    const harness = buildWorkflowHarness({ runtime })
    const waiting = await harness.controller.startRun(startInput(), OWNER)
    expect(waiting.state).toBe('awaiting_input')

    // A checkpoint written by another runtime kind/version than the run is locked to.
    const foreignCheckpointId = randomUUID()
    await harness.store.saveCheckpoint(
      SCOPE_A,
      RUN_A,
      {
        checkpointId: foreignCheckpointId,
        runtimeKind: 'runtime-other',
        runtimeVersion: '9.9.9',
        stateDigest: DIGEST,
        payload: new Uint8Array([9]),
        createdAt: NOW,
      },
      OWNER,
    )
    const current = await harness.service.getRun(RUN_A, OWNER)
    await harness.store.compareAndSetRunState(
      SCOPE_A,
      RUN_A,
      current.revision,
      { state: 'collecting', updatedAt: NOW, cancelReason: null, cancelledAt: null },
      OWNER,
    )

    const view = await harness.newController().drivePersistedRun(
      RUN_A,
      OWNER,
      false,
      `resume:${foreignCheckpointId}:2`,
    )
    expect(view.state).toBe('failed')
    expect(view.cancelReason).toBe('CHECKPOINT_INCOMPATIBLE')
    // The runtime that owns the run was never asked to restore the foreign blob.
    expect(runtime.resumeCalls).toHaveLength(0)
  })

  it('resumes a durable checkpoint after a controller restart on the same ledger', async () => {
    const clarificationId = randomUUID()
    const runtime = new ScriptedRuntime({
      saveCheckpoint: true,
      scripts: [
        [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('before')]), clarificationEvent(RUN_A, clarificationId)],
        [collectionCompleteEvent(RUN_A)],
      ],
    })
    const harness = buildWorkflowHarness({ runtime })
    const waiting = await harness.controller.startRun(startInput(), OWNER)
    expect(waiting.state).toBe('awaiting_input')

    const checkpoint = await harness.store.findLatestCheckpoint(SCOPE_A, RUN_A, OWNER)
    if (checkpoint === undefined) throw new Error('no durable checkpoint was written')

    // The API resume path validates the handle and durably moves the run to collecting.
    const resumed = await harness.service.resumeRun(
      {
        runId: RUN_A,
        checkpointId: checkpoint.checkpointId,
        runtimeKind: checkpoint.runtimeKind,
        runtimeVersion: checkpoint.runtimeVersion,
        stateDigest: checkpoint.stateDigest,
        expectedRevision: waiting.revision,
      },
      OWNER,
    )
    expect(resumed.state).toBe('collecting')

    // A fresh controller models a restarted worker process resuming the durable action.
    const view = await harness.newController().drivePersistedRun(
      RUN_A,
      OWNER,
      true,
      `resume:${checkpoint.checkpointId}:${resumed.revision}`,
    )
    expect(view.state).toBe('published')
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(runtime.startCalls).toHaveLength(1)
    expect(runtime.resumeCalls).toHaveLength(1)
  })
})
