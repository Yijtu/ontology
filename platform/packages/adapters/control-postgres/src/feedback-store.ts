import { FeedbackStoreError, isToolContext } from '@ontology/contracts'
import type {
  FeedbackAppendResult,
  FeedbackKind,
  FeedbackRecord,
  FeedbackStore,
  NewFeedbackRecord,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface FeedbackRow extends QueryResultRow {
  feedback_id: string
  run_id: string
  answer_id: string | null
  kind: FeedbackKind
  rating: number | null
  comment: string | null
  submitted_by: string
  sequence: string
  idempotency_key: string
  request_digest: string
  occurred_at: Date
  recorded_at: Date
}

const FEEDBACK_COLUMNS = `feedback_id, run_id, answer_id, kind, rating, comment, submitted_by,
  sequence, idempotency_key, request_digest, occurred_at, recorded_at`

function toFeedbackRecord(row: FeedbackRow): FeedbackRecord {
  return {
    feedbackId: row.feedback_id,
    runId: row.run_id,
    ...(row.answer_id === null ? {} : { answerId: row.answer_id }),
    kind: row.kind,
    ...(row.rating === null ? {} : { rating: row.rating }),
    ...(row.comment === null ? {} : { comment: row.comment }),
    submittedBy: row.submitted_by,
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL feedback store (SPEC D2/D7.4, INV-09; US-022, FR-30).
 *
 * Feedback is append-only: the table has an immutable-history trigger that rejects UPDATE and
 * DELETE, and this adapter exposes no mutation beyond `append`. Every statement runs as the
 * non-owner `ontology_app` role inside a transaction whose trusted scope is set with
 * `SET LOCAL` semantics, so row-level security applies to the whole call and a later request can
 * never inherit the previous tenant/space. A lookup in another tenant/space returns nothing.
 *
 * `append` is idempotent per `(tenant, space, idempotency_key)`: the `ON CONFLICT DO NOTHING`
 * insert plus a digest comparison means a retry of the same payload returns the stored entry
 * while a different payload is an explicit `IDEMPOTENCY_CONFLICT`, never an overwrite.
 */
export class PostgresFeedbackStore implements FeedbackStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<FeedbackRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<FeedbackRow>(
        `SELECT ${FEEDBACK_COLUMNS}
           FROM agent_platform.feedback_entries
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toFeedbackRecord(row)
    })
  }

  async append(
    scopeRef: ScopeRef,
    record: NewFeedbackRecord,
    ctx: ToolContext,
  ): Promise<FeedbackAppendResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<FeedbackRow>(
        `INSERT INTO agent_platform.feedback_entries
           (tenant_id, space_id, feedback_id, run_id, answer_id, kind, rating, comment,
            submitted_by, sequence, idempotency_key, request_digest, occurred_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz
         )
         ON CONFLICT DO NOTHING
         RETURNING ${FEEDBACK_COLUMNS}`,
        [
          record.feedbackId,
          record.runId,
          record.answerId ?? null,
          record.kind,
          record.rating ?? null,
          record.comment ?? null,
          record.submittedBy,
          record.sequence,
          record.idempotencyKey,
          record.requestDigest,
          record.occurredAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { feedback: toFeedbackRecord(row), inserted: true }

      const existing = await query.query<FeedbackRow>(
        `SELECT ${FEEDBACK_COLUMNS}
           FROM agent_platform.feedback_entries
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [record.idempotencyKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) {
        throw new FeedbackStoreError(
          'FEEDBACK_PERSIST_FAILED',
          `feedback ${record.feedbackId} could not be stored`,
        )
      }
      if (existingRow.request_digest !== record.requestDigest) {
        throw new FeedbackStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different feedback payload',
        )
      }
      return { feedback: toFeedbackRecord(existingRow), inserted: false }
    })
  }

  async listByRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<FeedbackRecord[]> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<FeedbackRow>(
          `SELECT ${FEEDBACK_COLUMNS}
             FROM agent_platform.feedback_entries
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1
            ORDER BY sequence ASC, recorded_at ASC`,
          [runId],
        )
        return result.rows.map((row) => toFeedbackRecord(row))
      },
      { readOnly: true },
    )
  }

  async listByAnswer(
    scopeRef: ScopeRef,
    runId: Uuid,
    answerId: Uuid,
    ctx: ToolContext,
  ): Promise<FeedbackRecord[]> {
    return this.#withScope(
      scopeRef,
      ctx,
      async (query) => {
        const result = await query.query<FeedbackRow>(
          `SELECT ${FEEDBACK_COLUMNS}
             FROM agent_platform.feedback_entries
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1
              AND answer_id = $2
            ORDER BY sequence ASC, recorded_at ASC`,
          [runId, answerId],
        )
        return result.rows.map((row) => toFeedbackRecord(row))
      },
      { readOnly: true },
    )
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new FeedbackStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new FeedbackStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
    }
    return this.#database.withIdentityScope(
      { tenantId, spaceId },
      async (client) =>
        run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        }),
      options,
    )
  }
}
