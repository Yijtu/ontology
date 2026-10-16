import type { QueryResultRow } from 'pg'
import {
  ToolConnectionError,
  assertExecutionToolBindingShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ExecutionToolBinding,
  ExecutionToolBindingStore,
  ScopeRef,
  ToolConnectionCapability,
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

interface BindingRow extends QueryResultRow {
  binding: ExecutionToolBinding
}

/**
 * PostgreSQL per-execution tool bindings (design §9). A binding is write-once per
 * (execution, toolId): a retry/resume re-reads the stored row instead of re-resolving, so a later
 * default change cannot retarget an in-flight task. The row carries no credential.
 */
export class PostgresExecutionToolBindingStore implements ExecutionToolBindingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putBinding(scopeRef: ScopeRef, binding: ExecutionToolBinding, ctx: ToolContext): Promise<ExecutionToolBinding> {
    assertExecutionToolBindingShape(binding)
    if (!isUuid(binding.executionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'executionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<BindingRow>(
        `INSERT INTO agent_platform.execution_tool_bindings
           (tenant_id, space_id, execution_id, tool_id, connection_id, connection_revision, assignment_revision,
            resolved_from, binding, bound_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2,
           $3::uuid, $4::bigint, $5::bigint, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (tenant_id, space_id, execution_id, tool_id) DO NOTHING
         RETURNING binding`,
        [
          binding.executionId, binding.toolId, binding.connectionId ?? null,
          binding.connectionRevision ?? null, binding.assignmentRevision, binding.resolvedFrom,
          JSON.stringify(binding), binding.boundAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return row.binding

      const existing = await this.#byKey(query, binding.executionId, binding.toolId)
      if (existing === undefined) throw new ToolConnectionError('STORE_FAILED', 'the execution tool binding could not be written')
      if (JSON.stringify(existing.binding) !== JSON.stringify(binding)) {
        throw new ToolConnectionError('TOOL_BINDING_REVOKED', 'the execution already has a different fixed tool binding')
      }
      return existing.binding
    })
  }

  async getBinding(
    scopeRef: ScopeRef,
    executionId: Uuid,
    toolId: ToolConnectionCapability,
    ctx: ToolContext,
  ): Promise<ExecutionToolBinding | undefined> {
    if (!isUuid(executionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'executionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, executionId, toolId)
      if (row === undefined) return undefined
      assertExecutionToolBindingShape(row.binding)
      return row.binding
    })
  }

  async #byKey(query: ScopedQuery, executionId: string, toolId: ToolConnectionCapability): Promise<BindingRow | undefined> {
    const result = await query.query<BindingRow>(
      `SELECT binding FROM agent_platform.execution_tool_bindings
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND execution_id = $1::uuid AND tool_id = $2`,
      [executionId, toolId],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
