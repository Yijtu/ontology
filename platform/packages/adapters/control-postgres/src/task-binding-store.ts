import type { QueryResultRow } from 'pg'
import { assertPublishedTaskBindingShape, isToolContext } from '@ontology/contracts'
import { ControlStorageError } from './errors'
import type {
  PublishedTaskBinding,
  ScopeRef,
  TaskBindingStore,
  TaskKind,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface BindingRow extends QueryResultRow {
  binding: PublishedTaskBinding
  same_content?: boolean
}

/**
 * Real PostgreSQL implementation of the published task binding store (SPEC v0.3a §EX-2.1).
 *
 * A binding is immutable per exact `(id, version, digest)`. Re-publishing the same envelope is
 * a no-op; a conflicting body under the same id/version is refused, so a run that pinned a ref
 * can never silently read a different declaration. Reads are scoped by RLS and never fall back
 * to a newer version.
 */
export class PostgresPublishedTaskBindingStore implements TaskBindingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putBinding(
    scopeRef: ScopeRef,
    binding: PublishedTaskBinding,
    ctx: ToolContext,
  ): Promise<void> {
    assertPublishedTaskBindingShape(binding)
    const ref = binding.taskBindingRef
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<BindingRow>(
        `INSERT INTO agent_platform.published_task_bindings
           (tenant_id, space_id, task_binding_id, version, digest, binding, registered_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, task_binding_id, version, digest) DO NOTHING
         RETURNING binding`,
        [ref.id, ref.version, ref.digest, JSON.stringify(binding), new Date().toISOString()],
      )
      if (inserted.rows[0] !== undefined) return
      // JSONB does not preserve key order; equality is decided by PostgreSQL so a byte-identical
      // re-publish is a no-op while a genuinely different body is refused.
      const existing = await query.query<BindingRow>(
        `SELECT binding, (binding = $4::jsonb) AS same_content
           FROM agent_platform.published_task_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND task_binding_id = $1 AND version = $2 AND digest = $3`,
        [ref.id, ref.version, ref.digest, JSON.stringify(binding)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `task binding ${ref.id}@${ref.version} already exists with different content`,
        )
      }
    })
  }

  async getBinding(
    scopeRef: ScopeRef,
    taskBindingRef: VersionRef,
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<BindingRow>(
        `SELECT binding FROM agent_platform.published_task_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND task_binding_id = $1 AND version = $2 AND digest = $3`,
        [taskBindingRef.id, taskBindingRef.version, taskBindingRef.digest],
      )
      return result.rows[0]?.binding
    })
  }

  async listBindings(
    scopeRef: ScopeRef,
    filter: { readonly definitionRef?: VersionRef; readonly kind?: TaskKind },
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const values: unknown[] = []
      const conditions = [
        "tenant_id = current_setting('app.tenant_id')::uuid",
        "space_id = current_setting('app.space_id')::uuid",
      ]
      if (filter.definitionRef !== undefined) {
        values.push(filter.definitionRef.id)
        conditions.push(`binding->'actionDefinitionRef'->>'id' = $${values.length}`)
        values.push(filter.definitionRef.version)
        conditions.push(`binding->'actionDefinitionRef'->>'version' = $${values.length}`)
      }
      if (filter.kind !== undefined) {
        values.push(filter.kind)
        conditions.push(`binding->>'kind' = $${values.length}`)
      }
      const result = await query.query<BindingRow>(
        `SELECT binding FROM agent_platform.published_task_bindings
           WHERE ${conditions.join(' AND ')}
           ORDER BY task_binding_id, version, digest`,
        values,
      )
      return result.rows.map((row) => row.binding)
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

