import type { QueryResultRow } from 'pg'
import { SyntheticValidationError, assertSyntheticExampleSetVersion, isToolContext } from '@ontology/contracts'
import type {
  IndustryValidationReport,
  IndustryValidationReportStore,
  ScopeRef,
  SyntheticExampleSetStore,
  SyntheticExampleSetVersion,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ExampleSetRow extends QueryResultRow {
  content_digest: string
  idempotency_key: string
  body: SyntheticExampleSetVersion
}

interface ValidationReportRow extends QueryResultRow {
  content_digest: string
  idempotency_key: string
  report: IndustryValidationReport
}

const SET_COLUMNS = `content_digest, idempotency_key, body`
const REPORT_COLUMNS = `content_digest, idempotency_key, report`

function toSet(row: ExampleSetRow): SyntheticExampleSetVersion {
  assertSyntheticExampleSetVersion(row.body)
  return row.body
}

function toReport(row: ValidationReportRow): IndustryValidationReport {
  return row.report
}

/**
 * Real PostgreSQL implementation of the synthetic sandbox and validation report stores
 * (SPEC v0.3a §3.4/§4.1, migration 065).
 *
 * Every statement runs in one transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so RLS applies as a second layer behind the explicit scope predicate. The
 * synthetic markers are re-validated before a write, so a malformed or mis-labelled sample is
 * rejected before any SQL runs. `insert` is idempotent on the key: a replay returns the stored
 * row, and a key reused with different content is an `IDEMPOTENCY_CONFLICT`.
 */
export class PostgresSyntheticExampleSetStore implements SyntheticExampleSetStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insert(
    scopeRef: ScopeRef,
    set: SyntheticExampleSetVersion,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion> {
    assertSyntheticExampleSetVersion(set)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ExampleSetRow>(
        `INSERT INTO agent_platform.synthetic_example_sets
           (tenant_id, space_id, example_set_id, workspace_id, source_kind, data_mode, isolation_label,
            case_kinds, body, content_digest, idempotency_key, actor, trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10,
           current_setting('app.trace_id', true), $11::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${SET_COLUMNS}`,
        [
          set.exampleSetId,
          set.workspaceId,
          set.sourceKind,
          set.dataMode,
          set.isolationLabel,
          JSON.stringify(set.caseKinds),
          JSON.stringify(set),
          set.contentDigest,
          set.idempotencyKey,
          set.actor,
          set.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toSet(row)
      const existing = await this.#byIdempotencyKey(query, set.idempotencyKey)
      if (existing === undefined) {
        throw new SyntheticValidationError('STORE_FAILED', 'the idempotent example set row is missing')
      }
      if (existing.content_digest !== set.contentDigest) {
        throw new SyntheticValidationError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different synthetic example set',
        )
      }
      return toSet(existing)
    })
  }

  async get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    exampleSetId: Uuid,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExampleSetRow>(
        `SELECT ${SET_COLUMNS} FROM agent_platform.synthetic_example_sets
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid AND example_set_id = $2::uuid`,
        [workspaceId, exampleSetId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toSet(row)
    })
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byIdempotencyKey(query, key)
      return row === undefined ? undefined : toSet(row)
    })
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExampleSetRow>(
        `SELECT ${SET_COLUMNS} FROM agent_platform.synthetic_example_sets
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
          ORDER BY recorded_at ASC, example_set_id ASC
          LIMIT $2`,
        [workspaceId, limit],
      )
      return result.rows.map(toSet)
    })
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<ExampleSetRow | undefined> {
    const result = await query.query<ExampleSetRow>(
      `SELECT ${SET_COLUMNS} FROM agent_platform.synthetic_example_sets
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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

/** Real PostgreSQL implementation of the validation report store (migration 065). */
export class PostgresIndustryValidationReportStore implements IndustryValidationReportStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insert(
    scopeRef: ScopeRef,
    report: IndustryValidationReport,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport> {
    if (report.dataMode !== 'synthetic' || report.isolationLabel !== 'synthetic test') {
      throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'a validation report must stay synthetic')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ValidationReportRow>(
        `INSERT INTO agent_platform.industry_validation_reports
           (tenant_id, space_id, validation_id, workspace_id, example_set_id, revision, data_mode,
            isolation_label, semantic_published, deployment_executable, publishable, report,
            content_digest, idempotency_key, actor, trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
           current_setting('app.trace_id', true), $14::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${REPORT_COLUMNS}`,
        [
          report.validationId,
          report.workspaceId,
          report.exampleSetId,
          report.revision,
          report.dataMode,
          report.isolationLabel,
          report.semanticPublished.passed,
          report.deploymentExecutable.passed,
          report.publishable,
          JSON.stringify(report),
          report.contentDigest,
          report.idempotencyKey,
          report.actor,
          report.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toReport(row)
      const existing = await this.#byIdempotencyKey(query, report.idempotencyKey)
      if (existing === undefined) {
        throw new SyntheticValidationError('STORE_FAILED', 'the idempotent validation report row is missing')
      }
      if (existing.content_digest !== report.contentDigest) {
        throw new SyntheticValidationError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different validation report',
        )
      }
      return toReport(existing)
    })
  }

  async get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    validationId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ValidationReportRow>(
        `SELECT ${REPORT_COLUMNS} FROM agent_platform.industry_validation_reports
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid AND validation_id = $2::uuid`,
        [workspaceId, validationId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toReport(row)
    })
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byIdempotencyKey(query, key)
      return row === undefined ? undefined : toReport(row)
    })
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ValidationReportRow>(
        `SELECT ${REPORT_COLUMNS} FROM agent_platform.industry_validation_reports
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
          ORDER BY recorded_at ASC, validation_id ASC
          LIMIT $2`,
        [workspaceId, limit],
      )
      return result.rows.map(toReport)
    })
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<ValidationReportRow | undefined> {
    const result = await query.query<ValidationReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM agent_platform.industry_validation_reports
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new SyntheticValidationError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
