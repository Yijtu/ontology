import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { ResearchError, assertResearchExecutionV2Shape, isRecord, isToolContext } from '@ontology/contracts'
import type {
  ResearchCoverage,
  ResearchExecution,
  ResearchExecutionAny,
  ResearchExecutionPage,
  ResearchExecutionStore,
  ResearchExecutionV2,
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
  schema_version: string
  run_id: string | null
  goal: unknown
  authorization_receipt_ref: unknown
  projection: unknown
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

const EXECUTION_COLUMNS = `workspace_id, research_id, job_id, schema_version, run_id, goal,
  authorization_receipt_ref, projection, status, stage, brief_ref, policy_ref, budget_ref,
  limits, coverage, source_count, candidate_count, sources, stop_reason, continued_from, recorded_at`

const TERMINAL_STATUSES = `('completed', 'cancelled', 'failed')`

/** The `@2`-only projection groups; the common columns stay the single durable source for the rest. */
interface ProjectionPayload {
  readonly budget: ResearchExecutionV2['budget']
  readonly coverageGaps: ResearchExecutionV2['coverageGaps']
  readonly humanTodos: ResearchExecutionV2['humanTodos']
  readonly evidence: ResearchExecutionV2['evidence']
  readonly candidateReceipts: ResearchExecutionV2['candidateReceipts']
  readonly usage: ResearchExecutionV2['usage']
}

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

/**
 * Reconstruct a `@2` run projection from its columns plus the versioned `projection` payload and
 * validate it, so a foreign writer's row is read back as a checked projection rather than trusted
 * as bare JSON. The common fields stay in their columns; only the agentic groups live in the
 * payload, so there is never a second copy of one truth.
 */
function toExecutionV2(row: ExecutionRow): ResearchExecutionV2 {
  if (row.run_id === null) throw new ResearchError('STORE_FAILED', 'a @2 research projection is missing its run link')
  if (!isRecord(row.projection)) throw new ResearchError('STORE_FAILED', 'a @2 research projection is missing its payload')
  const projection = row.projection
  const value: unknown = {
    schemaVersion: 'research-execution@2',
    researchId: row.research_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    jobId: row.job_id,
    goal: row.goal,
    status: row.status,
    stage: row.stage,
    briefRef: row.brief_ref,
    policyRef: row.policy_ref,
    budgetRef: row.budget_ref,
    budget: projection['budget'],
    limits: row.limits,
    coverage: row.coverage,
    coverageGaps: projection['coverageGaps'],
    humanTodos: projection['humanTodos'],
    evidence: projection['evidence'],
    candidateReceipts: projection['candidateReceipts'],
    sourceCount: row.source_count,
    candidateCount: row.candidate_count,
    usage: projection['usage'],
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    ...(row.sources.length === 0 ? {} : { sources: row.sources }),
    ...(row.continued_from === null ? {} : { continuedFromResearchId: row.continued_from }),
    recordedAt: row.recorded_at.toISOString(),
  }
  assertResearchExecutionV2Shape(value)
  return value
}

function toExecutionAny(row: ExecutionRow): ResearchExecutionAny {
  return row.schema_version === 'research-execution@2' ? toExecutionV2(row) : toExecution(row)
}

function projectionPayloadOf(execution: ResearchExecutionV2): ProjectionPayload {
  return {
    budget: execution.budget,
    coverageGaps: execution.coverageGaps,
    humanTodos: execution.humanTodos,
    evidence: execution.evidence,
    candidateReceipts: execution.candidateReceipts,
    usage: execution.usage,
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
 *
 * Both projection versions are stored in one table: a legacy `@1` record keeps its columns and no
 * projection payload, and an agentic `@2` run keeps its run link plus a versioned `projection`
 * jsonb. Reads reconstruct and validate either version; a legacy `@1` record is never rewritten into
 * `@2`.
 */
export class PostgresResearchExecutionStore implements ResearchExecutionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putExecution(scopeRef: ScopeRef, execution: ResearchExecutionAny, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const requestDigest = digestOf({
      workspaceId: execution.workspaceId,
      briefRef: execution.briefRef,
      policyRef: execution.policyRef,
      budgetRef: execution.budgetRef,
      limits: execution.limits,
    })
    const v2 = execution.schemaVersion === 'research-execution@2' ? execution : undefined
    const runId = v2?.runId ?? null
    const goal = v2?.goal ?? null
    const projection = v2 === undefined ? null : projectionPayloadOf(v2)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ExecutionRow>(
        `INSERT INTO agent_platform.workspace_research_runs
           (tenant_id, space_id, workspace_id, research_id, job_id, schema_version, run_id, goal,
            authorization_receipt_ref, projection, projection_revision, status, stage, brief_ref,
            policy_ref, budget_ref, limits, coverage, source_count, candidate_count, sources,
            stop_reason, request_idempotency_key, request_digest, recorded_at, updated_at, continued_from)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::jsonb, $7::jsonb, $8::jsonb, 0,
           $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18::jsonb,
           $19, $2, $20, $21::timestamptz, $21::timestamptz, $22::uuid)
         ON CONFLICT (tenant_id, space_id, research_id) DO UPDATE SET
           status = EXCLUDED.status,
           stage = EXCLUDED.stage,
           coverage = EXCLUDED.coverage,
           source_count = EXCLUDED.source_count,
           candidate_count = EXCLUDED.candidate_count,
           sources = EXCLUDED.sources,
           stop_reason = EXCLUDED.stop_reason,
           projection = EXCLUDED.projection,
           projection_revision = agent_platform.workspace_research_runs.projection_revision
             + CASE WHEN EXCLUDED.projection IS NULL THEN 0 ELSE 1 END,
           updated_at = now()
         WHERE agent_platform.workspace_research_runs.status NOT IN ${TERMINAL_STATUSES}
         RETURNING ${EXECUTION_COLUMNS}`,
        [
          execution.workspaceId, execution.researchId, execution.jobId, execution.schemaVersion, runId,
          goal === null ? null : JSON.stringify(goal), null, projection === null ? null : JSON.stringify(projection),
          execution.status, execution.stage,
          JSON.stringify(execution.briefRef), JSON.stringify(execution.policyRef), JSON.stringify(execution.budgetRef),
          JSON.stringify(execution.limits), JSON.stringify(execution.coverage), execution.sourceCount, execution.candidateCount,
          JSON.stringify(execution.sources ?? []), execution.stopReason ?? null, requestDigest, execution.recordedAt,
          execution.continuedFromResearchId ?? null,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toExecutionAny(row)

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
      return toExecutionAny(stored)
    })
  }

  async getExecution(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExecutionRow>(
        `SELECT ${EXECUTION_COLUMNS} FROM agent_platform.workspace_research_runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND research_id = $1::uuid`,
        [researchId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toExecutionAny(row)
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
        executions: rows.map(toExecutionAny),
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
