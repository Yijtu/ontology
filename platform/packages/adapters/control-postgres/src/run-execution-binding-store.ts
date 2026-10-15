import type { QueryResultRow } from 'pg'
import { assertRunExecutionBindingShape, isToolContext } from '@ontology/contracts'
import { ControlStorageError } from './errors'
import type {
  ArchivedRunExecutionBinding,
  ResourceRef,
  RunExecutionBinding,
  RunExecutionBindingStore,
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

interface ExecutionBindingRow extends QueryResultRow {
  binding_id: string
  version: string
  digest: string
  binding: RunExecutionBinding
  same_content?: boolean
}

function toArchived(row: ExecutionBindingRow): ArchivedRunExecutionBinding {
  return {
    ref: { id: row.binding_id, version: row.version, digest: row.digest, kind: 'plan' },
    binding: row.binding,
  }
}

const COLUMNS = 'binding_id, version, digest, binding'

/**
 * Real PostgreSQL implementation of the run execution binding store (SPEC v0.3a §EX-2.1).
 *
 * Exactly one execution binding is archived per run. Archiving is idempotent for the same
 * body; a run that already carries a different binding is refused, so a retry can never
 * re-point a run at a new project revision or input. The binding is a separate append-only row,
 * so later evidence appends never rewrite it.
 */
export class PostgresRunExecutionBindingStore implements RunExecutionBindingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async archiveBinding(
    scopeRef: ScopeRef,
    runId: Uuid,
    ref: ResourceRef,
    binding: RunExecutionBinding,
    ctx: ToolContext,
  ): Promise<void> {
    assertRunExecutionBindingShape(binding)
    if (binding.runId !== runId) {
      throw new ControlStorageError('INVALID_OPERATION', `execution binding runId ${binding.runId} does not match ${runId}`)
    }
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ExecutionBindingRow>(
        `INSERT INTO agent_platform.run_execution_bindings
           (tenant_id, space_id, run_id, binding_id, version, digest, binding, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, run_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [runId, ref.id, ref.version, ref.digest, JSON.stringify(binding), new Date().toISOString()],
      )
      if (inserted.rows[0] !== undefined) return
      // JSONB does not preserve key order, so equality is decided by PostgreSQL, not by a
      // JS stringify that could report a false conflict for byte-identical content.
      const existing = await query.query<ExecutionBindingRow>(
        `SELECT ${COLUMNS}, (binding = $2::jsonb) AS same_content
           FROM agent_platform.run_execution_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND run_id = $1`,
        [runId, JSON.stringify(binding)],
      )
      const row = existing.rows[0]
      if (
        row === undefined ||
        row.binding_id !== ref.id ||
        row.version !== ref.version ||
        row.digest !== ref.digest ||
        row.same_content !== true
      ) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `run ${runId} already has a different execution binding`,
        )
      }
    })
  }

  async getBindingByRun(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<ArchivedRunExecutionBinding | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExecutionBindingRow>(
        `SELECT ${COLUMNS} FROM agent_platform.run_execution_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND run_id = $1`,
        [runId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toArchived(row)
    })
  }

  async getBindingByRef(
    scopeRef: ScopeRef,
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedRunExecutionBinding | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ExecutionBindingRow>(
        `SELECT ${COLUMNS} FROM agent_platform.run_execution_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND binding_id = $1 AND version = $2 AND digest = $3
           ORDER BY recorded_at DESC
           LIMIT 1`,
        [ref.id, ref.version, ref.digest],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toArchived(row)
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
