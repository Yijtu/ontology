import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import { PostgresQueryError } from './errors'

export interface BusinessPostgresConfig {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly applicationName?: string
  readonly connectionTimeoutMs?: number
}

/** One read-only repeatable-read transaction, with the exact observed state. */
export interface ReadOnlySession {
  readonly client: PoolClient
  /** `transaction_timestamp()`, stable for the whole transaction. */
  readonly readAt: string
  readonly backendPid: number
}

/**
 * Owns the business-database pool.
 *
 * The connection is an independent, read-only role: it is deliberately separate from
 * the control-database Repository and from `ontology_app`. The adapter never issues
 * DDL/DML and every data query runs inside `BEGIN ... READ ONLY`, so a write is refused
 * at the database level even if the AST layer were bypassed.
 */
export class BusinessPostgresDatabase {
  readonly #pool: Pool

  constructor(config: BusinessPostgresConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-data-postgres',
      ...(config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMillis: config.connectionTimeoutMs }),
    })
  }

  /**
   * Run `operation` in one repeatable-read, read-only transaction.
   *
   * `repeatable_read` is only consistent inside this transaction (C3.1): the session
   * exposes the transaction timestamp, never a snapshot id that could be mistaken for a
   * permanently re-readable version.
   */
  async withReadOnlySnapshot<T>(options: {
    readonly statementTimeoutMs: number
    readonly operation: (session: ReadOnlySession) => Promise<T>
  }): Promise<T> {
    const client = await this.#pool.connect()
    const timeoutMs = Math.max(1, Math.trunc(options.statementTimeoutMs))
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)])
      const meta = await client.query<{ read_at: Date; backend_pid: number }>(
        'SELECT transaction_timestamp() AS read_at, pg_backend_pid() AS backend_pid',
      )
      const row = meta.rows[0]
      if (row === undefined) {
        throw new PostgresQueryError('INTERNAL_ERROR', 'could not read the transaction snapshot timestamp')
      }
      const result = await options.operation({
        client,
        readAt: row.read_at.toISOString(),
        backendPid: row.backend_pid,
      })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** A plain bounded read against the read-only role (used for catalog discovery). */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.#pool.query<T>(text, values === undefined ? undefined : [...values])
    return result.rows
  }

  /**
   * Best-effort backend cancellation. A role may always cancel its own backend, so the
   * read-only role can stop the query it started. A `false` return means the backend was
   * already gone (the query finished), not that cancellation was denied.
   */
  async cancelBackend(backendPid: number): Promise<boolean> {
    const result = await this.#pool.query<{ cancelled: boolean }>(
      'SELECT pg_cancel_backend($1) AS cancelled',
      [backendPid],
    )
    return result.rows[0]?.cancelled === true
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
