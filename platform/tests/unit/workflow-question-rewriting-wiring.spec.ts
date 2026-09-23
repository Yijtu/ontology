import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  QuestionRewriteOutcome,
  QuestionRewriteRequest,
  QuestionRewriter,
} from '@ontology/application'
import type { QuestionRewrite, ToolContext } from '@ontology/contracts'
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
import { SCOPE_A } from './profile-resolver-fixtures'

/**
 * LOCAL-080: the bounded rewrite step is wired into the actual `WorkflowController` run
 * path (not just the planner library) and its trace is persisted on the durable run record.
 * These unit cases prove the controller calls it during preflight, persists the trace, and
 * takes the existing clarify / explicit-failure paths without ever passing the original
 * question through as a rewrite.
 */

const OWNER = ownerContext()
const ORIGINAL = 'which meters used the most energy'
const REWRITTEN = 'List the meters with the highest total energy_kwh'

function trace(): QuestionRewrite {
  return {
    rewriteId: randomUUID(),
    runId: RUN_A,
    version: '1.0.0',
    originalQuestion: ORIGINAL,
    originalDigest: `sha256:${'1'.repeat(64)}`,
    rewrittenQuestion: REWRITTEN,
    rewrittenDigest: `sha256:${'2'.repeat(64)}`,
    inputRefs: [],
    modelRef: { modelId: 'rewrite-model', version: '1.0.0' },
    recordedAt: '2026-09-21T00:00:00Z',
  }
}

/** A deterministic rewriter double that records every request and replays one outcome. */
class ScriptedRewriter implements QuestionRewriter {
  readonly requests: QuestionRewriteRequest[] = []
  readonly #outcome: QuestionRewriteOutcome

  constructor(outcome: QuestionRewriteOutcome) {
    this.#outcome = outcome
  }

  rewrite(request: QuestionRewriteRequest, ctx: ToolContext): Promise<QuestionRewriteOutcome> {
    void ctx
    this.requests.push(request)
    return Promise.resolve(this.#outcome)
  }
}

function completedScript() {
  return [planEvent(RUN_A), evidenceEvent(RUN_A, [evidenceRef('a')]), collectionCompleteEvent(RUN_A)]
}

describe('question rewriting is wired into the controller run path (LOCAL-080)', () => {
  it('runs the rewrite once during preflight and persists the trace on the run record', async () => {
    const rewriter = new ScriptedRewriter({ status: 'rewritten', rewrite: trace() })
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
      rewriter,
    })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')

    // The controller actually invoked the rewrite step, once, with the run's question.
    expect(rewriter.requests).toHaveLength(1)
    expect(rewriter.requests[0]?.runId).toBe(RUN_A)
    expect(rewriter.requests[0]?.question).toBe('compare tomorrow energy strategies')

    // The trace is readable back from the durable run record and is exactly what ran.
    const run = await harness.service.getRun(RUN_A, OWNER)
    expect(run.questionRewrite?.originalQuestion).toBe(ORIGINAL)
    expect(run.questionRewrite?.rewrittenQuestion).toBe(REWRITTEN)
    expect(run.questionRewrite?.version).toBe('1.0.0')

    // The runtime generated from the disambiguated question, so the rewrite actually
    // feeds the SQL-generation path rather than only being recorded.
    expect(harness.runtime.startQuestions).toEqual([REWRITTEN])
    expect(run.question).toBe('compare tomorrow energy strategies')
  })

  it('takes the existing clarification path on ambiguity without recording a trace', async () => {
    const rewriter = new ScriptedRewriter({ status: 'clarify', reason: 'the billing period is missing' })
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
      rewriter,
    })

    const waiting = await harness.controller.startRun(startInput(), OWNER)
    expect(waiting.state).toBe('awaiting_input')
    expect(waiting.pendingClarificationId).toBeDefined()

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'clarification.required')).toBe(true)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)

    // No trace: absence means no successful rewrite, never a pass-through.
    const run = await harness.service.getRun(RUN_A, OWNER)
    expect(run.questionRewrite).toBeUndefined()
    // No runtime was selected before the user answered.
    expect(harness.selector.selected).toHaveLength(0)

    // Answering the clarification resumes collection on the same (unrewritten) run path.
    const clarificationId = waiting.pendingClarificationId
    if (clarificationId === undefined) throw new Error('no clarification to answer')
    const resumed = await harness.controller.respondToClarification(
      { runId: RUN_A, clarificationId, typedResponse: { period: '2026-01' }, expectedRevision: waiting.revision },
      OWNER,
    )
    expect(resumed.state).toBe('published')
    expect(harness.selector.selected).toHaveLength(1)
    // The rewrite is not re-run on resume: the run is already past preflight.
    expect(rewriter.requests).toHaveLength(1)
  })

  it('fails the run explicitly on a rewrite failure and never routes the original question', async () => {
    const rewriter = new ScriptedRewriter({
      status: 'failed',
      error: { code: 'MODEL_UNAVAILABLE', message: 'the rewrite model call failed', retryable: true },
    })
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
      rewriter,
    })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('failed')
    expect(view.answer).toBeUndefined()

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'run.failed')).toBe(true)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)

    // No trace and no runtime selection: the failure was never disguised as a success.
    const run = await harness.service.getRun(RUN_A, OWNER)
    expect(run.questionRewrite).toBeUndefined()
    expect(harness.selector.selected).toHaveLength(0)
    expect(harness.draftWriter.calls).toHaveLength(0)
  })

  it('keeps the run path unchanged when no rewriter is configured', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({ scripts: [completedScript()] }),
    })

    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.state).toBe('published')
    const run = await harness.service.getRun(RUN_A, OWNER)
    expect(run.questionRewrite).toBeUndefined()
    expect(SCOPE_A.tenantId).toBeTruthy()
  })
})
