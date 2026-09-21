import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ControlMigrationError,
  ControlStorageError,
  isLoopbackAddress,
  loadControlMigrations,
  resolveLocalDevPrincipal,
} from '@ontology/adapter-control-postgres'
import type { LocalDevPrincipalConfig } from '@ontology/adapter-control-postgres'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const CONFIG: LocalDevPrincipalConfig = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  roles: ['business-user'],
  scopes: ['control:read'],
  authEpoch: 1,
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'control-migrations-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('local-dev principal is loopback-only (SPEC §3)', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost', 'LOCALHOST'])(
    'accepts loopback caller %s in development mode',
    (address) => {
      const principal = resolveLocalDevPrincipal(address, 'development', CONFIG)
      expect(principal.subjectId).toBe('local-dev')
      expect(principal.tenantId).toBe(CONFIG.tenantId)
      expect(principal.authEpoch).toBe(1)
    },
  )

  it.each(['0.0.0.0', '10.0.0.5', '192.168.1.10', '::ffff:8.8.8.8', 'example.com', '127.0.0.1.evil.com', ''])(
    'refuses non-loopback caller %s',
    (address) => {
      expect(() => resolveLocalDevPrincipal(address, 'development', CONFIG)).toThrowError(
        ControlStorageError,
      )
      expect(() => resolveLocalDevPrincipal(address, 'development', CONFIG)).toThrowError(
        /non-loopback/,
      )
    },
  )

  it('refuses the fixed development principal in production mode even on loopback', () => {
    expect(() => resolveLocalDevPrincipal('127.0.0.1', 'production', CONFIG)).toThrowError(
      /development mode/,
    )
  })

  it('classifies loopback and non-loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('localhost')).toBe(true)
    expect(isLoopbackAddress('10.1.2.3')).toBe(false)
    expect(isLoopbackAddress('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('control migrations are versioned and discoverable (SPEC D8)', () => {
  it('loads the committed migrations in numeric order with content checksums', async () => {
    const migrations = await loadControlMigrations(MIGRATIONS_DIR)
    expect(migrations.length).toBeGreaterThanOrEqual(3)
    const versions = migrations.map((migration) => migration.version)
    expect(versions).toEqual([...versions].sort((left, right) => Number(left) - Number(right)))
    expect(migrations[0]?.filename).toBe('001_control_foundation.sql')
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(migration.sql.length).toBeGreaterThan(0)
    }
  })

  it('rejects a filename that is not NNN_snake_case.sql', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'not_a_migration.sql'), 'SELECT 1')
      await expect(loadControlMigrations(dir)).rejects.toMatchObject({
        code: 'MIGRATION_INVALID_FILENAME',
      })
    })
  })

  it('rejects two migrations that declare the same version', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, '001_first.sql'), 'SELECT 1')
      await writeFile(join(dir, '001_second.sql'), 'SELECT 2')
      await expect(loadControlMigrations(dir)).rejects.toMatchObject({
        code: 'MIGRATION_VERSION_DUPLICATE',
      })
    })
  })

  it('exposes a typed migration error', () => {
    const error = new ControlMigrationError('MIGRATION_INVALID_FILENAME', 'bad')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('MIGRATION_INVALID_FILENAME')
  })
})
