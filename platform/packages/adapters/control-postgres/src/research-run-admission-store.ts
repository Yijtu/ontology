import type { QueryResultRow } from 'pg'
import {
  ResearchRunAdmissionError,
  assertResearchRunAdmissionShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  NewResearchRunAdmission,
  ResearchRunAdmission,
  ResearchRunAdmissionStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface AdmissionRow extends QueryResultRow {
  run_id: string
  research_id: string
  workspace_id: string
  draft_revision: string
  idempotency_key: string
  request_digest: string
  state: string
  goal: unknown
  brief_ref: unknown
  authorization_receipt_ref: unknown
  config_snapshot_ref: unknown
  model_snapshot_refs: unknown
  tool_snapshot_refs: unknown
  config_snapshot_hash: string
  created_at: Date | string
  updated_at: Date | string
  ready_at: Date | string | null
}

const COLUMNS = `run_id, research_id, workspace_id, draft_revision::text AS draft_revision,
  idempotency_key, request_digest, state, goal, brief_ref, authorization_receipt_ref,
  config_snapshot_ref, model_snapshot_refs, tool_snapshot_refs, config_snapshot_hash,
  created_at, updated_at, ready_at`

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new ResearchRunAdmissionError('STORE_FAILED', 'a stored research admission timestamp is invalid')
  }
  return parsed.toISOString()
}

function toAdmission(row: AdmissionRow): ResearchRunAdmission {
  const value: unknown = {
    schemaVersion: 'research-run-admission@1',
    runId: row.run_id,
    researchId: row.research_id,
    workspaceId: row.workspace_id,
    draftRevision: row.draft_revision,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    state: row.state,
    goal: row.goal,
    briefRef: row.brief_ref,
    authorizationReceiptRef: row.authorization_receipt_ref,
    configSnapshotRef: row.config_snapshot_ref,
    modelSnapshotRefs: row.model_snapshot_refs,
    toolSnapshotRefs: row.tool_snapshot_refs,
    configSnapshotHash: row.config_snapshot_hash,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.ready_at === null ? {} : { readyAt: iso(row.ready_at) }),
  }
  assertResearchRunAdmissionShape(value)
  return value
}

/**
 * Real PostgreSQL implementation of the research run admission store (design §4/§8, S05).
 *
 * `begin` is the idempotent, write-once claim on `(tenant, space, idempotency_key)`: it inserts a
 * `preparing` row and, on a key race, re-reads the winner and refuses a differing digest rather
 * than overwriting it. `mark_ready` flips the dispatch-ready barrier idempotently. Every statement
 * runs inside the trusted tenant/space scope, so RLS applies on top of the application filter.
 */
export class PostgresResearchRunAdmissionStore implements ResearchRunAdmissionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async begin(
    scopeRef: ScopeRef,
    admission: NewResearchRunAdmission,
    ctx: ToolContext,
  ): Promise<ResearchRunAdmission> {
    if (!isUuid(admission.runId)) throw new ResearchRunAdmissionError('INVALID_REQUEST', 'runId must be a uuid')
    if (!isUuid(admission.researchId)) throw new ResearchRunAdmissionError('INVALID_REQUEST', 'researchId must be a uuid')
    if (admission.idempotencyKey.length < 8 || admission.idempotencyKey.length > 256) {
      throw new ResearchRunAdmissionError('INVALID_REQUEST', 'idempotencyKey must be 8..256 characters')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<AdmissionRow>(
        `INSERT INTO agent_platform.research_run_admission
           (tenant_id, space_id, run_id, research_id, workspace_id, draft_revision, idempotency_key,
            request_digest, state, goal, brief_ref, authorization_receipt_ref, config_snapshot_ref,
            model_snapshot_refs, tool_snapshot_refs, config_snapshot_hash, created_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5, $6, 'preparing', $7::jsonb, $8::jsonb,
           $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14::timestamptz, $14::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          admission.runId,
          admission.researchId,
          admission.workspaceId,
          admission.draftRevision,
          admission.idempotencyKey,
          admission.requestDigest,
          JSON.stringify(admission.goal),
          JSON.stringify(admission.briefRef),
          JSON.stringify(admission.authorizationReceiptRef),
          JSON.stringify(admission.configSnapshotRef),
          JSON.stringify(admission.modelSnapshotRefs),
          JSON.stringify(admission.toolSnapshotRefs),
          admission.configSnapshotHash,
          admission.createdAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toAdmission(row)
      // The key already exists: a replay of the same logical request returns the stored admission,
      // and a different digest (a different goal/authorization) is a conflict, never an overwrite.
      const existing = await this.#byKey(query, admission.idempotencyKey)
      if (existing === undefined) {
        throw new ResearchRunAdmissionError('STORE_FAILED', 'the admission claim references a missing row')
      }
      if (existing.requestDigest !== admission.requestDigest) {
        throw new ResearchRunAdmissionError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different research goal or authorization',
        )
      }
      return existing
    })
  }

  async markReady(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<ResearchRunAdmission> {
    if (!isUuid(runId)) throw new ResearchRunAdmissionError('INVALID_REQUEST', 'runId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<AdmissionRow>(
        `UPDATE agent_platform.research_run_admission
            SET state = 'ready', ready_at = now(), updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1::uuid AND state = 'preparing'
          RETURNING ${COLUMNS}`,
        [runId],
      )
      const row = updated.rows[0]
      if (row !== undefined) return toAdmission(row)
      // Already ready (an idempotent replay) returns the stored row; a missing admission is refused.
      const current = await query.query<AdmissionRow>(
        `SELECT ${COLUMNS} FROM agent_platform.research_run_admission
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1::uuid`,
        [runId],
      )
      const existing = current.rows[0]
      if (existing === undefined) {
        throw new ResearchRunAdmissionError('NOT_FOUND', `admission for run ${runId} is not visible in this scope`)
      }
      return toAdmission(existing)
    })
  }

  async get(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<ResearchRunAdmission | undefined> {
    if (!isUuid(runId)) throw new ResearchRunAdmissionError('INVALID_REQUEST', 'runId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AdmissionRow>(
        `SELECT ${COLUMNS} FROM agent_platform.research_run_admission
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1::uuid`,
        [runId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toAdmission(row)
    })
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<ResearchRunAdmission | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => this.#byKey(query, idempotencyKey))
  }

  async #byKey(query: ScopedQuery, idempotencyKey: string): Promise<ResearchRunAdmission | undefined> {
    const result = await query.query<AdmissionRow>(
      `SELECT ${COLUMNS} FROM agent_platform.research_run_admission
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [idempotencyKey],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : toAdmission(row)
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ResearchRunAdmissionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ResearchRunAdmissionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ResearchRunAdmissionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
      return run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      })
    })
  }
}
