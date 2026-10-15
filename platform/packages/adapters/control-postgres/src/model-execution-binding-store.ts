import type { QueryResultRow } from 'pg'
import {
  ModelSelectionError,
  assertExecutionModelBindingShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelCapability,
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

interface BindingRow extends QueryResultRow {
  binding: ExecutionModelBinding
}

/**
 * PostgreSQL per-execution model bindings (design §5.3). A binding is write-once per
 * (execution, capability): a retry/resume re-reads the stored row instead of re-resolving, so a
 * later default change cannot retarget an in-flight task. The row carries no credential.
 */
export class PostgresExecutionModelBindingStore implements ExecutionModelBindingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putBinding(scopeRef: ScopeRef, binding: ExecutionModelBinding, ctx: ToolContext): Promise<ExecutionModelBinding> {
    assertExecutionModelBindingShape(binding)
    if (!isUuid(binding.executionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'executionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<BindingRow>(
        `INSERT INTO agent_platform.execution_model_bindings
           (tenant_id, space_id, execution_id, capability, connection_id, connection_revision, assignment_revision,
            resolved_from, binding, bound_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2,
           $3::uuid, $4::bigint, $5::bigint, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (tenant_id, space_id, execution_id, capability) DO NOTHING
         RETURNING binding`,
        [
          binding.executionId, binding.capability, binding.connectionId ?? null,
          binding.connectionRevision ?? null, binding.assignmentRevision, binding.resolvedFrom,
          JSON.stringify(binding), binding.boundAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return row.binding

      const existing = await this.#byKey(query, binding.executionId, binding.capability)
      if (existing === undefined) throw new ModelSelectionError('STORE_FAILED', 'the execution model binding could not be written')
      if (JSON.stringify(existing.binding) !== JSON.stringify(binding)) {
        throw new ModelSelectionError('MODEL_BINDING_REVOKED', 'the execution already has a different fixed model binding')
      }
      return existing.binding
    })
  }

  async getBinding(
    scopeRef: ScopeRef,
    executionId: Uuid,
    capability: ModelCapability,
    ctx: ToolContext,
  ): Promise<ExecutionModelBinding | undefined> {
    if (!isUuid(executionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'executionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, executionId, capability)
      if (row === undefined) return undefined
      assertExecutionModelBindingShape(row.binding)
      return row.binding
    })
  }

  async #byKey(query: ScopedQuery, executionId: string, capability: ModelCapability): Promise<BindingRow | undefined> {
    const result = await query.query<BindingRow>(
      `SELECT binding FROM agent_platform.execution_model_bindings
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND execution_id = $1::uuid AND capability = $2`,
      [executionId, capability],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
