import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'

/**
 * Forward-only, versioned migration runner (SPEC D8). This module deliberately
 * has no relative imports so it can also be executed directly by Node's type
 * stripping through `scripts/migrate.mjs`. It is the explicit migration step and
 * is never called from service construction or startup.
 */
export type ControlMigrationErrorCode =
  | 'MIGRATION_INVALID_FILENAME'
  | 'MIGRATION_VERSION_DUPLICATE'
  | 'MIGRATION_CHECKSUM_MISMATCH'

export class ControlMigrationError extends Error {
  readonly code: ControlMigrationErrorCode

  constructor(code: ControlMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ControlMigrationError'
    this.code = code
  }
}

export interface ControlMigration {
  readonly version: string
  readonly name: string
  readonly filename: string
  readonly sql: string
  readonly checksum: string
}

export interface MigrationReport {
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
}

export interface MigrationOptions {
  readonly connectionString: string
  readonly migrationsDir: string
  readonly advisoryLockKey?: number
}

const MIGRATION_FILENAME = /^(\d{3,})_([a-z0-9_]+)\.sql$/
const LEDGER_TABLE = 'agent_platform.control_schema_migrations'
const DEFAULT_ADVISORY_LOCK_KEY = 404004

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export async function loadControlMigrations(migrationsDir: string): Promise<ControlMigration[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true })
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()

  const migrations: ControlMigration[] = []
  const versions = new Set<string>()

  for (const filename of filenames) {
    const match = MIGRATION_FILENAME.exec(filename)
    const version = match?.[1]
    const name = match?.[2]
    if (version === undefined || name === undefined) {
      throw new ControlMigrationError(
        'MIGRATION_INVALID_FILENAME',
        `migration filename must match NNN_snake_case.sql, received ${filename}`,
      )
    }
    if (versions.has(version)) {
      throw new ControlMigrationError(
        'MIGRATION_VERSION_DUPLICATE',
        `two migrations declare version ${version}`,
      )
    }
    versions.add(version)
    const sql = await readFile(join(migrationsDir, filename), 'utf8')
    migrations.push({ version, name, filename, sql, checksum: checksumOf(sql) })
  }

  migrations.sort((left, right) => Number(left.version) - Number(right.version))
  return migrations
}

export async function runControlMigrations(options: MigrationOptions): Promise<MigrationReport> {
  const migrations = await loadControlMigrations(options.migrationsDir)
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY
  const client = new Client({
    connectionString: options.connectionString,
    application_name: 'ontology-control-migrate',
  })
  const applied: string[] = []
  const skipped: string[] = []

  try {
    await client.connect()
    await client.query('SELECT pg_advisory_lock($1::bigint)', [advisoryLockKey])
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS agent_platform')
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
           version    text        PRIMARY KEY,
           name       text        NOT NULL,
           checksum   text        NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      )

      const ledger = await client.query<Record<string, string>>(
        `SELECT version, checksum FROM ${LEDGER_TABLE}`,
      )
      const appliedChecksums = new Map(ledger.rows.map((row) => [row.version, row.checksum]))

      for (const migration of migrations) {
        const previousChecksum = appliedChecksums.get(migration.version)
        if (previousChecksum !== undefined) {
          if (previousChecksum !== migration.checksum) {
            throw new ControlMigrationError(
              'MIGRATION_CHECKSUM_MISMATCH',
              `migration ${migration.filename} is already applied with a different checksum`,
            )
          }
          skipped.push(migration.filename)
          continue
        }

        await client.query('BEGIN')
        try {
          await client.query(migration.sql)
          await client.query(
            `INSERT INTO ${LEDGER_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
            [migration.version, migration.name, migration.checksum],
          )
          await client.query('COMMIT')
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // keep the original migration failure
          }
          throw error
        }
        applied.push(migration.filename)
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [advisoryLockKey])
      } catch {
        // the lock is released when the session ends; do not mask the real error
      }
    }
  } finally {
    try {
      await client.end()
    } catch {
      // the session, and with it the advisory lock, is already gone
    }
  }

  return { applied, skipped }
}
