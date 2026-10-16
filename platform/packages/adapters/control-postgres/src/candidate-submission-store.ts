import type { PoolClient, QueryResultRow } from 'pg'
import { CandidateSubmissionStoreError, isToolContext } from '@ontology/contracts'
import type {
  CandidateSourceLink,
  CandidateSourceSpan,
  CandidateSubmissionKind,
  CandidateSubmissionRecord,
  CandidateSubmissionStore,
  ScopeRef,
  SourceTrustTier,
  SubmitCandidatesReceipt,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

interface ReceiptRow extends QueryResultRow {
  workspace_id: string
  run_id: string
  idempotency_key: string
  command_digest: string
  receipt: SubmitCandidatesReceipt
  created_by: string
  recorded_at: Date
}

interface LinkRow extends QueryResultRow {
  workspace_id: string
  candidate_id: string
  candidate_kind: CandidateSubmissionKind
  submission_index: number
  evidence_index: number
  source_ref: CandidateSourceLink['sourceRef']
  source_span: CandidateSourceSpan | null
  trust_tier: SourceTrustTier
  parser_version: string
  pending_confirmation: boolean
  recorded_at: Date
}

const RECEIPT_COLUMNS = `workspace_id, run_id, idempotency_key, command_digest, receipt, created_by, recorded_at`
const LINK_COLUMNS = `workspace_id, candidate_id, candidate_kind, submission_index, evidence_index, source_ref,
  source_span, trust_tier, parser_version, pending_confirmation, recorded_at`

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function toLink(row: LinkRow): CandidateSourceLink {
  return {
    candidateId: row.candidate_id,
    candidateKind: row.candidate_kind,
    submissionIndex: row.submission_index,
    evidenceIndex: row.evidence_index,
    sourceRef: row.source_ref,
    ...(row.source_span === null ? {} : { sourceSpan: row.source_span }),
    trustTier: row.trust_tier,
    parserVersion: row.parser_version,
    pendingConfirmation: row.pending_confirmation,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toRecord(row: ReceiptRow, links: readonly CandidateSourceLink[]): CandidateSubmissionRecord {
  return {
    schemaVersion: 'candidate-submission-record@1',
    runId: row.run_id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    commandDigest: row.command_digest,
    receipt: row.receipt,
    links: [...links],
    createdBy: row.created_by,
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the candidate-submission store. It persists the idempotent
 * command receipt and the candidate↔source links together; every statement runs behind the
 * trusted-scope RLS predicate, so a receipt or link can never leak across tenant/space.
 */
export class PostgresCandidateSubmissionStore implements CandidateSubmissionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findByKey(
    scopeRef: ScopeRef,
    input: { readonly runId: Uuid; readonly idempotencyKey: string },
    ctx: ToolContext,
    client?: PoolClient,
  ): Promise<CandidateSubmissionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#receiptByKey(query, input.runId, input.idempotencyKey)
      if (row === undefined) return undefined
      const links = await this.#linksForRecord(query, row)
      return toRecord(row, links)
    }, client)
  }

  /**
   * Persist the idempotent receipt and its candidate↔source links. When `client` is supplied the
   * write joins that already-open transaction (the atomic candidate commit), so the receipt and the
   * candidate rows are all-or-nothing; otherwise it opens its own scoped transaction.
   */
  async record(
    scopeRef: ScopeRef,
    input: { readonly record: CandidateSubmissionRecord },
    ctx: ToolContext,
    client?: PoolClient,
  ): Promise<{ readonly record: CandidateSubmissionRecord; readonly replayed: boolean }> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const record = input.record
      let inserted: ReceiptRow | undefined
      try {
        const result = await query.query<ReceiptRow>(
          `INSERT INTO agent_platform.candidate_submission_receipts
             (tenant_id, space_id, workspace_id, run_id, idempotency_key, command_digest, receipt, created_by, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
             $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::timestamptz)
           ON CONFLICT (tenant_id, space_id, run_id, idempotency_key) DO NOTHING
           RETURNING ${RECEIPT_COLUMNS}`,
          [record.workspaceId, record.runId, record.idempotencyKey, record.commandDigest, JSON.stringify(record.receipt), record.createdBy, record.recordedAt],
        )
        inserted = result.rows[0]
      } catch (error) {
        if (pgCodeOf(error) === '23503') {
          throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'the submission workspace is not visible in this scope', { cause: error })
        }
        throw error
      }
      if (inserted === undefined) {
        // A concurrent or earlier write won the key; return the stored receipt instead of a second one.
        const existing = await this.#receiptByKey(query, record.runId, record.idempotencyKey)
        if (existing === undefined) throw new CandidateSubmissionStoreError('STORE_FAILED', 'the idempotent receipt row is missing')
        if (existing.command_digest !== record.commandDigest) {
          throw new CandidateSubmissionStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for a different submission')
        }
        return { record: toRecord(existing, await this.#linksForRecord(query, existing)), replayed: true }
      }
      for (const link of record.links) {
        await query.query(
          `INSERT INTO agent_platform.candidate_source_links
             (tenant_id, space_id, workspace_id, candidate_id, candidate_kind, submission_index, evidence_index,
              source_ref, source_span, trust_tier, parser_version, pending_confirmation, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
             $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::timestamptz)
           ON CONFLICT DO NOTHING`,
          [record.workspaceId, link.candidateId, link.candidateKind, link.submissionIndex, link.evidenceIndex,
            JSON.stringify(link.sourceRef), link.sourceSpan === undefined ? null : JSON.stringify(link.sourceSpan),
            link.trustTier, link.parserVersion, link.pendingConfirmation, link.recordedAt],
        )
      }
      return { record, replayed: false }
    }, client)
  }

  async listLinksForCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSourceLink[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM agent_platform.candidate_source_links
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1::uuid
          ORDER BY evidence_index ASC`,
        [candidateId],
      )
      return result.rows.map(toLink)
    })
  }

  async listUnconfirmedByWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSubmissionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM agent_platform.candidate_submission_receipts r
          WHERE r.tenant_id = current_setting('app.tenant_id')::uuid
            AND r.space_id = current_setting('app.space_id')::uuid
            AND r.workspace_id = $1::uuid
            AND EXISTS (
              SELECT 1 FROM agent_platform.candidate_source_links l
               WHERE l.tenant_id = r.tenant_id AND l.space_id = r.space_id
                 AND l.workspace_id = r.workspace_id AND l.pending_confirmation = true
                 AND l.candidate_id IN (
                   SELECT (entry->>'candidateId')::uuid
                     FROM jsonb_array_elements(r.receipt->'accepted') AS entry
                 )
            )
          ORDER BY r.recorded_at ASC`,
        [workspaceId],
      )
      const out: CandidateSubmissionRecord[] = []
      for (const row of result.rows) out.push(toRecord(row, await this.#linksForRecord(query, row)))
      return out
    })
  }

  async listByRun(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSubmissionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM agent_platform.candidate_submission_receipts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1::uuid
          ORDER BY recorded_at ASC, idempotency_key ASC`,
        [runId],
      )
      const out: CandidateSubmissionRecord[] = []
      for (const row of result.rows) out.push(toRecord(row, await this.#linksForRecord(query, row)))
      return out
    })
  }

  async #receiptByKey(query: ScopedQuery, runId: Uuid, idempotencyKey: string): Promise<ReceiptRow | undefined> {
    const result = await query.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM agent_platform.candidate_submission_receipts
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND run_id = $1::uuid
          AND idempotency_key = $2`,
      [runId, idempotencyKey],
    )
    return result.rows[0]
  }

  async #linksForRecord(query: ScopedQuery, row: ReceiptRow): Promise<CandidateSourceLink[]> {
    const candidateIds = row.receipt.accepted.map((entry) => entry.candidateId)
    if (candidateIds.length === 0) return []
    const result = await query.query<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM agent_platform.candidate_source_links
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND candidate_id = ANY($1::uuid[])`,
      [candidateIds],
    )
    return result.rows.map(toLink)
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
    client?: PoolClient,
  ): Promise<T> {
    if (!isToolContext(ctx)) throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
