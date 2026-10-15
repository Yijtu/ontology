import type { QueryResultRow } from 'pg'
import { isToolContext, isVersionRef } from '@ontology/contracts'
import type {
  ProjectReadinessKind,
  ProjectReadinessState,
  ScopeRef,
  ToolContext,
  Uuid,
  WorkbenchProjectState,
  WorkbenchReadinessSummary,
  WorkbenchSpaceState,
  WorkbenchStateReader,
  WorkbenchWorkspaceState,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'
import { ControlStorageError } from './errors'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface SpaceStateRow extends QueryResultRow {
  workspace_count: number
  project_count: number
  proposed_sources: number
  approved_sources_not_admitted: number
  candidates_pending_review: number
  records_pending_confirmation: number
  blocked_tasks: number
}

interface WorkspaceStateRow extends QueryResultRow {
  workspace_id: string
  head_revision: string
  state: WorkbenchWorkspaceState['state']
  latest_pack_ref: unknown
  source_count: number
  proposed_source_count: number
  approved_source_count: number
  admitted_source_count: number
  candidate_count: number
  candidates_pending_review: number
  publishable_validations: number
}

interface ProjectHeadRow extends QueryResultRow {
  head_revision: string
  industry_pack_ref: unknown
}

interface ReadinessRow extends QueryResultRow {
  kind: ProjectReadinessKind
  state: ProjectReadinessState
  error: { readonly code?: string; readonly retryable?: boolean } | null
}

interface CountRow extends QueryResultRow {
  count: number
}

const TENANT = "current_setting('app.tenant_id')::uuid"
const SPACE = "current_setting('app.space_id')::uuid"

function readinessSummary(row: ReadinessRow): WorkbenchReadinessSummary {
  const errorCode = row.error?.code
  const retryable = row.state === 'revoked' ? false : (row.error?.retryable ?? true)
  return { kind: row.kind, state: row.state, retryable, ...(errorCode === undefined ? {} : { errorCode }) }
}

/**
 * The PostgreSQL read adapter for the deterministic workbench overview (design §2.4/§2.5). It only
 * reads; every aggregate runs inside the trusted scope transaction, so a reader can never see
 * another tenant's or space's counts.
 */
export class PostgresWorkbenchStateReader implements WorkbenchStateReader {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async readSpaceState(scopeRef: ScopeRef, ctx: ToolContext): Promise<WorkbenchSpaceState> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SpaceStateRow>(
        `SELECT
           (SELECT count(*) FROM agent_platform.industry_workspaces WHERE tenant_id = ${TENANT} AND space_id = ${SPACE})::int AS workspace_count,
           (SELECT count(*) FROM agent_platform.projects WHERE tenant_id = ${TENANT} AND space_id = ${SPACE})::int AS project_count,
           (SELECT count(*) FROM agent_platform.candidate_sources
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND review_state = 'proposed' AND retracted_at IS NULL)::int AS proposed_sources,
           (SELECT count(*) FROM agent_platform.candidate_sources cs
              WHERE cs.tenant_id = ${TENANT} AND cs.space_id = ${SPACE} AND cs.review_state = 'approved' AND cs.retracted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM agent_platform.workspace_source_admissions sa
                  WHERE sa.tenant_id = cs.tenant_id AND sa.space_id = cs.space_id AND sa.workspace_id = cs.workspace_id AND sa.source_id = cs.source_id))::int AS approved_sources_not_admitted,
           (SELECT count(*) FROM agent_platform.asset_candidate_versions
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND state IN ('produced', 'pending_review', 'pending_confirmation'))::int AS candidates_pending_review,
           (SELECT count(*) FROM (
              SELECT DISTINCT ON (record_id) status FROM agent_platform.project_record_versions
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE}
              ORDER BY record_id, revision DESC) latest WHERE status = 'pending')::int AS records_pending_confirmation,
           (SELECT count(*) FROM agent_platform.project_readiness pr
              JOIN agent_platform.projects p ON p.tenant_id = pr.tenant_id AND p.space_id = pr.space_id AND p.project_id = pr.project_id
              WHERE pr.tenant_id = ${TENANT} AND pr.space_id = ${SPACE} AND pr.state IN ('failed', 'revoked') AND pr.project_revision = p.head_revision)::int AS blocked_tasks`,
      )
      const row = result.rows[0]
      if (row === undefined) throw new ControlStorageError('READ_FAILED', 'the space summary query returned no row')
      return {
        workspaceCount: row.workspace_count,
        projectCount: row.project_count,
        proposedSources: row.proposed_sources,
        approvedSourcesNotAdmitted: row.approved_sources_not_admitted,
        candidatesPendingReview: row.candidates_pending_review,
        recordsPendingConfirmation: row.records_pending_confirmation,
        blockedTasks: row.blocked_tasks,
      }
    })
  }

  async readWorkspaceState(scopeRef: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<WorkbenchWorkspaceState | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const workspace = await query.query<Pick<WorkspaceStateRow, 'workspace_id' | 'head_revision' | 'state' | 'latest_pack_ref'>>(
        `SELECT workspace_id, head_revision::text AS head_revision, state, latest_pack_ref
           FROM agent_platform.industry_workspaces
           WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid`,
        [workspaceId],
      )
      const head = workspace.rows[0]
      if (head === undefined) return undefined
      const counts = await query.query<Omit<WorkspaceStateRow, 'workspace_id' | 'head_revision' | 'state' | 'latest_pack_ref'>>(
        `SELECT
           (SELECT count(*) FROM agent_platform.candidate_sources
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid AND retracted_at IS NULL)::int AS source_count,
           (SELECT count(*) FROM agent_platform.candidate_sources
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid AND retracted_at IS NULL AND review_state = 'proposed')::int AS proposed_source_count,
           (SELECT count(*) FROM agent_platform.candidate_sources
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid AND retracted_at IS NULL AND review_state = 'approved')::int AS approved_source_count,
           (SELECT count(DISTINCT source_id) FROM agent_platform.workspace_source_admissions
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid)::int AS admitted_source_count,
           (SELECT count(*) FROM agent_platform.asset_candidate_versions
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid)::int AS candidate_count,
           (SELECT count(*) FROM agent_platform.asset_candidate_versions
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid AND state IN ('produced', 'pending_review', 'pending_confirmation'))::int AS candidates_pending_review,
           (SELECT count(*) FROM agent_platform.industry_validation_reports
              WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND workspace_id = $1::uuid AND publishable = true)::int AS publishable_validations`,
        [workspaceId],
      )
      const row = counts.rows[0]
      if (row === undefined) throw new ControlStorageError('READ_FAILED', 'the workspace summary query returned no row')
      const publishedPackRef = isVersionRef(head.latest_pack_ref) ? head.latest_pack_ref : undefined
      return {
        workspaceId: head.workspace_id,
        revision: head.head_revision,
        state: head.state,
        sourceCount: row.source_count,
        proposedSourceCount: row.proposed_source_count,
        approvedSourceCount: row.approved_source_count,
        admittedSourceCount: row.admitted_source_count,
        candidateCount: row.candidate_count,
        candidatesPendingReview: row.candidates_pending_review,
        validationSatisfied: row.publishable_validations > 0,
        ...(publishedPackRef === undefined ? {} : { publishedPackRef }),
      }
    })
  }

  async readProjectState(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<WorkbenchProjectState | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const project = await query.query<ProjectHeadRow>(
        `SELECT p.head_revision::text AS head_revision, pr.body -> 'industryPackRef' AS industry_pack_ref
           FROM agent_platform.projects p
           LEFT JOIN agent_platform.project_revisions pr
             ON pr.tenant_id = p.tenant_id AND pr.space_id = p.space_id AND pr.project_id = p.project_id AND pr.revision = p.head_revision
           WHERE p.tenant_id = ${TENANT} AND p.space_id = ${SPACE} AND p.project_id = $1::uuid`,
        [projectId],
      )
      const head = project.rows[0]
      if (head === undefined) return undefined
      // One connection carries one statement at a time, so these are awaited in order rather than
      // issued concurrently on the same client.
      const readiness = await query.query<ReadinessRow>(
        `SELECT kind, state, error FROM agent_platform.project_readiness
           WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND project_id = $1::uuid AND project_revision = $2::bigint
           ORDER BY kind`,
        [projectId, head.head_revision],
      )
      const records = await query.query<CountRow>(
        `SELECT count(*)::int AS count FROM (
           SELECT DISTINCT ON (record_id) status FROM agent_platform.project_record_versions
           WHERE tenant_id = ${TENANT} AND space_id = ${SPACE} AND project_id = $1::uuid
           ORDER BY record_id, revision DESC) latest WHERE status = 'pending'`,
        [projectId],
      )
      const tasks = await query.query<CountRow>(
        `SELECT count(*)::int AS count FROM agent_platform.published_task_bindings
           WHERE tenant_id = ${TENANT} AND space_id = ${SPACE}`,
      )
      const mountedPackRef = isVersionRef(head.industry_pack_ref) ? head.industry_pack_ref : undefined
      return {
        projectId,
        revision: head.head_revision,
        ...(mountedPackRef === undefined ? {} : { mountedPackRef }),
        recordsPendingConfirmation: records.rows[0]?.count ?? 0,
        readiness: readiness.rows.map(readinessSummary),
        availableTaskCount: tasks.rows[0]?.count ?? 0,
      }
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'the trusted context carries an inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'the requested scope does not match the trusted principal scope')
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
      { readOnly: true },
    )
  }
}
