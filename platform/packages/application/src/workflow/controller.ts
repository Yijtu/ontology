import type {
  AnswerDraft,
  BudgetPort,
  BudgetRemaining,
  BudgetSettlementStatus,
  ConfirmedContext,
  DraftWriterResult,
  PlatformError,
  PublicationGrant,
  PublishedAnswer,
  ResourceRef,
  ResumeInput,
  RunManifest,
  RunRecord,
  RuntimeAdapter,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeInput,
  ToolContext,
  ToolUsage,
  Uuid,
  VerificationResult,
  WorkflowInputEntry,
  WorkflowInputManifest,
  WorkflowRunState,
} from '@ontology/contracts'
import { createToolContext, DEFAULT_WORKFLOW_LIMITS, DRAFT_WRITER_REQUEST_VERSION, isToolContext } from '@ontology/contracts'
import { inputManifestDigest, scenarioManifestHash } from './canonical'
import { sha256DigestOf } from '../profiles/canonical'
import { PublicationRejectedError, WorkflowControllerError } from './errors'
import { repairFeedbackOf } from './repair-feedback'
import type {
  CancelWorkflowInput,
  RespondWorkflowInput,
  StartWorkflowInput,
  WorkflowControllerDependencies,
  WorkflowView,
} from './types'

const MAX_PHASE_STEPS = 32
const DRAFT_MODEL_TOKEN_ESTIMATE = 64

interface ActiveLoop {
  readonly adapter: RuntimeAdapter
  readonly controller: AbortController
}

/**
 * The workflow controller (SPEC §4, D7, ADR-14).
 *
 * It owns the outer phase machine — `created → preflight → collecting → drafting →
 * verifying → published` plus `awaiting_input/cancelling/cancelled/blocked/failed` — and
 * delegates the collection loop to **exactly one selected runtime**. It never starts a
 * competing planning loop: the draft writer and verifier are bounded, port-injected steps,
 * and the controller does not hand either of them a runtime.
 *
 * Three invariants are enforced here and proven by the test suite:
 *
 * - **One loop owner.** The runtime is selected once per run and is the only component that
 *   drives collection. Re-collection resumes the same runtime on the same budget ledger.
 * - **Shared budget and input manifest.** The run opens exactly one ledger and one input
 *   manifest; clarification resume re-checks permission (via `RunService`) and data
 *   validity, then continues on the same ledger/manifest.
 * - **Verified publication only (INV-09).** The controller is the only issuer of a
 *   publication grant, and only a recorded passing verification reaches the publisher.
 *   A cancelled run is terminal: a late result is quarantined and can never publish.
 */
export class WorkflowController {
  readonly #deps: WorkflowControllerDependencies
  readonly #now: () => string
  readonly #newId: () => string
  readonly #maxDraftAttempts: number
  readonly #selectedRuntimes = new Map<Uuid, RuntimeAdapter>()
  readonly #active = new Map<Uuid, ActiveLoop>()

  constructor(dependencies: WorkflowControllerDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#maxDraftAttempts =
      dependencies.limits?.maxDraftAttempts ?? DEFAULT_WORKFLOW_LIMITS.maxDraftAttempts
  }

  /** Create a run, open its one ledger/manifest and drive it to a stable phase. */
  async startRun(input: StartWorkflowInput, ctx: ToolContext): Promise<WorkflowView> {
    const created = await this.#deps.runs.createRun(
      {
        runId: input.runId,
        profileRef: input.profileRef,
        question: input.question,
        context: input.context,
        preferences: input.preferences,
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )

    const runId = created.runId
    const runContext = contextForCanonicalRun(ctx, runId)
    const run = await this.#deps.phase.requireRun(runId, runContext)
    const hadManifest = await this.#deps.manifests.getRunManifest(runId, runContext)
    if (hadManifest !== undefined) {
      const recoveryResult = await this.#recoverPersistedRun(run, runContext)
      if (recoveryResult !== undefined) return recoveryResult
    }
    const manifest = await this.#ensureRunManifest(run, runContext, input.budgetOverrides)
    return this.#drive(manifest.runId, runContext)
  }

  /** Recover a run accepted by RunService and persisted in the durable dispatch queue. */
  async drivePersistedRun(
    runId: Uuid,
    ctx: ToolContext,
    recoveredAttempt = false,
    logicalActionId = 'initial-drive',
  ): Promise<WorkflowView> {
    const runContext = contextForCanonicalRun(ctx, runId)
    const run = await this.#deps.phase.requireRun(runId, runContext)
    const manifest = await this.#ensureRunManifest(run, runContext)
    let resumedLogicalAction = false
    if (run.state === 'collecting') {
      const clarificationId = clarificationIdFromAction(logicalActionId)
      if (clarificationId !== undefined) {
        const response = await this.#deps.phase.findClarificationResponse(runId, clarificationId, runContext)
        const checkpoint = await this.#deps.phase.latestCheckpoint(runId, runContext)
        if (response === undefined) return this.#failUnsafeRecovery(run, 'recovery_clarification_response_missing', runContext)
        if (checkpoint === undefined) return this.#failUnsafeRecovery(run, 'recovery_checkpoint_missing', runContext)
        await this.#resumeCollection(runId, clarificationId, response.typedResponse, runContext, checkpoint.checkpointId)
        resumedLogicalAction = true
      } else {
        const checkpointId = resumeCheckpointIdFromAction(logicalActionId)
        if (checkpointId !== undefined) {
          const checkpoint = await this.#deps.phase.checkpointRef(runId, checkpointId, runContext)
          if (checkpoint === undefined) return this.#failUnsafeRecovery(run, 'recovery_checkpoint_missing', runContext)
          await this.#resumeCollection(runId, undefined, undefined, runContext, checkpoint.checkpointId)
          resumedLogicalAction = true
        }
      }
    }
    if (resumedLogicalAction) return this.#drive(manifest.runId, runContext)
    if (recoveredAttempt) {
      const current = await this.#deps.phase.requireRun(runId, runContext)
      const recoveryResult = await this.#recoverPersistedRun(current, runContext)
      if (recoveryResult !== undefined) return recoveryResult
    }
    return this.#drive(manifest.runId, runContext)
  }

  /** Abort in-flight runtime/tool work after its durable lease is lost, without changing run state. */
  abortActiveWork(runId: Uuid, reason: string): void {
    const active = this.#active.get(runId)
    if (active === undefined) return
    active.controller.abort(new Error(reason))
    void active.adapter.cancel(runId, reason).catch(() => undefined)
  }

  /** Persist a controlled terminal state when a durable worker fails outside RuntimeEvent delivery. */
  async failPersistedRun(runId: Uuid, reason: string, ctx: ToolContext): Promise<WorkflowView> {
    const runContext = contextForCanonicalRun(ctx, runId)
    const run = await this.#deps.phase.requireRun(runId, runContext)
    if (run.state === 'published' || run.state === 'failed' || run.state === 'cancelled') {
      return this.#view(runId, runContext)
    }
    const safeReason = /^[A-Za-z0-9_.-]{1,64}$/u.test(reason) ? reason : 'workflow_execution_failed'
    return this.#failUnsafeRecovery(run, safeReason, runContext)
  }

  /**
   * Answer a pending clarification. Permission and revision are re-checked by `RunService`;
   * the controller additionally re-checks that the referenced inputs are still valid. A
   * stale input forces re-collection on the same budget and the same input manifest.
   */
  async respondToClarification(input: RespondWorkflowInput, ctx: ToolContext): Promise<WorkflowView> {
    const run = await this.#deps.phase.requireRun(input.runId, ctx)
    const manifest = await this.#requireRunManifest(run.runId, ctx)
    await this.#deps.runs.respondToClarification(
      {
        runId: input.runId,
        clarificationId: input.clarificationId,
        typedResponse: input.typedResponse,
        expectedRevision: input.expectedRevision,
      },
      ctx,
    )

    const inputManifest = await this.#requireInputManifest(manifest.inputManifestId, ctx)
    const validity = await this.#deps.validity.validate(inputManifest.entries, ctx)
    const state = await this.#requireRunState(run.runId, ctx)
    await this.#saveRunState(
      {
        ...state,
        recheckCount: state.recheckCount + 1,
        staleEntryIds: validity.staleEntries.map((entry) => entry.entryId),
      },
      ctx,
    )

    if (!validity.valid) {
      // The stale data is never trusted. Record why, then re-collect through the runtime
      // on the same budget ledger and the same (append-only) input manifest.
      await this.#appendEntries(
        manifest.inputManifestId,
        validity.staleEntries.map((stale) => ({
          kind: 'clarification',
          label: `stale:${stale.entryId}:${stale.reason}`,
        })),
        run.runId,
        ctx,
      )
    }

    const resumed = await this.#deps.phase.requireRun(run.runId, ctx)
    if (resumed.state === 'collecting') {
      await this.#resumeCollection(manifest.runId, input.clarificationId, input.typedResponse, ctx)
    }
    return this.#drive(manifest.runId, ctx)
  }

  /** Cancel a run. The terminal state is never revived by a late runtime result. */
  async cancel(input: CancelWorkflowInput, ctx: ToolContext): Promise<WorkflowView> {
    await this.#deps.runs.cancelRun(
      { runId: input.runId, reason: input.reason, expectedRevision: input.expectedRevision },
      ctx,
    )
    const active = this.#active.get(input.runId)
    if (active !== undefined) {
      active.controller.abort(new Error(input.reason))
      await active.adapter.cancel(input.runId, input.reason).catch(() => undefined)
    }
    return this.#view(input.runId, ctx)
  }

  async getRun(runId: Uuid, ctx: ToolContext): Promise<WorkflowView> {
    return this.#view(runId, ctx)
  }

  /** The published answer, or `undefined` when nothing has been verified and published. */
  async getAnswer(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    return this.#deps.publisher.findAnswer(runId, ctx)
  }

  /**
   * Apply one runtime event through the existing run event log. A late event after
   * cancellation is quarantined by `RunService` and cannot revive or publish the run.
   */
  async recordRuntimeEvent(runId: Uuid, event: RuntimeEvent, ctx: ToolContext) {
    return this.#deps.runs.recordRuntimeEvent(runId, event, ctx)
  }

  async #drive(runId: Uuid, ctx: ToolContext): Promise<WorkflowView> {
    let collectionRounds = 0
    for (let step = 0; step < MAX_PHASE_STEPS; step += 1) {
      const run = await this.#deps.phase.requireRun(runId, ctx)
      switch (run.state) {
        case 'created':
          await this.#advance(run, 'preflight', {}, ctx)
          continue
        case 'preflight': {
          // The bounded rewrite runs before a runtime is selected or any collection starts.
          // A clarify/failure stops the drive; a success is persisted on the run record.
          if (await this.#rewriteQuestion(run, ctx)) return this.#view(runId, ctx)
          await this.#selectRuntime(run.runId, ctx, run)
          await this.#advance(run, 'collecting', {}, ctx)
          continue
        }
        case 'collecting':
          collectionRounds += 1
          if (collectionRounds > this.#maxDraftAttempts + 2) {
            // A runtime that keeps returning without a terminal event must not be allowed
            // to start an unbounded number of loops: block the run instead.
            await this.#advance(run, 'blocked', { cancelReason: 'NO_PROGRESS' }, ctx)
            return this.#view(runId, ctx)
          }
          await this.#collect(runId, ctx)
          continue
        case 'drafting':
          return this.#draftAndVerify(runId, ctx)
        case 'verifying':
          // A recovered mid-verify run returns to the bounded drafting step.
          await this.#advance(run, 'drafting', {}, ctx)
          continue
        case 'awaiting_input':
        case 'blocked':
        case 'cancelling':
        case 'cancelled':
        case 'failed':
        case 'published':
          return this.#view(runId, ctx)
      }
    }
    throw new WorkflowControllerError(
      'INTERNAL_ERROR',
      `run ${runId} did not reach a stable phase within ${MAX_PHASE_STEPS} steps`,
    )
  }

  /**
   * The bounded question-rewriting pre-step (LOCAL-074/ADR-14), wired into the actual run
   * path. It runs exactly once, during preflight, before a runtime is selected or any
   * collection starts:
   *
   * - a successful rewrite is persisted on the durable run record, so the original →
   *   rewrite → generated-SQL chain is replayable per run;
   * - an ambiguity takes the existing `clarification_requested` path and waits for the user,
   *   never guessing a value;
   * - a failure fails the run explicitly with the classified error, never passing the
   *   original question through as if it had been rewritten.
   *
   * It returns `true` when the run must stop driving (`awaiting_input` or `failed`).
   */
  async #rewriteQuestion(run: RunRecord, ctx: ToolContext): Promise<boolean> {
    const rewriter = this.#deps.rewriter
    if (rewriter === undefined) return false
    const outcome = await rewriter.rewrite(
      {
        runId: run.runId,
        question: run.question,
        context: toConfirmedContext(run),
        evidenceRefs: [],
      },
      ctx,
    )
    if (outcome.status === 'rewritten') {
      await this.#deps.runs.recordQuestionRewrite(run.runId, outcome.rewrite, ctx)
      return false
    }
    if (outcome.status === 'clarify') {
      await this.#deps.runs.recordRuntimeEvent(
        run.runId,
        this.#clarificationRequestedEvent(run, outcome.reason),
        ctx,
      )
      return true
    }
    await this.#deps.runs.recordRuntimeEvent(
      run.runId,
      this.#rewriteFailedEvent(run, outcome.error),
      ctx,
    )
    return true
  }

  /**
   * Synthesise the runtime `clarification_requested` event for a rewrite ambiguity. It reuses
   * the existing projection (awaiting_input + `clarification.required`), so the run waits on
   * the user through the same path a runtime clarification uses. The durable ledger allocates
   * the real monotonic sequence when the event is recorded; the union's `sequence` is a
   * placeholder here and is never persisted as the public id.
   */
  #clarificationRequestedEvent(run: RunRecord, reason: string): RuntimeEvent {
    return {
      type: 'clarification_requested',
      runId: run.runId,
      eventId: this.#newId(),
      sequence: 0,
      occurredAt: this.#now(),
      clarificationId: this.#newId(),
      questionRef: {
        id: `rewrite-clarify:${run.runId}`,
        version: '1.0.0',
        digest: sha256DigestOf(reason),
      },
      questionType: 'noul',
    }
  }

  /**
   * Synthesise the runtime `failed` event for a rewrite failure. The classified error is
   * carried unchanged; the original question is never routed.
   */
  #rewriteFailedEvent(run: RunRecord, error: PlatformError): RuntimeEvent {
    return {
      type: 'failed',
      runId: run.runId,
      eventId: this.#newId(),
      sequence: 0,
      occurredAt: this.#now(),
      error,
    }
  }

  async #collect(runId: Uuid, ctx: ToolContext): Promise<void> {
    const manifest = await this.#requireRunManifest(runId, ctx)
    const run = await this.#deps.phase.requireRun(runId, ctx)
    if (run.state !== 'collecting') return
    const adapter = await this.#selectRuntime(runId, ctx, run)
    const inputManifest = await this.#requireInputManifest(manifest.inputManifestId, ctx)
    const loop = new AbortController()
    this.#active.set(runId, { adapter, controller: loop })
    try {
      const input: RuntimeInput = {
        runId,
        resolvedProfileRef: manifest.resolvedProfileRef,
        // Once a rewrite step has run, the runtime generates from the disambiguated question;
        // the original stays immutable on the run record and the trace links the two. Without
        // a rewrite the original question is used unchanged.
        question: run.questionRewrite?.rewrittenQuestion ?? run.question,
        confirmedContext: toConfirmedContext(run),
        evidenceRefs: evidenceRefsOf(inputManifest),
        deficits: [],
        remainingBudget: await this.#remaining(manifest.budgetLedgerId, ctx),
      }
      const deps = await this.#runtimeDependencies(manifest, ctx, loop.signal)
      for await (const event of adapter.start(input, deps)) {
        const stop = await this.#applyRuntimeEvent(runId, event, ctx)
        if (stop) break
      }
    } finally {
      this.#active.delete(runId)
    }
  }

  async #resumeCollection(
    runId: Uuid,
    clarificationId: Uuid | undefined,
    typedResponse: Readonly<Record<string, unknown>> | undefined,
    ctx: ToolContext,
    checkpointId?: Uuid,
  ): Promise<void> {
    const manifest = await this.#requireRunManifest(runId, ctx)
    const run = await this.#deps.phase.requireRun(runId, ctx)
    const adapter = await this.#selectRuntime(runId, ctx, run)
    const checkpoint = checkpointId === undefined
      ? await this.#deps.phase.latestCheckpoint(runId, ctx)
      : await this.#deps.phase.checkpointRef(runId, checkpointId, ctx)
    if (checkpoint === undefined) {
      // Nothing to resume from: collect from the start on the same budget/manifest.
      await this.#collect(runId, ctx)
      const afterFreshCollection = await this.#deps.phase.requireRun(runId, ctx)
      if (afterFreshCollection.state === 'collecting') {
        await this.#failUnsafeRecovery(afterFreshCollection, 'runtime_collection_incomplete', ctx)
      }
      return
    }
    const loop = new AbortController()
    this.#active.set(runId, { adapter, controller: loop })
    try {
      const input: ResumeInput = {
        runId,
        checkpointRef: checkpoint,
        ...(clarificationId === undefined || typedResponse === undefined
          ? {}
          : {
              clarificationResponse: {
                clarificationId,
                typedResponse,
                expectedRevision: run.revision,
              },
            }),
        remainingBudget: await this.#remaining(manifest.budgetLedgerId, ctx),
      }
      const deps = await this.#runtimeDependencies(manifest, ctx, loop.signal)
      for await (const event of adapter.resume(input, deps)) {
        const stop = await this.#applyRuntimeEvent(runId, event, ctx)
        if (stop) break
      }
    } finally {
      this.#active.delete(runId)
    }
    const afterResume = await this.#deps.phase.requireRun(runId, ctx)
    if (afterResume.state === 'collecting') {
      await this.#failUnsafeRecovery(afterResume, 'runtime_resume_incomplete', ctx)
    }
  }

  /** Returns `true` when the collection loop must stop (terminal or hand-off phase). */
  async #applyRuntimeEvent(runId: Uuid, event: RuntimeEvent, ctx: ToolContext): Promise<boolean> {
    const result = await this.#deps.runs.recordRuntimeEvent(runId, event, ctx)
    if (event.type === 'evidence_added') {
      const manifest = await this.#requireRunManifest(runId, ctx)
      await this.#appendEntries(
        manifest.inputManifestId,
        event.evidenceRefs.map((ref) => ({
          kind: 'evidence',
          label: `evidence:${ref.id}`,
          ref,
        })),
        runId,
        ctx,
      )
    }
    if (event.type === 'failed' && event.error.remoteStateUnknown === true) {
      await this.#markUsageUnknown(runId, ctx)
    }
    if (result.disposition === 'abandoned') return true
    return (
      event.type === 'collection_complete' ||
      event.type === 'clarification_requested' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    )
  }

  async #draftAndVerify(runId: Uuid, ctx: ToolContext): Promise<WorkflowView> {
    let lastFailure: { readonly draft: AnswerDraft; readonly verification: VerificationResult } | undefined
    for (;;) {
      const run = await this.#deps.phase.requireRun(runId, ctx)
      if (run.state !== 'drafting') return this.#view(runId, ctx)

      const state = await this.#requireRunState(runId, ctx)
      if (state.draftAttempts >= this.#maxDraftAttempts) {
        // The bounded repair budget is exhausted. Never publish the unverified draft: fall
        // back once to a limited factual/gap result drawn only from already-supported claims.
        return this.#limitedFallback(runId, lastFailure, 'draft repair budget exhausted', ctx)
      }
      const attempt = state.draftAttempts + 1
      await this.#saveRunState(
        { ...state, draftAttempts: attempt },
        ctx,
      )

      const manifest = await this.#requireRunManifest(runId, ctx)
      const inputManifest = await this.#requireInputManifest(manifest.inputManifestId, ctx)
      const reservation = await this.#deps.budget.reserve(
        {
          ledgerId: manifest.budgetLedgerId,
          idempotencyKey: `draft-${runId}-${attempt}`,
          toolCalls: 0,
          repair: attempt > 1,
          modelTokens: DRAFT_MODEL_TOKEN_ESTIMATE,
        },
        ctx,
      )
      if (!reservation.granted || reservation.reservation === undefined) {
        return this.#limitedFallback(
          runId,
          lastFailure,
          reservation.denial?.code ?? 'BUDGET_EXHAUSTED',
          ctx,
        )
      }

      // A repair attempt is told exactly what failed, in a versioned, locatable form. The
      // feedback is derived from the previous verdict only; it carries claim/field/evidence
      // locators and never draft prose, and it is delivered in process to the writer.
      const failedChecks =
        attempt > 1 && lastFailure !== undefined
          ? repairFeedbackOf(lastFailure.verification)
          : []

      let written: DraftWriterResult
      try {
        written = await this.#deps.draftWriter.writeDraft(
          {
            runId,
            question: run.question,
            inputManifest,
            deficits: state.staleEntryIds.map((id) => `stale_input:${id}`),
            remainingBudget: await this.#remaining(manifest.budgetLedgerId, ctx),
            attempt,
            requestVersion: DRAFT_WRITER_REQUEST_VERSION,
            ...(failedChecks.length === 0 ? {} : { failedChecks }),
          },
          ctx,
        )
      } catch (error) {
        await this.#settle(
          manifest.budgetLedgerId,
          reservation.reservation.reservationId,
          'failed',
          { durationMs: 0 },
          [],
          ctx,
        )
        throw error
      }

      const usageUnknown = written.usage?.usageUnknown === true
      await this.#settle(
        manifest.budgetLedgerId,
        reservation.reservation.reservationId,
        usageUnknown ? 'usage_unknown' : 'completed',
        written.usage ?? { durationMs: 0 },
        usageUnknown ? [] : (written.evidenceRefs ?? []),
        ctx,
      )
      if (usageUnknown) {
        await this.#markUsageUnknown(runId, ctx)
        const fresh = await this.#deps.phase.requireRun(runId, ctx)
        await this.#advance(fresh, 'blocked', { cancelReason: 'usage_unknown' }, ctx)
        return this.#view(runId, ctx)
      }

      const fresh = await this.#deps.phase.requireRun(runId, ctx)
      if (fresh.state !== 'drafting') return this.#view(runId, ctx)
      const verifying = await this.#advance(fresh, 'verifying', {}, ctx)

      const verification = await this.#deps.verifier.verify(
        {
          runId,
          question: verifying.question,
          draft: written.draft,
          inputManifest,
          ...(written.limitations === undefined || written.limitations.length === 0
            ? {}
            : { trustedLimitations: written.limitations }),
        },
        ctx,
      )
      await this.#deps.verifications.record({ runId, verification }, ctx)

      if (verification.verdict !== 'pass') {
        lastFailure = { draft: written.draft, verification }
        const failed = await this.#deps.phase.requireRun(runId, ctx)
        if (failed.state === 'verifying') {
          await this.#advance(failed, 'drafting', {}, ctx)
        }
        continue
      }

      return this.#publishVerified(runId, written.draft, verification, verifying.revision, ctx)
    }
  }

  /**
   * Mint the grant, publish through the real gate and record the public `answer.published`
   * event. The event carries only answer ids/hashes/limitations — never draft text — so the
   * business SSE stream can never leak an unverified draft (C6.1).
   */
  async #publishVerified(
    runId: Uuid,
    draft: AnswerDraft,
    verification: VerificationResult,
    expectedRunRevision: string,
    ctx: ToolContext,
  ): Promise<WorkflowView> {
    const manifest = await this.#requireRunManifest(runId, ctx)
    const inputManifest = await this.#requireInputManifest(manifest.inputManifestId, ctx)
    const workflowDispatchFence = await this.#deps.publicationFence?.(runId, ctx)
    const grant: PublicationGrant = {
      grantId: this.#newId(),
      runId,
      draftId: draft.draftId,
      draftHash: draft.contentHash,
      verificationId: verification.verificationId,
      evidenceManifestHash: verification.evidenceManifestHash,
      scenarioManifestHash: scenarioManifestHash(manifest, inputManifest),
      expectedRunRevision,
      ...(workflowDispatchFence === undefined ? {} : { workflowDispatchFence }),
      issuedBy: 'workflow-controller',
      issuedAt: this.#now(),
    }
    let answer: PublishedAnswer
    try {
      answer = await this.#deps.publisher.publish({ grant, draft, verification }, ctx)
    } catch (error) {
      if (error instanceof PublicationRejectedError) {
        throw new WorkflowControllerError('PUBLICATION_REJECTED', error.message, {
          cause: error,
          failedChecks: verification.failedChecks,
        })
      }
      throw error
    }
    const publishable = await this.#deps.phase.requireRun(runId, ctx)
    if (publishable.state !== 'verifying') {
      // The run was cancelled between verification and publication; the answer store only
      // records an answer while the run is still verifying, so this never publishes.
      throw new WorkflowControllerError(
        'VERSION_CONFLICT',
        `run ${runId} left verifying before publication and cannot publish`,
      )
    }
    await this.#advance(publishable, 'published', {}, ctx)
    await this.#deps.phase.appendEvent(
      runId,
      `run-published:${runId}`,
      'answer.published',
      {
        answerId: answer.answerId,
        draftHash: answer.contentHash,
        verificationId: answer.verificationId,
        publicationKind: answer.publicationKind,
        limitations: answer.limitations,
      },
      this.#now(),
      ctx,
    )
    return this.#view(runId, ctx)
  }

  /**
   * Fallback after the shared repair budget is exhausted: compose one limited result from the
   * last recorded verdict (only already-supported claims survive), verify it with the same
   * verifier and publish it only if it passes. If nothing can be supported, or the limited
   * draft still fails, the run is blocked with an explicit reason — unverified prose is never
   * published.
   */
  async #limitedFallback(
    runId: Uuid,
    lastFailure: { readonly draft: AnswerDraft; readonly verification: VerificationResult } | undefined,
    reason: string,
    ctx: ToolContext,
  ): Promise<WorkflowView> {
    const run = await this.#deps.phase.requireRun(runId, ctx)
    if (run.state !== 'drafting') return this.#view(runId, ctx)
    const state = await this.#requireRunState(runId, ctx)
    if (state.limitedResultAttempted) {
      await this.#advance(run, 'blocked', { cancelReason: reason }, ctx)
      return this.#view(runId, ctx)
    }
    await this.#saveRunState(
      { ...state, limitedResultAttempted: true },
      ctx,
    )

    const manifest = await this.#requireRunManifest(runId, ctx)
    const inputManifest = await this.#requireInputManifest(manifest.inputManifestId, ctx)
    const limited = await this.#deps.limited.compose(
      {
        runId,
        question: run.question,
        inputManifest,
        ...(lastFailure === undefined
          ? {}
          : {
              previousDraft: lastFailure.draft,
              failedVerification: lastFailure.verification,
            }),
        remainingBudget: await this.#remaining(manifest.budgetLedgerId, ctx),
      },
      ctx,
    )

    const fresh = await this.#deps.phase.requireRun(runId, ctx)
    if (fresh.state !== 'drafting') return this.#view(runId, ctx)
    const verifying = await this.#advance(fresh, 'verifying', {}, ctx)
    const trustedLimitations = [
      'limited_factual_result',
      ...(lastFailure?.verification.failedChecks ?? ['verification_never_passed']),
      ...(lastFailure?.verification.missingEvidence ?? []).map((id) => `missing_evidence:${id}`),
      ...((limited.draft.claims?.length ?? 0) + (limited.draft.assertions?.length ?? 0) === 0
        ? ['no_supported_statements']
        : []),
    ]
    const verification = await this.#deps.verifier.verify(
      { runId, question: run.question, draft: limited.draft, inputManifest, trustedLimitations },
      ctx,
    )
    await this.#deps.verifications.record({ runId, verification }, ctx)
    if (verification.verdict !== 'pass') {
      const blocked = await this.#deps.phase.requireRun(runId, ctx)
      if (blocked.state === 'verifying') {
        await this.#advance(blocked, 'blocked', { cancelReason: reason }, ctx)
      }
      return this.#view(runId, ctx)
    }
    return this.#publishVerified(runId, limited.draft, verification, verifying.revision, ctx)
  }

  async #advance(
    run: RunRecord,
    state: RunRecord['state'],
    patch: { readonly cancelReason?: string },
    ctx: ToolContext,
  ): Promise<RunRecord> {
    const updated = await this.#deps.phase.transition(
      run.runId,
      run.revision,
      state,
      patch.cancelReason === undefined ? {} : { cancelReason: patch.cancelReason },
      ctx,
    )
    await this.#deps.phase.appendEvent(
      run.runId,
      `run-phase:${run.runId}:${state}:${updated.revision}`,
      'run.state',
      { state, ...(patch.cancelReason === undefined ? {} : { reason: patch.cancelReason }) },
      this.#now(),
      ctx,
    )
    return updated
  }

  async #selectRuntime(runId: Uuid, ctx: ToolContext, run: RunRecord): Promise<RuntimeAdapter> {
    const cached = this.#selectedRuntimes.get(runId)
    if (cached !== undefined) return cached
    let adapter: RuntimeAdapter
    try {
      adapter = await this.#deps.runtimes.select(run.runtimeRef, ctx)
    } catch (error) {
      throw new WorkflowControllerError(
        'NO_RUNTIME_SELECTED',
        `could not select the runtime ${run.runtimeRef.id}@${run.runtimeRef.version} for run ${runId}`,
        { cause: error },
      )
    }
    this.#selectedRuntimes.set(runId, adapter)
    return adapter
  }

  async #runtimeDependencies(
    manifest: RunManifest,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<RuntimeDependencies> {
    const capability = await this.#deps.capabilities.forRun(
      {
        runId: manifest.runId,
        resolvedProfileRef: manifest.resolvedProfileRef,
        runtimeRef: manifest.runtimeRef,
        budgetLedgerId: manifest.budgetLedgerId,
        signal,
      },
      ctx,
    )
    return {
      ctx,
      gateway: capability.gateway,
      generation: capability.generation,
      decision: capability.decision,
      checkpoints: capability.checkpoints,
      budget: this.#runtimeBudget(manifest.budgetLedgerId, ctx),
      signal,
    }
  }

  #runtimeBudget(ledgerId: Uuid, ctx: ToolContext): BudgetPort {
    const budget = this.#deps.budget
    return {
      reserve: () =>
        Promise.reject(
          new WorkflowControllerError(
            'INVALID_ARGUMENT',
            'the runtime must not reserve budget directly; it reads the shared projection',
          ),
        ),
      settle: () =>
        Promise.reject(
          new WorkflowControllerError(
            'INVALID_ARGUMENT',
            'the runtime must not settle budget directly; the gateway settles each call',
          ),
        ),
      remaining: async () => (await budget.remaining(ledgerId, ctx)).remaining,
    }
  }

  async #remaining(ledgerId: Uuid, ctx: ToolContext): Promise<BudgetRemaining> {
    return (await this.#deps.budget.remaining(ledgerId, ctx)).remaining
  }

  async #settle(
    ledgerId: Uuid,
    reservationId: Uuid,
    status: BudgetSettlementStatus,
    usage: ToolUsage,
    evidenceRefs: readonly ResourceRef[],
    ctx: ToolContext,
  ): Promise<void> {
    await this.#deps.budget.settle({ ledgerId, reservationId, status, usage, evidenceRefs }, ctx)
  }

  async #createInputManifest(run: RunRecord, ctx: ToolContext): Promise<WorkflowInputManifest> {
    const recordedAt = run.createdAt
    const entries: WorkflowInputEntry[] = [
      {
        entryId: stableUuid('question-entry', run.runId),
        kind: 'confirmed_context',
        label: `question:${run.runId}`,
        addedInPhase: 'preflight',
        recordedAt,
        readAt: recordedAt,
      },
      {
        entryId: stableUuid('site-entry', run.runId),
        kind: 'confirmed_context',
        label: `site:${run.context.siteRef ?? 'unspecified'}`,
        addedInPhase: 'preflight',
        recordedAt,
        readAt: recordedAt,
      },
    ]
    const manifest: WorkflowInputManifest = {
      manifestId: stableUuid('input-manifest', run.runId),
      runId: run.runId,
      revision: '1',
      entries,
      digest: inputManifestDigest(run.runId, entries),
    }
    return this.#deps.manifests.saveInputManifest(manifest, ctx)
  }

  async #ensureRunManifest(
    run: RunRecord,
    ctx: ToolContext,
    budgetOverrides?: StartWorkflowInput['budgetOverrides'],
  ): Promise<RunManifest> {
    const existing = await this.#deps.manifests.getRunManifest(run.runId, ctx)
    if (existing !== undefined) return existing

    const inputManifest = await this.#createInputManifest(run, ctx)
    const ledger = await this.#deps.budget.openLedger(
      {
        ledgerId: stableUuid('run-budget-ledger', run.runId),
        kind: 'run',
        runId: run.runId,
        ...(budgetOverrides === undefined ? {} : { overrideLimits: budgetOverrides }),
      },
      ctx,
    )
    return this.#deps.manifests.saveRunManifest(
      {
        runId: run.runId,
        resolvedProfileRef: {
          id: run.profileRef.id,
          version: run.profileRef.version,
          snapshotHash: run.resolvedProfileHash,
        },
        runtimeRef: run.runtimeRef,
        budgetLedgerId: ledger.ledgerId,
        inputManifestId: inputManifest.manifestId,
        createdAt: run.createdAt,
      },
      ctx,
    )
  }

  /**
   * A reclaimed dispatch is not permission to repeat an uncertain external operation.
   * Resume collection only from a durable runtime checkpoint; if the lost process had
   * started a non-idempotent model/verifier step without a saved receipt, end in a visible
   * controlled failure instead of silently starting it again.
   */
  async #recoverPersistedRun(run: RunRecord, ctx: ToolContext): Promise<WorkflowView | undefined> {
    if (run.state === 'preflight' && this.#deps.rewriter !== undefined && run.questionRewrite === undefined) {
      return this.#failUnsafeRecovery(run, 'recovery_rewriter_receipt_missing', ctx)
    }
    if (run.state === 'collecting') {
      const checkpoint = await this.#deps.phase.latestCheckpoint(run.runId, ctx)
      if (checkpoint === undefined) {
        return this.#failUnsafeRecovery(run, 'recovery_checkpoint_missing', ctx)
      }
      await this.#resumeCollection(run.runId, undefined, undefined, ctx)
      return undefined
    }
    if (run.state === 'drafting') {
      const state = await this.#requireRunState(run.runId, ctx)
      if (state.draftAttempts > 0 && this.#deps.draftWriter.recoverySafety !== 'idempotent') {
        return this.#failUnsafeRecovery(run, 'recovery_draft_receipt_missing', ctx)
      }
    }
    if (run.state === 'verifying') {
      return this.#failUnsafeRecovery(run, 'recovery_verification_draft_missing', ctx)
    }
    return undefined
  }

  async #failUnsafeRecovery(run: RunRecord, reason: string, ctx: ToolContext): Promise<WorkflowView> {
    await this.#advance(run, 'failed', { cancelReason: reason }, ctx)
    return this.#view(run.runId, ctx)
  }

  async #appendEntries(
    manifestId: Uuid,
    additions: readonly {
      readonly kind: WorkflowInputEntry['kind']
      readonly label: string
      readonly ref?: ResourceRef
    }[],
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<void> {
    if (additions.length === 0) return
    const current = await this.#requireInputManifest(manifestId, ctx)
    const recordedAt = this.#now()
    const newEntries: WorkflowInputEntry[] = additions.map((addition) => ({
      entryId: this.#newId(),
      kind: addition.kind,
      label: addition.label,
      ...(addition.ref === undefined ? {} : { ref: addition.ref }),
      addedInPhase: 'collecting',
      recordedAt,
      readAt: recordedAt,
    }))
    const entries = [...current.entries, ...newEntries]
    await this.#deps.manifests.saveInputManifest(
      {
        ...current,
        revision: String(Number(current.revision) + 1),
        entries,
        digest: inputManifestDigest(runId, entries),
      },
      ctx,
    )
  }

  async #markUsageUnknown(runId: Uuid, ctx: ToolContext): Promise<void> {
    const state = await this.#requireRunState(runId, ctx)
    if (state.usageUnknown) return
    await this.#saveRunState(
      { ...state, usageUnknown: true },
      ctx,
    )
  }

  async #requireRunManifest(runId: Uuid, ctx: ToolContext) {
    const manifest = await this.#deps.manifests.getRunManifest(runId, ctx)
    if (manifest === undefined) {
      throw new WorkflowControllerError('MANIFEST_NOT_FOUND', `run ${runId} has no run manifest`)
    }
    return manifest
  }

  async #requireInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest> {
    const manifest = await this.#deps.manifests.getInputManifest(manifestId, ctx)
    if (manifest === undefined) {
      throw new WorkflowControllerError(
        'MANIFEST_NOT_FOUND',
        `input manifest ${manifestId} is not visible in this scope`,
      )
    }
    return manifest
  }

  async #requireRunState(runId: Uuid, ctx: ToolContext): Promise<WorkflowRunState> {
    const state = await this.#deps.manifests.getRunState(runId, ctx)
    if (state !== undefined) return state
    return {
      runId,
      revision: '0',
      draftAttempts: 0,
      recheckCount: 0,
      staleEntryIds: [],
      usageUnknown: false,
      limitedResultAttempted: false,
      updatedAt: this.#now(),
    }
  }

  async #saveRunState(state: WorkflowRunState, ctx: ToolContext): Promise<WorkflowRunState> {
    const expectedRevision = state.revision
    const revision = (BigInt(expectedRevision) + 1n).toString()
    return this.#deps.manifests.saveRunState(
      { ...state, revision, updatedAt: this.#now() },
      expectedRevision,
      ctx,
    )
  }

  async #view(runId: Uuid, ctx: ToolContext): Promise<WorkflowView> {
    const run = await this.#deps.phase.requireRun(runId, ctx)
    const manifest = await this.#deps.manifests.getRunManifest(runId, ctx)
    const inputManifest =
      manifest === undefined
        ? undefined
        : await this.#deps.manifests.getInputManifest(manifest.inputManifestId, ctx)
    const state = await this.#requireRunState(runId, ctx)
    const answer = await this.#deps.publisher.findAnswer(runId, ctx)
    const evidenceCount =
      inputManifest === undefined
        ? 0
        : inputManifest.entries.filter((entry) => entry.kind === 'evidence').length
    return {
      runId,
      state: run.state,
      revision: run.revision,
      runtimeRef: run.runtimeRef,
      resolvedProfileHash: run.resolvedProfileHash,
      budgetLedgerId: manifest?.budgetLedgerId ?? '',
      inputManifestRevision: inputManifest?.revision ?? '0',
      evidenceCount,
      draftAttempts: state.draftAttempts,
      usageUnknown: state.usageUnknown,
      ...(run.pendingClarificationId === undefined
        ? {}
        : { pendingClarificationId: run.pendingClarificationId }),
      ...(run.cancelReason === undefined ? {} : { cancelReason: run.cancelReason }),
      ...(answer === undefined ? {} : { answer }),
    }
  }
}

function contextForCanonicalRun(ctx: ToolContext, runId: Uuid): ToolContext {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  return createToolContext({ ...ctx, runId })
}

function stableUuid(namespace: string, runId: Uuid): Uuid {
  const digest = sha256DigestOf(`${namespace}:${runId}`).slice('sha256:'.length, 'sha256:'.length + 32)
  const chars = [...digest]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function clarificationIdFromAction(logicalActionId: string): Uuid | undefined {
  const match = /^clarification-response:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9]\d*)$/iu.exec(logicalActionId)
  return match?.[1] as Uuid | undefined
}

function resumeCheckpointIdFromAction(logicalActionId: string): Uuid | undefined {
  const match = /^resume:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9]\d*)$/iu.exec(logicalActionId)
  return match?.[1] as Uuid | undefined
}

function toConfirmedContext(run: RunRecord): ConfirmedContext {
  return {
    timeZone: run.context.timeZone,
    ...(run.context.siteRef === undefined ? {} : { siteRef: run.context.siteRef }),
  }
}

function evidenceRefsOf(manifest: WorkflowInputManifest): ResourceRef[] {
  return manifest.entries
    .filter((entry): entry is WorkflowInputEntry & { ref: ResourceRef } => entry.ref !== undefined)
    .map((entry) => entry.ref)
}
