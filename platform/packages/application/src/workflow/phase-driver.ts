import { RunStoreError, isToolContext } from '@ontology/contracts'
import type {
  ControlAppendEventRequest,
  ControlRepository,
  ClarificationResponseRecord,
  RevisionString,
  RunRecord,
  RunState,
  RunStore,
  RuntimeCheckpointRef,
  ScopeRef,
  SseEventType,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { WorkflowControllerError } from './errors'

/**
 * The phase driver applies the controller's outer phase transitions and appends the public
 * SSE projection. It reuses the existing run record (compare-and-set on `revision`) and the
 * existing durable `ControlRepository` event ledger — it never opens a second event store
 * or budget ledger (ADR-14).
 *
 * `RunService` owns creation, cancellation and clarification; the controller owns the
 * preflight → collecting → drafting → verifying → published transitions. Both go through
 * the same run store, so their optimistic revisions stay consistent.
 */
export interface RunPhasePatch {
  readonly pendingClarificationId?: string | null
  readonly cancelReason?: string | null
  readonly cancelledAt?: string | null
}

export interface RunPhaseDriverDependencies {
  readonly store: RunStore
  readonly control: ControlRepository
  readonly now?: () => string
  readonly newId?: () => string
}

export class RunPhaseDriver {
  readonly #store: RunStore
  readonly #control: ControlRepository
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: RunPhaseDriverDependencies) {
    this.#store = dependencies.store
    this.#control = dependencies.control
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async get(runId: Uuid, ctx: ToolContext): Promise<RunRecord | undefined> {
    return this.#store.getRun(scopeOf(ctx), runId, ctx)
  }

  async requireRun(runId: Uuid, ctx: ToolContext): Promise<RunRecord> {
    const run = await this.get(runId, ctx)
    if (run === undefined) {
      throw new WorkflowControllerError('RUN_NOT_FOUND', `run ${runId} is not visible in this scope`)
    }
    return run
  }

  /** The latest runtime-private checkpoint handle for a run, if one was written. */
  async latestCheckpoint(
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef | undefined> {
    return this.#store.findLatestCheckpoint(scopeOf(ctx), runId, ctx)
  }

  async checkpointRef(
    runId: Uuid,
    checkpointId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef | undefined> {
    const checkpoint = await this.#store.loadCheckpoint(scopeOf(ctx), runId, checkpointId, ctx)
    if (checkpoint === undefined) return undefined
    return {
      checkpointId: checkpoint.checkpointId,
      runId,
      runtimeKind: checkpoint.runtimeKind,
      runtimeVersion: checkpoint.runtimeVersion,
      stateDigest: checkpoint.stateDigest,
      createdAt: checkpoint.createdAt,
    }
  }

  async findClarificationResponse(
    runId: Uuid,
    clarificationId: Uuid,
    ctx: ToolContext,
  ): Promise<ClarificationResponseRecord | undefined> {
    return this.#store.findClarificationResponse(scopeOf(ctx), runId, clarificationId, ctx)
  }

  async transition(
    runId: Uuid,
    expectedRevision: RevisionString,
    state: RunState,
    patch: RunPhasePatch,
    ctx: ToolContext,
  ): Promise<RunRecord> {
    try {
      return await this.#store.compareAndSetRunState(
        scopeOf(ctx),
        runId,
        expectedRevision,
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
      if (error instanceof RunStoreError) {
        const code =
          error.code === 'REVISION_CONFLICT'
            ? 'VERSION_CONFLICT'
            : error.code === 'RUN_NOT_FOUND'
              ? 'RUN_NOT_FOUND'
              : error.code === 'SCOPE_MISMATCH'
                ? 'SCOPE_MISMATCH'
                : 'INTERNAL_ERROR'
        throw new WorkflowControllerError(code, error.message, { cause: error })
      }
      throw error
    }
  }

  /**
   * Append one public event to the existing ledger and store its queryable payload under
   * the ledger sequence, so `Last-Event-ID` replay stays ordered and de-duplicable.
   */
  async appendEvent(
    runId: Uuid,
    idempotencyKey: string,
    sseType: SseEventType,
    data: Readonly<Record<string, unknown>>,
    occurredAt: string,
    ctx: ToolContext,
  ): Promise<RevisionString> {
    const scopeRef = scopeOf(ctx)
    const eventId = this.#newId()
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: `run:${runId}`,
      payloadDigest: sha256DigestOf(canonicalJson({ eventId, sseType, data })),
      idempotencyKey,
    }
    let sequence: RevisionString
    try {
      const appended = await this.#control.appendEvent(request, ctx)
      sequence = appended.recordedSeq
    } catch (error) {
      throw new WorkflowControllerError(
        'EVIDENCE_PERSIST_FAILED',
        `could not append the ${sseType} event for run ${runId} to the control ledger`,
        { cause: error },
      )
    }
    await this.#store.appendRunEvent(
      scopeRef,
      runId,
      { eventId, sequence, sseType, data, occurredAt, idempotencyKey },
      ctx,
    )
    return sequence
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}
