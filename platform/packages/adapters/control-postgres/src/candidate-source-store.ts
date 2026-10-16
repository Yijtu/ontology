import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { CandidateSourceError, isToolContext } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceFreshness,
  CandidateSourceKind,
  CandidateSourceListFilter,
  CandidateSourcePage,
  CandidateSourcePageRequest,
  CandidateSourceRecord,
  CandidateSourceRetractionStore,
  CandidateSourceReviewCommand,
  CandidateSourceReviewEvent,
  CandidateSourceReviewReceipt,
  CandidateSourceReviewState,
  CandidateSourceStore,
  ResourceRef,
  ScopeRef,
  SourceRetraction,
  SourceRetractionReceipt,
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
  retracted_at: Date | null
  retracted_by: string | null
  recorded_at: Date
}

interface EventRow extends QueryResultRow {
  seq: string
  event_id: string
  workspace_id: string
  source_id: string
  previous_state: CandidateSourceReviewState
  next_state: CandidateSourceReviewState
  previous_trust_tier: SourceTrustTier | null
  next_trust_tier: SourceTrustTier | null
  reason: string
  basis_refs: ResourceRef[]
  actor: string
  recorded_at: Date
  retraction: boolean
  next_revision: string
  idempotency_key: string
  request_digest: string
}

const SOURCE_COLUMNS = `workspace_id, source_id, revision, kind, trust_tier, review_state, origin, content_ref,
  content_digest, freshness, proposed_by, reviewed_by, retracted_at, retracted_by, recorded_at`
const EVENT_COLUMNS = `seq, event_id, workspace_id, source_id, previous_state, next_state, previous_trust_tier,
  next_trust_tier, reason, basis_refs, actor, recorded_at, retraction, next_revision, idempotency_key, request_digest`

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
    ...(row.retracted_at === null ? {} : { retractedAt: row.retracted_at.toISOString() }),
    ...(row.retracted_by === null ? {} : { retractedBy: row.retracted_by }),
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toEvent(row: EventRow): CandidateSourceReviewEvent {
  return {
    schemaVersion: 'candidate-source-review-event@1',
    eventId: row.event_id,
    sourceId: row.source_id,
    workspaceId: row.workspace_id,
    previousState: row.previous_state,
    nextState: row.next_state,
    ...(row.previous_trust_tier === null ? {} : { previousTrustTier: row.previous_trust_tier }),
    ...(row.next_trust_tier === null ? {} : { nextTrustTier: row.next_trust_tier }),
    reason: row.reason,
    basisRefs: row.basis_refs,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  }
}

function toRetraction(row: EventRow): SourceRetraction {
  return {
    schemaVersion: 'source-retraction@1',
    retractionId: row.event_id,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    previousState: row.previous_state,
    sourceRevision: row.next_revision,
    reason: row.reason,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
    idempotencyKey: row.idempotency_key,
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

function encodeCursor(recordedAt: Date, id: string): string {
  return Buffer.from(`${recordedAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}

function decodeSourceCursor(cursor: string | undefined): { recordedAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) throw new CandidateSourceError('INVALID_SOURCE', 'the list cursor is malformed')
  return { recordedAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) }
}

function decodeSeqCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^\d+$/.test(decoded)) throw new CandidateSourceError('INVALID_SOURCE', 'the page cursor is malformed')
  return decoded
}

function encodeSeqCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url')
}

/**
 * Real PostgreSQL implementation of the candidate-source store. It persists proposed authoring
 * sources with their provenance tier and review state; a review is a compare-and-swap on
 * `revision` that also appends an auditable review event, and every statement runs behind the
 * trusted-scope RLS predicate.
 */
export class PostgresCandidateSourceStore implements CandidateSourceStore, CandidateSourceRetractionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putSource(
    scopeRef: ScopeRef,
    input: { readonly source: CandidateSource; readonly idempotencyKey: string },
    ctx: ToolContext,
    client?: PoolClient,
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
           RETURNING ${SOURCE_COLUMNS}`,
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
    }, client)
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
        `SELECT ${SOURCE_COLUMNS} FROM agent_platform.candidate_sources
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

  async listSourcesPage(scopeRef: ScopeRef, workspaceId: Uuid, page: CandidateSourcePageRequest, ctx: ToolContext): Promise<CandidateSourcePage> {
    const limit = normalizeLimit(page.limit)
    const cursor = decodeSourceCursor(page.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceRow>(
        `SELECT ${SOURCE_COLUMNS} FROM agent_platform.candidate_sources
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
            AND ($2::text IS NULL OR review_state = $2)
            AND ($3::text IS NULL OR trust_tier = $3)
            AND ($4::timestamptz IS NULL OR (recorded_at, source_id) > ($4::timestamptz, $5::uuid))
          ORDER BY recorded_at ASC, source_id ASC
          LIMIT $6`,
        [workspaceId, page.filter?.reviewState ?? null, page.filter?.trustTier ?? null,
          cursor?.recordedAt ?? null, cursor?.id ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      const complete = result.rows.length <= limit
      return {
        sources: rows.map(toSource),
        complete,
        ...(complete || last === undefined ? {} : { nextCursor: encodeCursor(last.recorded_at, last.source_id) }),
      }
    })
  }

  async reviewSource(
    scopeRef: ScopeRef,
    input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string; readonly expectedRevision: string; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<CandidateSourceRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await this.#lockById(query, input.sourceId)
      const current = locked
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
          RETURNING ${SOURCE_COLUMNS}`,
        [input.sourceId, nextRevision, input.reviewState, nextTier, input.reviewedBy],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new CandidateSourceError('STORE_FAILED', 'the candidate source review was not written')
      return toSource(row)
    })
  }

  async reviewSourceCommand(scopeRef: ScopeRef, command: CandidateSourceReviewCommand, ctx: ToolContext): Promise<CandidateSourceReviewReceipt> {
    const requestDigest = digestOf(command)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#eventByIdempotencyKey(query, command.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== requestDigest) throw new CandidateSourceError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for another review')
        return this.#receiptOf(replay, true)
      }
      const current = await this.#lockById(query, command.sourceId)
      if (current === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${command.sourceId} is not visible in this scope`)
      if (current.workspace_id !== command.workspaceId) throw new CandidateSourceError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
      if (current.revision !== command.expectedRevision) {
        throw new CandidateSourceError('VERSION_CONFLICT', `candidate source head is ${current.revision}, not the expected ${command.expectedRevision}`)
      }
      const nextTier = command.trustTier ?? current.trust_tier
      const nextRevision = (BigInt(current.revision) + 1n).toString()
      const eventId = randomUUID()
      const recordedAt = new Date()
      try {
        await query.query(
          `INSERT INTO agent_platform.candidate_source_review_events
             (tenant_id, space_id, workspace_id, source_id, event_id, previous_state, next_state, previous_trust_tier,
              next_trust_tier, reason, basis_refs, actor, recorded_at, retraction, next_revision, idempotency_key, request_digest)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2::uuid, $3::uuid,
             $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, false, $12::bigint, $13, $14)`,
          [current.workspace_id, command.sourceId, eventId, current.review_state, command.reviewState,
            current.trust_tier, nextTier, command.reason, JSON.stringify(command.basisRefs), command.reviewedBy,
            recordedAt.toISOString(), nextRevision, command.idempotencyKey, requestDigest],
        )
        await query.query(
          `UPDATE agent_platform.candidate_sources
              SET revision = $2::bigint, review_state = $3, trust_tier = $4, reviewed_by = $5, updated_at = now()
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND source_id = $1::uuid`,
          [command.sourceId, nextRevision, command.reviewState, nextTier, command.reviewedBy],
        )
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          const concurrent = await this.#eventByIdempotencyKey(query, command.idempotencyKey)
          if (concurrent !== undefined) {
            if (concurrent.request_digest !== requestDigest) throw new CandidateSourceError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for another review')
            return this.#receiptOf(concurrent, true)
          }
        }
        throw error
      }
      return { sourceId: command.sourceId, revision: nextRevision, reviewState: command.reviewState,
        trustTier: nextTier, eventId, replayed: false }
    })
  }

  async listReviewEvents(scopeRef: ScopeRef, sourceId: Uuid, page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext): Promise<{ readonly events: readonly CandidateSourceReviewEvent[]; readonly nextCursor?: string }> {
    const limit = normalizeLimit(page.limit)
    const afterSeq = decodeSeqCursor(page.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM agent_platform.candidate_source_review_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1::uuid
            AND retraction = false
            AND ($2::bigint IS NULL OR seq > $2::bigint)
          ORDER BY seq ASC
          LIMIT $3`,
        [sourceId, afterSeq ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      return { events: rows.map(toEvent), ...(result.rows.length <= limit || last === undefined ? {} : { nextCursor: encodeSeqCursor(last.seq) }) }
    })
  }

  async retractSource(scopeRef: ScopeRef, input: { readonly workspaceId: Uuid; readonly sourceId: Uuid; readonly expectedRevision: string; readonly reason: string; readonly actor: string; readonly idempotencyKey: string }, ctx: ToolContext): Promise<SourceRetractionReceipt> {
    const requestDigest = digestOf({ workspaceId: input.workspaceId, sourceId: input.sourceId, expectedRevision: input.expectedRevision, reason: input.reason })
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#eventByIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== requestDigest) throw new CandidateSourceError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for another retraction')
        return { sourceId: input.sourceId, workspaceId: input.workspaceId, revision: replay.next_revision, eventId: replay.event_id, replayed: true }
      }
      const current = await this.#lockById(query, input.sourceId)
      if (current === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${input.sourceId} is not visible in this scope`)
      if (current.workspace_id !== input.workspaceId) throw new CandidateSourceError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
      if (current.revision !== input.expectedRevision) {
        throw new CandidateSourceError('VERSION_CONFLICT', `candidate source head is ${current.revision}, not the expected ${input.expectedRevision}`)
      }
      const nextRevision = (BigInt(current.revision) + 1n).toString()
      const eventId = randomUUID()
      const recordedAt = new Date()
      try {
        await query.query(
          `INSERT INTO agent_platform.candidate_source_review_events
             (tenant_id, space_id, workspace_id, source_id, event_id, previous_state, next_state, previous_trust_tier,
              next_trust_tier, reason, basis_refs, actor, recorded_at, retraction, next_revision, idempotency_key, request_digest)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2::uuid, $3::uuid,
             $4, 'rejected', $5, $5, $6, '[]'::jsonb, $7, $8::timestamptz, true, $9::bigint, $10, $11)`,
          [current.workspace_id, input.sourceId, eventId, current.review_state, current.trust_tier,
            input.reason, input.actor, recordedAt.toISOString(), nextRevision, input.idempotencyKey, requestDigest],
        )
        await query.query(
          `UPDATE agent_platform.candidate_sources
              SET revision = $2::bigint, review_state = 'rejected', reviewed_by = $3, retracted_at = $4::timestamptz,
                  retracted_by = $3, updated_at = now()
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND source_id = $1::uuid`,
          [input.sourceId, nextRevision, input.actor, recordedAt.toISOString()],
        )
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          const concurrent = await this.#eventByIdempotencyKey(query, input.idempotencyKey)
          if (concurrent !== undefined) {
            if (concurrent.request_digest !== requestDigest) throw new CandidateSourceError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for another retraction')
            return { sourceId: input.sourceId, workspaceId: input.workspaceId, revision: concurrent.next_revision, eventId: concurrent.event_id, replayed: true }
          }
        }
        throw error
      }
      return { sourceId: input.sourceId, workspaceId: input.workspaceId, revision: nextRevision, eventId, replayed: false }
    })
  }

  async listRetractions(scopeRef: ScopeRef, sourceId: Uuid, page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext): Promise<{ readonly retractions: readonly SourceRetraction[]; readonly nextCursor?: string }> {
    const limit = normalizeLimit(page.limit)
    const afterSeq = decodeSeqCursor(page.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM agent_platform.candidate_source_review_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1::uuid
            AND retraction = true
            AND ($2::bigint IS NULL OR seq > $2::bigint)
          ORDER BY seq ASC
          LIMIT $3`,
        [sourceId, afterSeq ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      return { retractions: rows.map(toRetraction), ...(result.rows.length <= limit || last === undefined ? {} : { nextCursor: encodeSeqCursor(last.seq) }) }
    })
  }

  #receiptOf(row: EventRow, replayed: boolean): CandidateSourceReviewReceipt {
    // A review event always records its resulting tier explicitly; a null here would be a silent
    // promotion, so it is a store failure rather than a default.
    if (row.next_trust_tier === null) throw new CandidateSourceError('STORE_FAILED', 'the stored review event has no recorded trust tier')
    return {
      sourceId: row.source_id,
      revision: row.next_revision,
      reviewState: row.next_state,
      trustTier: row.next_trust_tier,
      eventId: row.event_id,
      replayed,
    }
  }

  async #byId(query: ScopedQuery, sourceId: Uuid): Promise<SourceRow | undefined> {
    const result = await query.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND source_id = $1::uuid`,
      [sourceId],
    )
    return result.rows[0]
  }

  async #lockById(query: ScopedQuery, sourceId: Uuid): Promise<SourceRow | undefined> {
    const result = await query.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND source_id = $1::uuid
        FOR UPDATE`,
      [sourceId],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<SourceRow | undefined> {
    const result = await query.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #eventByIdempotencyKey(query: ScopedQuery, key: string): Promise<EventRow | undefined> {
    const result = await query.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM agent_platform.candidate_source_review_events
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>, client?: PoolClient): Promise<T> {
    if (!isToolContext(ctx)) throw new CandidateSourceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new CandidateSourceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    const scoped = (target: PoolClient): ScopedQuery => ({
      query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        const result = await target.query<Row>(text, values === undefined ? undefined : [...values])
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      },
    })
    if (client !== undefined) return run(scoped(client))
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (connection) => {
      await connection.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
      return run(scoped(connection))
    })
  }
}
