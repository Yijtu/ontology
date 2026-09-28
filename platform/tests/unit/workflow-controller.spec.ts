import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryVerificationStore,
  PublicationRejectedError,
  RestrictedAnswerPublisher,
  RunServiceError,
  answerDraftContentHash,
} from '@ontology/application'
import type {
  AnswerDraft,
  PublicationGrant,
  RuntimeEvent,
  VerificationResult,
} from '@ontology/contracts'
import {
  DIGEST,
  RUN_A,
  ScriptedRuntime,
  buildWorkflowHarness,
  clarificationEvent,
  collectionCompleteEvent,
  evidenceRef,
  evidenceEvent,
  otherContext,
  ownerContext,
  planEvent,
  startInput,
} from './workflow-fixtures'
import { waitFor } from './template-runtime-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'

const OWNER = ownerContext()
const OTHER = otherContext()

function completedScript(): RuntimeEvent[] {
  return [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('a')]), collectionCompleteEvent(RUN_A)]
}

async function runToPublished(): Promise<ReturnType<typeof buildWorkflowHarness>> {
  const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [completedScript()] }) })
  const view = await harness.controller.startRun(startInput(), OWNER)
  expect(view.state).toBe('published')
  return harness
}

describe('WorkflowController phase transitions', () => {
  it('drives created → preflight → collecting → drafting → verifying → published', async () => {
    const harness = await runToPublished()

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    const eventNames = events.map((event) => event.event)
    expect(eventNames).toContain('plan.summary')
    expect(eventNames).toContain('evidence.available')
    expect(eventNames[eventNames.length - 1]).toBe('answer.published')
    expect(eventNames).not.toContain('unverified_answer.delta')

    const view = await harness.controller.getRun(RUN_A, OWNER)
    expect(view.state).toBe('published')
    expect(view.answer?.runId).toBe(RUN_A)
    expect(view.evidenceCount).toBe(1)
  })

  it('selects exactly one runtime and starts no competing planning loop', async () => {
    const harness = await runToPublished()

    // Exactly one runtime was selected, one collection loop ran, and the bounded
    // planner/verifier/publisher steps each ran once.
    expect(harness.selector.selected).toHaveLength(1)
    expect(harness.runtime.startCalls).toEqual([RUN_A])
    expect(harness.runtime.resumeCalls).toHaveLength(0)
    expect(harness.probe.runtimeLoops).toBe(1)
    expect(harness.probe.competingLoops).toBe(0)
    expect(harness.draftWriter.calls).toHaveLength(1)
    expect(harness.verifier.calls).toHaveLength(1)
    expect(harness.publisher.publishCalls).toHaveLength(1)

    // The runtime may never reserve or reset the shared budget: only read the projection.
    expect(harness.runtime.budgetReserveAttempts).toEqual(['denied'])
  })

  it('opens the shared budget ledger exactly once across phases and repair', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [completedScript()] }) })
    harness.verifier.failOnce = true

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')

    // One ledger for the whole run, even though a repair re-drafted.
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(view.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])
    expect(harness.draftWriter.calls).toHaveLength(2)
    expect(harness.draftWriter.calls[1]?.attempt).toBe(2)

    // The second (repair) attempt drew from the same monotonic ledger.
    const remaining = await harness.budgetService.remaining(view.budgetLedgerId, OWNER)
    expect(remaining.remaining.repairAttemptsRemaining).toBe(1)
    expect(harness.selector.selected).toHaveLength(1)
    expect(harness.runtime.startCalls).toHaveLength(1)
  })

  it('uses the existing canonical run id and trusted context on an idempotent retry', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [completedScript()] }) })
    const original = startInput()
    await harness.service.createRun(original, OWNER)
    const temporaryRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    const view = await harness.controller.startRun(
      startInput({ runId: temporaryRunId }),
      ownerContext(temporaryRunId),
    )

    expect(view.runId).toBe(RUN_A)
    expect(view.state).toBe('published')
    expect(harness.capabilities.calls).toEqual([RUN_A])
    expect(harness.capabilities.contextRunIds).toEqual([RUN_A])
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
  })
})

describe('clarification resume re-verification', () => {
  function resumeHarness(): ReturnType<typeof buildWorkflowHarness> {
    const clarificationId = randomUUID()
    const runtime = new ScriptedRuntime({
      saveCheckpoint: true,
      scripts: [
        [
          planEvent(RUN_A),
          evidenceEvent(RUN_A, [evidenceRef('first')]),
          clarificationEvent(RUN_A, clarificationId),
        ],
        [evidenceEvent(RUN_A, [evidenceRef('second')]), collectionCompleteEvent(RUN_A, 2)],
      ],
    })
    return buildWorkflowHarness({ runtime })
  }

  it('re-checks permission, resumes the same runtime on the same budget and input manifest', async () => {
    const harness = resumeHarness()
    const waiting = await harness.controller.startRun(startInput(), OWNER)
    expect(waiting.state).toBe('awaiting_input')
    const clarificationId = waiting.pendingClarificationId
    if (clarificationId === undefined) throw new Error('the run did not wait on a clarification')

    // A non-owner cannot answer: permission is re-checked by the run service.
    await expect(
      harness.controller.respondToClarification(
        {
          runId: RUN_A,
          clarificationId,
          typedResponse: { choice: 'a' },
          expectedRevision: waiting.revision,
        },
        OTHER,
      ),
    ).rejects.toBeInstanceOf(RunServiceError)

    const published = await harness.controller.respondToClarification(
      {
        runId: RUN_A,
        clarificationId,
        typedResponse: { choice: 'a' },
        expectedRevision: waiting.revision,
      },
      OWNER,
    )
    expect(published.state).toBe('published')
    expect(published.evidenceCount).toBe(2)

    // The same selected runtime resumed; no second runtime and no second ledger.
    expect(harness.selector.selected).toHaveLength(1)
    expect(harness.runtime.startCalls).toHaveLength(1)
    expect(harness.runtime.resumeCalls).toHaveLength(1)
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(published.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])

    // The input manifest is append-only: the clarification round added evidence without
    // resetting the manifest.
    expect(Number(published.inputManifestRevision)).toBeGreaterThan(1)
  })

  it('rejects stale referenced data and forces re-collection on the same budget/manifest', async () => {
    const harness = resumeHarness()
    const waiting = await harness.controller.startRun(startInput(), OWNER)
    const clarificationId = waiting.pendingClarificationId
    if (clarificationId === undefined) throw new Error('the run did not wait on a clarification')

    const manifest = await harness.workflowStore.getRunManifest(RUN_A, OWNER)
    if (manifest === undefined) throw new Error('the run manifest is missing')
    const input = await harness.workflowStore.getInputManifest(manifest.inputManifestId, OWNER)
    if (input === undefined) throw new Error('the input manifest is missing')
    const evidence = input.entries.find((entry) => entry.kind === 'evidence')
    if (evidence === undefined) throw new Error('no evidence entry was recorded')
    harness.validity.markStale(evidence.entryId, 'source watermark advanced')

    const published = await harness.controller.respondToClarification(
      {
        runId: RUN_A,
        clarificationId,
        typedResponse: { choice: 'a' },
        expectedRevision: waiting.revision,
      },
      OWNER,
    )

    expect(published.state).toBe('published')
    // Data validity was re-checked and the stale entry was flagged, not trusted.
    const state = await harness.workflowStore.getRunState(RUN_A, OWNER)
    expect(state?.recheckCount).toBe(1)
    expect(state?.staleEntryIds).toEqual([evidence.entryId])

    // Re-collection still used the one budget ledger and the append-only manifest.
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(published.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])
    const after = await harness.workflowStore.getInputManifest(manifest.inputManifestId, OWNER)
    expect(after?.entries.some((entry) => entry.label.startsWith('stale:'))).toBe(true)
  })
})

describe('cancellation is terminal', () => {
  it('does not revive or publish a cancelled run when a late collection_complete arrives', async () => {
    const runtime = new ScriptedRuntime({ scripts: [completedScript()] })
    runtime.block()
    const harness = buildWorkflowHarness({ runtime })

    const running = harness.controller.startRun(startInput(), OWNER)
    await waitFor(() => runtime.startCalls.length === 1)

    const before = await harness.service.getRun(RUN_A, OWNER)
    const cancelled = await harness.controller.cancel(
      { runId: RUN_A, reason: 'user cancelled', expectedRevision: before.revision },
      OWNER,
    )
    expect(cancelled.state).toBe('cancelled')

    // The blocked runtime now emits its (late) terminal event.
    runtime.release()
    const final = await running
    expect(final.state).toBe('cancelled')
    expect(final.answer).toBeUndefined()
    expect(await harness.controller.getAnswer(RUN_A, OWNER)).toBeUndefined()

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
    const abandoned = await harness.service.listAbandonedAttempts(RUN_A, OWNER)
    expect(abandoned.length).toBeGreaterThanOrEqual(1)
  })

  it('quarantines a late runtime event delivered after cancellation', async () => {
    const runtime = new ScriptedRuntime({ scripts: [completedScript()] })
    runtime.block()
    const harness = buildWorkflowHarness({ runtime })

    const running = harness.controller.startRun(startInput(), OWNER)
    await waitFor(() => runtime.startCalls.length === 1)
    const before = await harness.service.getRun(RUN_A, OWNER)
    await harness.controller.cancel(
      { runId: RUN_A, reason: 'stop', expectedRevision: before.revision },
      OWNER,
    )
    runtime.release()
    await running

    const late = await harness.controller.recordRuntimeEvent(
      RUN_A,
      collectionCompleteEvent(RUN_A),
      OWNER,
    )
    expect(late.disposition).toBe('abandoned')
    const view = await harness.controller.getRun(RUN_A, OWNER)
    expect(view.state).toBe('cancelled')
  })
})

describe('published only after the verifier and publisher ports pass (INV-09)', () => {
  function validDraft(): AnswerDraft {
    const blocks = [{ kind: 'summary' }]
    return {
      draftId: randomUUID(),
      runId: RUN_A,
      blocks,
      evidenceManifestHash: DIGEST,
      contentHash: answerDraftContentHash(RUN_A, blocks, DIGEST),
      limitations: [],
      producedInPhase: 'drafting',
      createdAt: '2026-09-21T00:00:00Z',
    }
  }

  function validVerification(draft: AnswerDraft): VerificationResult {
    return {
      verificationId: randomUUID(),
      draftHash: draft.contentHash,
      evidenceManifestHash: DIGEST,
      verdict: 'pass',
      failedChecks: [],
      policyVersion: 'restricted-policy-v1',
      verifiedAt: '2026-09-21T00:00:00Z',
    }
  }

  function validGrant(draft: AnswerDraft, verification: VerificationResult): PublicationGrant {
    return {
      grantId: randomUUID(),
      runId: RUN_A,
      draftId: draft.draftId,
      draftHash: draft.contentHash,
      verificationId: verification.verificationId,
      evidenceManifestHash: DIGEST,
      scenarioManifestHash: DIGEST,
      expectedRunRevision: '1',
      issuedBy: 'workflow-controller',
      issuedAt: '2026-09-21T00:00:00Z',
    }
  }

  it('rejects a direct publication of a draft whose verification was never recorded', async () => {
    const store = new InMemoryRunStore()
    const verifications = new InMemoryVerificationStore()
    const publisher = new RestrictedAnswerPublisher({ store, verifications })
    const draft = validDraft()
    const verification = validVerification(draft)

    await expect(
      publisher.publish({ grant: validGrant(draft, verification), draft, verification }, OWNER),
    ).rejects.toMatchObject({ reason: 'verification_not_recorded' })
  })

  it('rejects a forged pass verdict, a mismatched draft and a non-controller grant', async () => {
    const store = new InMemoryRunStore()
    const verifications = new InMemoryVerificationStore()
    const publisher = new RestrictedAnswerPublisher({ store, verifications })
    const draft = validDraft()
    const verification = validVerification(draft)

    await expect(
      publisher.publish(
        { grant: validGrant(draft, verification), draft, verification: { ...verification, verdict: 'fail' } },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'verification_not_passed' })

    await expect(
      publisher.publish(
        { grant: validGrant(draft, verification), draft: { ...draft, contentHash: DIGEST }, verification },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'draft_mismatch' })

    await expect(
      publisher.publish(
        {
          grant: { ...validGrant(draft, verification), issuedBy: 'runtime' as 'workflow-controller' },
          draft,
          verification,
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(PublicationRejectedError)
  })

  it('blocks after the bounded repair budget instead of publishing an unverified draft', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [completedScript()] }) })
    harness.verifier.alwaysFail = true

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('blocked')
    expect(view.answer).toBeUndefined()
    expect(await harness.controller.getAnswer(RUN_A, OWNER)).toBeUndefined()
    // The bounded planner ran at most maxDraftAttempts times; it never looped forever.
    expect(harness.draftWriter.calls.length).toBeLessThanOrEqual(2)
    expect(harness.publisher.publishCalls).toHaveLength(0)

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
  })
})

describe('usage_unknown handling', () => {
  it('holds a usage-unknown draft step, blocks the run and never publishes', async () => {
    const harness = buildWorkflowHarness({ runtime: new ScriptedRuntime({ scripts: [completedScript()] }) })
    harness.draftWriter.usageUnknown = true

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('blocked')
    expect(view.usageUnknown).toBe(true)
    expect(view.answer).toBeUndefined()

    const reservations = await harness.budgetStore.listReservations(SCOPE_A, view.budgetLedgerId, OWNER)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('usage_unknown')
    expect(reservations[0]?.usageUnknown).toBe(true)

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
  })
})
