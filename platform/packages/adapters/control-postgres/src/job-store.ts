import { JobStoreError, canAdvanceJobStage, isRetryableStage, isToolContext } from '@ontology/contracts'
import type {
  JobAttemptCompletion,
  JobAttemptFailure,
  JobAttemptRecord,
  JobErrorInfo,
  JobInsertResult,
  JobKind,
  JobLease,
  JobLeaseRenewal,
  JobLeaseRequest,
  JobPublicationRef,
  JobPublicationRequest,
  JobPublicationResult,
  JobRetryRequest,
  JobStageAdvance,
  JobStageCounts,
  JobStore,
  LogicalJobRecord,
  NewLogicalJobRecord,
  NewOutboxMessage,
  OutboxMessageRecord,
  PipelineStage,
  RevisionString,
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

interface JobRow extends QueryResultRow {
  job_id: string
  kind: JobKind
  source_ref: string
  document_ref: string | null
  dataset_ref: string | null
  pipeline_version: string
  stage: PipelineStage
  failed_stage: PipelineStage | null
  idempotency_key: string
  input_digest: string
  revision: string
  attempt_count: number
  abandoned_attempt_count: number
  counts: JobStageCounts
  last_error: JobErrorInfo | null
  next_attempt_at: Date
  publication_id: string | null
  publication_version_ref: VersionRef | null
  published_at: Date | null
  created_at: Date
  created_by: string
  updated_at: Date
}

interface AttemptRow extends QueryResultRow {
  attempt_id: string
  job_id: string
  attempt_number: number
  state: JobAttemptRecord['state']
  stage: PipelineStage
  worker_id: string | null
  lease_expires_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  abandoned_reason: string | null
  error: JobErrorInfo | null
  idempotency_key: string | null
}

interface OutboxRow extends QueryResultRow {
  outbox_id: string
  job_id: string
  topic: string
  payload: Readonly<Record<string, unknown>>
  idempotency_key: string
  state: OutboxMessageRecord['state']
  attempts: number
  available_at: Date
  dispatched_at: Date | null
  created_at: Date
}

interface PublicationRow extends QueryResultRow {
  publication_id: string
  version_ref: VersionRef
  version_digest: string
  published_at: Date
}

const JOB_COLUMNS = `job_id, kind, source_ref, document_ref, dataset_ref, pipeline_version, stage,
  failed_stage, idempotency_key, input_digest, revision, attempt_count, abandoned_attempt_count,
  counts, last_error, next_attempt_at, publication_id, publication_version_ref, published_at,
  created_at, created_by, updated_at`

const ATTEMPT_COLUMNS = `attempt_id, job_id, attempt_number, state, stage, worker_id,
  lease_expires_at, started_at, finished_at, abandoned_reason, error, idempotency_key`

const OUTBOX_COLUMNS = `outbox_id, job_id, topic, payload, idempotency_key, state, attempts,
  available_at, dispatched_at, created_at`

function toJobRecord(row: JobRow): LogicalJobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    sourceRef: row.source_ref,
    ...(row.document_ref === null ? {} : { documentRef: row.document_ref }),
    ...(row.dataset_ref === null ? {} : { datasetRef: row.dataset_ref }),
    pipelineVersion: row.pipeline_version,
    stage: row.stage,
    ...(row.failed_stage === null ? {} : { failedStage: row.failed_stage }),
    idempotencyKey: row.idempotency_key,
    inputDigest: row.input_digest,
    revision: row.revision,
    attemptCount: row.attempt_count,
    abandonedAttemptCount: row.abandoned_attempt_count,
    counts: row.counts,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    nextAttemptAt: row.next_attempt_at.toISOString(),
    ...(row.publication_id === null || row.publication_version_ref === null || row.published_at === null
      ? {}
      : {
          publication: {
            publicationId: row.publication_id,
            versionRef: row.publication_version_ref,
            publishedAt: row.published_at.toISOString(),
          } satisfies JobPublicationRef,
        }),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
  }
}

function toAttemptRecord(row: AttemptRow): JobAttemptRecord {
  return {
    attemptId: row.attempt_id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    state: row.state,
    stage: row.stage,
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.toISOString() }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() }),
    ...(row.abandoned_reason === null ? {} : { abandonedReason: row.abandoned_reason }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
  }
}

function toOutboxRecord(row: OutboxRow): OutboxMessageRecord {
  return {
    outboxId: row.outbox_id,
    jobId: row.job_id,
    topic: row.topic,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    availableAt: row.available_at.toISOString(),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the job store (D6/C6).
 *
 * Every statement runs inside a transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so row-level security applies to the whole call. A lease is claimed atomically
 * with `FOR UPDATE SKIP LOCKED`; stage checkpoints are idempotent on `(job, stage)`;
 * publication is exactly-once on `(job, publication_key)`; outbox messages are written in the
 * same transaction as the state change and dispatched at-least-once.
 */
export class PostgresJobStore implements JobStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findJobByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toJobRecord(row)
    })
  }

  async insertJob(
    scopeRef: ScopeRef,
    record: NewLogicalJobRecord,
    ctx: ToolContext,
  ): Promise<JobInsertResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const byKey = await query.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [record.idempotencyKey],
      )
      const existingByKey = byKey.rows[0]
      if (existingByKey !== undefined) {
        if (existingByKey.input_digest !== record.inputDigest) {
          throw new JobStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload or pipeline version',
          )
        }
        return { job: toJobRecord(existingByKey), inserted: false }
      }

      const byDigest = await query.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND input_digest = $1`,
        [record.inputDigest],
      )
      const existingByDigest = byDigest.rows[0]
      if (existingByDigest !== undefined) {
        // Same content under a different key: the logical job identity is content-derived.
        return { job: toJobRecord(existingByDigest), inserted: false }
      }

      const inserted = await query.query<JobRow>(
        `INSERT INTO agent_platform.jobs
           (tenant_id, space_id, job_id, kind, source_ref, document_ref, dataset_ref,
            pipeline_version, stage, idempotency_key, input_digest, revision, attempt_count,
            abandoned_attempt_count, counts, next_attempt_at, created_at, created_by, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, 'received', $7, $8, 1, 0, 0, $9::jsonb, $10::timestamptz,
           $10::timestamptz, $11, $10::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${JOB_COLUMNS}`,
        [
          record.jobId,
          record.kind,
          record.sourceRef,
          record.documentRef ?? null,
          record.datasetRef ?? null,
          record.pipelineVersion,
          record.idempotencyKey,
          record.inputDigest,
          JSON.stringify(record.counts),
          record.createdAt,
          record.createdBy,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { job: toJobRecord(row), inserted: true }

      // A concurrent writer won the race; re-read and compare.
      const raced = await query.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND (idempotency_key = $1 OR input_digest = $2)
          LIMIT 1`,
        [record.idempotencyKey, record.inputDigest],
      )
      const racedRow = raced.rows[0]
      if (racedRow === undefined) {
        throw new JobStoreError('JOB_NOT_FOUND', 'the idempotency claim references a missing job')
      }
      if (racedRow.input_digest !== record.inputDigest) {
        throw new JobStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different payload or pipeline version',
        )
      }
      return { job: toJobRecord(racedRow), inserted: false }
    })
  }

  async getJob(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<LogicalJobRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1`,
        [jobId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toJobRecord(row)
    })
  }

  async listAttempts(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<JobAttemptRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM agent_platform.job_attempts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1
          ORDER BY attempt_number ASC`,
        [jobId],
      )
      return result.rows.map(toAttemptRecord)
    })
  }

  async getAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM agent_platform.job_attempts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1 AND attempt_id = $2`,
        [jobId, attemptId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toAttemptRecord(row)
    })
  }

  async acquireLease(
    scopeRef: ScopeRef,
    request: JobLeaseRequest,
    ctx: ToolContext,
  ): Promise<JobLease | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const leaseExpiresAt = new Date(Date.parse(request.now) + request.leaseDurationMs).toISOString()
      const candidate = await query.query<{ job_id: string; stage: PipelineStage }>(
        `SELECT j.job_id, j.stage
           FROM agent_platform.jobs j
          WHERE ($1::uuid IS NULL OR j.job_id = $1::uuid)
            AND (
              EXISTS (
                SELECT 1 FROM agent_platform.job_attempts a
                 WHERE a.tenant_id = j.tenant_id AND a.space_id = j.space_id AND a.job_id = j.job_id
                   AND a.state = 'pending'
              )
              OR EXISTS (
                SELECT 1 FROM agent_platform.job_attempts a
                 WHERE a.tenant_id = j.tenant_id AND a.space_id = j.space_id AND a.job_id = j.job_id
                   AND a.state IN ('leased', 'running')
                   AND a.lease_expires_at < $2::timestamptz
              )
              OR (
                j.stage IN ('received', 'parsed', 'extracted', 'validated')
                AND j.next_attempt_at <= $2::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM agent_platform.job_attempts a
                   WHERE a.tenant_id = j.tenant_id AND a.space_id = j.space_id AND a.job_id = j.job_id
                     AND a.state IN ('pending', 'leased', 'running')
                )
              )
            )
          ORDER BY j.next_attempt_at ASC, j.created_at ASC
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
        [request.jobId ?? null, request.now],
      )
      const picked = candidate.rows[0]
      if (picked === undefined) return undefined

      const abandoned = await query.query<{ attempt_id: string }>(
        `UPDATE agent_platform.job_attempts
            SET state = 'abandoned', abandoned_reason = 'lease expired', finished_at = $1::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $2
            AND state IN ('leased', 'running')
            AND lease_expires_at < $1::timestamptz
          RETURNING attempt_id`,
        [request.now, picked.job_id],
      )
      const reclaimedAttemptId = abandoned.rows[0]?.attempt_id

      const pending = await query.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM agent_platform.job_attempts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1 AND state = 'pending'
          ORDER BY attempt_number ASC
          LIMIT 1
          FOR UPDATE`,
        [picked.job_id],
      )

      let attemptRow: AttemptRow | undefined
      let createdNewAttempt = false
      let attemptNumber: number
      const pendingRow = pending.rows[0]
      if (pendingRow !== undefined) {
        const leased = await query.query<AttemptRow>(
          `UPDATE agent_platform.job_attempts
              SET state = 'leased', worker_id = $1, lease_expires_at = $2::timestamptz,
                  started_at = COALESCE(started_at, $3::timestamptz)
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND job_id = $4 AND attempt_id = $5
            RETURNING ${ATTEMPT_COLUMNS}`,
          [request.workerId, leaseExpiresAt, request.now, picked.job_id, pendingRow.attempt_id],
        )
        attemptRow = leased.rows[0]
        attemptNumber = pendingRow.attempt_number
      } else {
        const next = await query.query<{ attempt_number: number }>(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
             FROM agent_platform.job_attempts
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND job_id = $1`,
          [picked.job_id],
        )
        attemptNumber = next.rows[0]?.attempt_number ?? 1
        const inserted = await query.query<AttemptRow>(
          `INSERT INTO agent_platform.job_attempts
             (tenant_id, space_id, job_id, attempt_id, attempt_number, state, stage, worker_id,
              lease_expires_at, started_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, 'leased', $4, $5, $6::timestamptz, $7::timestamptz
           )
           RETURNING ${ATTEMPT_COLUMNS}`,
          [
            picked.job_id,
            globalThis.crypto.randomUUID(),
            attemptNumber,
            picked.stage,
            request.workerId,
            leaseExpiresAt,
            request.now,
          ],
        )
        attemptRow = inserted.rows[0]
        createdNewAttempt = true
      }
      if (attemptRow === undefined) {
        throw new JobStoreError('ATTEMPT_NOT_FOUND', 'the lease claim produced no attempt')
      }

      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET attempt_count = CASE WHEN $1::boolean THEN $2::integer ELSE attempt_count END,
                abandoned_attempt_count = abandoned_attempt_count + $3::integer,
                next_attempt_at = $4::timestamptz,
                revision = revision + 1,
                updated_at = $5::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $6
          RETURNING ${JOB_COLUMNS}`,
        [
          createdNewAttempt,
          attemptNumber,
          reclaimedAttemptId === undefined ? 0 : 1,
          leaseExpiresAt,
          request.now,
          picked.job_id,
        ],
      )
      const jobRow = updated.rows[0]
      if (jobRow === undefined) {
        throw new JobStoreError('JOB_NOT_FOUND', 'the claimed job disappeared during the lease')
      }
      return {
        job: toJobRecord(jobRow),
        attempt: toAttemptRecord(attemptRow),
        ...(reclaimedAttemptId === undefined ? {} : { reclaimedAttemptId }),
      }
    })
  }

  async renewLease(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    renewal: JobLeaseRenewal,
    ctx: ToolContext,
  ): Promise<JobAttemptRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const leaseExpiresAt = new Date(Date.parse(renewal.now) + renewal.leaseDurationMs).toISOString()
      const updated = await query.query<AttemptRow>(
        `UPDATE agent_platform.job_attempts
            SET state = 'running', lease_expires_at = $1::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $2 AND attempt_id = $3
            AND worker_id = $4
            AND state IN ('leased', 'running')
          RETURNING ${ATTEMPT_COLUMNS}`,
        [leaseExpiresAt, jobId, attemptId, renewal.workerId],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not held by ${renewal.workerId}`)
      }
      return toAttemptRecord(row)
    })
  }

  async advanceStage(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    advance: JobStageAdvance,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const job = await this.#lockJob(query, jobId)
      const attempt = await this.#lockAttempt(query, jobId, attemptId)
      if (attempt.state !== 'leased' && attempt.state !== 'running') {
        throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
      }
      // Check the checkpoint first: a stage that was already committed is an idempotent no-op,
      // even when the job has since advanced past it.
      const existing = await query.query<{ stage: string }>(
        `SELECT stage FROM agent_platform.job_stage_checkpoints
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1 AND stage = $2`,
        [jobId, advance.stage],
      )
      if (existing.rows[0] !== undefined) {
        return toJobRecord(job)
      }
      if (!canAdvanceJobStage(job.stage, advance.stage)) {
        throw new JobStoreError(
          'STAGE_CONFLICT',
          `job ${jobId} cannot advance from ${job.stage} to ${advance.stage}`,
        )
      }
      const checkpoint = await query.query<{ stage: string }>(
        `INSERT INTO agent_platform.job_stage_checkpoints
           (tenant_id, space_id, job_id, stage, attempt_id, counts, created_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, job_id, stage) DO NOTHING
         RETURNING stage`,
        [jobId, advance.stage, attemptId, JSON.stringify(advance.counts), advance.completedAt],
      )
      if (checkpoint.rows[0] === undefined) {
        // A concurrent attempt committed the same stage first.
        return toJobRecord(job)
      }
      if (advance.outbox !== undefined) {
        await this.#insertOutbox(query, jobId, advance.outbox)
      }
      await query.query(
        `UPDATE agent_platform.job_attempts
            SET state = 'running', stage = $1
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $2 AND attempt_id = $3`,
        [advance.stage, jobId, attemptId],
      )
      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET stage = $1, counts = $2::jsonb, revision = revision + 1, updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $4
          RETURNING ${JOB_COLUMNS}`,
        [advance.stage, JSON.stringify(advance.counts), advance.completedAt, jobId],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} disappeared`)
      return toJobRecord(row)
    })
  }

  async completeAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    completion: JobAttemptCompletion,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const job = await this.#lockJob(query, jobId)
      const attempt = await this.#lockAttempt(query, jobId, attemptId)
      if (attempt.state === 'succeeded') return toJobRecord(job)
      if (attempt.state !== 'leased' && attempt.state !== 'running') {
        throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
      }
      await query.query(
        `UPDATE agent_platform.job_attempts
            SET state = 'succeeded', finished_at = $1::timestamptz, lease_expires_at = NULL
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $2 AND attempt_id = $3`,
        [completion.completedAt, jobId, attemptId],
      )
      if (completion.finalStage === job.stage) return toJobRecord(job)
      if (!canAdvanceJobStage(job.stage, completion.finalStage)) {
        throw new JobStoreError(
          'STAGE_CONFLICT',
          `job ${jobId} cannot advance from ${job.stage} to ${completion.finalStage}`,
        )
      }
      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET stage = $1, revision = revision + 1, updated_at = $2::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $3
          RETURNING ${JOB_COLUMNS}`,
        [completion.finalStage, completion.completedAt, jobId],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} disappeared`)
      return toJobRecord(row)
    })
  }

  async failAttempt(
    scopeRef: ScopeRef,
    jobId: Uuid,
    attemptId: Uuid,
    failure: JobAttemptFailure,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const current = await this.#lockJob(query, jobId)
      const attempt = await this.#lockAttempt(query, jobId, attemptId)
      if (attempt.state === 'failed') return toJobRecord(current)
      if (attempt.state !== 'leased' && attempt.state !== 'running') {
        throw new JobStoreError('LEASE_LOST', `attempt ${attemptId} is not active`)
      }
      await query.query(
        `UPDATE agent_platform.job_attempts
            SET state = 'failed', error = $1::jsonb, finished_at = $2::timestamptz, lease_expires_at = NULL
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $3 AND attempt_id = $4`,
        [JSON.stringify(failure.error), failure.failedAt, jobId, attemptId],
      )
      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET stage = 'failed', failed_stage = $1, last_error = $2::jsonb,
                revision = revision + 1, updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $4
          RETURNING ${JOB_COLUMNS}`,
        [attempt.stage, JSON.stringify(failure.error), failure.failedAt, jobId],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} disappeared`)
      return toJobRecord(row)
    })
  }

  async retryJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    expectedRevision: RevisionString,
    request: JobRetryRequest,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const job = await this.#lockJob(query, jobId)
      const replayed = await query.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM agent_platform.job_attempts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1 AND idempotency_key = $2`,
        [jobId, request.idempotencyKey],
      )
      if (replayed.rows[0] !== undefined) {
        // Replayed retry: return the existing job without creating a second attempt.
        return toJobRecord(job)
      }
      if (job.revision !== expectedRevision) {
        throw new JobStoreError(
          'REVISION_CONFLICT',
          `job ${jobId} revision ${job.revision} does not match ${expectedRevision}`,
        )
      }
      if (job.stage !== 'failed' || !isRetryableStage(request.failedStage)) {
        throw new JobStoreError('STAGE_CONFLICT', `job ${jobId} is not failed at a retryable stage`)
      }
      if (job.failed_stage !== null && job.failed_stage !== request.failedStage) {
        throw new JobStoreError(
          'STAGE_CONFLICT',
          `job ${jobId} failed at ${job.failed_stage}, not ${request.failedStage}`,
        )
      }
      const attemptNumber = job.attempt_count + 1
      const inserted = await query.query<AttemptRow>(
        `INSERT INTO agent_platform.job_attempts
           (tenant_id, space_id, job_id, attempt_id, attempt_number, state, stage, idempotency_key)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, 'pending', $4, $5
         )
         ON CONFLICT (tenant_id, space_id, job_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING ${ATTEMPT_COLUMNS}`,
        [jobId, request.attemptId, attemptNumber, request.failedStage, request.idempotencyKey],
      )
      if (inserted.rows[0] === undefined) {
        // A concurrent retry with the same key won.
        return toJobRecord(job)
      }
      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET stage = $1, failed_stage = NULL, last_error = NULL, attempt_count = $2,
                next_attempt_at = $3::timestamptz, revision = revision + 1, updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $4
          RETURNING ${JOB_COLUMNS}`,
        [request.failedStage, attemptNumber, request.requestedAt, jobId],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} disappeared`)
      return toJobRecord(row)
    })
  }

  async publishJob(
    scopeRef: ScopeRef,
    jobId: Uuid,
    request: JobPublicationRequest,
    ctx: ToolContext,
  ): Promise<JobPublicationResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const job = await this.#lockJob(query, jobId)
      const inserted = await query.query<PublicationRow>(
        `INSERT INTO agent_platform.job_publications
           (tenant_id, space_id, job_id, publication_id, publication_key, version_ref,
            version_digest, published_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5, $6::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, job_id, publication_key) DO NOTHING
         RETURNING publication_id, version_ref, version_digest, published_at`,
        [
          jobId,
          request.publicationId,
          request.publicationKey,
          JSON.stringify(request.versionRef),
          request.versionRef.digest,
          request.publishedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        const existing = await query.query<PublicationRow>(
          `SELECT publication_id, version_ref, version_digest, published_at
             FROM agent_platform.job_publications
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND job_id = $1 AND publication_key = $2`,
          [jobId, request.publicationKey],
        )
        const existingRow = existing.rows[0]
        if (existingRow === undefined) {
          throw new JobStoreError('PUBLICATION_CONFLICT', 'the publication claim is inconsistent')
        }
        if (existingRow.version_digest !== request.versionRef.digest) {
          throw new JobStoreError(
            'PUBLICATION_CONFLICT',
            `publication ${request.publicationKey} already exists with a different version digest`,
          )
        }
        return {
          publication: {
            publicationId: existingRow.publication_id,
            versionRef: existingRow.version_ref,
            publishedAt: existingRow.published_at.toISOString(),
          },
          created: false,
          job: toJobRecord(job),
        }
      }
      await this.#insertOutbox(query, jobId, request.outbox)
      const updated = await query.query<JobRow>(
        `UPDATE agent_platform.jobs
            SET stage = 'published', publication_id = $1, publication_version_ref = $2::jsonb,
                published_at = $3::timestamptz, revision = revision + 1, updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $4
          RETURNING ${JOB_COLUMNS}`,
        [request.publicationId, JSON.stringify(request.versionRef), request.publishedAt, jobId],
      )
      const updatedRow = updated.rows[0]
      if (updatedRow === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} disappeared`)
      return {
        publication: {
          publicationId: row.publication_id,
          versionRef: row.version_ref,
          publishedAt: row.published_at.toISOString(),
        },
        created: true,
        job: toJobRecord(updatedRow),
      }
    })
  }

  async listPendingOutbox(
    scopeRef: ScopeRef,
    limit: number,
    now: string,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM agent_platform.job_outbox
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND state = 'pending'
            AND available_at <= $1::timestamptz
          ORDER BY created_at ASC, outbox_id ASC
          LIMIT $2`,
        [now, limit],
      )
      return result.rows.map(toOutboxRecord)
    })
  }

  async markOutboxDispatched(
    scopeRef: ScopeRef,
    outboxId: Uuid,
    dispatchedAt: string,
    ctx: ToolContext,
  ): Promise<OutboxMessageRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<OutboxRow>(
        `UPDATE agent_platform.job_outbox
            SET state = 'dispatched', dispatched_at = $1::timestamptz, attempts = attempts + 1
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND outbox_id = $2 AND state = 'pending'
          RETURNING ${OUTBOX_COLUMNS}`,
        [dispatchedAt, outboxId],
      )
      const row = updated.rows[0]
      if (row !== undefined) return toOutboxRecord(row)
      const existing = await query.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM agent_platform.job_outbox
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND outbox_id = $1`,
        [outboxId],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) {
        throw new JobStoreError('JOB_NOT_FOUND', `outbox message ${outboxId} does not exist`)
      }
      return toOutboxRecord(existingRow)
    })
  }

  async #lockJob(query: ScopedQuery, jobId: Uuid): Promise<JobRow> {
    const result = await query.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM agent_platform.jobs
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND job_id = $1
        FOR UPDATE`,
      [jobId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new JobStoreError('JOB_NOT_FOUND', `job ${jobId} does not exist`)
    return row
  }

  async #lockAttempt(query: ScopedQuery, jobId: Uuid, attemptId: Uuid): Promise<AttemptRow> {
    const result = await query.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM agent_platform.job_attempts
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND job_id = $1 AND attempt_id = $2
        FOR UPDATE`,
      [jobId, attemptId],
    )
    const row = result.rows[0]
    if (row === undefined) {
      throw new JobStoreError('ATTEMPT_NOT_FOUND', `attempt ${attemptId} does not exist`)
    }
    return row
  }

  async #insertOutbox(
    query: ScopedQuery,
    jobId: Uuid,
    message: NewOutboxMessage,
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.job_outbox
         (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state,
          attempts, available_at, created_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3, $4::jsonb, $5, 'pending', 0, $6::timestamptz, $7::timestamptz
       )
       ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
      [
        message.outboxId,
        jobId,
        message.topic,
        JSON.stringify(message.payload),
        message.idempotencyKey,
        message.availableAt,
        message.createdAt,
      ],
    )
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new JobStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new JobStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
