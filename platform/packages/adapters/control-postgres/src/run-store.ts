import { RunStoreError, isToolContext } from '@ontology/contracts'
import type {
  AbandonedAttemptRecord,
  ClarificationResponseRecord,
  CreateRunContext,
  NewRunRecord,
  QuestionRewrite,
  RevisionString,
  RunEventInput,
  RunEventRecord,
  RunInsertResult,
  ResourceRef,
  RunPreferences,
  RunRecord,
  RunState,
  RunStateUpdate,
  RunStore,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface RunRow extends QueryResultRow {
  run_id: string
  owner_subject_id: string
  profile_id: string
  profile_version: string
  resolved_profile_hash: string
  runtime_ref: VersionRef
  question: string
  context: CreateRunContext
  preferences: RunPreferences
  state: RunState
  revision: string
  idempotency_key: string
  request_digest: string
  cancel_reason: string | null
  cancelled_at: Date | null
  pending_clarification_id: string | null
  question_rewrite: QuestionRewrite | null
  execution_binding_ref: ResourceRef | null
  created_at: Date
  updated_at: Date
}

interface RunEventRow extends QueryResultRow {
  event_id: string
  sequence: string
  sse_type: RunEventRecord['sseType']
  data: Readonly<Record<string, unknown>>
  occurred_at: Date
  idempotency_key: string
}

interface CheckpointRow extends QueryResultRow {
  checkpoint_id: string
  runtime_kind: string
  runtime_version: string
  state_digest: string
  payload: Buffer
  created_at: Date
}

interface CheckpointRefRow extends QueryResultRow {
  checkpoint_id: string
  runtime_kind: string
  runtime_version: string
  state_digest: string
  created_at: Date
}

interface ClarificationRow extends QueryResultRow {
  clarification_id: string
  typed_response: Readonly<Record<string, unknown>>
  responded_at: Date
  responded_by: string
  revision: string
}

interface AbandonedRow extends QueryResultRow {
  attempt_id: string
  call_id: string | null
  reason: string
  abandoned_at: Date
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    ownerSubjectId: row.owner_subject_id,
    profileRef: { id: row.profile_id, version: row.profile_version },
    resolvedProfileHash: row.resolved_profile_hash,
    runtimeRef: row.runtime_ref,
    question: row.question,
    context: row.context,
    preferences: row.preferences,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    createdAt: row.created_at.toISOString(),
    state: row.state,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at.toISOString() }),
    ...(row.pending_clarification_id === null
      ? {}
      : { pendingClarificationId: row.pending_clarification_id }),
    ...(row.question_rewrite === null ? {} : { questionRewrite: row.question_rewrite }),
    ...(row.execution_binding_ref === null ? {} : { executionBindingRef: row.execution_binding_ref }),
  }
}

function toRunEventRecord(runId: string, row: RunEventRow): RunEventRecord {
  return {
    runId,
    eventId: row.event_id,
    sequence: row.sequence,
    sseType: row.sse_type,
    data: row.data,
    occurredAt: row.occurred_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  }
}

function toCheckpointRef(runId: string, row: CheckpointRefRow): RuntimeCheckpointRef {
  return {
    checkpointId: row.checkpoint_id,
    runId,
    runtimeKind: row.runtime_kind,
    runtimeVersion: row.runtime_version,
    stateDigest: row.state_digest,
    createdAt: row.created_at.toISOString(),
  }
}

const RUN_COLUMNS = `run_id, owner_subject_id, profile_id, profile_version, resolved_profile_hash,
  runtime_ref, question, context, preferences, state, revision, idempotency_key, request_digest,
  cancel_reason, cancelled_at, pending_clarification_id, question_rewrite, execution_binding_ref,
  created_at, updated_at`

/**
 * Real PostgreSQL implementation of the run store (C6/D7).
 *
 * Every statement runs as the non-owner `ontology_app` role inside a transaction whose
 * trusted scope is set with `SET LOCAL` semantics, so row-level security applies to the
 * whole call and a later request can never inherit the previous tenant/space. Creation is an
 * idempotent claim on `(tenant, space, idempotency_key)`; state changes are compare-and-set
 * on the monotonic revision; events are ordered by the ledger sequence; checkpoint blobs are
 * stored separately and never returned by the public run queries.
 */
export class PostgresRunStore implements RunStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findRunByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<RunRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRunRecord(row)
    })
  }

  async insertRun(
    scopeRef: ScopeRef,
    record: NewRunRecord,
    ctx: ToolContext,
  ): Promise<RunInsertResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<RunRow>(
        `INSERT INTO agent_platform.runs
           (tenant_id, space_id, run_id, owner_subject_id, profile_id, profile_version,
            resolved_profile_hash, runtime_ref, question, context, preferences, state, revision,
            idempotency_key, request_digest, execution_binding_ref, created_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, 'created', 1, $10, $11,
           $13::jsonb, $12::timestamptz, $12::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [
          record.runId,
          record.ownerSubjectId,
          record.profileRef.id,
          record.profileRef.version,
          record.resolvedProfileHash,
          JSON.stringify(record.runtimeRef),
          record.question,
          JSON.stringify(record.context),
          JSON.stringify(record.preferences),
          record.idempotencyKey,
          record.requestDigest,
          record.createdAt,
          record.executionBindingRef === undefined ? null : JSON.stringify(record.executionBindingRef),
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { run: toRunRecord(row), inserted: true }

      const existing = await query.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [record.idempotencyKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) {
        throw new RunStoreError('RUN_NOT_FOUND', 'the idempotency claim references a missing run')
      }
      if (existingRow.request_digest !== record.requestDigest) {
        throw new RunStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload',
        )
      }
      return { run: toRunRecord(existingRow), inserted: false }
    })
  }

  async getRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<RunRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1`,
        [runId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRunRecord(row)
    })
  }

  async compareAndSetRunState(
    scopeRef: ScopeRef,
    runId: Uuid,
    expectedRevision: RevisionString,
    update: RunStateUpdate,
    ctx: ToolContext,
  ): Promise<RunRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const values: unknown[] = [runId, expectedRevision, update.state, update.updatedAt]
      const sets = ['state = $3', 'revision = revision + 1', 'updated_at = $4::timestamptz']
      if (update.cancelReason !== null) {
        values.push(update.cancelReason)
        sets.push(`cancel_reason = $${values.length}`)
      }
      if (update.cancelledAt !== null) {
        values.push(update.cancelledAt)
        sets.push(`cancelled_at = $${values.length}::timestamptz`)
      }
      if (update.pendingClarificationId !== undefined) {
        values.push(update.pendingClarificationId)
        sets.push(`pending_clarification_id = $${values.length}::uuid`)
      }
      const updated = await query.query<RunRow>(
        `UPDATE agent_platform.runs
            SET ${sets.join(', ')}
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
            AND revision = $2
          RETURNING ${RUN_COLUMNS}`,
        values,
      )
      const row = updated.rows[0]
      if (row !== undefined) return toRunRecord(row)

      const exists = await query.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM agent_platform.runs
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1
         ) AS exists`,
        [runId],
      )
      if (exists.rows[0]?.exists !== true) {
        throw new RunStoreError('RUN_NOT_FOUND', `run ${runId} does not exist`)
      }
      throw new RunStoreError(
        'REVISION_CONFLICT',
        `run ${runId} revision changed since ${expectedRevision}`,
      )
    })
  }

  async recordQuestionRewrite(
    scopeRef: ScopeRef,
    runId: Uuid,
    rewrite: QuestionRewrite,
    ctx: ToolContext,
  ): Promise<void> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<{ run_id: string }>(
        `UPDATE agent_platform.runs
            SET question_rewrite = $2::jsonb
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
            AND question_rewrite IS NULL
        RETURNING run_id`,
        [runId, JSON.stringify(rewrite)],
      )
      if (updated.rows[0] !== undefined) return
      // The trace is written once. A no-op here means the run is missing or already carried a
      // trace; only a missing run is an error, so a retry never overwrites an earlier rewrite.
      const exists = await query.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM agent_platform.runs
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1
         ) AS exists`,
        [runId],
      )
      if (exists.rows[0]?.exists !== true) {
        throw new RunStoreError('RUN_NOT_FOUND', `run ${runId} does not exist`)
      }
    })
  }

  async appendRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    event: RunEventInput,
    ctx: ToolContext,
  ): Promise<RunEventRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<RunEventRow>(
        `INSERT INTO agent_platform.run_events
           (tenant_id, space_id, run_id, event_id, sequence, sse_type, data, occurred_at, idempotency_key)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7
         )
         ON CONFLICT DO NOTHING
         RETURNING event_id, sequence, sse_type, data, occurred_at, idempotency_key`,
        [
          runId,
          event.eventId,
          event.sequence,
          event.sseType,
          JSON.stringify(event.data),
          event.occurredAt,
          event.idempotencyKey,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toRunEventRecord(runId, row)

      const existing = await query.query<RunEventRow>(
        `SELECT event_id, sequence, sse_type, data, occurred_at, idempotency_key
           FROM agent_platform.run_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
            AND (idempotency_key = $2 OR event_id = $3)
          ORDER BY sequence
          LIMIT 1`,
        [runId, event.idempotencyKey, event.eventId],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) {
        throw new RunStoreError(
          'REVISION_CONFLICT',
          `run ${runId} event sequence ${event.sequence} collided with another event`,
        )
      }
      return toRunEventRecord(runId, existingRow)
    })
  }

  async findRunEvent(
    scopeRef: ScopeRef,
    runId: Uuid,
    eventId: Uuid,
    ctx: ToolContext,
  ): Promise<RunEventRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RunEventRow>(
        `SELECT event_id, sequence, sse_type, data, occurred_at, idempotency_key
           FROM agent_platform.run_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND event_id = $2`,
        [runId, eventId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRunEventRecord(runId, row)
    })
  }

  async listRunEvents(
    scopeRef: ScopeRef,
    runId: Uuid,
    afterSequence: RevisionString | undefined,
    ctx: ToolContext,
  ): Promise<RunEventRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RunEventRow>(
        `SELECT event_id, sequence, sse_type, data, occurred_at, idempotency_key
           FROM agent_platform.run_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
            AND ($2::bigint IS NULL OR sequence > $2::bigint)
          ORDER BY sequence ASC`,
        [runId, afterSequence ?? null],
      )
      return result.rows.map((row) => toRunEventRecord(runId, row))
    })
  }

  async saveCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: RuntimeCheckpointRecord,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.runtime_checkpoints
           (tenant_id, space_id, run_id, checkpoint_id, runtime_kind, runtime_version, state_digest,
            payload, created_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7::timestamptz
         )
         ON CONFLICT DO NOTHING`,
        [
          runId,
          record.checkpointId,
          record.runtimeKind,
          record.runtimeVersion,
          record.stateDigest,
          Buffer.from(record.payload),
          record.createdAt,
        ],
      )
      const stored = await query.query<CheckpointRefRow>(
        `SELECT checkpoint_id, runtime_kind, runtime_version, state_digest, created_at
           FROM agent_platform.runtime_checkpoints
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND checkpoint_id = $2`,
        [runId, record.checkpointId],
      )
      const row = stored.rows[0]
      if (row === undefined) {
        throw new RunStoreError('RUN_NOT_FOUND', 'the checkpoint could not be stored')
      }
      if (row.state_digest !== record.stateDigest || row.runtime_kind !== record.runtimeKind || row.runtime_version !== record.runtimeVersion) {
        throw new RunStoreError(
          'CHECKPOINT_CONFLICT',
          `checkpoint ${record.checkpointId} already exists with different content`,
        )
      }
      return toCheckpointRef(runId, row)
    })
  }

  async loadCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    checkpointId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CheckpointRow>(
        `SELECT checkpoint_id, runtime_kind, runtime_version, state_digest, payload, created_at
           FROM agent_platform.runtime_checkpoints
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND checkpoint_id = $2`,
        [runId, checkpointId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return {
        checkpointId: row.checkpoint_id,
        runtimeKind: row.runtime_kind,
        runtimeVersion: row.runtime_version,
        stateDigest: row.state_digest,
        payload: new Uint8Array(row.payload),
        createdAt: row.created_at.toISOString(),
      }
    })
  }

  async findLatestCheckpoint(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CheckpointRefRow>(
        `SELECT checkpoint_id, runtime_kind, runtime_version, state_digest, created_at
           FROM agent_platform.runtime_checkpoints
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
          ORDER BY created_at DESC, checkpoint_id DESC
          LIMIT 1`,
        [runId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toCheckpointRef(runId, row)
    })
  }

  async recordClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: ClarificationResponseRecord,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.run_clarification_responses
           (tenant_id, space_id, run_id, clarification_id, typed_response, responded_at, responded_by, revision)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3::jsonb, $4::timestamptz, $5, $6
         )
         ON CONFLICT DO NOTHING`,
        [
          runId,
          record.clarificationId,
          JSON.stringify(record.typedResponse),
          record.respondedAt,
          record.respondedBy,
          record.revision,
        ],
      )
    })
  }

  async findClarificationResponse(
    scopeRef: ScopeRef,
    runId: Uuid,
    clarificationId: Uuid,
    ctx: ToolContext,
  ): Promise<ClarificationResponseRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ClarificationRow>(
        `SELECT clarification_id, typed_response, responded_at, responded_by, revision
           FROM agent_platform.run_clarification_responses
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND clarification_id = $2`,
        [runId, clarificationId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return {
        clarificationId: row.clarification_id,
        typedResponse: row.typed_response,
        respondedAt: row.responded_at.toISOString(),
        respondedBy: row.responded_by,
        revision: row.revision,
      }
    })
  }

  async recordAbandonedAttempt(
    scopeRef: ScopeRef,
    runId: Uuid,
    record: AbandonedAttemptRecord,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.run_abandoned_attempts
           (tenant_id, space_id, run_id, attempt_id, call_id, reason, abandoned_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::timestamptz
         )
         ON CONFLICT DO NOTHING`,
        [runId, record.attemptId, record.callId ?? null, record.reason, record.abandonedAt],
      )
    })
  }

  async listAbandonedAttempts(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<AbandonedAttemptRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AbandonedRow>(
        `SELECT attempt_id, call_id, reason, abandoned_at
           FROM agent_platform.run_abandoned_attempts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
          ORDER BY abandoned_at ASC, attempt_id ASC`,
        [runId],
      )
      return result.rows.map((row) => ({
        attemptId: row.attempt_id,
        reason: row.reason,
        abandonedAt: row.abandoned_at.toISOString(),
        ...(row.call_id === null ? {} : { callId: row.call_id }),
      }))
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new RunStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new RunStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId, spaceId }, async (client) =>
      run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }),
    )
  }
}
