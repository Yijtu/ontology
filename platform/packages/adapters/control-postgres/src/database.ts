import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'

export interface ControlPostgresConfig {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly applicationName?: string
  readonly statementTimeoutMs?: number
  readonly connectionTimeoutMs?: number
}

export interface ControlScope {
  readonly tenantId: string
  readonly spaceId: string
}

export interface ControlQueryResult<T> {
  readonly rows: T[]
  readonly rowCount: number
}

/**
 * Owns the control-database pool. Construction does not touch the schema: the
 * database is initialised and evolved only by the explicit migration step in
 * `migrations.ts`, never by service startup (SPEC D8).
 */
export class ControlPostgresDatabase {
  readonly #pool: Pool

  constructor(config: ControlPostgresConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-control-postgres',
      ...(config.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: config.statementTimeoutMs }),
      ...(config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMillis: config.connectionTimeoutMs }),
    })
  }

  /**
   * Run a statement with no identity scope. RLS denies every tenant row, so this
   * is only safe for health checks and administrative diagnostics, never for
   * tenant data.
   */
  async queryUnscoped<T extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<ControlQueryResult<T>> {
    const result = await this.#pool.query<T>(text, values)
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  /**
   * Run `operation` in one transaction whose trusted scope is set with
   * `SET LOCAL` semantics, then always clear the session scope before the
   * connection returns to the pool. A later request can therefore never inherit
   * the previous request's tenant/space.
   */
  async withIdentityScope<T>(
    scope: ControlScope,
    operation: (client: PoolClient) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query(options?.readOnly === true ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
        [scope.tenantId, scope.spaceId],
      )
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // keep the original failure; a broken connection is discarded below
      }
      throw error
    } finally {
      let reset = true
      try {
        await client.query(
          "SELECT set_config('app.tenant_id', '', false), set_config('app.space_id', '', false)",
        )
      } catch {
        reset = false
      }
      client.release(!reset)
    }
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
