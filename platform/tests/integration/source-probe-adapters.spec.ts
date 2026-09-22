import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSourceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  BusinessPostgresDatabase,
  DATA_POSTGRES_ADAPTER_REF,
  PostgresQueryAdapter,
} from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { DATA_DUCKDB_ADAPTER_REF, DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import { SourceRegistry } from '@ontology/application'
import { SecretValue, createToolContext } from '@ontology/contracts'
import type {
  ProfileRef,
  ScopeRef,
  SecretResolver,
  SourceProbeAdapter,
  SourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { READINGS_ROWS, readingsRelation } from '../fixtures/data-query/duckdb-relations'
import {
  StaticProbeAdapterResolver,
  capabilityRequirement,
  fixedClock,
  mappingRef,
  sequentialIds,
} from '../unit/source-registry-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * End-to-end probe → register → preflight for the two real data backends. The PostgreSQL
 * control store, the PostgreSQL business source and the DuckDB engine are all real; nothing
 * on the probe path is mocked. Each backend must produce a capability-matrix row, fail
 * honestly when it cannot observe the source, and invalidate a recorded preflight when its
 * mapping/capability version changes.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const READ_ONLY_ROLE = 'ontology_probe_reader'

const TENANT = '55555555-5555-4555-8555-555555555555'
const SPACE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN = '33333333-3333-4333-8333-333333333333'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const SNAPSHOT_HASH = `sha256:${'a'.repeat(64)}`

const PG_SOURCE: SourceRef = { namespace: 'business', sourceId: 'orders-db' }

const MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: { sourceRef: PG_SOURCE, objectPath: 'sales.orders' },
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer', type: 'string' },
      { name: 'amount', type: 'decimal' },
      { name: 'created_at', type: 'timestamp' },
    ],
  },
  {
    objectRef: { sourceRef: PG_SOURCE, objectPath: 'sales.customers' },
    schema: 'sales',
    relation: 'customers',
    relationKind: 'table',
  },
]

const PG_BAD_REF: VersionRef = {
  id: DATA_POSTGRES_ADAPTER_REF.id,
  version: '9.9.9',
  digest: sha256DigestOf('@ontology/adapter-data-postgres@9.9.9'),
}
const DUCK_BAD_REF: VersionRef = {
  id: DATA_DUCKDB_ADAPTER_REF.id,
  version: '9.9.9',
  digest: sha256DigestOf('@ontology/adapter-data-duckdb@9.9.9'),
}
const LEAK_REF: VersionRef = {
  id: '@ontology/adapter-probe-leak',
  version: '1.0.0',
  digest: sha256DigestOf('@ontology/adapter-probe-leak@1.0.0'),
}

const LEAK_SECRET = 'leak-secret-DO-NOT-LEAK-9f31'
const UNREACHABLE_SECRET = 'unreachable-secret-DO-NOT-LEAK-2a77'

const DUCK_RELATION: RegisteredRelation = readingsRelation()
const DUCK_MISSING_RELATION: RegisteredRelation = {
  relation: 'not_materialised',
  objectRef: { sourceRef: { namespace: 'local', sourceId: 'energy-snapshot' }, objectPath: 'public.not_materialised' },
  schemaRevision: '2026-09-01',
  columns: [{ name: 'x', type: 'string' }],
}

class MappingSecretResolver implements SecretResolver {
  readonly refs: string[] = []
  readonly #values: ReadonlyMap<string, string>

  constructor(values: ReadonlyMap<string, string>) {
    this.#values = values
  }

  resolve(secretRef: string): Promise<SecretValue> {
    this.refs.push(secretRef)
    return Promise.resolve(new SecretValue(this.#values.get(secretRef) ?? 'unresolved'))
  }
}

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function editorContext(sourceRefs: readonly SourceRef[]): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId: 'probe-editor',
      roles: ['data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: `sha256:${'b'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: RUN,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: [],
      sourceRefs: [...sourceRefs],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-probe-adapters',
  })
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let businessDbName = ''
let businessPassword = ''
let businessDb: BusinessPostgresDatabase
let controlDatabase: ControlPostgresDatabase
let registry: SourceRegistry
let pgAdapter: PostgresQueryAdapter
let pgBadAdapter: PostgresQueryAdapter
let duckAdapter: DuckDbQueryAdapter
let duckBadAdapter: DuckDbQueryAdapter

const EDITOR = editorContext([PG_SOURCE])
const EDITOR_NO_REFS = editorContext([])

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'probe-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'probe-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )

  // Real business source, reached through an independent read-only role.
  businessDbName = `probe_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  businessPassword = `throwaway_${randomBytes(8).toString('hex')}`
  const roleExists = await adminClient.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AS exists',
    [READ_ONLY_ROLE],
  )
  const roleStatement = await adminClient.query<{ statement: string }>(
    "SELECT format($1::text || ' ROLE ' || quote_ident($2) || ' LOGIN PASSWORD %L', $3::text) AS statement",
    [roleExists.rows[0]?.exists === true ? 'ALTER' : 'CREATE', READ_ONLY_ROLE, businessPassword],
  )
  const statement = roleStatement.rows[0]?.statement
  if (statement === undefined) throw new Error('could not build the read-only role statement')
  await adminClient.query(statement)

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, businessPassword, businessDbName)
  const businessAdminUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  const businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE SCHEMA sales;
    CREATE TABLE sales.orders (
      id integer PRIMARY KEY,
      customer text NOT NULL,
      amount numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sales.customers (
      id integer PRIMARY KEY,
      name text NOT NULL,
      region text NOT NULL
    );
    INSERT INTO sales.orders (id, customer, amount, created_at) VALUES
      (1, 'acme', 10.50, '2026-01-01T00:00:00Z'),
      (2, 'beta', 20.00, '2026-01-02T00:00:00Z');
    GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READ_ONLY_ROLE};
  `)
  await businessAdmin.end()

  businessDb = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  pgAdapter = new PostgresQueryAdapter({ database: businessDb, mappings: MAPPINGS, sourceRef: PG_SOURCE })
  pgBadAdapter = new PostgresQueryAdapter({
    database: new BusinessPostgresDatabase({
      connectionString: `postgresql://postgres:${encodeURIComponent(UNREACHABLE_SECRET)}@127.0.0.1:1/postgres`,
      connectionTimeoutMs: 1_000,
    }),
    mappings: MAPPINGS,
    sourceRef: PG_SOURCE,
    adapterRef: PG_BAD_REF,
  })

  duckAdapter = new DuckDbQueryAdapter({
    relations: [DUCK_RELATION],
    catalogSchemaRevision: '2026-09-01',
    adapterRef: DATA_DUCKDB_ADAPTER_REF,
  })
  await duckAdapter.start()
  await duckAdapter.materialiseRelation('readings', READINGS_ROWS)
  duckBadAdapter = new DuckDbQueryAdapter({
    relations: [DUCK_MISSING_RELATION],
    catalogSchemaRevision: '2026-09-01',
    adapterRef: DUCK_BAD_REF,
  })

  const leakingAdapter: SourceProbeAdapter = {
    adapterRef: LEAK_REF,
    probe: (request) => Promise.reject(new Error(`connect failed: password=${request.secret.reveal()}`)),
  }

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const appStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = appStatement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  controlDatabase = new ControlPostgresDatabase({
    connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres'),
    maxPoolSize: 4,
  })

  const secrets = new MappingSecretResolver(
    new Map([
      ['secret://vault/pg-orders', businessUrl],
      ['secret://vault/pg-unreachable', UNREACHABLE_SECRET],
      ['secret://vault/duck-energy', 'duckdb://memory/energy'],
      ['secret://vault/duck-partial', 'duckdb://memory/partial'],
      ['secret://vault/leak', LEAK_SECRET],
    ]),
  )

  registry = new SourceRegistry({
    control: new ControlPostgresRepository(controlDatabase),
    store: new PostgresSourceStore(controlDatabase),
    secrets,
    adapters: new StaticProbeAdapterResolver([pgAdapter, pgBadAdapter, duckAdapter, duckBadAdapter, leakingAdapter]),
    now: fixedClock(),
    newId: sequentialIds('60606060'),
  })
}, 300_000)

afterAll(async () => {
  duckAdapter?.close()
  duckBadAdapter?.close()
  await businessDb?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('PostgreSQL SourceProbeAdapter through the registry', () => {
  it('produces a capability-matrix row, becomes ready and drives a fresh preflight', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'read_only_origin',
        role: 'catalog',
        adapterRef: DATA_POSTGRES_ADAPTER_REF,
        secretRef: 'secret://vault/pg-orders',
        mappingRef: mappingRef('catalog', 'a'),
        capabilityVersion: '1.0.0',
      },
      EDITOR,
    )

    const job = await registry.probeSource(
      {
        scopeRef: SCOPE,
        sourceId: binding.sourceId,
        capabilities: [capabilityRequirement('structured_query.execute')],
      },
      EDITOR,
    )
    expect(job.status).toBe('succeeded')
    expect(job.capabilities?.map((capability) => capability.name).sort()).toEqual([
      'catalog.describe',
      'structured_query.execute',
    ])
    const capability = job.capabilities?.find((entry) => entry.name === 'structured_query.execute')
    expect(capability).toMatchObject({
      version: '1.0.0',
      consistency: 'repeatable_read',
      cancellation: 'supported',
      pagination: 'opaque_cursor',
    })
    expect(capability?.supportedDataTypes).toEqual(
      expect.arrayContaining(['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json', 'binary']),
    )
    expect(capability?.limits.maxRows).toBeGreaterThan(0)
    expect(capability?.limits.maxBytes).toBeGreaterThan(0)
    expect(job.schemaRevision).toBeDefined()

    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).toBe('ready')

    // The resolved connection secret never reaches the stored job or binding.
    expect(JSON.stringify(job)).not.toContain(businessPassword)
    expect(JSON.stringify(stored)).not.toContain(businessPassword)

    await registry.recordPreflight(
      { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH, roles: ['catalog'] },
      EDITOR,
    )
    const fresh = await registry.assessPreflight(
      { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
      EDITOR,
    )
    expect(fresh.status).toBe('fresh')

    await registry.reviseSource(
      {
        scopeRef: SCOPE,
        sourceId: binding.sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('catalog', 'd', '1.1.0'),
      },
      EDITOR,
    )
    const stale = await registry.assessPreflight(
      { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
      EDITOR,
    )
    expect(stale.status).toBe('stale')
    await expect(
      registry.requireFreshPreflight(
        { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_STALE' })
  }, 120_000)

  it('keeps an unreachable source not-ready with an explicit error', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'read_only_origin',
        role: 'catalog',
        adapterRef: PG_BAD_REF,
        secretRef: 'secret://vault/pg-unreachable',
        mappingRef: mappingRef('catalog', 'b'),
      },
      EDITOR,
    )
    const job = await registry.probeSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('SOURCE_UNAVAILABLE')
    expect(JSON.stringify(job)).not.toContain(UNREACHABLE_SECRET)

    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).toBe('failed')
  }, 120_000)

  it('fails the probe instead of reporting ready when no mapped relation is visible', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'read_only_origin',
        role: 'documents',
        adapterRef: DATA_POSTGRES_ADAPTER_REF,
        secretRef: 'secret://vault/pg-orders',
        mappingRef: mappingRef('documents', 'c'),
      },
      EDITOR,
    )
    const job = await registry.probeSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR_NO_REFS)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('SOURCE_UNAVAILABLE')
    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).not.toBe('ready')
  }, 120_000)
})

describe('DuckDB SourceProbeAdapter through the registry', () => {
  it('produces a capability-matrix row from the real engine and drives a fresh preflight', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'imported',
        role: 'telemetry',
        adapterRef: DATA_DUCKDB_ADAPTER_REF,
        secretRef: 'secret://vault/duck-energy',
        mappingRef: mappingRef('telemetry', 'a'),
        capabilityVersion: '1.0.0',
      },
      EDITOR,
    )

    const job = await registry.probeSource(
      {
        scopeRef: SCOPE,
        sourceId: binding.sourceId,
        capabilities: [capabilityRequirement('structured_query.execute')],
      },
      EDITOR,
    )
    expect(job.status).toBe('succeeded')
    expect(job.capabilities?.map((capability) => capability.name).sort()).toEqual([
      'catalog.describe',
      'structured_query.execute',
    ])
    const capability = job.capabilities?.find((entry) => entry.name === 'structured_query.execute')
    expect(capability).toMatchObject({
      version: '1.0.0',
      consistency: 'repeatable_read',
      cancellation: 'supported',
      pagination: 'opaque_cursor',
    })
    expect(capability?.supportedDataTypes).toEqual(
      expect.arrayContaining(['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json', 'binary']),
    )
    expect(capability?.limits.maxRows).toBeGreaterThan(0)

    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).toBe('ready')

    await registry.recordPreflight(
      { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH, roles: ['telemetry'] },
      EDITOR,
    )
    expect(
      (
        await registry.assessPreflight(
          { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
          EDITOR,
        )
      ).status,
    ).toBe('fresh')

    await registry.reviseSource(
      {
        scopeRef: SCOPE,
        sourceId: binding.sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('telemetry', 'd', '1.1.0'),
      },
      EDITOR,
    )
    expect(
      (
        await registry.assessPreflight(
          { scopeRef: SCOPE, profileRef: PROFILE_REF, snapshotHash: SNAPSHOT_HASH },
          EDITOR,
        )
      ).status,
    ).toBe('stale')
  }, 120_000)

  it('keeps a partially materialised source not-ready with an explicit error', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'imported',
        role: 'documents',
        adapterRef: DUCK_BAD_REF,
        secretRef: 'secret://vault/duck-partial',
        mappingRef: mappingRef('documents', 'e'),
      },
      EDITOR,
    )
    const job = await registry.probeSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('SOURCE_UNAVAILABLE')
    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).not.toBe('ready')
  }, 120_000)

  it('fails the probe when the requested capability is not supported', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'imported',
        role: 'documents',
        adapterRef: DATA_DUCKDB_ADAPTER_REF,
        secretRef: 'secret://vault/duck-energy',
        mappingRef: mappingRef('documents', 'f'),
      },
      EDITOR,
    )
    const job = await registry.probeSource(
      { scopeRef: SCOPE, sourceId: binding.sourceId, capabilities: [capabilityRequirement('telemetry_read')] },
      EDITOR,
    )
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('CAPABILITY_NOT_CONFIGURED')
    const stored = await registry.getSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).not.toBe('ready')
  }, 120_000)
})

describe('secret handling through the real registry', () => {
  it('scrubs a resolved secret out of a failed probe message', async () => {
    const binding = await registry.registerSource(
      {
        scopeRef: SCOPE,
        kind: 'read_only_origin',
        role: 'documents',
        adapterRef: LEAK_REF,
        secretRef: 'secret://vault/leak',
        mappingRef: mappingRef('documents', 'a'),
      },
      EDITOR,
    )
    const job = await registry.probeSource({ scopeRef: SCOPE, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.safeMessage).toContain('[redacted]')
    expect(job.safeMessage).not.toContain(LEAK_SECRET)
  }, 120_000)
})
