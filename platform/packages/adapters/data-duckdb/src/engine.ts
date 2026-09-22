import { DuckDBInstance } from '@duckdb/node-api'
import type { DuckDBConnection } from '@duckdb/node-api'
import { DuckDBTypeId } from '@duckdb/node-api'
import type { ScalarValue } from '@ontology/contracts'
import { DuckDbAdapterError } from './errors'

/**
 * Thin, hardened wrapper around the DuckDB Node binding.
 *
 * Hardening (SPEC C3, "同类绕过"):
 *  - `enable_external_access=false` blocks every file/network read and `ATTACH`.
 *  - `autoload_known_extensions`/`autoinstall_known_extensions=false` stop `LOAD`/`INSTALL`
 *    from reaching the network or disk.
 *  - `allow_community_extensions=false`, `allow_unsigned_extensions=false`.
 *  - `lock_configuration=true` so a query cannot re-enable any of the above.
 *  - every user query runs inside `BEGIN TRANSACTION READ ONLY`, so even a query that
 *    slipped past the AST sandbox cannot write.
 *
 * The adapter owns one instance; each execution gets its own connection so cancellation
 * (`interrupt`) targets exactly one query and transactions never interleave.
 */
export interface DuckDbEngineOptions {
  readonly instancePath?: string
  readonly lockConfiguration?: boolean
}

export interface SessionExecution {
  readonly columnNames: readonly string[]
  readonly columnTypeIds: readonly DuckDBTypeId[]
  readonly rawRows: readonly unknown[][]
  readonly jsRows: readonly unknown[][]
  /** True when more rows existed than the requested page. */
  readonly truncated: boolean
  /** Rows the engine actually materialised before the page was cut (page + 1). */
  readonly scannedRows: number
}

export class DuckDbEngine {
  readonly #options: DuckDbEngineOptions
  #instance: DuckDBInstance | undefined
  #trusted: DuckDBConnection | undefined

  constructor(options: DuckDbEngineOptions = {}) {
    this.#options = options
  }

  get started(): boolean {
    return this.#instance !== undefined
  }

  async start(): Promise<void> {
    if (this.#instance !== undefined) return
    const config: Record<string, string> = {
      enable_external_access: 'false',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_community_extensions: 'false',
      allow_unsigned_extensions: 'false',
    }
    if (this.#options.lockConfiguration !== false) {
      config.lock_configuration = 'true'
    }
    if (this.#options.instancePath !== undefined) {
      config.access_mode = 'READ_ONLY'
    }
    try {
      this.#instance = await DuckDBInstance.create(
        this.#options.instancePath ?? ':memory:',
        config,
      )
      this.#trusted = await this.#instance.connect()
    } catch (error) {
      throw new DuckDbAdapterError('SOURCE_UNAVAILABLE', 'the DuckDB engine could not be opened', {
        cause: error,
      })
    }
  }

  async version(): Promise<string> {
    const connection = this.#requireTrusted()
    const reader = await connection.runAndReadAll('SELECT version() AS version')
    const rows = reader.getRows()
    const first = rows[0]
    const value = first === undefined ? undefined : first[0]
    return value === null || value === undefined ? 'unknown' : String(value)
  }

  /** Trusted setup connection: used to materialise an imported snapshot, never for queries. */
  async runTrusted(sql: string, params?: readonly ScalarValue[]): Promise<void> {
    const connection = this.#requireTrusted()
    await connection.run(sql, params === undefined ? undefined : [...params])
  }

  async createSession(): Promise<DuckDbSession> {
    const instance = this.#instance
    if (instance === undefined) {
      throw new DuckDbAdapterError('INTERNAL_ERROR', 'the DuckDB engine is not started')
    }
    const connection = await instance.connect()
    return new DuckDbSession(connection)
  }

  close(): void {
    try {
      this.#trusted?.closeSync()
    } catch {
      // best effort
    }
    this.#trusted = undefined
    try {
      this.#instance?.closeSync()
    } catch {
      // best effort
    }
    this.#instance = undefined
  }

  #requireTrusted(): DuckDBConnection {
    if (this.#trusted === undefined) {
      throw new DuckDbAdapterError('INTERNAL_ERROR', 'the DuckDB engine is not started')
    }
    return this.#trusted
  }
}

export class DuckDbSession {
  readonly #connection: DuckDBConnection
  #closed = false

  constructor(connection: DuckDBConnection) {
    this.#connection = connection
  }

  /**
   * Run one read-only query, reading at most `maxRows + 1` rows so truncation is detected
   * without materialising the full result. The transaction is always closed.
   */
  async executeReadOnly(
    sql: string,
    parameters: readonly ScalarValue[],
    maxRows: number,
  ): Promise<SessionExecution> {
    const connection = this.#connection
    await connection.run('BEGIN TRANSACTION READ ONLY')
    try {
      const reader = await connection.streamAndReadUntil(sql, maxRows + 1, [...parameters])
      const columnNames = reader.columnNames()
      const columnTypeIds = columnNames.map((_, index) => reader.columnTypeId(index))
      const rawRows: unknown[][] = reader.getRows()
      const jsRows: unknown[][] = reader.getRowsJS()
      await connection.run('COMMIT')
      const truncated = rawRows.length > maxRows
      const keep = truncated ? maxRows : rawRows.length
      return {
        columnNames,
        columnTypeIds,
        rawRows: rawRows.slice(0, keep),
        jsRows: jsRows.slice(0, keep),
        truncated,
        scannedRows: rawRows.length,
      }
    } catch (error) {
      try {
        await connection.run('ROLLBACK')
      } catch {
        // the connection may already be aborted; the original error is what matters
      }
      throw error
    }
  }

  /** Interrupt the in-flight query on this connection. Deterministic for an in-process engine. */
  interrupt(): void {
    try {
      this.#connection.interrupt()
    } catch {
      // interrupting an idle connection is a no-op
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#connection.closeSync()
    } catch {
      // best effort
    }
  }
}

export { DuckDBTypeId }
