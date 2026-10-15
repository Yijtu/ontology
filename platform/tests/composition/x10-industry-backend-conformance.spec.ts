import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import type {
  DirectSqlQueryPlan,
  QueryLimits,
  SemanticQueryPlan,
  SourceRef,
  StructuredQueryValidateResponse,
  ToolCall,
  ToolContext,
  ToolResult,
} from '@ontology/contracts'
import { InMemorySemanticMappingRegistry, type SemanticMapping } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { buildGateway, gatewayContext, openGatewayLedger } from '../unit/tool-gateway-fixtures'
import {
  AUTOMOTIVE_COLUMNS,
  AUTOMOTIVE_CONCEPT,
  AUTOMOTIVE_DATASET,
  AUTOMOTIVE_GOLDEN_ROWS,
  AUTOMOTIVE_MAPPING,
  AUTOMOTIVE_OBJECT,
  AUTOMOTIVE_OUTPUT_COLUMNS,
  AUTOMOTIVE_RELATION,
  AUTOMOTIVE_ROWS,
  AUTOMOTIVE_SOURCE,
  BUSINESS_PG_RELATION,
  BUSINESS_PG_SCHEMA,
  INDUSTRY_SCHEMA_REVISION,
  TRANSPORT_COLUMNS_A,
  TRANSPORT_COLUMNS_B,
  TRANSPORT_CONCEPT,
  TRANSPORT_DATASET,
  TRANSPORT_GOLDEN_ROWS,
  TRANSPORT_MAPPING_A,
  TRANSPORT_MAPPING_A_PG,
  TRANSPORT_MAPPING_B,
  TRANSPORT_NAMESPACE,
  TRANSPORT_OBJECT_A,
  TRANSPORT_OBJECT_B,
  TRANSPORT_OBJECT_PG,
  TRANSPORT_OUTPUT_COLUMNS,
  TRANSPORT_RELATION_A,
  TRANSPORT_RELATION_B,
  TRANSPORT_ROWS_A,
  TRANSPORT_ROWS_B,
  TRANSPORT_SOURCE_A,
  TRANSPORT_SOURCE_B,
  automotivePlan,
  facilityPlan,
  semanticFingerprint,
} from '../fixtures/industry-conformance'
import { compareObservations, observeToolResult } from './conformance'

/**
 * X-10 — two industries, two mappings and two business SQL backends through one public contract
 * (V03-043, A.US-015.AC-01/02/03; SPEC v0.3 §7.3).
 *
 * The `data_query` semantic contract is the seam. Everything an industry needs — its concept,
 * its physical relation, its unit/value encoding and its source binding — is injected as a
 * confirmed mapping; the handler, gateway and code path are the same for every industry. This
 * suite proves the four ACs together:
 *
 *  - US-015.AC-01: `transport-government` and `automotive` produce *independent* golden results
 *    through the same `DataQueryHandler` + gateway, with no industry branch anywhere in the path.
 *  - US-006.AC-03: two physical mappings (naming A / naming B) of the same business data compile
 *    to equal canonical rows, while each result's source snapshot locates its own physical object.
 *  - US-015.AC-02/03: a real DuckDB backend and a real *business* PostgreSQL backend (a distinct
 *    database/schema, never the control database) run the same semantic mapping; the contract
 *    observation is identical. The control PostgreSQL database is explicitly excluded by a
 *    negative check: a control relation is not in the principal's confirmed mapping.
 *  - US-015.AC-04: the generic packages and the public web app carry no industry token.
 */

const FAR_FUTURE = '2099-01-01T00:00:00Z'
const READ_ONLY_ROLE = `x10_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`
const BUSINESS_DATABASE = `x10_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`

const LIMITS: QueryLimits = { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 }

/** A source that only exists in the control plane, never in the business database. */
const CONTROL_SOURCE: SourceRef = { namespace: 'control', sourceId: 'platform-control' }

const DUCK_RELATIONS: readonly RegisteredRelation[] = [
  {
    relation: TRANSPORT_RELATION_A,
    objectRef: TRANSPORT_OBJECT_A,
    schemaRevision: INDUSTRY_SCHEMA_REVISION,
    columns: TRANSPORT_COLUMNS_A,
  },
  {
    relation: TRANSPORT_RELATION_B,
    objectRef: TRANSPORT_OBJECT_B,
    schemaRevision: INDUSTRY_SCHEMA_REVISION,
    columns: TRANSPORT_COLUMNS_B,
  },
  {
    relation: AUTOMOTIVE_RELATION,
    objectRef: AUTOMOTIVE_OBJECT,
    schemaRevision: INDUSTRY_SCHEMA_REVISION,
    columns: AUTOMOTIVE_COLUMNS,
  },
]

const duckdb = new DuckDbQueryAdapter({
  relations: DUCK_RELATIONS,
  catalogSchemaRevision: INDUSTRY_SCHEMA_REVISION,
  consistency: 'repeatable_read',
})

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
let controlDatabase = ''

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function semanticHandler(query: DuckDbQueryAdapter | PostgresQueryAdapter, mapping: SemanticMapping): DataQueryHandler {
  return new DataQueryHandler({ query, mappings: new InMemorySemanticMappingRegistry([mapping]) })
}

async function invokeSemantic(
  handler: DataQueryHandler,
  sourceRefs: readonly SourceRef[],
  plan: SemanticQueryPlan,
): Promise<ToolResult> {
  const ctx: ToolContext = gatewayContext({ sourceRefs: [...sourceRefs], deadline: FAR_FUTURE })
  const harness = buildGateway({ handlers: [handler], ctx })
  await openGatewayLedger(harness, ctx)
  const call: ToolCall = {
    callId: randomUUID(),
    toolId: 'data_query',
    arguments: { kind: 'query', mode: 'semantic', queryPlan: plan },
  }
  return harness.gateway.invoke(call, ctx)
}

beforeAll(async () => {
  await duckdb.start()
  await duckdb.materialiseRelation(TRANSPORT_RELATION_A, TRANSPORT_ROWS_A)
  await duckdb.materialiseRelation(TRANSPORT_RELATION_B, TRANSPORT_ROWS_B)
  await duckdb.materialiseRelation(AUTOMOTIVE_RELATION, AUTOMOTIVE_ROWS)

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) container = await startPostgresContainer()
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')

  const admin = new Client({ connectionString: adminUrl })
  adminClient = admin
  await admin.connect()
  const controlRow = await admin.query<{ db: string }>('SELECT current_database() AS db')
  controlDatabase = controlRow.rows[0]?.db ?? ''

  await admin.query(`CREATE DATABASE ${BUSINESS_DATABASE}`)
  const readerPassword = `throwaway_${randomBytes(8).toString('hex')}`
  await admin.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${readerPassword}'`)

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, readerPassword, BUSINESS_DATABASE)
  const businessAdminUrl = connectionStringFor(
    adminUrl,
    'postgres',
    new URL(adminUrl).password,
    BUSINESS_DATABASE,
  )
  const businessAdmin = new Client({ connectionString: businessAdminUrl })
  try {
    await businessAdmin.connect()
    await businessAdmin.query(`
      CREATE SCHEMA ${BUSINESS_PG_SCHEMA};
      CREATE TABLE ${BUSINESS_PG_SCHEMA}.${BUSINESS_PG_RELATION} (
        facility_key text PRIMARY KEY,
        district_code text NOT NULL,
        condition_code integer NOT NULL
      );
    `)
    for (const row of TRANSPORT_ROWS_A) {
      await businessAdmin.query(
        `INSERT INTO ${BUSINESS_PG_SCHEMA}.${BUSINESS_PG_RELATION} (facility_key, district_code, condition_code) VALUES ($1, $2, $3)`,
        [...row],
      )
    }
    await businessAdmin.query(`GRANT USAGE ON SCHEMA ${BUSINESS_PG_SCHEMA} TO ${READ_ONLY_ROLE}`)
    await businessAdmin.query(
      `GRANT SELECT ON ${BUSINESS_PG_SCHEMA}.${BUSINESS_PG_RELATION} TO ${READ_ONLY_ROLE}`,
    )
  } finally {
    await businessAdmin.end().catch(() => undefined)
  }

  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mapping: BusinessObjectMapping = {
    objectRef: TRANSPORT_OBJECT_PG,
    schema: BUSINESS_PG_SCHEMA,
    relation: BUSINESS_PG_RELATION,
    relationKind: 'table',
  }
  postgresAdapter = new PostgresQueryAdapter({
    database,
    mappings: [mapping],
    sourceRef: TRANSPORT_SOURCE_A,
  })
}, 300_000)

afterAll(async () => {
  duckdb.close()
  await businessDb?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

function requirePostgres(): PostgresQueryAdapter {
  const adapter = postgresAdapter
  if (adapter === undefined) throw new Error('the business PostgreSQL adapter was not initialised')
  return adapter
}

describe('US-015.AC-01 — two industries produce independent golden results through one contract', () => {
  it('serves transport-government and automotive with the same handler class and gateway', async () => {
    const transport = observeToolResult(
      await invokeSemantic(
        semanticHandler(duckdb, TRANSPORT_MAPPING_A),
        [TRANSPORT_SOURCE_A],
        facilityPlan(TRANSPORT_MAPPING_A),
      ),
    )
    const automotive = observeToolResult(
      await invokeSemantic(
        semanticHandler(duckdb, AUTOMOTIVE_MAPPING),
        [AUTOMOTIVE_SOURCE],
        automotivePlan(AUTOMOTIVE_MAPPING),
      ),
    )

    // Each industry's result is its own independently derived golden, not a copy of the other.
    expect(transport.status).toBe('ok')
    expect(transport.columns).toEqual(TRANSPORT_OUTPUT_COLUMNS)
    expect(transport.rows).toEqual(TRANSPORT_GOLDEN_ROWS)
    expect(automotive.status).toBe('ok')
    expect(automotive.columns).toEqual(AUTOMOTIVE_OUTPUT_COLUMNS)
    expect(automotive.rows).toEqual(AUTOMOTIVE_GOLDEN_ROWS)
    expect(transport.rows).not.toEqual(automotive.rows)

    // The industry identity is carried only by the physical mapping's source ref.
    expect(TRANSPORT_OBJECT_A.sourceRef.namespace).toBe(TRANSPORT_NAMESPACE)
    expect(AUTOMOTIVE_OBJECT.sourceRef.namespace).toBe(AUTOMOTIVE_DATASET.namespace)
    expect(TRANSPORT_DATASET.conceptId).toBe(TRANSPORT_CONCEPT)
    expect(AUTOMOTIVE_DATASET.conceptId).toBe(AUTOMOTIVE_CONCEPT)
  })

  it('locates each result at the industry physical object it read', async () => {
    const transport = await invokeSemantic(
      semanticHandler(duckdb, TRANSPORT_MAPPING_A),
      [TRANSPORT_SOURCE_A],
      facilityPlan(TRANSPORT_MAPPING_A),
    )
    const automotive = await invokeSemantic(
      semanticHandler(duckdb, AUTOMOTIVE_MAPPING),
      [AUTOMOTIVE_SOURCE],
      automotivePlan(AUTOMOTIVE_MAPPING),
    )
    expect(transport.sourceSnapshots[0]?.sourceRef).toEqual(TRANSPORT_SOURCE_A)
    expect(automotive.sourceSnapshots[0]?.sourceRef).toEqual(AUTOMOTIVE_SOURCE)
    expect(transport.warnings[0]?.message).toContain(TRANSPORT_MAPPING_A.mappingRef.id)
    expect(automotive.warnings[0]?.message).toContain(AUTOMOTIVE_MAPPING.mappingRef.id)
  })
})

describe('US-006.AC-03 — two physical mappings of one business data are semantically consistent', () => {
  it('returns equal canonical rows while each result points at its own physical object', async () => {
    const namingA = await invokeSemantic(
      semanticHandler(duckdb, TRANSPORT_MAPPING_A),
      [TRANSPORT_SOURCE_A],
      facilityPlan(TRANSPORT_MAPPING_A),
    )
    const namingB = await invokeSemantic(
      semanticHandler(duckdb, TRANSPORT_MAPPING_B),
      [TRANSPORT_SOURCE_B],
      facilityPlan(TRANSPORT_MAPPING_B),
    )
    const observationA = observeToolResult(namingA)
    const observationB = observeToolResult(namingB)

    expect(observationA.rows).toEqual(TRANSPORT_GOLDEN_ROWS)
    expect(observationB.rows).toEqual(TRANSPORT_GOLDEN_ROWS)
    // Different physical column names, status encodings and sources must not change the result.
    expect(compareObservations(observationA, observationB, ['logicalEvidenceDigest'])).toEqual([])
    // The two mappings bind different source objects, so the evidence identity legitimately differs.
    expect(observationA.logicalEvidenceDigest).not.toBe(observationB.logicalEvidenceDigest)
    expect(namingA.sourceSnapshots[0]?.sourceRef).toEqual(TRANSPORT_SOURCE_A)
    expect(namingB.sourceSnapshots[0]?.sourceRef).toEqual(TRANSPORT_SOURCE_B)
    expect(namingA.warnings[0]?.message).toContain(TRANSPORT_MAPPING_A.mappingRef.id)
    expect(namingB.warnings[0]?.message).toContain(TRANSPORT_MAPPING_B.mappingRef.id)
  })
})

describe('US-015.AC-02/03 — two business SQL backends run the same semantic mapping', () => {
  it('matches the DuckDB and business PostgreSQL contract observations for one mapping', async () => {
    const pg = requirePostgres()
    const duckResult = await invokeSemantic(
      semanticHandler(duckdb, TRANSPORT_MAPPING_A),
      [TRANSPORT_SOURCE_A],
      facilityPlan(TRANSPORT_MAPPING_A),
    )
    const postgresResult = await invokeSemantic(
      semanticHandler(pg, TRANSPORT_MAPPING_A_PG),
      [TRANSPORT_SOURCE_A],
      facilityPlan(TRANSPORT_MAPPING_A_PG),
    )
    const duckObservation = observeToolResult(duckResult)
    const postgresObservation = observeToolResult(postgresResult)

    expect(duckObservation.rows).toEqual(TRANSPORT_GOLDEN_ROWS)
    expect(postgresObservation.rows).toEqual(TRANSPORT_GOLDEN_ROWS)
    expect(postgresObservation.columns).toEqual(TRANSPORT_OUTPUT_COLUMNS)
    // Same logical data, same contract: only the physical engine/dialect differs.
    expect(compareObservations(duckObservation, postgresObservation, ['logicalEvidenceDigest'])).toEqual([])
    expect(duckObservation.snapshotConsistency).toBe('repeatable_read')
    expect(postgresObservation.snapshotConsistency).toBe('repeatable_read')
    // The two mappings are the same semantic mapping, modulo dialect and physical binding.
    expect(semanticFingerprint(TRANSPORT_MAPPING_A_PG)).toBe(semanticFingerprint(TRANSPORT_MAPPING_A))
  })

  it('uses a distinct business database, not the control PostgreSQL database', async () => {
    const pg = requirePostgres()
    expect(controlDatabase).not.toBe('')
    expect(BUSINESS_DATABASE).not.toBe(controlDatabase)
    expect(pg.adapterRef.id).toBe('@ontology/adapter-data-postgres')

    const businessDb = requireDatabase()
    const businessRow = await businessDb.query<{ db: string }>('SELECT current_database() AS db')
    expect(businessRow[0]?.db).toBe(BUSINESS_DATABASE)
    expect(businessRow[0]?.db).not.toBe(controlDatabase)
  })

  it('refuses a control-database relation instead of reading it as business data', async () => {
    const pg = requirePostgres()
    const controlPlan: DirectSqlQueryPlan = {
      mode: 'direct',
      statementKind: 'select',
      sql: 'SELECT tenant_id FROM "agent_platform"."tenants"',
      parameters: [],
      referencedObjects: [{ sourceRef: CONTROL_SOURCE, objectPath: 'agent_platform.tenants' }],
      readOnly: true,
    }
    const ctx = gatewayContext({ sourceRefs: [CONTROL_SOURCE], deadline: FAR_FUTURE })
    const validation: StructuredQueryValidateResponse = await pg.validate(
      { plan: controlPlan, limits: LIMITS },
      ctx,
    )
    expect(validation.valid).toBe(false)
    expect(validation.rejectedReason?.code).toBe('FORBIDDEN')
  })
})

describe('US-015.AC-04 — the generic packages and public web app carry no industry branch', () => {
  const platformRoot = fileURLToPath(new URL('../..', import.meta.url))
  const genericSources = [
    'packages/core/src',
    'packages/application/src',
    'packages/tool-services/src',
    'packages/semantic-engine/src',
    'apps/web/src',
  ]
  const industryToken = /transport-government|automotive|road_facilit|charging_station/i

  function sourceFiles(relative: string): readonly string[] {
    const root = `${platformRoot.replaceAll('\\', '/')}/${relative}`
    return readdirSync(root, { recursive: true, withFileTypes: false })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => `${root}/${entry}`)
  }

  it('keeps every generic package and the public web shell free of an industry identifier', () => {
    const offenders: string[] = []
    for (const relative of genericSources) {
      for (const file of sourceFiles(relative)) {
        if (industryToken.test(readFileSync(file, 'utf8'))) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

function requireDatabase(): BusinessPostgresDatabase {
  const database = businessDb
  if (database === undefined) throw new Error('the business PostgreSQL database was not initialised')
  return database
}
