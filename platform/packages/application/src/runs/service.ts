import { isToolContext, RunStoreError } from '@ontology/contracts'
import type {
  AbandonedAttemptRecord,
  ControlAppendEventRequest,
  ControlRepository,
  QuestionRewrite,
  ResourceRef,
  RevisionString,
  RunInsertResult,
  RunRecord,
  RunState,
  RunStore,
  RuntimeCheckpointRef,
  RuntimeEvent,
  ScopeRef,
  SseEventType,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ProfileResolverError } from '../profiles/errors'
import { RunServiceError } from './errors'
import type { RunServiceErrorCode } from './errors'
import { canTransition, isTerminalRunState, projectRuntimeEvent } from './events'
import type {
  CancelRunInput,
  CreateRunInput,
  CreateRunResult,
  PublicRunEvent,
  RespondToClarificationInput,
  ResumeRunInput,
  RunExecutionBinder,
  RunProfileBinder,
  RunProfileBinding,
  RunView,
  RuntimeEventResult,
  SaveCheckpointInput,
} from './types'
import { parseCreateRunRequest } from './parse'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

export interface RunServiceDependencies {
  /** Run records, the public event log and runtime-private checkpoints. */
  readonly store: RunStore
  /** Durable, monotonic, idempotent event ledger (C1/D2). */
  readonly control: ControlRepository
  /** Resolves and persists the manifest a run binds to; supplied by the composition root. */
  readonly profiles: RunProfileBinder
  /**
   * Resolves, validates and archives the optional execution binding (SPEC v0.3a §EX-2.1).
   * Supplied by the composition root; when absent a request carrying `task` is rejected with
   * `CAPABILITY_NOT_CONFIGURED` rather than silently running without a binding.
   */
  readonly execution?: RunExecutionBinder
  readonly now?: () => string
  readonly newId?: () => string
}

const OPERATOR_ROLES: readonly string[] = ['operator', 'platform-admin']
const READER_ROLES: readonly string[] = ['scoped-reader', 'operator', 'platform-admin']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new RunServiceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new RunServiceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertRunOwner(run: RunRecord, ctx: ToolContext): void {
  if (run.ownerSubjectId !== ctx.principal.subjectId) {
    throw new RunServiceError('FORBIDDEN', 'only the run owner may perform this action')
  }
}

function assertRunOwnerOrOperator(run: RunRecord, ctx: ToolContext): void {
  if (run.ownerSubjectId === ctx.principal.subjectId) return
  if (OPERATOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new RunServiceError('FORBIDDEN', 'only the run owner or an operator may cancel a run')
}

function assertRunReader(run: RunRecord, ctx: ToolContext): void {
  if (run.ownerSubjectId === ctx.principal.subjectId) return
  if (READER_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new RunServiceError('FORBIDDEN', 'only the run owner or a scoped reader may read this run')
}

function requireRevision(run: RunRecord, expected: RevisionString | undefined): void {
  if (expected === undefined) {
    throw new RunServiceError(
      'REVISION_REQUIRED',
      'this update requires an If-Match expected revision',
    )
  }
  if (expected !== run.revision) {
    throw new RunServiceError(
      'VERSION_CONFLICT',
      `run revision ${run.revision} does not match the expected revision ${expected}`,
    )
  }
}

function toView(run: RunRecord, checkpoint: RuntimeCheckpointRef | undefined): RunView {
  return {
    runId: run.runId,
    state: run.state,
    revision: run.revision,
    ownerSubjectId: run.ownerSubjectId,
    profileRef: run.profileRef,
    resolvedProfileHash: run.resolvedProfileHash,
    question: run.question,
    context: run.context,
    preferences: run.preferences,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.cancelReason === undefined ? {} : { cancelReason: run.cancelReason }),
    ...(run.cancelledAt === undefined ? {} : { cancelledAt: run.cancelledAt }),
    ...(run.pendingClarificationId === undefined
      ? {}
      : { pendingClarificationId: run.pendingClarificationId }),
    ...(run.questionRewrite === undefined ? {} : { questionRewrite: run.questionRewrite }),
    ...(run.executionBindingRef === undefined ? {} : { executionBindingRef: run.executionBindingRef }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  }
}

function mapBinderError(error: unknown, profileLabel: string): never {
  if (error instanceof ProfileResolverError) {
    const code: RunServiceErrorCode =
      error.code === 'AUDIT_PERSIST_FAILED'
        ? 'STORAGE_FAILURE'
        : error.code === 'PROFILE_NOT_FOUND'
          ? 'PROFILE_INCOMPATIBLE'
          : error.code
    throw new RunServiceError(code, `could not bind profile ${profileLabel}: ${error.message}`, {
      cause: error,
      ...(error.missingCapabilities === undefined
        ? {}
        : { missingCapabilities: error.missingCapabilities }),
      ...(error.incompatibleReasons === undefined
        ? {}
        : { incompatibleReasons: error.incompatibleReasons }),
    })
  }
  throw error
}

function mapStoreError(error: unknown): never {
  if (error instanceof RunStoreError) {
    const code: RunServiceErrorCode =
      error.code === 'REVISION_CONFLICT'
        ? 'VERSION_CONFLICT'
        : error.code === 'CHECKPOINT_CONFLICT'
          ? 'CHECKPOINT_INCOMPATIBLE'
          : error.code
    throw new RunServiceError(code, error.message, { cause: error })
  }
  throw error
}

/**
 * The run control service (C6/D7). It owns the run state machine, optimistic concurrency,
 * idempotent creation, the public SSE projection and runtime-private checkpoints. It holds
 * no model loop, no runtime adapter and no database driver: every capability arrives by
 * construction injection, and the durable event sequence comes from the existing
 * `ControlRepository.appendEvent` ledger.
 */
export class RunService {
  readonly #store: RunStore
  readonly #control: ControlRepository
  readonly #profiles: RunProfileBinder
  readonly #execution: RunExecutionBinder | undefined
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: RunServiceDependencies) {
    this.#store = dependencies.store
    this.#control = dependencies.control
    this.#profiles = dependencies.profiles
    this.#execution = dependencies.execution
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Create a run and lock its profile. The `Idempotency-Key` is required; the same key with
   * the same canonical payload returns the same run, and the same key with a different
   * payload is `IDEMPOTENCY_CONFLICT` (409), never an overwrite.
   */
  async createRun(input: CreateRunInput, ctx: ToolContext): Promise<CreateRunResult> {
    const scopeRef = scopeOf(ctx)
    this.#validateCreateIdentity(input)
    const fields = parseCreateRunRequest({
      profileRef: input.profileRef,
      question: input.question,
      context: input.context,
      preferences: input.preferences,
      ...(input.execution === undefined ? {} : { task: input.execution }),
    })

    const requestDigest = sha256DigestOf(
      canonicalJson({
        profileRef: { id: fields.profileRef.id, version: fields.profileRef.version },
        question: fields.question,
        context: fields.context,
        preferences: { route: fields.preferences.route, allowWeb: fields.preferences.allowWeb },
        task: fields.execution ?? null,
      }),
    )

    const existing = await this.#store.findRunByIdempotencyKey(scopeRef, input.idempotencyKey, ctx)
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw new RunServiceError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different request payload',
        )
      }
      return {
        runId: existing.runId,
        state: existing.state,
        revision: existing.revision,
        resolvedProfileHash: existing.resolvedProfileHash,
        ...(existing.executionBindingRef === undefined
          ? {}
          : { executionBindingRef: existing.executionBindingRef }),
        reused: true,
      }
    }

    let binding: RunProfileBinding
    try {
      binding = await this.#profiles.bindProfileForRun(fields.profileRef, scopeRef, ctx)
    } catch (error) {
      mapBinderError(error, `${fields.profileRef.id}@${fields.profileRef.version}`)
    }

    let executionBindingRef: ResourceRef | undefined
    if (fields.execution !== undefined) {
      if (this.#execution === undefined) {
        throw new RunServiceError(
          'CAPABILITY_NOT_CONFIGURED',
          'this host cannot resolve a task/input execution binding',
        )
      }
      const resolution = await this.#execution.bindExecution(
        { runId: input.runId, request: fields.execution, profileBinding: binding },
        scopeRef,
        ctx,
      )
      executionBindingRef = resolution.executionBindingRef
    }

    const createdAt = this.#now()
    let inserted: RunInsertResult
    try {
      inserted = await this.#store.insertRun(
        scopeRef,
        {
          runId: input.runId,
          ownerSubjectId: ctx.principal.subjectId,
          profileRef: binding.profileRef,
          resolvedProfileHash: binding.resolvedProfileHash,
          runtimeRef: binding.runtimeRef,
          question: fields.question,
          context: fields.context,
          preferences: fields.preferences,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          createdAt,
          ...(executionBindingRef === undefined ? {} : { executionBindingRef }),
        },
        ctx,
      )
    } catch (error) {
      mapStoreError(error)
    }

    if (!inserted.inserted) {
      // Another request won the race. Same digest means the same run; anything else is a
      // conflict, never an overwrite.
      if (inserted.run.requestDigest !== requestDigest) {
        throw new RunServiceError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different request payload',
        )
      }
      return {
        runId: inserted.run.runId,
        state: inserted.run.state,
        revision: inserted.run.revision,
        resolvedProfileHash: inserted.run.resolvedProfileHash,
        ...(inserted.run.executionBindingRef === undefined
          ? {}
          : { executionBindingRef: inserted.run.executionBindingRef }),
        reused: true,
      }
    }

    const run = inserted.run
    await this.#appendPublicEvent(
      scopeRef,
      run,
      this.#newId(),
      `run-created:${run.runId}`,
      'run.state',
      { state: run.state, resolvedProfileHash: run.resolvedProfileHash },
      createdAt,
      ctx,
    )
    return {
      runId: run.runId,
      state: run.state,
      revision: run.revision,
      resolvedProfileHash: run.resolvedProfileHash,
      ...(run.executionBindingRef === undefined ? {} : { executionBindingRef: run.executionBindingRef }),
      reused: false,
    }
  }

  async getRun(runId: Uuid, ctx: ToolContext): Promise<RunView> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    assertRunReader(run, ctx)
    const checkpoint = await this.#store.findLatestCheckpoint(scopeRef, runId, ctx)
    return toView(run, checkpoint)
  }

  /**
   * Ordered replay for `GET /runs/{id}/events`. `afterSequence` is the `Last-Event-ID`; only
   * strictly greater sequences are returned, so a reconnect cannot skip or duplicate.
   */
  async listEvents(
    runId: Uuid,
    afterSequence: RevisionString | undefined,
    ctx: ToolContext,
  ): Promise<PublicRunEvent[]> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    assertRunReader(run, ctx)
    const events = await this.#store.listRunEvents(scopeRef, runId, afterSequence, ctx)
    return events.map((event) => ({
      id: event.sequence,
      event: event.sseType,
      data: event.data,
      occurredAt: event.occurredAt,
    }))
  }

  /** Answer a pending clarification. Owner-only, with a required If-Match revision. */
  async respondToClarification(
    input: RespondToClarificationInput,
    ctx: ToolContext,
  ): Promise<RunView> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, input.runId, ctx)
    assertRunOwner(run, ctx)
    if (isTerminalRunState(run.state)) {
      throw new RunServiceError('VERSION_CONFLICT', `run is already ${run.state}`)
    }
    requireRevision(run, input.expectedRevision)
    if (run.state !== 'awaiting_input') {
      throw new RunServiceError('VERSION_CONFLICT', `run is in state ${run.state}, not awaiting_input`)
    }
    if (run.pendingClarificationId !== input.clarificationId) {
      throw new RunServiceError(
        'CLARIFICATION_NOT_FOUND',
        'the run is not waiting on this clarification',
      )
    }

    const updated = await this.#setState(
      scopeRef,
      run,
      'collecting',
      { pendingClarificationId: null },
      ctx,
    )
    await this.#store.recordClarificationResponse(
      scopeRef,
      run.runId,
      {
        clarificationId: input.clarificationId,
        typedResponse: input.typedResponse,
        respondedAt: this.#now(),
        respondedBy: ctx.principal.subjectId,
        revision: updated.revision,
      },
      ctx,
    )
    await this.#appendPublicEvent(
      scopeRef,
      updated,
      this.#newId(),
      `run-response:${run.runId}:${input.clarificationId}`,
      'run.state',
      { state: updated.state, clarificationId: input.clarificationId },
      this.#now(),
      ctx,
    )
    return this.getRun(run.runId, ctx)
  }

  /**
   * Cancel a run. Owner or operator only, with a required If-Match revision. The run moves
   * through `cancelling` to `cancelled`; the request is never applied to a terminal run.
   */
  async cancelRun(input: CancelRunInput, ctx: ToolContext): Promise<RunView> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, input.runId, ctx)
    assertRunOwnerOrOperator(run, ctx)
    if (isTerminalRunState(run.state) || run.state === 'cancelling') {
      return toView(run, await this.#store.findLatestCheckpoint(scopeRef, run.runId, ctx))
    }
    if (!isNonEmptyString(input.reason)) {
      throw new RunServiceError('INVALID_ARGUMENT', 'a cancellation requires a non-empty reason')
    }
    requireRevision(run, input.expectedRevision)

    let updated = await this.#setState(
      scopeRef,
      run,
      'cancelling',
      { cancelReason: input.reason },
      ctx,
    )
    await this.#appendPublicEvent(
      scopeRef,
      updated,
      this.#newId(),
      `run-cancelling:${run.runId}`,
      'run.state',
      { state: updated.state, reason: input.reason },
      this.#now(),
      ctx,
    )
    updated = await this.#setState(
      scopeRef,
      updated,
      'cancelled',
      { cancelReason: input.reason, cancelledAt: this.#now() },
      ctx,
    )
    await this.#appendPublicEvent(
      scopeRef,
      updated,
      this.#newId(),
      `run-cancelled:${run.runId}`,
      'run.state',
      { state: updated.state, reason: input.reason, abandonedAttempts: [] },
      this.#now(),
      ctx,
    )
    return toView(updated, await this.#store.findLatestCheckpoint(scopeRef, run.runId, ctx))
  }

  /**
   * Resume from a runtime-private checkpoint. Only the run owner may resume, the revision
   * must match, and the checkpoint must have been written by the exact runtime kind/version
   * the run is locked to. Anything else is an explicit `CHECKPOINT_INCOMPATIBLE` (409)
   * rather than a silent restore.
   */
  async resumeRun(input: ResumeRunInput, ctx: ToolContext): Promise<RunView> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, input.runId, ctx)
    assertRunOwner(run, ctx)
    if (isTerminalRunState(run.state)) {
      throw new RunServiceError('VERSION_CONFLICT', `run is already ${run.state}`)
    }
    requireRevision(run, input.expectedRevision)
    if (run.state !== 'awaiting_input' && run.state !== 'blocked') {
      throw new RunServiceError(
        'VERSION_CONFLICT',
        `run is in state ${run.state}; only awaiting_input or blocked runs can resume`,
      )
    }

    const checkpoint = await this.#store.loadCheckpoint(scopeRef, run.runId, input.checkpointId, ctx)
    if (checkpoint === undefined) {
      throw new RunServiceError('CHECKPOINT_NOT_FOUND', 'the requested checkpoint does not exist')
    }
    if (
      checkpoint.runtimeKind !== input.runtimeKind ||
      checkpoint.runtimeVersion !== input.runtimeVersion ||
      checkpoint.stateDigest !== input.stateDigest
    ) {
      throw new RunServiceError(
        'CHECKPOINT_INCOMPATIBLE',
        'the checkpoint handle does not match the stored runtime-private checkpoint',
      )
    }
    // SPEC §4.3: by default a checkpoint is only restored by the same runtime and version.
    if (
      checkpoint.runtimeKind !== run.runtimeRef.id ||
      checkpoint.runtimeVersion !== run.runtimeRef.version
    ) {
      throw new RunServiceError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint runtime ${checkpoint.runtimeKind}@${checkpoint.runtimeVersion} does not match the run runtime ${run.runtimeRef.id}@${run.runtimeRef.version}`,
      )
    }

    const updated = await this.#setState(scopeRef, run, 'collecting', {}, ctx)
    await this.#appendPublicEvent(
      scopeRef,
      updated,
      this.#newId(),
      `run-resumed:${run.runId}:${input.checkpointId}`,
      'run.state',
      { state: updated.state, resumedFrom: input.checkpointId },
      this.#now(),
      ctx,
    )
    return toView(updated, await this.#store.findLatestCheckpoint(scopeRef, run.runId, ctx))
  }

  /**
   * Persist a runtime-private checkpoint blob. The blob is stored separately from the
   * public run state and is only reachable through `resumeRun`. A checkpoint written by
   * another runtime kind/version is refused up front.
   */
  async saveRuntimeCheckpoint(
    input: SaveCheckpointInput,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, input.runId, ctx)
    assertRunOwner(run, ctx)
    if (isTerminalRunState(run.state)) {
      throw new RunServiceError('VERSION_CONFLICT', `run is already ${run.state}`)
    }
    if (
      input.runtimeKind !== run.runtimeRef.id ||
      input.runtimeVersion !== run.runtimeRef.version
    ) {
      throw new RunServiceError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint runtime ${input.runtimeKind}@${input.runtimeVersion} does not match the run runtime ${run.runtimeRef.id}@${run.runtimeRef.version}`,
      )
    }
    return this.#store.saveCheckpoint(
      scopeRef,
      run.runId,
      {
        checkpointId: input.checkpointId,
        runtimeKind: input.runtimeKind,
        runtimeVersion: input.runtimeVersion,
        stateDigest: input.stateDigest,
        payload: input.payload,
        createdAt: this.#now(),
      },
      ctx,
    )
  }

  /**
   * Apply one runtime event (C2). Events that arrive after the run reached a terminal state,
   * or while it is cancelling, are quarantined as abandoned attempts and can never revive or
   * publish the run. Re-delivering the same event id is a no-op.
   */
  async recordRuntimeEvent(
    runId: Uuid,
    event: RuntimeEvent,
    ctx: ToolContext,
  ): Promise<RuntimeEventResult> {
    const scopeRef = scopeOf(ctx)
    if (event.runId !== runId) {
      throw new RunServiceError(
        'INVALID_ARGUMENT',
        `runtime event ${event.eventId} names run ${event.runId}, not ${runId}`,
      )
    }
    const run = await this.#requireRun(scopeRef, runId, ctx)

    const existing = await this.#store.findRunEvent(scopeRef, runId, event.eventId, ctx)
    if (existing !== undefined) {
      return {
        disposition: 'duplicate',
        runState: run.state,
        revision: run.revision,
        eventId: existing.eventId,
        sequence: existing.sequence,
      }
    }

    if (isTerminalRunState(run.state) || (run.state === 'cancelling' && event.type !== 'cancelled' && event.type !== 'failed')) {
      const abandoned = await this.#abandon(
        scopeRef,
        run,
        `late ${event.type} arrived after the run reached ${run.state}`,
        ctx,
      )
      return {
        disposition: 'abandoned',
        runState: run.state,
        revision: run.revision,
        eventId: event.eventId,
        abandonedAttemptId: abandoned.attemptId,
      }
    }

    if (event.type === 'checkpoint_ready') {
      const checkpoint = await this.#store.loadCheckpoint(
        scopeRef,
        runId,
        event.checkpointRef.checkpointId,
        ctx,
      )
      if (checkpoint === undefined) {
        throw new RunServiceError(
          'CHECKPOINT_NOT_FOUND',
          'the checkpoint_ready event references a checkpoint that was never saved',
        )
      }
      if (
        checkpoint.runtimeKind !== event.checkpointRef.runtimeKind ||
        checkpoint.runtimeVersion !== event.checkpointRef.runtimeVersion ||
        checkpoint.stateDigest !== event.checkpointRef.stateDigest
      ) {
        throw new RunServiceError(
          'CHECKPOINT_INCOMPATIBLE',
          'the checkpoint_ready handle does not match the stored runtime-private checkpoint',
        )
      }
      return {
        disposition: 'private',
        runState: run.state,
        revision: run.revision,
        eventId: event.eventId,
      }
    }

    const projection = projectRuntimeEvent(event)
    let updated = run
    if (projection.nextState !== undefined && projection.nextState !== run.state) {
      if (!canTransition(run.state, projection.nextState)) {
        const abandoned = await this.#abandon(
          scopeRef,
          run,
          `${event.type} cannot move the run from ${run.state} to ${projection.nextState}`,
          ctx,
        )
        return {
          disposition: 'abandoned',
          runState: run.state,
          revision: run.revision,
          eventId: event.eventId,
          abandonedAttemptId: abandoned.attemptId,
        }
      }
      const patch: { pendingClarificationId?: string | null; cancelReason?: string | null; cancelledAt?: string | null } = {}
      if (projection.nextState === 'cancelled') {
        patch.pendingClarificationId = null
        patch.cancelledAt = this.#now()
        if (event.type === 'cancelled') patch.cancelReason = event.reason
      } else {
        // Persist the canonical bounded stop reason for a terminal runtime failure
        // (BUDGET_EXHAUSTED/DEADLINE_EXCEEDED/NO_PROGRESS/...) so the reason survives a
        // restart and is reported by `GET /runs/{id}`, not only in the event stream.
        if (projection.stopReason !== undefined) patch.cancelReason = projection.stopReason
        if (projection.pendingClarificationId !== undefined) {
          patch.pendingClarificationId = projection.pendingClarificationId
        }
      }
      updated = await this.#setState(scopeRef, run, projection.nextState, patch, ctx)
    }

    let sequence: RevisionString | undefined
    if (projection.publicEvent !== undefined) {
      const record = await this.#appendPublicEvent(
        scopeRef,
        updated,
        event.eventId,
        `run-event:${runId}:${event.eventId}`,
        projection.publicEvent.type,
        projection.publicEvent.data,
        event.occurredAt,
        ctx,
      )
      sequence = record.sequence
    }
    return {
      disposition: 'applied',
      runState: updated.state,
      revision: updated.revision,
      eventId: event.eventId,
      ...(sequence === undefined ? {} : { sequence }),
    }
  }

  /**
   * Persist the bounded question-rewrite trace onto the durable run record (LOCAL-080). The
   * controller calls this once, during preflight, before the collection loop starts. It is
   * written once and never overwritten, so a replay always sees the rewrite that produced the
   * routed question. A run that clarified or failed never records a trace — absence means no
   * successful rewrite, never that a failed rewrite was silently passed through.
   */
  async recordQuestionRewrite(
    runId: Uuid,
    rewrite: QuestionRewrite,
    ctx: ToolContext,
  ): Promise<void> {
    const scopeRef = scopeOf(ctx)
    if (rewrite.runId !== runId) {
      throw new RunServiceError(
        'INVALID_ARGUMENT',
        `question rewrite ${rewrite.rewriteId} names run ${rewrite.runId}, not ${runId}`,
      )
    }
    await this.#requireRun(scopeRef, runId, ctx)
    try {
      await this.#store.recordQuestionRewrite(scopeRef, runId, rewrite, ctx)
    } catch (error) {
      mapStoreError(error)
    }
  }

  /**
   * Quarantine a late result. Used when an attempt finishes after its run was cancelled: the
   * result is recorded as abandoned and the run is left untouched, so it can never revive or
   * publish a cancelled run.
   */
  async recordLateResult(
    runId: Uuid,
    input: { readonly attemptId: Uuid; readonly callId?: Uuid; readonly reason: string },
    ctx: ToolContext,
  ): Promise<AbandonedAttemptRecord> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    return this.#abandon(scopeRef, run, input.reason, ctx, input.attemptId, input.callId)
  }

  async listAbandonedAttempts(
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<AbandonedAttemptRecord[]> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    assertRunReader(run, ctx)
    return this.#store.listAbandonedAttempts(scopeRef, runId, ctx)
  }

  #validateCreateIdentity(input: CreateRunInput): void {
    if (
      !isNonEmptyString(input.idempotencyKey) ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 256
    ) {
      throw new RunServiceError(
        'INVALID_ARGUMENT',
        'Idempotency-Key must be a string between 8 and 256 characters',
      )
    }
    if (!isNonEmptyString(input.runId)) {
      throw new RunServiceError('INVALID_ARGUMENT', 'runId must be a non-empty uuid')
    }
  }

  async #requireRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<RunRecord> {
    let run: RunRecord | undefined
    try {
      run = await this.#store.getRun(scopeRef, runId, ctx)
    } catch (error) {
      mapStoreError(error)
    }
    if (run === undefined) {
      throw new RunServiceError('RUN_NOT_FOUND', `run ${runId} is not visible in this scope`)
    }
    return run
  }

  async #setState(
    scopeRef: ScopeRef,
    run: RunRecord,
    state: RunState,
    patch: {
      readonly pendingClarificationId?: string | null
      readonly cancelReason?: string | null
      readonly cancelledAt?: string | null
    },
    ctx: ToolContext,
  ): Promise<RunRecord> {
    try {
      return await this.#store.compareAndSetRunState(
        scopeRef,
        run.runId,
        run.revision,
        {
          state,
          updatedAt: this.#now(),
          cancelReason: patch.cancelReason ?? null,
          cancelledAt: patch.cancelledAt ?? null,
          ...(patch.pendingClarificationId === undefined
            ? {}
            : { pendingClarificationId: patch.pendingClarificationId }),
        },
        ctx,
      )
    } catch (error) {
      mapStoreError(error)
    }
  }

  async #abandon(
    scopeRef: ScopeRef,
    run: RunRecord,
    reason: string,
    ctx: ToolContext,
    attemptId?: Uuid,
    callId?: Uuid,
  ): Promise<AbandonedAttemptRecord> {
    const record: AbandonedAttemptRecord = {
      attemptId: attemptId ?? this.#newId(),
      reason,
      abandonedAt: this.#now(),
      ...(callId === undefined ? {} : { callId }),
    }
    await this.#store.recordAbandonedAttempt(scopeRef, run.runId, record, ctx)
    return record
  }

  /**
   * Append one public event. The durable sequence comes from the existing
   * `ControlRepository.appendEvent` ledger (idempotent per stream+key, monotonic per
   * stream); the queryable payload is stored under that same sequence. Re-using the ledger
   * is what makes `Last-Event-ID` replay ordered and de-duplicable.
   */
  async #appendPublicEvent(
    scopeRef: ScopeRef,
    run: RunRecord,
    eventId: Uuid,
    idempotencyKey: string,
    sseType: SseEventType,
    data: Readonly<Record<string, unknown>>,
    occurredAt: string,
    ctx: ToolContext,
  ): Promise<{ readonly sequence: RevisionString }> {
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: `run:${run.runId}`,
      payloadDigest: sha256DigestOf(canonicalJson({ eventId, sseType, data })),
      idempotencyKey,
    }
    let recordedSeq: RevisionString
    try {
      const appended = await this.#control.appendEvent(request, ctx)
      recordedSeq = appended.recordedSeq
    } catch (error) {
      throw new RunServiceError(
        'EVIDENCE_PERSIST_FAILED',
        `could not append the ${sseType} event for run ${run.runId} to the control ledger`,
        { cause: error },
      )
    }
    const record = await this.#store.appendRunEvent(
      scopeRef,
      run.runId,
      {
        eventId,
        sequence: recordedSeq,
        sseType,
        data,
        occurredAt,
        idempotencyKey,
      },
      ctx,
    )
    return { sequence: record.sequence }
  }
}
