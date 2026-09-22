import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import type {
  QueryColumn,
  ScalarValue,
  SourceObjectRef,
  StructuredQueryExecuteRequest,
} from '@ontology/contracts'
import { ENERGY_SOURCE, duckdbContext } from '../fixtures/data-query/duckdb-relations'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * X-03 — the live DuckDB ↔ PostgreSQL equivalence run (SPEC §1 ADR-06, V2 X-03).
 *
 * The same logical fixture is loaded into both engines and the same logical query is run
 * through each real adapter. The normalised columns, rows and `resultDigest` must be
 * equal; the only difference between the two query texts is the dialect placeholder
 * syntax (`?` vs `$n`), which is confined to the adapter side.
 */
interface DatasetFixture {
  readonly relation: string
  readonly objectPath: string
  readonly schemaRevision: string
  readonly columns: readonly QueryColumn[]
  readonly physicalTypes?: Readonly<Record<string, string>>
  readonly rows: readonly (readonly (string | number | boolean | null)[])[]
}

interface ExpectedFixture {
  readonly logicalQuery: string
  readonly postgresQuery: string
  readonly parameters: readonly ScalarValue[]
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly (readonly unknown[])[]
  readonly crossEngine: { readonly status: string; readonly note: string }
}

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
  ) as T
}

const dataset = readJson<DatasetFixture>('../fixtures/data-query/x03-dataset.json')
const expected = readJson<ExpectedFixture>('../fixtures/data-query/x03-expected.json')

const OBJECT_REF: SourceObjectRef = {
  sourceRef: ENERGY_SOURCE,
  objectPath: dataset.objectPath,
}

const relation: RegisteredRelation = {
  relation: dataset.relation,
  objectRef: OBJECT_REF,
  schemaRevision: dataset.schemaRevision,
  columns: dataset.columns,
  ...(dataset.physicalTypes === undefined ? {} : { physicalTypes: dataset.physicalTypes }),
}

const duckdbAdapter = new DuckDbQueryAdapter({
  relations: [relation],
  catalogSchemaRevision: dataset.schemaRevision,
  now: () => '2026-09-21T00:00:00.000Z',
})

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function executeRequest(sql: string): StructuredQueryExecuteRequest {
  return {
    plan: {
      mode: 'direct',
      statementKind: 'select',
      sql,
      parameters: [...expected.parameters],
      referencedObjects: [OBJECT_REF],
      readOnly: true,
    },
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
    snapshotRequest: { consistency: 'repeatable_read' },
  }
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let businessAdmin: Client | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
const roleName = `x03_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`
const businessDbName = `x03_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`

beforeAll(async () => {
  await duckdbAdapter.start()
  await duckdbAdapter.materialiseRelation(dataset.relation, dataset.rows)

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) {
    container = await startPostgresContainer()
  }
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')
  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const password = `throwaway_${randomBytes(8).toString('hex')}`
  await adminClient.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}'`)

  const businessUrl = connectionStringFor(adminUrl, roleName, password, businessDbName)
  const adminBusinessUrl = connectionStringFor(
    adminUrl,
    'postgres',
    new URL(adminUrl).password,
    businessDbName,
  )
  businessAdmin = new Client({ connectionString: adminBusinessUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE TABLE public.readings (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_kwh numeric(18, 4) NOT NULL,
      quality_flag integer NOT NULL,
      is_estimated boolean NOT NULL
    );
  `)
  for (const row of dataset.rows) {
    await businessAdmin.query(
      'INSERT INTO public.readings (reading_id, meter_id, recorded_at, energy_kwh, quality_flag, is_estimated) VALUES ($1, $2, $3, $4, $5, $6)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`)
  await businessAdmin.query(`GRANT SELECT ON public.readings TO ${roleName}`)

  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mapping: BusinessObjectMapping = {
    objectRef: OBJECT_REF,
    schema: 'public',
    relation: dataset.relation,
    relationKind: 'table',
  }
  postgresAdapter = new PostgresQueryAdapter({
    database,
    mappings: [mapping],
    sourceRef: ENERGY_SOURCE,
  })
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
  duckdbAdapter.close()
})

describe('X-03 cross-engine equivalence (DuckDB vs PostgreSQL)', () => {
  it('produces equal normalised columns, rows and resultDigest in both engines', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')

    const duck = await duckdbAdapter.execute(executeRequest(expected.logicalQuery), duckdbContext())
    const postgres = await pg.execute(executeRequest(expected.postgresQuery), duckdbContext())

    expect(duck.columns).toEqual(expected.columns)
    expect(postgres.columns).toEqual(expected.columns)
    expect(duck.rows).toEqual(expected.rows)
    expect(postgres.rows).toEqual(expected.rows)

    expect(postgres.columns).toEqual(duck.columns)
    expect(postgres.rows).toEqual(duck.rows)
    expect(postgres.snapshot.resultDigest).toBe(duck.snapshot.resultDigest)
    expect(postgres.snapshot.consistency).toBe('repeatable_read')
    expect(duck.snapshot.consistency).toBe('repeatable_read')
    expect(expected.crossEngine.status).toBe('verified')
  }, 120_000)
})
