import { createHash } from 'node:crypto'
import { isToolContext } from '@ontology/contracts'
import type {
  Sha256Digest,
  ToolContext,
  Uuid,
  NewWorkflowDispatch,
  WorkflowDispatchCancelRequest,
  WorkflowDispatchClaimRequest,
  WorkflowDispatchFence,
  WorkflowDispatchFailure,
  WorkflowDispatchLease,
  WorkflowDispatchPayload,
  WorkflowDispatchPort,
  WorkflowDispatchRecord,
  WorkflowDispatchRenewal,
  WorkflowDispatchState,
} from '@ontology/contracts'
import { WorkflowDispatchError } from '@ontology/contracts'
import type { PoolClient, QueryResultRow } from 'pg'
import type { ControlPostgresDatabase } from './database'

interface DispatchRow extends QueryResultRow {
  dispatch_id: string
  run_id: string
  action_kind: string
  logical_action_id: string
  payload: unknown
  payload_digest: string
  state: string
  attempt: string
  revision: string
  available_at: Date | string
  lease_owner_id: string | null
  lease_expires_at: Date | string | null
  failure_code: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface RecoverableRunRow extends QueryResultRow {
  run_id: string
  state: string
  revision: string
  clarification_id: string | null
  resumed_checkpoint_id: string | null
  has_dispatch_history: boolean
}

interface TrustedScope {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
}

type DispatchDatabase = Pick<ControlPostgresDatabase, 'withIdentityScope'>

const SELECT_COLUMNS = `dispatch_id, run_id, action_kind, logical_action_id, payload, payload_digest,
  state, attempt::text AS attempt, revision::text AS revision, available_at, lease_owner_id,
  lease_expires_at, failure_code, created_at, updated_at`
const RETURNING_COLUMNS = `dispatch.dispatch_id, dispatch.run_id, dispatch.action_kind,
  dispatch.logical_action_id, dispatch.payload, dispatch.payload_digest, dispatch.state,
  dispatch.attempt::text AS attempt, dispatch.revision::text AS revision, dispatch.available_at,
  dispatch.lease_owner_id, dispatch.lease_expires_at, dispatch.failure_code,
  dispatch.created_at, dispatch.updated_at`

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const REVISION_PATTERN = /^(0|[1-9]\d*)$/u
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u
const MIN_LEASE_DURATION_MS = 1000
const MAX_LEASE_DURATION_MS = 300_000

function invalid(message: string): never {
  throw new WorkflowDispatchError('INVALID_ARGUMENT', message)
}

function scopeOf(ctx: ToolContext): TrustedScope {
  if (!isToolContext(ctx)) {
    throw new WorkflowDispatchError('SCOPE_MISMATCH', 'a consistent host-minted tenant/space context is required')
  }
  const tenantId = ctx.principal.tenantId.toLowerCase()
  const allowedTenantId = ctx.allowedResources.tenantId.toLowerCase()
  const spaceId = ctx.allowedResources.spaceId.toLowerCase()
  if (
    !UUID_PATTERN.test(tenantId) ||
    !UUID_PATTERN.test(allowedTenantId) ||
    !UUID_PATTERN.test(spaceId) ||
    tenantId !== allowedTenantId
  ) {
    throw new WorkflowDispatchError('SCOPE_MISMATCH', 'a consistent host-minted tenant/space context is required')
  }
  return { tenantId, spaceId }
}

function assertUuid(value: string, label: string): asserts value is Uuid {
  if (!UUID_PATTERN.test(value)) invalid(`${label} must be a UUID`)
}

function canonicalUuid(value: string, label: string): Uuid {
  assertUuid(value, label)
  return value.toLowerCase()
}

function isUuid(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value)
}

function assertRevision(value: string, label: string, minimum = 0n): bigint {
  if (!REVISION_PATTERN.test(value)) invalid(`${label} must be a canonical non-negative integer`)
  const parsed = BigInt(value)
  if (parsed < minimum) invalid(`${label} is outside its allowed range`)
  return parsed
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_LEASE_DURATION_MS ||
    leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    invalid(`leaseDurationMs must be an integer from ${MIN_LEASE_DURATION_MS} to ${MAX_LEASE_DURATION_MS}`)
  }
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch contains an invalid timestamp')
  }
  return parsed.toISOString()
}

function payloadFrom(value: unknown, expectedRunId: string): WorkflowDispatchPayload {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch (error) {
      throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch payload is not valid JSON', { cause: error })
    }
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || parsed['runId'] !== expectedRunId) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch payload does not match its run id')
  }
  return { runId: expectedRunId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDispatchState(value: string): value is WorkflowDispatchState {
  return value === 'pending' || value === 'leased' || value === 'completed' || value === 'failed' || value === 'cancelled'
}

function toRecord(row: DispatchRow): WorkflowDispatchRecord {
  if (
    row.action_kind !== 'drive_run' ||
    !isDispatchState(row.state) ||
    !UUID_PATTERN.test(row.dispatch_id) ||
    !UUID_PATTERN.test(row.run_id) ||
    !REVISION_PATTERN.test(row.attempt) ||
    !REVISION_PATTERN.test(row.revision) ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.payload_digest) ||
    row.payload_digest !== workflowDispatchPayloadDigest(row.run_id)
  ) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch record violates its contract')
  }
  if (
    row.logical_action_id.length === 0 ||
    row.logical_action_id.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(row.logical_action_id) ||
    !ACTION_ID_PATTERN.test(row.logical_action_id)
  ) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch logical action id is invalid')
  }
  const state = row.state
  if ((state === 'leased') !== (row.lease_owner_id !== null && row.lease_expires_at !== null)) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch lease fields do not match its state')
  }
  if ((state === 'failed') !== (row.failure_code !== null)) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch failure code does not match its state')
  }
  const leaseOwnerId = row.lease_owner_id ?? undefined
  if (leaseOwnerId !== undefined && !UUID_PATTERN.test(leaseOwnerId)) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch lease owner is invalid')
  }
  const failureCode = row.failure_code ?? undefined
  if (
    failureCode !== undefined &&
    (failureCode.length > 64 || /[\u0000-\u001f\u007f]/u.test(failureCode) || !FAILURE_CODE_PATTERN.test(failureCode))
  ) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'stored dispatch failure code is invalid')
  }
  return {
    dispatchId: row.dispatch_id,
    runId: row.run_id,
    actionKind: 'drive_run',
    logicalActionId: row.logical_action_id,
    payload: payloadFrom(row.payload, row.run_id),
    payloadDigest: row.payload_digest,
    state,
    attempt: row.attempt,
    revision: row.revision,
    availableAt: timestamp(row.available_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(leaseOwnerId === undefined ? {} : { leaseOwnerId }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: timestamp(row.lease_expires_at) }),
    ...(failureCode === undefined ? {} : { failureCode }),
  }
}

function asLease(record: WorkflowDispatchRecord): WorkflowDispatchLease {
  if (record.state !== 'leased' || record.leaseOwnerId === undefined || record.leaseExpiresAt === undefined) {
    throw new WorkflowDispatchError('CORRUPT_RECORD', 'a claimed dispatch must contain a live lease')
  }
  return {
    ...record,
    state: 'leased',
    leaseOwnerId: record.leaseOwnerId,
    leaseExpiresAt: record.leaseExpiresAt,
  }
}

/** Canonical digest for the intentionally fixed `{ runId }` dispatch payload. */
function workflowDispatchPayloadDigest(runId: Uuid): Sha256Digest {
  const canonicalRunId = canonicalUuid(runId, 'runId')
  return `sha256:${createHash('sha256').update(JSON.stringify({ runId: canonicalRunId }), 'utf8').digest('hex')}`
}

/**
 * PostgreSQL dispatch store. Each operation gets its tenant and space from the branded
 * context and opens one scoped transaction; claim uses row locking with SKIP LOCKED, while
 * every worker mutation also fences on owner, attempt, revision, and database-clock expiry.
 */
export class PostgresWorkflowDispatchStore implements WorkflowDispatchPort {
  readonly #db: DispatchDatabase

  constructor(database: DispatchDatabase) {
    this.#db = database
  }

  async enqueue(input: NewWorkflowDispatch, ctx: ToolContext): Promise<WorkflowDispatchRecord> {
    const trusted = scopeOf(ctx)
    const runId = canonicalUuid(input.runId, 'runId')
    if (
      input.logicalActionId.length < 1 ||
      input.logicalActionId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(input.logicalActionId) ||
      !ACTION_ID_PATTERN.test(input.logicalActionId)
    ) {
      invalid('logicalActionId must be 1-256 ASCII identifier characters')
    }
    const payload: WorkflowDispatchPayload = { runId }
    const payloadDigest = workflowDispatchPayloadDigest(runId)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const run = await client.query<{ run_id: string } & QueryResultRow>(
        `SELECT run_id FROM agent_platform.runs
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
        [trusted.tenantId, trusted.spaceId, runId],
      )
      if (run.rows[0] === undefined) {
        throw new WorkflowDispatchError('RUN_NOT_FOUND', 'the run is not visible in this tenant/space')
      }
      const inserted = await client.query<DispatchRow>(
        `INSERT INTO agent_platform.workflow_dispatches
           (tenant_id, space_id, run_id, action_kind, logical_action_id, payload, payload_digest)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'drive_run', $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id, space_id, run_id, action_kind, logical_action_id) DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [trusted.tenantId, trusted.spaceId, runId, input.logicalActionId, JSON.stringify(payload), payloadDigest],
      )
      const fresh = inserted.rows[0]
      if (fresh !== undefined) return toRecord(fresh)
      const existing = await client.query<DispatchRow>(
        `SELECT ${SELECT_COLUMNS} FROM agent_platform.workflow_dispatches
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid
           AND action_kind = 'drive_run' AND logical_action_id = $4`,
        [trusted.tenantId, trusted.spaceId, runId, input.logicalActionId],
      )
      const prior = existing.rows[0]
      if (prior === undefined) {
        throw new WorkflowDispatchError('DISPATCH_NOT_FOUND', 'dispatch disappeared while resolving its idempotency key')
      }
      const record = toRecord(prior)
      if (record.payloadDigest !== payloadDigest || record.payload.runId !== runId) {
        throw new WorkflowDispatchError('IDEMPOTENCY_CONFLICT', 'logical action id was already used with a different payload')
      }
      return record
    })
  }

  async reconcileOpenRuns(ctx: ToolContext): Promise<number> {
    const trusted = scopeOf(ctx)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const recoverable = await client.query<RecoverableRunRow>(
        `SELECT run.run_id, run.state, run.revision::text AS revision,
                clarification.clarification_id::text AS clarification_id,
                resumed.checkpoint_id AS resumed_checkpoint_id,
                EXISTS (
                  SELECT 1 FROM agent_platform.workflow_dispatches AS history
                   WHERE history.tenant_id = run.tenant_id AND history.space_id = run.space_id
                     AND history.run_id = run.run_id
                ) AS has_dispatch_history
           FROM agent_platform.runs AS run
           LEFT JOIN LATERAL (
             SELECT response.clarification_id
               FROM agent_platform.run_clarification_responses AS response
              WHERE response.tenant_id = run.tenant_id AND response.space_id = run.space_id
                AND response.run_id = run.run_id AND response.revision = run.revision
              ORDER BY response.responded_at DESC, response.clarification_id
              LIMIT 1
           ) AS clarification ON true
           LEFT JOIN LATERAL (
             SELECT event.data->>'resumedFrom' AS checkpoint_id
               FROM agent_platform.run_events AS event
              WHERE event.tenant_id = run.tenant_id AND event.space_id = run.space_id
                AND event.run_id = run.run_id AND event.data->>'state' = 'collecting'
                AND event.data ? 'resumedFrom'
              ORDER BY event.sequence DESC
              LIMIT 1
           ) AS resumed ON true
          WHERE run.tenant_id = $1::uuid AND run.space_id = $2::uuid
            AND run.state IN ('created', 'preflight', 'collecting', 'drafting', 'verifying')
            AND run.updated_at <= clock_timestamp() - interval '5 seconds'
            AND NOT EXISTS (
              SELECT 1 FROM agent_platform.workflow_dispatches AS active
               WHERE active.tenant_id = run.tenant_id AND active.space_id = run.space_id
                 AND active.run_id = run.run_id AND active.state IN ('pending', 'leased')
            )
          ORDER BY run.updated_at, run.run_id
          FOR UPDATE OF run SKIP LOCKED
          LIMIT 100`,
        [trusted.tenantId, trusted.spaceId],
      )
      let insertedCount = 0
      for (const row of recoverable.rows) {
        const runId = canonicalUuid(row.run_id, 'runId')
        const logicalActionId =
          row.state === 'collecting' && row.clarification_id !== null
            ? `clarification-response:${row.clarification_id}:${row.revision}`
            : row.state === 'collecting' && isUuid(row.resumed_checkpoint_id)
              ? `resume:${row.resumed_checkpoint_id}:${row.revision}`
              : row.has_dispatch_history
                ? `recovery:${runId}:${row.revision}`
                : 'initial-drive'
        const payload: WorkflowDispatchPayload = { runId }
        const inserted = await client.query(
          `INSERT INTO agent_platform.workflow_dispatches
             (tenant_id, space_id, run_id, action_kind, logical_action_id, payload, payload_digest)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'drive_run', $4, $5::jsonb, $6)
           ON CONFLICT (tenant_id, space_id, run_id, action_kind, logical_action_id) DO NOTHING`,
          [trusted.tenantId, trusted.spaceId, runId, logicalActionId, JSON.stringify(payload), workflowDispatchPayloadDigest(runId)],
        )
        insertedCount += inserted.rowCount ?? 0
      }
      return insertedCount
    })
  }

  async get(dispatchId: Uuid, ctx: ToolContext): Promise<WorkflowDispatchRecord | undefined> {
    const trusted = scopeOf(ctx)
    assertUuid(dispatchId, 'dispatchId')
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query<DispatchRow>(
        `SELECT ${SELECT_COLUMNS} FROM agent_platform.workflow_dispatches
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
        [trusted.tenantId, trusted.spaceId, dispatchId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRecord(row)
    }, { readOnly: true })
  }

  async claimNext(
    request: WorkflowDispatchClaimRequest,
    ctx: ToolContext,
  ): Promise<WorkflowDispatchLease | undefined> {
    const trusted = scopeOf(ctx)
    assertUuid(request.ownerId, 'ownerId')
    assertLeaseDuration(request.leaseDurationMs)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const claimed = await client.query<DispatchRow>(
        `WITH candidate AS (
           SELECT dispatch_id
           FROM agent_platform.workflow_dispatches
           WHERE tenant_id = $1::uuid AND space_id = $2::uuid
             AND ((state = 'pending' AND available_at <= clock_timestamp())
               OR (state = 'leased' AND lease_expires_at <= clock_timestamp()))
           ORDER BY COALESCE(lease_expires_at, available_at), created_at, dispatch_id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE agent_platform.workflow_dispatches AS dispatch
         SET state = 'leased', lease_owner_id = $3::uuid,
             attempt = dispatch.attempt + 1, revision = dispatch.revision + 1,
             lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             failure_code = NULL, updated_at = clock_timestamp()
         FROM candidate
         WHERE dispatch.tenant_id = $1::uuid AND dispatch.space_id = $2::uuid
           AND dispatch.dispatch_id = candidate.dispatch_id
         RETURNING ${RETURNING_COLUMNS}`,
        [trusted.tenantId, trusted.spaceId, request.ownerId, request.leaseDurationMs],
      )
      const row = claimed.rows[0]
      return row === undefined ? undefined : asLease(toRecord(row))
    })
  }

  async renew(request: WorkflowDispatchRenewal, ctx: ToolContext): Promise<WorkflowDispatchLease> {
    const trusted = scopeOf(ctx)
    validateFence(request)
    assertLeaseDuration(request.leaseDurationMs)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query<DispatchRow>(
        `UPDATE agent_platform.workflow_dispatches AS dispatch
         SET lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
             revision = revision + 1, updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid
           AND state = 'leased' AND lease_owner_id = $4::uuid
           AND attempt = $5::bigint AND revision = $6::bigint
           AND lease_expires_at > clock_timestamp()
         RETURNING dispatch.dispatch_id, dispatch.run_id, dispatch.action_kind, dispatch.logical_action_id,
           dispatch.payload, dispatch.payload_digest, dispatch.state, dispatch.attempt::text AS attempt,
           dispatch.revision::text AS revision, dispatch.available_at, dispatch.lease_owner_id,
           dispatch.lease_expires_at, dispatch.failure_code, dispatch.created_at, dispatch.updated_at`,
        [trusted.tenantId, trusted.spaceId, request.dispatchId, request.ownerId, request.attempt, request.expectedRevision, request.leaseDurationMs],
      )
      const row = result.rows[0]
      if (row !== undefined) return asLease(toRecord(row))
      return this.#raiseMutationMiss(client, trusted, request.dispatchId, request.expectedRevision)
    })
  }

  async complete(fence: WorkflowDispatchFence, ctx: ToolContext): Promise<WorkflowDispatchRecord> {
    const trusted = scopeOf(ctx)
    validateFence(fence)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query<DispatchRow>(
        `UPDATE agent_platform.workflow_dispatches
         SET state = 'completed', lease_owner_id = NULL, lease_expires_at = NULL,
             revision = revision + 1, updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid
           AND state = 'leased' AND lease_owner_id = $4::uuid
           AND attempt = $5::bigint AND revision = $6::bigint
           AND lease_expires_at > clock_timestamp()
         RETURNING ${SELECT_COLUMNS}`,
        [trusted.tenantId, trusted.spaceId, fence.dispatchId, fence.ownerId, fence.attempt, fence.expectedRevision],
      )
      const row = result.rows[0]
      if (row !== undefined) return toRecord(row)
      return this.#raiseMutationMiss(client, trusted, fence.dispatchId, fence.expectedRevision)
    })
  }

  async fail(request: WorkflowDispatchFailure, ctx: ToolContext): Promise<WorkflowDispatchRecord> {
    const trusted = scopeOf(ctx)
    validateFence(request)
    if (
      request.failureCode.length < 1 ||
      request.failureCode.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(request.failureCode) ||
      !FAILURE_CODE_PATTERN.test(request.failureCode)
    ) {
      invalid('failureCode must be a lowercase machine-readable code of at most 64 characters')
    }
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query<DispatchRow>(
        `UPDATE agent_platform.workflow_dispatches
         SET state = 'failed', lease_owner_id = NULL, lease_expires_at = NULL,
             failure_code = $7, revision = revision + 1, updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid
           AND state = 'leased' AND lease_owner_id = $4::uuid
           AND attempt = $5::bigint AND revision = $6::bigint
           AND lease_expires_at > clock_timestamp()
         RETURNING ${SELECT_COLUMNS}`,
        [trusted.tenantId, trusted.spaceId, request.dispatchId, request.ownerId, request.attempt, request.expectedRevision, request.failureCode],
      )
      const row = result.rows[0]
      if (row !== undefined) return toRecord(row)
      return this.#raiseMutationMiss(client, trusted, request.dispatchId, request.expectedRevision)
    })
  }

  async cancel(
    request: WorkflowDispatchCancelRequest,
    ctx: ToolContext,
  ): Promise<WorkflowDispatchRecord> {
    const trusted = scopeOf(ctx)
    assertUuid(request.dispatchId, 'dispatchId')
    assertRevision(request.expectedRevision, 'expectedRevision', 1n)
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query<DispatchRow>(
        `UPDATE agent_platform.workflow_dispatches
         SET state = 'cancelled', lease_owner_id = NULL, lease_expires_at = NULL,
             revision = revision + 1, updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid
           AND state IN ('pending', 'leased') AND revision = $4::bigint
         RETURNING ${SELECT_COLUMNS}`,
        [trusted.tenantId, trusted.spaceId, request.dispatchId, request.expectedRevision],
      )
      const row = result.rows[0]
      if (row !== undefined) return toRecord(row)
      return this.#raiseMutationMiss(client, trusted, request.dispatchId, request.expectedRevision)
    })
  }

  async cancelRun(runId: Uuid, ctx: ToolContext): Promise<number> {
    const trusted = scopeOf(ctx)
    assertUuid(runId, 'runId')
    return this.#db.withIdentityScope(trusted, async (client) => {
      const result = await client.query(
        `UPDATE agent_platform.workflow_dispatches
         SET state = 'cancelled', lease_owner_id = NULL, lease_expires_at = NULL,
             revision = revision + 1, updated_at = clock_timestamp()
         WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid
           AND state IN ('pending', 'leased')`,
        [trusted.tenantId, trusted.spaceId, runId],
      )
      return result.rowCount ?? 0
    })
  }

  async #raiseMutationMiss(
    client: PoolClient,
    trusted: TrustedScope,
    dispatchId: Uuid,
    expectedRevision: string,
  ): Promise<never> {
    const current = await client.query<{ revision: string } & QueryResultRow>(
      `SELECT revision::text AS revision FROM agent_platform.workflow_dispatches
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
      [trusted.tenantId, trusted.spaceId, dispatchId],
    )
    const row = current.rows[0]
    if (row === undefined) {
      throw new WorkflowDispatchError('DISPATCH_NOT_FOUND', 'dispatch is not visible in this tenant/space')
    }
    if (row.revision !== expectedRevision) {
      throw new WorkflowDispatchError('REVISION_CONFLICT', 'dispatch revision changed before the requested transition')
    }
    throw new WorkflowDispatchError('LEASE_LOST', 'dispatch is no longer owned by this unexpired lease')
  }
}

function validateFence(fence: WorkflowDispatchFence): void {
  assertUuid(fence.dispatchId, 'dispatchId')
  assertUuid(fence.ownerId, 'ownerId')
  assertRevision(fence.attempt, 'attempt', 1n)
  assertRevision(fence.expectedRevision, 'expectedRevision', 1n)
}
