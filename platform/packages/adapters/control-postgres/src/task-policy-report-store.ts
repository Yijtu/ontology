import type { QueryResultRow } from 'pg'
import { assertTaskValidationPolicyReportShape, isToolContext } from '@ontology/contracts'
import { ControlStorageError } from './errors'
import type {
  ArchivedTaskPolicyReport,
  ResourceRef,
  ScopeRef,
  TaskPolicyReportStore,
  TaskValidationPolicyReport,
  ToolContext,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ReportRow extends QueryResultRow {
  report: TaskValidationPolicyReport
  evidence_ref: ResourceRef | null
  same_content?: boolean
}

/**
 * Real PostgreSQL implementation of the immutable task policy report store (SPEC v0.3a
 * §EX-6.1). A report is immutable per exact ref digest: a re-archive of the same bytes is
 * a no-op while a conflicting body under the same ref is refused, so finalization can
 * never read a silently rewritten report. Reads are RLS-scoped.
 */
export class PostgresTaskPolicyReportStore implements TaskPolicyReportStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putReport(
    scopeRef: ScopeRef,
    reportRef: ResourceRef,
    report: TaskValidationPolicyReport,
    ctx: ToolContext,
    evidenceRef?: ResourceRef,
  ): Promise<void> {
    assertTaskValidationPolicyReportShape(report)
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ReportRow>(
        `INSERT INTO agent_platform.task_policy_reports
           (tenant_id, space_id, report_id, version, digest, policy_id, policy_version, policy_digest, stage, status, report, evidence_ref, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, report_id, version, digest) DO NOTHING
         RETURNING report`,
        [
          reportRef.id,
          reportRef.version,
          reportRef.digest,
          report.policyRef.id,
          report.policyRef.version,
          report.policyRef.digest,
          report.stage,
          report.status,
          JSON.stringify(report),
          evidenceRef === undefined ? null : JSON.stringify(evidenceRef),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows[0] !== undefined) return
      const existing = await query.query<ReportRow>(
        `SELECT report, (report = $4::jsonb) AS same_content
           FROM agent_platform.task_policy_reports
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND report_id = $1 AND version = $2 AND digest = $3`,
        [reportRef.id, reportRef.version, reportRef.digest, JSON.stringify(report)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `policy report ${reportRef.id} already exists with different content`,
        )
      }
    })
  }

  async getReport(
    scopeRef: ScopeRef,
    reportRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTaskPolicyReport | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReportRow>(
        `SELECT report, evidence_ref FROM agent_platform.task_policy_reports
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND report_id = $1 AND version = $2 AND digest = $3`,
        [reportRef.id, reportRef.version, reportRef.digest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertTaskValidationPolicyReportShape(row.report)
      return row.evidence_ref === null
        ? { ref: reportRef, report: row.report }
        : { ref: reportRef, report: row.report, evidenceRef: row.evidence_ref }
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
      throw new ControlStorageError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
