import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { ResearchError, isToolContext } from '@ontology/contracts'
import type {
  ResearchCoverage,
  ResearchExecution,
  ResearchExecutionPage,
  ResearchExecutionStore,
  ResearchLimits,
  ResearchSourceRef,
  ResearchStopReason,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

interface ExecutionRow extends QueryResultRow {
  workspace_id: string
  research_id: string
  job_id: string
  status: ResearchExecution['status']
  stage: ResearchExecution['stage']
  brief_ref: ResourceRef
  policy_ref: VersionRef
  budget_ref: VersionRef
  limits: ResearchLimits
  coverage: ResearchCoverage
  source_count: number
  candidate_count: number
  sources: ResearchSourceRef[]
  stop_reason: ResearchStopReason | null
  continued_from: string | null
  recorded_at: Date
}

const EXECUTION_COLUMNS = `workspace_id, research_id, job_id, status, stage, brief_ref, policy_ref, budget_ref,
  limits, coverage, source_count, candidate_count, sources, stop_reason, continued_from, recorded_at`

const TERMINAL_STATUSES = `('completed', 'cancelled', 'failed')`

function toExecution(row: ExecutionRow): ResearchExecution {
  return {
    schemaVersion: 'research-execution@1',
    researchId: row.research_id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    status: row.status,
    stage: row.stage,
    briefRef: row.brief_ref,
    policyRef: row.policy_ref,
    budgetRef: row.budget_ref,
    limits: row.limits,
    coverage: row.coverage,
    sourceCount: row.source_count,
    candidateCount: row.candidate_count,
    ...(row.sources.length === 0 ? {} : { sources: row.sources }),
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    ...(row.continued_from === null ? {} : { continuedFromResearchId: row.continued_from }),
    recordedAt: row.recorded_at.toISOString(),
  }
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function encodeCursor(recordedAt: Date, researchId: string): string {
  return Buffer.from(`${recordedAt.toISOString()}|${researchId}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): { recordedAt: string; researchId: string } | undefined {
  if (cursor === undefined) return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) throw new ResearchError('INVALID_REQUEST', 'the list cursor is malformed')
  return { recordedAt: decoded.slice(0, separator), researchId: decoded.slice(separator + 1) }
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) throw new ResearchError('INVALID_REQUEST', 'list limit must be a positive integer')
  return Math.min(limit, 200)
}

/**
 * Real PostgreSQL implementation of the research-execution store. Each call runs inside the
 * trusted tenant/space scope, so RLS is a second layer behind the application filter.
 *
 * The run key is `(tenant_id, space_id, research_id)`. `putExecution` is a monotonic upsert: it
 * inserts the queued run and then advances it, but once the run reaches a terminal status it is
 * frozen — a later write returns the stored row instead of resurrecting a cancelled/completed
 * run, so a crashed and restarted attempt can never overwrite a stop verdict.
 */
export class PostgresResearchExecutionStore implements ResearchExecutionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putExecution(scopeRef: ScopeRef, execution: ResearchExecution, ctx: ToolContext): Promise<ResearchExecution> {
    const requestDigest = digestOf({
      workspaceId: execution.workspaceId,
      briefRef: execution.briefRef,
      policyRef: execution.policyRef,
      budgetRef: execution.budgetRef,
      limits: execution.limits,
    })
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ExecutionRow>(
        `INSERT INTO agent_platform.workspace_research_runs
           (tenant_id, space_id, workspace_id, research_id, job_id, status, stage, brief_ref, policy_ref,
            budget_ref, limits, coverage, source_count, candidate_count, sources, stop_reason,
            request_idempotency_key, request_digest, recorded_at, updated_at, continued_from)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $12, $13::jsonb, $14, $2, $15, $16::timestamptz, $16::timestamptz, $17::uuid)
         ON CONFLICT (tenant_id, space_id, research_id) DO UPDATE SET
           status = EXCLUDED.status,
           stage = EXCLUDED.stage,
           coverage = EXCLUDED.coverage,
           source_count = EXCLUDED.source_count,
           candidate_count = EXCLUDED.candidate_count,
           sources = EXCLUDED.sources,
           stop_reason = EXCLUDED.stop_reason,
           updated_at = now()
         WHERE agent_platform.workspace_research_runs.status NOT IN ${TERMINAL_STATUSES}
         RETURNING ${EXECUTION_COLUMNS}`,
        [
          execution.workspaceId, execution.researchId, execution.jobId, execution.status, execution.stage,
          JSON.stringify(execution.briefRef), JSON.stringify(execution.policyRef), JSON.stringify(execution.budgetRef),
          JSON.stringify(execution.limits), JSON.stringify(execution.coverage), execution.sourceCount, execution.candidateCount,
          JSON.stringify(execution.sources ?? []), execution.stopReason ?? null, requestDigest, execution.recordedAt,
          execution.continuedFromResearchId ?? null,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toExecution(row)

      // The upsert was refused because the stored run is already terminal; return it unchanged so
      // a replayed/restarted attempt cannot resurrect or overwrite a stop verdict.
      const existing = await query.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM agent_platform.workspace_research_runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND research_id = $1::uuid`,
        [execution.researchId],
      )
      const stored = existing.rows[0]
      if (stored === undefined) throw new ResearchError('STORE_FAILED', 'the research execution was not written')
      return toExecution(stored)
    })
  }

  async getExecution(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecution | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM agent_platform.workspace_research_runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND research_id = $1::uuid`,
        [researchId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toExecution(row)
    })
  }

  async listExecutions(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext,
  ): Promise<ResearchExecutionPage> {
    const limit = normalizeLimit(page.limit)
    const cursor = decodeCursor(page.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM agent_platform.workspace_research_runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (recorded_at, research_id) > ($2::timestamptz, $3::uuid))
          ORDER BY recorded_at ASC, research_id ASC
          LIMIT $4`,
        [workspaceId, cursor?.recordedAt ?? null, cursor?.researchId ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      const complete = result.rows.length <= limit
      return {
        executions: rows.map(toExecution),
        ...(complete || last === undefined ? {} : { nextCursor: encodeCursor(last.recorded_at, last.research_id) }),
      }
    })
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) throw new ResearchError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new ResearchError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ResearchError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
