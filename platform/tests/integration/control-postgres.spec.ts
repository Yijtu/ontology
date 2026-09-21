import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import type { ControlOperationHandler } from '@ontology/adapter-control-postgres'
import { createToolContext } from '@ontology/contracts'
import type { ToolContext } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROJECTION = 'semantic-projection-1'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444'
const DIGEST = `sha256:${'a'.repeat(64)}`

function connectionStringFor(
  adminUrl: string,
  user: string,
  password: string,
  database: string,
): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(tenantId: string, spaceId: string): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'integration-test',
      roles: ['platform-admin'],
      scopes: ['control:read', 'control:write'],
      authEpoch: 1,
    },
    runId: RUN_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-integration-1',
  })
}

const OPERATIONS = new Map<string, ControlOperationHandler>([
  [
    'seedProjection',
    async (context, params) => {
      const value = params as { projectionRef: string; generation: number }
      await context.query(
        `INSERT INTO agent_platform.projection_state
           (tenant_id, space_id, projection_ref, generation, watermark_kind, watermark_value, dirty)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2::bigint, 'sequence', $3, false
         )
         ON CONFLICT (tenant_id, space_id, projection_ref)
         DO UPDATE SET generation = EXCLUDED.generation, updated_at = now()`,
        [value.projectionRef, value.generation, String(value.generation)],
      )
    },
  ],
  [
    'incrementGeneration',
    async (context, params) => {
      const value = params as { projectionRef: string }
      const result = await context.query(
        `UPDATE agent_platform.projection_state
            SET generation = generation + 1, updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND projection_ref = $1
          RETURNING generation`,
        [value.projectionRef],
      )
      if (result.rowCount === 0) {
        throw new Error(`projection ${value.projectionRef} is not visible in scope`)
      }
    },
  ],
  [
    'alwaysFails',
    async () => {
      throw new Error('intentional transaction failure')
    },
  ],
])

async function withRawScope<T>(
  client: Client,
  tenantId: string,
  spaceId: string,
  run: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
      [tenantId, spaceId],
    )
    const result = await run()
    await client.query('ROLLBACK')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

const contextA = toolContext(TENANT_A, SPACE_A)
const contextB = toolContext(TENANT_B, SPACE_B)
const scopeA = { tenantId: TENANT_A, spaceId: SPACE_A }
const scopeB = { tenantId: TENANT_B, spaceId: SPACE_B }

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appClient: Client
let database: ControlPostgresDatabase
let repository: ControlPostgresRepository

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'tenant-a'), ($2, 'tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'space-a'), ($3, $4, 'space-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.projection_state
       (tenant_id, space_id, projection_ref, generation, watermark_kind, watermark_value, dirty)
     VALUES ($1, $2, $3, 7, 'sequence', '42', false)
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, PROJECTION],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.event_streams (tenant_id, space_id, stream_ref, last_seq)
     VALUES ($1, $2, 'cross-tenant', 0)
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) {
    throw new Error('could not build the application-role login statement')
  }
  await adminClient.query(alterStatement)

  const adminBase = new URL(adminUrl)
  const appUrl = connectionStringFor(
    adminUrl,
    'ontology_app',
    appPassword,
    adminBase.pathname.replace(/^\//, '') || 'postgres',
  )

  appClient = new Client({ connectionString: appUrl })
  await appClient.connect()

  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 1 })
  repository = new ControlPostgresRepository(database, { operations: OPERATIONS })
}, 300_000)

afterAll(async () => {
  await appClient?.end().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('role and row-level security configuration', () => {
  it('runs the application as a non-owner, non-superuser, non-BYPASSRLS role', async () => {
    const role = await adminClient.query<{
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
    }>("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ontology_app'")
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true })

    const owned = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
        WHERE schemaname = 'agent_platform' AND tableowner = 'ontology_app'`,
    )
    expect(owned.rows[0]?.count).toBe('0')
  })

  it('enables row level security on every control table', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname <> 'control_schema_migrations'
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])
  })

  it('puts tenant_id/space_id in every primary key and foreign key', async () => {
    const primaryKeys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace AND c.contype = 'p'
        GROUP BY 1`,
    )
    for (const row of primaryKeys.rows) {
      if (row.table_name === 'agent_platform.control_schema_migrations') {
        continue
      }
      if (row.table_name === 'agent_platform.tenants') {
        expect(row.columns).toEqual(['tenant_id'])
        continue
      }
      expect(row.columns, row.table_name).toContain('tenant_id')
      expect(row.columns, row.table_name).toContain('space_id')
    }

    const foreignKeys = await adminClient.query<{ conname: string; columns: string[] }>(
      `SELECT c.conname, array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace AND c.contype = 'f'
        GROUP BY 1`,
    )
    const byName = new Map(foreignKeys.rows.map((row) => [row.conname, row.columns]))
    expect(byName.get('spaces_tenant_fkey')).toEqual(['tenant_id'])
    expect(byName.get('event_streams_space_fkey')).toEqual(['tenant_id', 'space_id'])
    expect(byName.get('semantic_events_stream_fkey')).toEqual([
      'tenant_id',
      'space_id',
      'stream_ref',
    ])
    expect(byName.get('projection_state_space_fkey')).toEqual(['tenant_id', 'space_id'])
    expect(byName.get('control_transactions_space_fkey')).toEqual(['tenant_id', 'space_id'])
  })
})

describe('cross-tenant negatives (real RLS)', () => {
  it('reads its own projection and hides another tenant projection', async () => {
    const own = await repository.readProjection(
      { scopeRef: scopeA, projectionRef: { id: PROJECTION, version: '1.0.0', digest: DIGEST } },
      contextA,
    )
    expect(own.generation).toBe('7')
    expect(own.watermark).toEqual({ kind: 'sequence', value: '42' })
    expect(own.dirty).toBe(false)

    await expect(
      repository.readProjection(
        { scopeRef: scopeB, projectionRef: { id: PROJECTION, version: '1.0.0', digest: DIGEST } },
        contextB,
      ),
    ).rejects.toMatchObject({ code: 'PROJECTION_NOT_FOUND' })
  })

  it('denies every tenant row when no scope is set (RLS default deny)', async () => {
    const projections = await appClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.projection_state',
    )
    expect(projections.rows[0]?.count).toBe('0')

    const events = await appClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.semantic_events',
    )
    expect(events.rows[0]?.count).toBe('0')
  })

  it('returns nothing for another tenant even with an explicit predicate', async () => {
    const result = await withRawScope(appClient, TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_platform.projection_state WHERE tenant_id = $1',
        [TENANT_A],
      ),
    )
    expect(result.rows[0]?.count).toBe('0')
  })

  it('cannot update another tenant row', async () => {
    const result = await withRawScope(appClient, TENANT_B, SPACE_B, () =>
      appClient.query(
        `UPDATE agent_platform.projection_state
            SET dirty = true
          WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3`,
        [TENANT_A, SPACE_A, PROJECTION],
      ),
    )
    expect(result.rowCount).toBe(0)

    const ownerView = await adminClient.query<{ dirty: boolean }>(
      `SELECT dirty FROM agent_platform.projection_state
        WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3`,
      [TENANT_A, SPACE_A, PROJECTION],
    )
    expect(ownerView.rows[0]?.dirty).toBe(false)
  })

  it('rejects a cross-tenant write even with an explicit target tenant', async () => {
    await expect(
      withRawScope(appClient, TENANT_B, SPACE_B, () =>
        appClient.query(
          `INSERT INTO agent_platform.semantic_events
             (tenant_id, space_id, stream_ref, recorded_seq, payload_digest, idempotency_key)
           VALUES ($1, $2, 'cross-tenant', 999, $3, 'cross-tenant-1')`,
          [TENANT_A, SPACE_A, DIGEST],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('trusted scope is not taken from the request', () => {
  it('rejects a scopeRef that differs from the trusted principal', async () => {
    await expect(
      repository.appendEvent(
        {
          scopeRef: scopeB,
          streamRef: 'scope-mismatch',
          payloadDigest: DIGEST,
          idempotencyKey: 'scope-mismatch-1',
        },
        contextA,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })

    const written = await adminClient.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_platform.semantic_events WHERE stream_ref = 'scope-mismatch'",
    )
    expect(written.rows[0]?.count).toBe('0')
  })

  it('refuses a deserialized context that lost the trusted brand', async () => {
    const deserialized = JSON.parse(JSON.stringify(contextA)) as ToolContext
    await expect(
      repository.readProjection(
        { scopeRef: scopeA, projectionRef: { id: PROJECTION, version: '1.0.0', digest: DIGEST } },
        deserialized,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('rejects a space mismatch inside the same tenant', async () => {
    await expect(
      repository.appendEvent(
        {
          scopeRef: { tenantId: TENANT_A, spaceId: SPACE_B },
          streamRef: 'space-mismatch',
          payloadDigest: DIGEST,
          idempotencyKey: 'space-mismatch-1',
        },
        contextA,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})

describe('connection pool does not leak scope between requests', () => {
  it('clears the pooled session scope after a request on the same backend', async () => {
    const before = await database.queryUnscoped<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const pid = before.rows[0]?.pid

    await repository.readProjection(
      { scopeRef: scopeA, projectionRef: { id: PROJECTION, version: '1.0.0', digest: DIGEST } },
      contextA,
    )

    const after = await database.queryUnscoped<{ tenant: string; space: string; pid: number }>(
      `SELECT current_setting('app.tenant_id', true) AS tenant,
              current_setting('app.space_id', true) AS space,
              pg_backend_pid() AS pid`,
    )
    expect(after.rows[0]?.tenant).toBe('')
    expect(after.rows[0]?.space).toBe('')
    expect(after.rows[0]?.pid).toBe(pid)

    const unscoped = await database.queryUnscoped<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.projection_state',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })

  it('does not let a second principal reuse the first principal scope', async () => {
    await repository.appendEvent(
      {
        scopeRef: scopeA,
        streamRef: 'pool-reuse',
        payloadDigest: DIGEST,
        idempotencyKey: 'pool-a-1',
      },
      contextA,
    )
    const leaked = await database.queryUnscoped<{ tenant: string }>(
      "SELECT current_setting('app.tenant_id', true) AS tenant",
    )
    expect(leaked.rows[0]?.tenant).toBe('')

    const firstForB = await repository.appendEvent(
      {
        scopeRef: scopeB,
        streamRef: 'pool-reuse',
        payloadDigest: DIGEST,
        idempotencyKey: 'pool-b-1',
      },
      contextB,
    )
    expect(firstForB).toEqual({ recordedSeq: '1', appended: true })

    const replayOfAKeyUnderB = await repository.appendEvent(
      {
        scopeRef: scopeB,
        streamRef: 'pool-reuse',
        payloadDigest: DIGEST,
        idempotencyKey: 'pool-a-1',
      },
      contextB,
    )
    expect(replayOfAKeyUnderB).toEqual({ recordedSeq: '2', appended: true })
  })
})

describe('appendEvent idempotency and monotonic sequence per scope', () => {
  it('is idempotent per scope and monotonic per stream', async () => {
    const first = await repository.appendEvent(
      { scopeRef: scopeA, streamRef: 'idem', payloadDigest: DIGEST, idempotencyKey: 'idem-1' },
      contextA,
    )
    expect(first).toEqual({ recordedSeq: '1', appended: true })

    const replay = await repository.appendEvent(
      { scopeRef: scopeA, streamRef: 'idem', payloadDigest: DIGEST, idempotencyKey: 'idem-1' },
      contextA,
    )
    expect(replay).toEqual({ recordedSeq: '1', appended: false })

    const second = await repository.appendEvent(
      { scopeRef: scopeA, streamRef: 'idem', payloadDigest: DIGEST, idempotencyKey: 'idem-2' },
      contextA,
    )
    expect(second).toEqual({ recordedSeq: '2', appended: true })

    const otherTenant = await repository.appendEvent(
      { scopeRef: scopeB, streamRef: 'idem', payloadDigest: DIGEST, idempotencyKey: 'idem-1' },
      contextB,
    )
    expect(otherTenant).toEqual({ recordedSeq: '1', appended: true })
  })
})

describe('transaction repository', () => {
  it('commits registered operations atomically and rolls back on failure', async () => {
    await repository.transaction(
      {
        scopeRef: scopeA,
        operations: [
          JSON.stringify({ op: 'seedProjection', params: { projectionRef: 'txn-projection', generation: 3 } }),
        ],
      },
      contextA,
    )
    const stored = await repository.readProjection(
      {
        scopeRef: scopeA,
        projectionRef: { id: 'txn-projection', version: '1.0.0', digest: DIGEST },
      },
      contextA,
    )
    expect(stored.generation).toBe('3')

    await expect(
      repository.transaction(
        {
          scopeRef: scopeA,
          operations: [
            JSON.stringify({ op: 'seedProjection', params: { projectionRef: 'txn-rollback', generation: 9 } }),
            JSON.stringify({ op: 'alwaysFails', params: {} }),
          ],
        },
        contextA,
      ),
    ).rejects.toThrow('intentional transaction failure')

    await expect(
      repository.readProjection(
        {
          scopeRef: scopeA,
          projectionRef: { id: 'txn-rollback', version: '1.0.0', digest: DIGEST },
        },
        contextA,
      ),
    ).rejects.toMatchObject({ code: 'PROJECTION_NOT_FOUND' })
  })

  it('applies a keyed transaction exactly once and rejects a different payload', async () => {
    await repository.transaction(
      {
        scopeRef: scopeA,
        operations: [
          JSON.stringify({ op: 'seedProjection', params: { projectionRef: 'txn-idem', generation: 0 } }),
        ],
      },
      contextA,
    )
    const increment = JSON.stringify({
      op: 'incrementGeneration',
      params: { projectionRef: 'txn-idem' },
    })
    const keyed = { scopeRef: scopeA, operations: [increment], idempotencyKey: 'txn-idem-key-1' }

    await repository.transaction(keyed, contextA)
    await repository.transaction(keyed, contextA)

    const replayed = await repository.readProjection(
      { scopeRef: scopeA, projectionRef: { id: 'txn-idem', version: '1.0.0', digest: DIGEST } },
      contextA,
    )
    expect(replayed.generation).toBe('1')

    await expect(
      repository.transaction(
        {
          scopeRef: scopeA,
          operations: [
            JSON.stringify({ op: 'seedProjection', params: { projectionRef: 'txn-idem', generation: 5 } }),
          ],
          idempotencyKey: 'txn-idem-key-1',
        },
        contextA,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('rejects unknown and malformed operations without touching the database', async () => {
    await expect(
      repository.transaction(
        { scopeRef: scopeA, operations: [JSON.stringify({ op: 'unknown-op' })] },
        contextA,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })

    await expect(
      repository.transaction({ scopeRef: scopeA, operations: ['not json'] }, contextA),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })

    await expect(
      repository.transaction({ scopeRef: scopeA, operations: [] }, contextA),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION' })
  })
})

describe('migration step is separate, idempotent and immutable', () => {
  it('applies nothing when re-run', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped.length).toBeGreaterThanOrEqual(3)
  })

  it('refuses a changed already-applied migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-migrations-'))
    try {
      const source = await readFile(join(MIGRATIONS_DIR, '001_control_foundation.sql'), 'utf8')
      await writeFile(join(dir, '001_control_foundation.sql'), `${source}\n-- tampered\n`)
      await expect(
        runControlMigrations({ connectionString: adminUrl, migrationsDir: dir }),
      ).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not initialise the schema when the service database is constructed', async () => {
    const databaseName = `control_startup_${randomUUID().replaceAll('-', '')}`
    await adminClient.query(`CREATE DATABASE "${databaseName}"`)
    const base = new URL(adminUrl)
    const startupUrl = connectionStringFor(
      adminUrl,
      decodeURIComponent(base.username),
      decodeURIComponent(base.password),
      databaseName,
    )
    const startupDatabase = new ControlPostgresDatabase({ connectionString: startupUrl, maxPoolSize: 1 })
    try {
      const result = await startupDatabase.queryUnscoped<{ regclass: string | null }>(
        "SELECT to_regclass('agent_platform.control_schema_migrations')::text AS regclass",
      )
      expect(result.rows[0]?.regclass).toBeNull()
    } finally {
      await startupDatabase.close()
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    }
  })
})
