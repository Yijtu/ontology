import type { QueryResultRow } from 'pg'
import {
  ProjectReadinessStoreError,
  assertReadinessProjectionShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  CompletenessStatus,
  ProjectReadinessKind,
  ProjectReadinessState,
  ProjectReadinessStore,
  ProjectReadinessUpsertResult,
  ProjectRevisionRef,
  ReadinessError,
  ReadinessProjection,
  ReadinessTargetRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
  UpsertProjectReadinessInput,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ReadinessRow extends QueryResultRow {
  project_id: string
  project_revision: string
  kind: ProjectReadinessKind
  target_ref: ReadinessTargetRef
  state: ProjectReadinessState
  completeness: CompletenessStatus
  expected_count: number
  processed_count: number
  failed_count: number
  target_digest: string
  receipt_ref: ResourceRef | null
  fence_revision: string
  job_id: string | null
  error: ReadinessError | null
}

const READINESS_COLUMNS = `project_id, project_revision::text AS project_revision, kind, target_ref,
  state, completeness, expected_count::int AS expected_count, processed_count::int AS processed_count,
  failed_count::int AS failed_count, target_digest, receipt_ref, fence_revision::text AS fence_revision,
  job_id, error`

/**
 * The row does not carry the project revision digest (a projection is not part of it), so the
 * caller's exact ref is attached, preserving the digest it read alongside the revision.
 */
function toProjection(row: ReadinessRow, ref: ProjectRevisionRef): ReadinessProjection {
  return {
    projectRevisionRef: ref,
    kind: row.kind,
    targetRef: row.target_ref,
    state: row.state,
    completeness: row.completeness,
    expectedCount: row.expected_count,
    processedCount: row.processed_count,
    failedCount: row.failed_count,
    targetDigest: row.target_digest,
    fenceRevision: row.fence_revision,
    ...(row.receipt_ref === null ? {} : { receiptRef: row.receipt_ref }),
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ...(row.error === null ? {} : { error: row.error }),
  }
}

function projectionOf(input: UpsertProjectReadinessInput): ReadinessProjection {
  return {
    projectRevisionRef: input.projectRevisionRef,
    kind: input.kind,
    targetRef: input.targetRef,
    state: input.state,
    completeness: input.completeness,
    expectedCount: input.expectedCount,
    processedCount: input.processedCount,
    failedCount: input.failedCount,
    targetDigest: input.targetDigest,
    fenceRevision: input.fenceRevision,
    ...(input.receiptRef === undefined ? {} : { receiptRef: input.receiptRef }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

/**
 * Real PostgreSQL implementation of the per-revision readiness store (SPEC v0.3a §3.2/§4.1).
 *
 * `upsertProjection` is the fence CAS the background materialisation/index guards rely on: a
 * stale (lower) fence is refused with FENCE_STALE, and at the same fence a different target
 * digest cannot replace the active target. The store never sees the project revision digest,
 * so a reader must pair the stored projection with the exact revision it read; the digest is
 * not part of what a projection asserts.
 */
export class PostgresProjectReadinessStore implements ProjectReadinessStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async upsertProjection(
    scopeRef: ScopeRef,
    input: UpsertProjectReadinessInput,
    ctx: ToolContext,
  ): Promise<ProjectReadinessUpsertResult> {
    const projection = projectionOf(input)
    assertReadinessProjectionShape(projection)

    return this.#withScope(scopeRef, ctx, async (query) => {
      if (input.state === 'ready') {
        const owner = await query.query<{ head_revision: string; staging_writable: boolean }>(`SELECT head_revision::text,staging_writable FROM agent_platform.projects
          WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND project_id=$1::uuid FOR SHARE`, [input.projectRevisionRef.projectId])
        if (owner.rows[0]?.head_revision === input.projectRevisionRef.revision && owner.rows[0].staging_writable === false) throw new ProjectReadinessStoreError('FENCE_STALE', 'cancelled staging revisions cannot become ready')
        if (input.kind === 'document_index') {
          const visibility = await query.query<{ epoch: string }>(`SELECT visibility_epoch::text AS epoch FROM agent_platform.project_visibility
            WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND project_id=$1::uuid FOR SHARE`, [input.projectRevisionRef.projectId])
          if (visibility.rows[0]?.epoch !== input.fenceRevision) throw new ProjectReadinessStoreError('FENCE_STALE', 'the document corpus changed before readiness committed')
        }
      }
      const replay = await this.#byIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== input.requestDigest) {
          throw new ProjectReadinessStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different readiness payload',
          )
        }
        return {
          projection: toProjection(replay, input.projectRevisionRef),
          created: false,
        }
      }

      const upserted = await query.query<ReadinessRow & { inserted: boolean }>(
        `INSERT INTO agent_platform.project_readiness
           (tenant_id, space_id, project_id, project_revision, kind, target_ref, state, completeness,
            expected_count, processed_count, failed_count, target_digest, receipt_ref, fence_revision,
            job_id, error, idempotency_key, request_digest, actor, trace_id, recorded_at, available_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::bigint, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::bigint,
           $13::uuid, $14::jsonb, $15, $16, $17, current_setting('app.trace_id', true),
           $18::timestamptz, $18::timestamptz)
         ON CONFLICT (tenant_id, space_id, project_id, project_revision, kind)
         DO UPDATE SET
           target_ref = EXCLUDED.target_ref,
           state = EXCLUDED.state,
           completeness = EXCLUDED.completeness,
           expected_count = EXCLUDED.expected_count,
           processed_count = EXCLUDED.processed_count,
           failed_count = EXCLUDED.failed_count,
           target_digest = EXCLUDED.target_digest,
           receipt_ref = EXCLUDED.receipt_ref,
           fence_revision = EXCLUDED.fence_revision,
           job_id = EXCLUDED.job_id,
           error = EXCLUDED.error,
           idempotency_key = EXCLUDED.idempotency_key,
           request_digest = EXCLUDED.request_digest,
           actor = EXCLUDED.actor,
           recorded_at = EXCLUDED.recorded_at,
           available_at = EXCLUDED.available_at
         WHERE (EXCLUDED.fence_revision > agent_platform.project_readiness.fence_revision)
            OR (EXCLUDED.fence_revision = agent_platform.project_readiness.fence_revision
                AND EXCLUDED.target_digest = agent_platform.project_readiness.target_digest)
         RETURNING ${READINESS_COLUMNS}, (xmax = 0) AS inserted`,
        [
          input.projectRevisionRef.projectId,
          input.projectRevisionRef.revision,
          input.kind,
          JSON.stringify(input.targetRef),
          input.state,
          input.completeness,
          input.expectedCount,
          input.processedCount,
          input.failedCount,
          input.targetDigest,
          input.receiptRef === undefined ? null : JSON.stringify(input.receiptRef),
          input.fenceRevision,
          input.jobId ?? null,
          input.error === undefined ? null : JSON.stringify(input.error),
          input.idempotencyKey,
          input.requestDigest,
          input.actor,
          input.recordedAt,
        ],
      )

      const row = upserted.rows[0]
      if (row !== undefined) {
        return {
          projection: toProjection(row, input.projectRevisionRef),
          created: row.inserted === true,
        }
      }

      const existing = await this.#byKey(query, input.projectRevisionRef, input.kind)
      if (existing === undefined) {
        throw new ProjectReadinessStoreError(
          'INVALID_PROJECTION',
          'the readiness projection could not be written',
        )
      }
      throw new ProjectReadinessStoreError(
        'FENCE_STALE',
        `readiness ${input.kind} for revision ${input.projectRevisionRef.revision} was already built at a fence >= ${input.fenceRevision}`,
      )
    })
  }

  async getProjection(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    kind: ProjectReadinessKind,
    ctx: ToolContext,
  ): Promise<ReadinessProjection | undefined> {
    if (!isUuid(projectRevisionRef.projectId)) {
      throw new ProjectReadinessStoreError('INVALID_PROJECTION', 'projectRevisionRef.projectId must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, projectRevisionRef, kind)
      return row === undefined ? undefined : toProjection(row, projectRevisionRef)
    })
  }

  async listProjections(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    ctx: ToolContext,
  ): Promise<ReadinessProjection[]> {
    if (!isUuid(projectRevisionRef.projectId)) {
      throw new ProjectReadinessStoreError('INVALID_PROJECTION', 'projectRevisionRef.projectId must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReadinessRow>(
        `SELECT ${READINESS_COLUMNS} FROM agent_platform.project_readiness
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid AND project_revision = $2::bigint
           ORDER BY kind`,
        [projectRevisionRef.projectId, projectRevisionRef.revision],
      )
      return result.rows.map((row) => toProjection(row, projectRevisionRef))
    })
  }

  async #byKey(
    query: ScopedQuery,
    projectRevisionRef: ProjectRevisionRef,
    kind: ProjectReadinessKind,
  ): Promise<ReadinessRow | undefined> {
    const result = await query.query<ReadinessRow>(
      `SELECT ${READINESS_COLUMNS} FROM agent_platform.project_readiness
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND project_revision = $2::bigint AND kind = $3`,
      [projectRevisionRef.projectId, projectRevisionRef.revision, kind],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(
    query: ScopedQuery,
    idempotencyKey: string,
  ): Promise<(ReadinessRow & { request_digest: string }) | undefined> {
    const result = await query.query<ReadinessRow & { request_digest: string }>(
      `SELECT ${READINESS_COLUMNS}, request_digest FROM agent_platform.project_readiness
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [idempotencyKey],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ProjectReadinessStoreError(
        'SCOPE_MISMATCH',
        'a host-minted trusted tool context is required',
      )
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ProjectReadinessStoreError(
        'SCOPE_MISMATCH',
        'trusted context carries inconsistent tenant scope',
      )
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectReadinessStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
    }
    return this.#database.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) => {
        await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
        return run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        })
      },
    )
  }
}
