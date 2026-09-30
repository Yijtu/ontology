import type {
  CreateRunContext,
  ProfileRef,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  RunPreferences,
  RunState,
  RuntimeCheckpointRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SseEventType,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { QuestionRewrite } from './planning'
import type { ToolContext } from './trusted'

/**
 * Control persistence for runs, their public event log and their runtime-private
 * checkpoints (SPEC D2/D7, C6). It lives next to `ProfileStore`/`ComponentRegistryStore`
 * so an adapter can implement it while depending on `contracts` alone
 * (SPEC §2: adapters → contracts). The application layer receives it by construction
 * injection and never imports an adapter or driver.
 *
 * Two things are deliberately separated:
 *
 * - the **public run record** carries the exact locked `resolvedProfileHash` and the
 *   monotonic `revision` used for optimistic concurrency (`If-Match`);
 * - the **runtime checkpoint** is a private blob that is never returned by the public
 *   run surface. Only its public handle (`RuntimeCheckpointRef`) is exposed, and a resume
 *   is refused unless the runtime kind/version match the one that wrote it.
 *
 * The durable, monotonic event sequence is allocated by `ControlRepository.appendEvent`;
 * `appendRunEvent` stores the queryable public payload under that same sequence, so the
 * SSE `id` is the ledger sequence and replay cannot skip or duplicate.
 */

/**
 * The immutable part of a run. The locked `resolvedProfileHash` plus `runtimeRef` pin the
 * exact scenario composition the run started under, so a later profile or component
 * version can never change an existing run.
 */
export interface NewRunRecord {
  readonly runId: Uuid
  readonly ownerSubjectId: string
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly runtimeRef: VersionRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly createdAt: Rfc3339UtcTimestamp
  /**
   * The archived run execution binding this run is pinned to (SPEC v0.3a §EX-2.1). It is set at
   * creation when the request carried an optional `task` binding and is immutable: later
   * evidence appends never rewrite the binding, and the body itself lives in the binding store.
   */
  readonly executionBindingRef?: ResourceRef
}

export interface RunRecord extends NewRunRecord {
  readonly state: RunState
  readonly revision: RevisionString
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly cancelReason?: string
  readonly cancelledAt?: Rfc3339UtcTimestamp
  /** The clarification the run is currently waiting on, if any. */
  readonly pendingClarificationId?: Uuid
  /**
   * The bounded question-rewrite trace the run recorded before collection (LOCAL-080).
   * It is written once and is immutable: the original → rewrite → generated-SQL chain is
   * replayable from the durable run record. Absent means no rewrite step ran (or it
   * clarified/failed before producing a trace), never that a successful rewrite was dropped.
   */
  readonly questionRewrite?: QuestionRewrite
}

/**
 * A state change applied by compare-and-set. `cancelReason`/`cancelledAt` are `null` when
 * the transition must leave them untouched; `pendingClarificationId` is `undefined` when it
 * must be preserved, `null` when it must be cleared and a string when it must be set.
 */
export interface RunStateUpdate {
  readonly state: RunState
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly cancelReason: string | null
  readonly cancelledAt: Rfc3339UtcTimestamp | null
  readonly pendingClarificationId?: string | null
}

/**
 * One persisted public event. `sequence` is the ledger sequence and the SSE `id`;
 * `idempotencyKey` is the stable identity of the logical event, so a retry that generates a
 * fresh `eventId` still cannot double-append.
 */
export interface RunEventInput {
  readonly eventId: Uuid
  readonly sequence: RevisionString
  readonly sseType: SseEventType
  readonly data: Readonly<Record<string, unknown>>
  readonly occurredAt: Rfc3339UtcTimestamp
  readonly idempotencyKey: string
}

export interface RunEventRecord extends RunEventInput {
  readonly runId: Uuid
}

/** Runtime-private checkpoint content. `payload` never leaves the control database. */
export interface RuntimeCheckpointRecord {
  readonly checkpointId: Uuid
  readonly runtimeKind: string
  readonly runtimeVersion: Semver
  readonly stateDigest: Sha256Digest
  readonly payload: Uint8Array
  readonly createdAt: Rfc3339UtcTimestamp
}

export interface ClarificationResponseRecord {
  readonly clarificationId: Uuid
  readonly typedResponse: Readonly<Record<string, unknown>>
  readonly respondedAt: Rfc3339UtcTimestamp
  readonly respondedBy: string
  readonly revision: RevisionString
}

/** A late or uncancellable attempt. Its result is quarantined and can never revive a run. */
export interface AbandonedAttemptRecord {
  readonly attemptId: Uuid
  readonly callId?: Uuid
  readonly reason: string
  readonly abandonedAt: Rfc3339UtcTimestamp
}

export type RunStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'CHECKPOINT_CONFLICT'

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode

  constructor(code: RunStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RunStoreError'
    this.code = code
  }
}

export interface RunInsertResult {
  readonly run: RunRecord
  readonly inserted: boolean
}

export interface RunStore {
  /**
   * Resolve an idempotency key inside the trusted scope. A caller that sees an existing run
   * with a different `requestDigest` must raise `IDEMPOTENCY_CONFLICT`, never overwrite.
   */
  findRunByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<RunRecord | undefined>
  /**
   * Insert a new run. If the `(tenant, space, idempotency_key)` claim already exists it
   * returns that run with `inserted: false`; a different request digest is a
   * `RunStoreError('IDEMPOTENCY_CONFLICT')`.
   */
  insertRun(scopeRef: ScopeRef, record: NewRunRecord, ctx: ToolContext): Promise<RunInsertResult>
  getRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<RunRecord | undefined>
  /**
   * Compare-and-set on `revision`. A stale expectation raises `REVISION_CONFLICT`; a
   * missing run raises `RUN_NOT_FOUND`. The new revision is assigned by the store, so the
   * operation is never last-write-wins.
   */
  compareAndSetRunState(
    scopeRef: ScopeRef,
    runId: Uuid,
    expectedRevision: RevisionString,
    update: RunStateUpdate,
    ctx: ToolContext,
  ): Promise<RunRecord>
  appendRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    event: RunEventInput,
    ctx: ToolContext,
  ): Promise<RunEventRecord>
  findRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    eventId: Uuid,
    ctx: ToolContext,
  ): Promise<RunEventRecord | undefined>
  /**
   * Ordered replay. `afterSequence === undefined` returns the whole log; otherwise only
   * events with a strictly greater sequence, so a `Last-Event-ID` reconnect cannot skip or
   * duplicate.
   */
  listRunEvents(
    scopeRef: ScopeRef,
    runId: Uuid,
    afterSequence: RevisionString | undefined,
    ctx: ToolContext,
  ): Promise<RunEventRecord[]>
  /**
   * Persist the bounded question-rewrite trace onto the durable run record. It is written
   * once and never overwritten, so a replayed run keeps the exact rewrite that produced its
   * question. It does not change the run's monotonic `revision` (it is metadata, not a state
   * transition), so it can never invalidate a concurrent compare-and-set.
   */
  recordQuestionRewrite(
    scopeRef: ScopeRef,
    runId: Uuid,
    rewrite: QuestionRewrite,
    ctx: ToolContext,
  ): Promise<void>
  saveCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: RuntimeCheckpointRecord,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef>
  loadCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    checkpointId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRecord | undefined>
  findLatestCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef | undefined>
  recordClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: ClarificationResponseRecord,
    ctx: ToolContext,
  ): Promise<void>
  findClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    clarificationId: Uuid,
    ctx: ToolContext,
  ): Promise<ClarificationResponseRecord | undefined>
  recordAbandonedAttempt(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: AbandonedAttemptRecord,
    ctx: ToolContext,
  ): Promise<void>
  listAbandonedAttempts(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<AbandonedAttemptRecord[]>
}
