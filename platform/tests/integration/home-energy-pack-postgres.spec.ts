import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSemanticDefinitionStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import {
  createToolContext,
  type DirectSqlQueryPlan,
  type ScalarValue,
  type SourceRef,
  type ToolContext,
} from '@ontology/contracts'
import {
  SemanticDefinitionService,
  compileSemanticQuery,
  renderCompiledQuery,
} from '@ontology/semantic-engine'
import {
  HOME_ENERGY_DEFINITIONS,
  HOME_ENERGY_NAMESPACE,
  buildHomeEnergyManifest,
} from '@ontology/industry-pack-home-energy'
import {
  HOME_ENERGY_COMPILE_BUDGET,
  HOME_ENERGY_EXPECTED_COLUMNS,
  HOME_ENERGY_EXPECTED_ROWS,
  HOME_ENERGY_MAPPING_A,
  HOME_ENERGY_MAPPING_B,
  HOME_ENERGY_OBJECT_A,
  HOME_ENERGY_OBJECT_B,
  HOME_ENERGY_SOURCE_A,
  HOME_ENERGY_SOURCE_B,
  homeEnergyObservationQuery,
  sourceARows,
  sourceBRows,
} from '../fixtures/home-energy'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * LOCAL-042 real-database acceptance.
 *
 * The pack's declaration version is published into the real PostgreSQL definition store
 * (migration 007), and the same canonical observation query is compiled through two
 * different customer mappings and executed against a real, read-only PostgreSQL business
 * database. The two differently named/unit-ed synthetic sources must normalise to equal
 * results. Nothing here is mocked: the definitions, the compiler and the SQL all run
 * against a throwaway containerised PostgreSQL with a unique name and port.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE = { tenantId: TENANT, spaceId: SPACE } as const

const READ_ONLY_ROLE = `home_energy_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`
const BUSINESS_DB = `home_energy_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client | undefined
let appClient: Client | undefined
let controlDatabase: ControlPostgresDatabase | undefined
let service: SemanticDefinitionService | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function contextFor(roles: readonly string[], sourceRefs: readonly SourceRef[]): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT, subjectId: 'home-energy-node-42', roles: [...roles], scopes: [], authEpoch: 1 },
    runId: '99999999-9999-4999-8999-999999999999',
    resolvedProfileHash: `sha256:${'c'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: '99999999-9999-4999-8999-999999999999',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
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
    traceId: 'trace-home-energy-pack-postgres',
  })
}

async function executeMapping(
  mapping: typeof HOME_ENERGY_MAPPING_A,
  ctx: ToolContext,
): Promise<{ columns: readonly { name: string; type: string }[]; rows: readonly (readonly unknown[])[] }> {
  const adapter = postgresAdapter
  if (adapter === undefined) throw new Error('the PostgreSQL adapter was not initialised')
  const compiled = compileSemanticQuery(homeEnergyObservationQuery(mapping), mapping, {
    budget: HOME_ENERGY_COMPILE_BUDGET,
  })
  const rendered = renderCompiledQuery(compiled)
  const plan: DirectSqlQueryPlan = {
    mode: 'direct',
    statementKind: 'select',
    sql: rendered.sql,
    parameters: [...rendered.parameters] as ScalarValue[],
    referencedObjects: [...rendered.referencedObjects],
    readOnly: true,
  }
  const result = await adapter.execute(
    {
      plan,
      limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
      snapshotRequest: { consistency: 'repeatable_read' },
    },
    ctx,
  )
  return { columns: result.columns, rows: result.rows }
}

beforeAll(async () => {
  container = await startPostgresContainer()
  adminUrl = container.adminUrl
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'home-energy-node-42')
     ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'home-energy-space')
     ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres')
  appClient = new Client({ connectionString: appUrl })
  await appClient.connect()

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  service = new SemanticDefinitionService({
    control: new ControlPostgresRepository(controlDatabase),
    store: new PostgresSemanticDefinitionStore(controlDatabase),
    now: () => new Date().toISOString(),
  })

  await adminClient.query(`CREATE DATABASE ${BUSINESS_DB}`)
  const readPassword = `throwaway_${randomBytes(8).toString('hex')}`
  await adminClient.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${readPassword}'`)

  const businessAdminUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, BUSINESS_DB)
  const businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE TABLE public.synthetic_observation_a (
      obs_id text PRIMARY KEY,
      sensor_key text NOT NULL,
      ts timestamptz NOT NULL,
      power_w numeric(18, 2) NOT NULL,
      energy_wh numeric(18, 2) NOT NULL,
      quality_code integer NOT NULL
    );
    CREATE TABLE public.synthetic_observation_b (
      reading_id text PRIMARY KEY,
      sensor_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      active_power_kw numeric(18, 4) NOT NULL,
      interval_energy_kwh numeric(18, 4) NOT NULL,
      quality_label text NOT NULL
    );
  `)
  for (const row of sourceARows()) {
    await businessAdmin.query(
      'INSERT INTO public.synthetic_observation_a (obs_id, sensor_key, ts, power_w, energy_wh, quality_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [...row],
    )
  }
  for (const row of sourceBRows()) {
    await businessAdmin.query(
      'INSERT INTO public.synthetic_observation_b (reading_id, sensor_id, recorded_at, active_power_kw, interval_energy_kwh, quality_label) VALUES ($1, $2, $3, $4, $5, $6)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.synthetic_observation_a TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.synthetic_observation_b TO ${READ_ONLY_ROLE}`)
  await businessAdmin.end()

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, readPassword, BUSINESS_DB)
  businessDb = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  const businessMappings: BusinessObjectMapping[] = [
    { objectRef: HOME_ENERGY_OBJECT_A, schema: 'public', relation: 'synthetic_observation_a', relationKind: 'table' },
    { objectRef: HOME_ENERGY_OBJECT_B, schema: 'public', relation: 'synthetic_observation_b', relationKind: 'table' },
  ]
  postgresAdapter = new PostgresQueryAdapter({
    database: businessDb,
    mappings: businessMappings,
    sourceRef: HOME_ENERGY_SOURCE_A,
  })
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await businessDb?.close().catch(() => undefined)
  await appClient?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('home-energy pack against real PostgreSQL', () => {
  it('publishes the pack definitions into the real definition store and resolves the ref', async () => {
    const definitionService = service
    if (definitionService === undefined) throw new Error('the definition service was not initialised')
    const admin = contextFor(['platform-admin'], [])

    const published = await definitionService.publish({ scopeRef: SCOPE, ...HOME_ENERGY_DEFINITIONS }, admin)
    expect(published.namespace).toBe(HOME_ENERGY_NAMESPACE)
    expect(published.ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const manifest = buildHomeEnergyManifest(published.ref)
    expect(manifest.definitionsRef).toEqual(published.ref)

    const resolved = await definitionService.getVersion(
      {
        scopeRef: SCOPE,
        namespace: HOME_ENERGY_NAMESPACE,
        definitionId: HOME_ENERGY_DEFINITIONS.definitionId,
        version: HOME_ENERGY_DEFINITIONS.version,
      },
      admin,
    )
    expect(resolved.ref.digest).toBe(published.ref.digest)
    expect(resolved.objects.map((object) => object.id)).toContain('sensor')
    expect(resolved.objects.map((object) => object.id)).toContain('device')

    const trail = await definitionService.getAuditTrail(
      SCOPE,
      HOME_ENERGY_DEFINITIONS.definitionId,
      admin,
    )
    expect(trail).toHaveLength(1)
  })

  it('stores no tenant id, URL or physical column in the shared declaration body', async () => {
    const client = adminClient
    if (client === undefined) throw new Error('the admin client was not initialised')
    const row = await client.query<{ definition: string }>(
      `SELECT definition::text AS definition
         FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = $3`,
      [TENANT, SPACE, HOME_ENERGY_DEFINITIONS.definitionId],
    )
    const body = row.rows[0]?.definition
    if (body === undefined) throw new Error('the home-energy definition row was not persisted')
    expect(body).not.toContain(TENANT)
    expect(body).not.toContain(SPACE)
    expect(body).not.toContain('://')
    expect(body).not.toContain('synthetic_observation')
    expect(body.toLowerCase()).not.toContain('connectionstring')
  })

  it('normalises two differently named/unit-ed sources to equal results (E-01, T003a)', async () => {
    const ctx = contextFor(['business-user'], [HOME_ENERGY_SOURCE_A, HOME_ENERGY_SOURCE_B])

    const resultA = await executeMapping(HOME_ENERGY_MAPPING_A, ctx)
    const resultB = await executeMapping(HOME_ENERGY_MAPPING_B, ctx)

    expect(resultA.columns).toEqual(HOME_ENERGY_EXPECTED_COLUMNS)
    expect(resultA.rows).toEqual(HOME_ENERGY_EXPECTED_ROWS)
    expect(resultB.rows).toEqual(resultA.rows)
  }, 120_000)

  it('keeps the canonical units after normalisation (kW vs kWh)', async () => {
    const ctx = contextFor(['business-user'], [HOME_ENERGY_SOURCE_A, HOME_ENERGY_SOURCE_B])
    const resultA = await executeMapping(HOME_ENERGY_MAPPING_A, ctx)
    const resultB = await executeMapping(HOME_ENERGY_MAPPING_B, ctx)

    const powerIndex = HOME_ENERGY_EXPECTED_COLUMNS.findIndex((column) => column.name === 'power_kw')
    const energyIndex = HOME_ENERGY_EXPECTED_COLUMNS.findIndex((column) => column.name === 'energy_kwh')
    // Source A stores W and Wh; source B stores kW and kWh. Both normalise to 3.5 kW / 5.25 kWh.
    expect(resultA.rows[1]?.[powerIndex]).toBe('3.5000000000')
    expect(resultB.rows[1]?.[powerIndex]).toBe('3.5000000000')
    expect(resultA.rows[1]?.[energyIndex]).toBe('5.2500000000')
    expect(resultB.rows[1]?.[energyIndex]).toBe('5.2500000000')
  }, 120_000)
})
