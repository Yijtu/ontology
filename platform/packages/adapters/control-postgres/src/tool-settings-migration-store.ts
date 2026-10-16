import type { QueryResultRow } from 'pg'
import { ToolConnectionError, isToolContext } from '@ontology/contracts'
import type {
  ScopeRef,
  ToolContext,
  ToolSettingsMigrationRecord,
  ToolSettingsMigrationStore,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

/**
 * PostgreSQL durable idempotency records for the one-time tool-settings bridge (S03, design §10).
 *
 * One row per (tenant, space, migration_key); a record is written once and never overwritten, so a
 * later start cannot re-import the legacy environment after the catalogue was edited. The table
 * carries no secret and every statement runs inside the trusted scope's transaction (RLS is a second
 * layer behind the explicit predicate).
 */
export class PostgresToolSettingsMigrationStore implements ToolSettingsMigrationStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async isApplied(scopeRef: ScopeRef, migrationKey: string, ctx: ToolContext): Promise<boolean> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query(
        `SELECT 1 FROM agent_platform.core_tool_settings_migrations
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND migration_key = $1`,
        [migrationKey],
      )
      return result.rows.length > 0
    })
  }

  async record(scopeRef: ScopeRef, record: ToolSettingsMigrationRecord, ctx: ToolContext): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.core_tool_settings_migrations
           (tenant_id, space_id, migration_key, detail, migrated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (tenant_id, space_id, migration_key) DO NOTHING`,
        [record.migrationKey, JSON.stringify(record.detail), record.migratedAt],
      )
    })
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
