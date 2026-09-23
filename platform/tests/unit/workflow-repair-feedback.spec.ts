import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  answerDraftContentHash,
} from '@ontology/application'
import {
  DRAFT_WRITER_REQUEST_VERSION,
  draftWriterRequestVersionOf,
} from '@ontology/contracts'
import type {
  AnswerDraft,
  AnswerVerifierPort,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  ResourceRef,
  RuntimeEvent,
  ToolContext,
  VerificationResult,
} from '@ontology/contracts'
import {
  RUN_A,
  ScriptedRuntime,
  buildWorkflowHarness,
  collectionCompleteEvent,
  evidenceEvent,
  evidenceRef,
  ownerContext,
  planEvent,
  startInput,
} from './workflow-fixtures'

const OWNER = ownerContext()

const CLAIM_ID = '44444444-4444-4444-8444-444444444444'
const EVIDENCE_REF: ResourceRef = {
  id: '55555555-5555-4555-8555-555555555555',
  version: '1.0.0',
  digest: `sha256:${'e'.repeat(64)}`,
  kind: 'evidence',
}

function completedScript(): RuntimeEvent[] {
  return [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('a')]), collectionCompleteEvent(RUN_A)]
}

/** Fails the first verification with one located hard finding, then defers to the inner verifier. */
class LocatingVerifier implements AnswerVerifierPort {
  calls = 0
  readonly #inner: AnswerVerifierPort

  constructor(inner: AnswerVerifierPort) {
    this.#inner = inner
  }

  async verify(
    request: Parameters<AnswerVerifierPort['verify']>[0],
    ctx: ToolContext,
  ): Promise<VerificationResult> {
    this.calls += 1
    const result = await this.#inner.verify(request, ctx)
    if (this.calls > 1) return result
    return {
      ...result,
      verdict: 'fail',
      failedChecks: ['unit_mismatch'],
      findings: [
        {
          code: 'unit_mismatch',
          axis: 'hard',
          claimId: CLAIM_ID,
          field: 'unit',
          evidenceRef: EVIDENCE_REF,
          pointer: '/unit',
          expected: 'kWh',
          actual: 'MWh',
        },
      ],
    }
  }
}

/** A bounded writer whose draft body carries a sentinel that must never reach the event stream. */
class SentinelDraftWriter implements DraftWriterPort {
  writeDraft(request: DraftWriterRequest): Promise<DraftWriterResult> {
    const blocks: readonly unknown[] = [{ kind: 'summary', sentinel: 'DRAFT_SENTINEL_LEAK' }]
    const draft: AnswerDraft = {
      draftId: randomUUID(),
      runId: request.runId,
      blocks,
      evidenceManifestHash: request.inputManifest.digest,
      contentHash: answerDraftContentHash(request.runId, blocks, request.inputManifest.digest),
      limitations: [],
      producedInPhase: 'drafting',
      createdAt: '2026-09-21T00:00:00Z',
    }
    return Promise.resolve({
      draft,
      usage: { durationMs: 1, calls: 0, modelTokens: 32 },
      evidenceRefs: [
        { id: draft.draftId, version: '1.0.0', digest: draft.contentHash, kind: 'artifact' },
      ],
    })
  }
}

describe('versioned draft-writer request (backward compatible)', () => {
  it('reads an absent requestVersion as the original @1 request', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
    })
    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')

    const captured = harness.draftWriter.calls[0]
    if (captured === undefined) throw new Error('the controller never called the draft writer')

    // A v1 caller is exactly the request without the v2 additions; it is still accepted.
    const v1Request: DraftWriterRequest = {
      runId: captured.runId,
      question: captured.question,
      inputManifest: captured.inputManifest,
      deficits: captured.deficits,
      remainingBudget: captured.remainingBudget,
      attempt: captured.attempt,
    }
    expect(draftWriterRequestVersionOf(v1Request)).toBe('draft-writer-request@1')

    const written = await new RestrictedDraftWriter().writeDraft(v1Request, OWNER)
    expect(written.draft.runId).toBe(RUN_A)
  })

  it('stamps the repair-aware @2 version on the controller request', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
    })
    await harness.controller.startRun(startInput(), OWNER)
    expect(harness.draftWriter.calls[0]?.requestVersion).toBe(DRAFT_WRITER_REQUEST_VERSION)
  })
})

describe('failed checks feed back into the bounded repair (FR-29)', () => {
  it('passes located feedback to the repair attempt and re-verifies it', async () => {
    const runtime = new ScriptedRuntime({ scripts: [completedScript()] })
    const verifier = new LocatingVerifier(new RestrictedAnswerVerifier())
    const harness = buildWorkflowHarness({ runtime, verifier })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')

    // First draft carried no feedback; the repair carried the located finding.
    expect(harness.draftWriter.calls).toHaveLength(2)
    expect(harness.draftWriter.calls[0]?.failedChecks).toBeUndefined()
    const repair = harness.draftWriter.calls[1]
    expect(repair?.attempt).toBe(2)
    expect(repair?.requestVersion).toBe(DRAFT_WRITER_REQUEST_VERSION)
    expect(repair?.failedChecks).toEqual([
      {
        code: 'unit_mismatch',
        axis: 'hard',
        claimId: CLAIM_ID,
        field: 'unit',
        evidenceRef: EVIDENCE_REF,
        pointer: '/unit',
        expected: 'kWh',
        actual: 'MWh',
      },
    ])

    // The repair was re-verified; the verifier was never bypassed or loosened.
    expect(verifier.calls).toBe(2)
    expect(harness.verifier.calls).toHaveLength(2)

    // One shared ledger for the whole run; the repair never reset it.
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(view.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])
    const remaining = await harness.budgetService.remaining(view.budgetLedgerId, OWNER)
    expect(remaining.remaining.repairAttemptsRemaining).toBe(1)
  })

  it('caps the repair rounds and never publishes the unverified draft', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
    })
    harness.verifier.alwaysFail = true

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('blocked')
    expect(view.answer).toBeUndefined()

    // At most the bounded repair budget ran, and the repair was told what failed.
    expect(harness.draftWriter.calls.length).toBe(2)
    expect(harness.draftWriter.calls[1]?.failedChecks?.some((check) => check.code === 'forced_failure')).toBe(
      true,
    )
    expect(harness.publisher.publishCalls).toHaveLength(0)

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
    // The failure feedback is never echoed onto the business event stream.
    expect(JSON.stringify(events)).not.toContain('forced_failure')
  })

  it('never leaks the draft body into the business event stream', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
      draftWriter: new SentinelDraftWriter(),
    })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.map((event) => event.event)).toContain('answer.published')
    expect(JSON.stringify(events)).not.toContain('DRAFT_SENTINEL_LEAK')
  })
})
