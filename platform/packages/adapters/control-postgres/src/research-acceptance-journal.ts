import type { QueryResultRow } from 'pg'
import {
  ResearchAcceptanceJournalError,
  assertResearchAcceptanceRecordShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ResearchAcceptanceJournal,
  ResearchAcceptanceRecord,
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

interface JournalRow extends QueryResultRow {
  research_id: string
  run_id: string | null
  engine: string
  request_digest: string
  idempotency_key: string
  accepted_at: Date | string
}

const COLUMNS = 'research_id, run_id, engine, request_digest, idempotency_key, accepted_at'

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new ResearchAcceptanceJournalError('STORE_FAILED', 'a stored research acceptance timestamp is invalid')
  }
  return parsed.toISOString()
}

function toRecord(row: JournalRow): ResearchAcceptanceRecord {
  const value: unknown = {
    researchId: row.research_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    engine: row.engine,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    acceptedAt: iso(row.accepted_at),
  }
  assertResearchAcceptanceRecordShape(value)
  return value
}

/**
 * Real PostgreSQL implementation of the research acceptance journal (design §10, S10/S11).
 *
 * `record` is a write-once claim on `(tenant, space, research_id)`: the first caller inserts, a later
 * caller with the same digest reads the stored row back, and a differing digest is
 * `IDEMPOTENCY_CONFLICT` — never an overwrite and never a second engine. Every statement runs inside
 * the trusted tenant/space scope, so RLS applies on top of the application filter.
 */
export class PostgresResearchAcceptanceJournal implements ResearchAcceptanceJournal {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async record(
    scopeRef: ScopeRef,
    record: ResearchAcceptanceRecord,
    ctx: ToolContext,
  ): Promise<{ readonly record: ResearchAcceptanceRecord; readonly created: boolean }> {
    assertResearchAcceptanceRecordShape(record)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<JournalRow>(
        `INSERT INTO agent_platform.research_acceptance_journal
           (tenant_id, space_id, research_id, run_id, engine, request_digest, idempotency_key, accepted_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (tenant_id, space_id, research_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          record.researchId,
          record.runId ?? null,
          record.engine,
          record.requestDigest,
          record.idempotencyKey,
          record.acceptedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { record: toRecord(row), created: true }

      // The research id is already accepted: the winner's row is the truth, and a different request
      // digest under the same id is a conflict, never a second acceptance.
      const existing = await this.#byResearchId(query, record.researchId)
      if (existing === undefined) {
        throw new ResearchAcceptanceJournalError('STORE_FAILED', 'the acceptance claim references a missing row')
      }
      if (existing.requestDigest !== record.requestDigest || existing.engine !== record.engine) {
        throw new ResearchAcceptanceJournalError(
          'IDEMPOTENCY_CONFLICT',
          'the research request was already accepted by a different engine or with a different digest',
        )
      }
      return { record: existing, created: false }
    })
  }

  async get(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchAcceptanceRecord | undefined> {
    if (!isUuid(researchId)) throw new ResearchAcceptanceJournalError('STORE_FAILED', 'researchId must be a uuid')
    return this.#withScope(scopeRef, ctx, (query) => this.#byResearchId(query, researchId))
  }

  async findByIdempotencyKey(scopeRef: ScopeRef, idempotencyKey: string, ctx: ToolContext): Promise<ResearchAcceptanceRecord | undefined> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ResearchAcceptanceJournalError('STORE_FAILED', 'an idempotency key is required')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<JournalRow>(
        `SELECT ${COLUMNS} FROM agent_platform.research_acceptance_journal
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRecord(row)
    })
  }

  async #byResearchId(query: ScopedQuery, researchId: Uuid): Promise<ResearchAcceptanceRecord | undefined> {
    const result = await query.query<JournalRow>(
      `SELECT ${COLUMNS} FROM agent_platform.research_acceptance_journal
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND research_id = $1::uuid`,
      [researchId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : toRecord(row)
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ResearchAcceptanceJournalError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ResearchAcceptanceJournalError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, (client) =>
      run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }))
  }
}
