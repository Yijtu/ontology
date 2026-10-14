import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { CandidateSourceError, isToolContext } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceFreshness,
  CandidateSourceKind,
  CandidateSourceListFilter,
  CandidateSourceRecord,
  CandidateSourceReviewState,
  CandidateSourceStore,
  ResourceRef,
  ScopeRef,
  SourceTrustTier,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

interface SourceRow extends QueryResultRow {
  workspace_id: string
  source_id: string
  revision: string
  kind: CandidateSourceKind
  trust_tier: SourceTrustTier
  review_state: CandidateSourceReviewState
  origin: CandidateSource['origin']
  content_ref: ResourceRef
  content_digest: string
  freshness: CandidateSourceFreshness | null
  proposed_by: string
  reviewed_by: string | null
  recorded_at: Date
}

const COLUMNS = `workspace_id, source_id, revision, kind, trust_tier, review_state, origin, content_ref,
  content_digest, freshness, proposed_by, reviewed_by, recorded_at`

function toSource(row: SourceRow): CandidateSourceRecord {
  return {
    schemaVersion: 'candidate-source@1',
    sourceId: row.source_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    kind: row.kind,
    trustTier: row.trust_tier,
    origin: row.origin,
    contentRef: row.content_ref,
    contentDigest: row.content_digest,
    ...(row.freshness === null ? {} : { freshness: row.freshness }),
    reviewState: row.review_state,
    proposedBy: row.proposed_by,
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
    recordedAt: row.recorded_at.toISOString(),
  }
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit <= 0) throw new CandidateSourceError('INVALID_SOURCE', 'list limit must be a positive integer')
  return Math.min(limit, 250)
}

/**
 * Real PostgreSQL implementation of the candidate-source store. It persists proposed authoring
 * sources with their provenance tier and review state; a review is a compare-and-swap on
 * `revision`, and every statement runs behind the trusted-scope RLS predicate.
 */
export class PostgresCandidateSourceStore implements CandidateSourceStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putSource(
    scopeRef: ScopeRef,
    input: { readonly source: CandidateSource; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<CandidateSourceRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const requestDigest = digestOf(input.source)
      const replay = await this.#byIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        // A replay must name the same source; `recorded_at` is server-normalised, so compare the
        // identity-defining fields instead of a whole-row digest.
        const sameSource = replay.source_id === input.source.sourceId && replay.workspace_id === input.source.workspaceId
          && replay.kind === input.source.kind && replay.trust_tier === input.source.trustTier
          && replay.content_digest === input.source.contentDigest
        if (!sameSource) throw new CandidateSourceError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for another candidate source')
        return toSource(replay)
      }
      try {
        const inserted = await query.query<SourceRow>(
          `INSERT INTO agent_platform.candidate_sources
             (tenant_id, space_id, workspace_id, source_id, revision, kind, trust_tier, review_state, origin,
              content_ref, content_digest, freshness, proposed_by, idempotency_key, request_digest, recorded_at, updated_at)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
             $1::uuid, $2::uuid, 1, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13::timestamptz, $13::timestamptz)
           RETURNING ${COLUMNS}`,
          [
            input.source.workspaceId, input.source.sourceId, input.source.kind, input.source.trustTier, input.source.reviewState,
            JSON.stringify(input.source.origin), JSON.stringify(input.source.contentRef), input.source.contentDigest,
            input.source.freshness === undefined ? null : JSON.stringify(input.source.freshness),
            input.source.proposedBy, input.idempotencyKey, requestDigest, input.source.recordedAt,
          ],
        )
        const row = inserted.rows[0]
        if (row === undefined) throw new CandidateSourceError('STORE_FAILED', 'the candidate source was not written')
        return toSource(row)
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          const concurrent = await this.#byIdempotencyKey(query, input.idempotencyKey)
          if (concurrent !== undefined) return toSource(concurrent)
          throw new CandidateSourceError('VERSION_CONFLICT', 'a concurrent write won the candidate source', { cause: error })
        }
        if (pgCodeOf(error) === '23503') {
          throw new CandidateSourceError('NOT_FOUND', 'the candidate source workspace is not visible in this scope', { cause: error })
        }
        throw error
      }
    })
  }

  async getSource(scopeRef: ScopeRef, sourceId: Uuid, ctx: ToolContext): Promise<CandidateSourceRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byId(query, sourceId)
      return row === undefined ? undefined : toSource(row)
    })
  }

  async listSources(scopeRef: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter, ctx: ToolContext): Promise<readonly CandidateSourceRecord[]> {
    const limit = normalizeLimit(filter.limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceRow>(
        `SELECT ${COLUMNS} FROM agent_platform.candidate_sources
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
            AND ($2::text IS NULL OR review_state = $2)
            AND ($3::text IS NULL OR trust_tier = $3)
          ORDER BY recorded_at ASC, source_id ASC
          LIMIT $4`,
        [workspaceId, filter.reviewState ?? null, filter.trustTier ?? null, limit],
      )
      return result.rows.map(toSource)
    })
  }

  async reviewSource(
    scopeRef: ScopeRef,
    input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string; readonly expectedRevision: string; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<CandidateSourceRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<SourceRow>(
        `SELECT ${COLUMNS} FROM agent_platform.candidate_sources
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1::uuid
          FOR UPDATE`,
        [input.sourceId],
      )
      const current = locked.rows[0]
      if (current === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${input.sourceId} is not visible in this scope`)
      const nextTier = input.trustTier ?? current.trust_tier
      if (current.review_state === input.reviewState && current.reviewed_by === input.reviewedBy && current.trust_tier === nextTier) return toSource(current)
      if (current.revision !== input.expectedRevision) {
        throw new CandidateSourceError('VERSION_CONFLICT', `candidate source head is ${current.revision}, not the expected ${input.expectedRevision}`)
      }
      const nextRevision = (BigInt(current.revision) + 1n).toString()
      const updated = await query.query<SourceRow>(
        `UPDATE agent_platform.candidate_sources
            SET revision = $2::bigint, review_state = $3, trust_tier = $4, reviewed_by = $5, updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1::uuid
          RETURNING ${COLUMNS}`,
        [input.sourceId, nextRevision, input.reviewState, nextTier, input.reviewedBy],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new CandidateSourceError('STORE_FAILED', 'the candidate source review was not written')
      return toSource(row)
    })
  }

  async #byId(query: ScopedQuery, sourceId: Uuid): Promise<SourceRow | undefined> {
    const result = await query.query<SourceRow>(
      `SELECT ${COLUMNS} FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND source_id = $1::uuid`,
      [sourceId],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<SourceRow | undefined> {
    const result = await query.query<SourceRow>(
      `SELECT ${COLUMNS} FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) throw new CandidateSourceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new CandidateSourceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
