import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSourceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { SourceRegistry } from '@ontology/application'
import type { ProfileRef, ToolContext } from '@ontology/contracts'
import {
  DOCUMENTS_ADAPTER_REF,
  SENTINEL_SECRET,
  SCOPE_A,
  SCOPE_B,
  TELEMETRY_ADAPTER_REF,
  ControlledProbeAdapter,
  SentinelSecretResolver,
  StaticProbeAdapterResolver,
  capabilityRequirement,
  fixedClock,
  mappingRef,
  sequentialIds,
  toolContext,
} from '../unit/source-registry-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const SNAPSHOT_HASH = `sha256:${'a'.repeat(64)}`

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let controlDatabase: ControlPostgresDatabase
let registry: SourceRegistry

const EDITOR_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'pg-source-a')
const EDITOR_B: ToolContext = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['data-editor'], 'pg-source-b')

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

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
     VALUES ($1, 'source-tenant-a'), ($2, 'source-tenant-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_B.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'source-space-a'), ($3, $4, 'source-space-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, SCOPE_B.tenantId, SCOPE_B.spaceId],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)

  controlDatabase = new ControlPostgresDatabase({
    connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword),
    maxPoolSize: 4,
  })

  registry = new SourceRegistry({
    control: new ControlPostgresRepository(controlDatabase),
    store: new PostgresSourceStore(controlDatabase),
    secrets: new SentinelSecretResolver(),
    adapters: new StaticProbeAdapterResolver([
      new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF }),
      new ControlledProbeAdapter({
        adapterRef: DOCUMENTS_ADAPTER_REF,
        observation: { capabilities: [{ name: 'document_search', version: '1.0.0' }] },
      }),
    ]),
    now: fixedClock(),
    newId: sequentialIds('77777777'),
  })
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('source binding migration (009)', () => {
  it('enables RLS and keeps tenant/space in the primary keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN (
            'source_bindings', 'source_versions', 'source_probe_jobs', 'source_preflight_bindings'
          )
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.source_bindings',
            'agent_platform.source_versions',
            'agent_platform.source_probe_jobs',
            'agent_platform.source_preflight_bindings'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.source_bindings')).toEqual(['tenant_id', 'space_id', 'source_id'])
    expect(byTable.get('agent_platform.source_versions')).toEqual([
      'tenant_id',
      'space_id',
      'source_id',
      'version',
    ])
    expect(byTable.get('agent_platform.source_probe_jobs')).toEqual(['tenant_id', 'space_id', 'job_id'])
    expect(byTable.get('agent_platform.source_preflight_bindings')).toEqual([
      'tenant_id',
      'space_id',
      'profile_id',
      'version',
      'snapshot_hash',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('009_source_bindings.sql')
  })
})

describe('source registration and probing against real PostgreSQL', () => {
  it('registers, probes and exports a read-only origin and an imported source', async () => {
    const origin = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'read_only_origin',
        role: 'telemetry',
        adapterRef: TELEMETRY_ADAPTER_REF,
        secretRef: 'secret://vault/telemetry-ro',
        mappingRef: mappingRef('telemetry', 'a'),
        capabilityVersion: '1.0.0',
      },
      EDITOR_A,
    )
    const imported = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
        mappingRef: mappingRef('documents', 'b'),
      },
      EDITOR_A,
    )
    expect(origin.status).toBe('registered')
    expect(imported.status).toBe('registered')

    const job = await registry.probeSource(
      { scopeRef: SCOPE_A, sourceId: origin.sourceId, capabilities: [capabilityRequirement('telemetry_read')] },
      EDITOR_A,
    )
    expect(job.status).toBe('succeeded')
    expect(job.capabilities?.[0]?.consistency).toBe('repeatable_read')
    expect(job.capabilities?.[0]?.pagination).toBe('cursor')

    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: origin.sourceId }, EDITOR_A)
    expect(stored.status).toBe('ready')

    const persisted = await registry.getProbeJob({ scopeRef: SCOPE_A, jobId: job.jobId }, EDITOR_A)
    expect(persisted.status).toBe('succeeded')
    expect(persisted.capabilities?.[0]?.name).toBe('telemetry_read')

    const exported = await registry.exportConfig(SCOPE_A, EDITOR_A)
    expect(exported.sources).toHaveLength(2)
    expect(JSON.stringify(exported)).not.toContain(SENTINEL_SECRET)

    const model = await registry.buildModelContext(SCOPE_A, EDITOR_A)
    expect(JSON.stringify(model)).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(model)).not.toContain('secret://vault/telemetry-ro')
  })

  it('never persists the resolved secret value', async () => {
    const rows = await adminClient.query<{ body: string }>(
      `SELECT concat_ws('|', secret_ref, status, current_version, coalesce(capability_version, '')) AS body
         FROM agent_platform.source_bindings`,
    )
    expect(rows.rows.length).toBeGreaterThan(0)
    for (const row of rows.rows) {
      expect(row.body).not.toContain(SENTINEL_SECRET)
    }

    const jobs = await adminClient.query<{ body: string }>(
      `SELECT concat_ws('|', coalesce(safe_message, ''), coalesce(capabilities::text, '')) AS body
         FROM agent_platform.source_probe_jobs`,
    )
    for (const row of jobs.rows) {
      expect(row.body).not.toContain(SENTINEL_SECRET)
    }
  })

  it('scrubs the resolved secret from a failed probe error body', async () => {
    const leaking = {
      adapterRef: TELEMETRY_ADAPTER_REF,
      probe: (request: { secret: { reveal(): string } }) =>
        Promise.reject(new Error(`connect failed: password=${request.secret.reveal()}`)),
    }
    const failing = new SourceRegistry({
      control: new ControlPostgresRepository(controlDatabase),
      store: new PostgresSourceStore(controlDatabase),
      secrets: new SentinelSecretResolver(),
      adapters: new StaticProbeAdapterResolver([leaking]),
      now: fixedClock(),
      newId: sequentialIds('88888888'),
    })
    const binding = await failing.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'read_only_origin',
        role: 'catalog',
        adapterRef: TELEMETRY_ADAPTER_REF,
        secretRef: 'secret://vault/catalog',
        mappingRef: mappingRef('catalog', 'c'),
      },
      EDITOR_A,
    )
    const job = await failing.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR_A)
    expect(job.status).toBe('failed')
    expect(job.safeMessage).toContain('[redacted]')
    expect(job.safeMessage).not.toContain(SENTINEL_SECRET)

    const stored = await failing.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR_A)
    expect(stored.status).toBe('failed')
  })

  it('keeps every row inside the tenant/space boundary through RLS', async () => {
    expect(await registry.listSources(SCOPE_B, EDITOR_B)).toHaveLength(0)

    const unscoped = await controlDatabase.queryUnscoped<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.source_bindings',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })

  it('invalidates a recorded preflight when the mapping/capability version changes', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'read_only_origin',
        role: 'telemetry',
        adapterRef: TELEMETRY_ADAPTER_REF,
        secretRef: 'secret://vault/telemetry-stale',
        mappingRef: mappingRef('telemetry', 'a'),
        capabilityVersion: '1.0.0',
      },
      EDITOR_A,
    )
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR_A)
    await registry.recordPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH, roles: ['telemetry'] },
      EDITOR_A,
    )
    expect(
      (
        await registry.assessPreflight(
          { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
          EDITOR_A,
        )
      ).status,
    ).toBe('fresh')

    await registry.reviseSource(
      {
        scopeRef: SCOPE_A,
        sourceId: binding.sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('telemetry', 'd', '1.1.0'),
      },
      EDITOR_A,
    )
    const stale = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
      EDITOR_A,
    )
    expect(stale.status).toBe('stale')

    // The application role cannot see another tenant's recorded preflight either.
    const crossScope = await registry.assessPreflight(
      { scopeRef: SCOPE_B, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
      EDITOR_B,
    )
    expect(crossScope.status).toBe('stale')
  })

  it('fails the probe when the requested capability subset is unsupported', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents-2',
        mappingRef: mappingRef('documents', 'e'),
      },
      EDITOR_A,
    )
    const job = await registry.probeSource(
      { scopeRef: SCOPE_A, sourceId: binding.sourceId, capabilities: [capabilityRequirement('telemetry_read')] },
      EDITOR_A,
    )
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('CAPABILITY_NOT_CONFIGURED')
    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR_A)
    expect(stored.status).not.toBe('ready')
  })
})
