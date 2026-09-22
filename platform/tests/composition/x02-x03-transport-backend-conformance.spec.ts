import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { connectStdioToolClient } from '@ontology/adapter-transport-mcp'
import type { RemoteToolMapping } from '@ontology/adapter-transport-mcp'
import type {
  DirectSqlQueryPlan,
  ScalarValue,
  StructuredQueryExecuteRequest,
  ToolCall,
  ToolResult,
} from '@ontology/contracts'
import {
  compileSemanticQuery,
  renderCompiledQuery,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { createMcpSchemaValidator } from '../fixtures/mcp/validator'
import {
  MCP_SOURCE,
  buildPlatformSession,
  dataQueryDefinition,
  documentSearchDefinition,
  launcherIdentity,
  ontologyLookupDefinition,
  webSearchDefinition,
} from '../fixtures/mcp/platform-session'
import type { PlatformSession } from '../fixtures/mcp/platform-session'
import {
  COMPILE_BUDGET,
  EXPECTED_COLUMNS,
  MAPPING_B,
  MAPPING_C,
  OBJECT_B,
  OBJECT_C,
  SOURCE_B,
  SOURCE_C,
  rowsForMappingB,
  rowsForMappingC,
  semanticPlan,
} from '../fixtures/semantic-mapping'
import { runContractSuite, compareRuns, type ConformanceCase, type ToolContractTarget } from './conformance'
import { gatewayContext } from '../unit/tool-gateway-fixtures'

/**
 * X-02 and X-03 — the two-transport and two-backend combinations, both real.
 *
 * X-02: the same real `data_query` runs on the in-process local path and behind a real
 * stdio MCP child. Both share the real gateway, handlers, adapter and budget contract, so
 * the only variable is the transport. The suite compares authorization, error and
 * data/evidence semantics through one contract suite.
 *
 * X-03: PostgreSQL and DuckDB are two real `StructuredQueryPort` implementations loaded
 * with the same canonical fixture. The same semantic plan compiles to each dialect and the
 * canonical columns/rows must be equal; unsupported input and unauthorized sources are
 * rejected with the same typed code.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PLATFORM_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STDIO_SERVER = fileURLToPath(new URL('../fixtures/mcp/stdio-server.ts', import.meta.url))
const READ_ONLY_ROLE = `composition_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LOCAL_RUN = '33333333-3333-4333-8333-333333333333'
const LOCAL_LEDGER = '88888888-8888-4888-8888-888888888888'
const STDIO_RUN = '33333333-3333-4333-8333-333333333334'
const STDIO_LEDGER = '88888888-8888-4888-8888-888888888889'

const MAPPINGS: readonly RemoteToolMapping[] = [
  { toolId: 'data_query', remoteName: 'data_query', definition: dataQueryDefinition() },
  { toolId: 'ontology_lookup', remoteName: 'ontology_lookup', definition: ontologyLookupDefinition() },
  { toolId: 'document_search', remoteName: 'document_search', definition: documentSearchDefinition() },
  { toolId: 'web_search', remoteName: 'web_search', definition: webSearchDefinition() },
]

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function declared(objectPath: string): { sourceRef: typeof MCP_SOURCE; objectPath: string } {
  return { sourceRef: MCP_SOURCE, objectPath }
}

function directCall(
  callId: string,
  sql: string,
  parameters: readonly ScalarValue[],
  objectPaths: readonly string[],
): ToolCall {
  const plan: DirectSqlQueryPlan = {
    mode: 'direct',
    statementKind: 'select',
    sql,
    parameters: [...parameters],
    referencedObjects: objectPaths.map(declared),
    readOnly: true,
  }
  return { callId, toolId: 'data_query', arguments: { kind: 'query', mode: 'direct', queryPlan: plan } }
}

/** The canonical X-02 cases: an authorized read, an empty read, a denial and a bad argument. */
function transportCases(): readonly ConformanceCase[] {
  const baseSql = 'SELECT id, customer, amount FROM sales.orders WHERE amount >= $1 ORDER BY id'
  return [
    { caseId: 'authorized', kind: 'authorized', buildCall: (callId) => directCall(callId, baseSql, [20], ['sales.orders']) },
    { caseId: 'empty', kind: 'empty', buildCall: (callId) => directCall(callId, baseSql, [1000], ['sales.orders']) },
    {
      caseId: 'forbidden',
      kind: 'forbidden',
      buildCall: (callId) => ({
        callId,
        toolId: 'data_query',
        arguments: {
          kind: 'query',
          mode: 'direct',
          queryPlan: {
            mode: 'direct',
            statementKind: 'select',
            sql: 'SELECT id FROM sales.orders',
            parameters: [],
            referencedObjects: [{ sourceRef: { namespace: 'other', sourceId: 'unapproved' }, objectPath: 'sales.orders' }],
            readOnly: true,
          },
        },
      }),
    },
    {
      caseId: 'malformed',
      kind: 'malformed',
      buildCall: (callId) => ({
        callId,
        toolId: 'data_query',
        arguments: { kind: 'query', mode: 'direct', queryPlan: { mode: 'direct', sql: 42 } },
      }),
    },
  ]
}

const duckRelation: RegisteredRelation = {
  relation: 'energy_readings_c',
  objectRef: OBJECT_C,
  schemaRevision: '2026-09-01',
  columns: [
    { name: 'reading_id', type: 'string' },
    { name: 'meter_id', type: 'string' },
    { name: 'recorded_at', type: 'timestamp' },
    { name: 'energy_kwh', type: 'decimal' },
    { name: 'status_text', type: 'string' },
  ],
  physicalTypes: { energy_kwh: 'DECIMAL(18,4)', recorded_at: 'TIMESTAMP' },
}

function executeRequestFor(mapping: SemanticMapping): StructuredQueryExecuteRequest {
  const compiled = compileSemanticQuery(semanticPlan(mapping), mapping, { budget: COMPILE_BUDGET })
  const rendered = renderCompiledQuery(compiled)
  const plan: DirectSqlQueryPlan = {
    mode: 'direct',
    statementKind: 'select',
    sql: rendered.sql,
    parameters: [...rendered.parameters],
    referencedObjects: [...rendered.referencedObjects],
    readOnly: true,
  }
  return {
    plan,
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
    snapshotRequest: { consistency: 'repeatable_read' },
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

async function captureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    return errorCodeOf(error)
  }
  throw new Error('expected the operation to be rejected')
}

let container: PostgresContainer | undefined
let adminClient: Client
let appUrl = ''
let businessUrl = ''
let objectDir = ''
let platformLocal: PlatformSession | undefined
let stdioClient: Awaited<ReturnType<typeof connectStdioToolClient>> | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
let businessDb: BusinessPostgresDatabase | undefined
const duckdbAdapter = new DuckDbQueryAdapter({
  relations: [duckRelation],
  catalogSchemaRevision: '2026-09-01',
  consistency: 'repeatable_read',
})

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

beforeAll(async () => {
  await duckdbAdapter.start()
  await duckdbAdapter.materialiseRelation('energy_readings_c', rowsForMappingC())

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) container = await startPostgresContainer()
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')
  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'composition-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'composition-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const appStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = appStatement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres')

  const businessDbName = `composition_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const readerPassword = `throwaway_${randomBytes(8).toString('hex')}`
  const readerStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('CREATE ROLE ' || quote_ident($1) || ' LOGIN PASSWORD %L', $2::text) AS statement",
    [READ_ONLY_ROLE, readerPassword],
  )
  const createReader = readerStatement.rows[0]?.statement
  if (createReader === undefined) throw new Error('could not build the read-only role statement')
  await adminClient.query(createReader)
  businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, readerPassword, businessDbName)
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
    INSERT INTO sales.orders (id, customer, amount, created_at) VALUES
      (1, 'acme', 10.50, '2026-01-01T00:00:00Z'),
      (2, 'beta', 20.00, '2026-01-02T00:00:00Z'),
      (3, 'acme', 30.25, '2026-01-03T00:00:00Z'),
      (4, 'gamma', 40.00, '2026-01-04T00:00:00Z');
    CREATE TABLE public.energy_readings_b (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_kwh numeric(18, 4) NOT NULL,
      quality_label text NOT NULL
    );
  `)
  for (const row of rowsForMappingB()) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_b (reading_id, meter_id, recorded_at, energy_kwh, quality_label) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON sales.orders TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_b TO ${READ_ONLY_ROLE}`)
  await businessAdmin.end()

  objectDir = await mkdtemp(join(tmpdir(), 'composition-blob-'))
  platformLocal = await buildPlatformSession({
    controlDatabaseUrl: appUrl,
    businessDatabaseUrl: businessUrl,
    objectDir,
    identity: launcherIdentity({ runId: LOCAL_RUN, sessionId: 'composition-local', tenantId: TENANT, spaceId: SPACE }),
    ledgerId: LOCAL_LEDGER,
  })

  stdioClient = await connectStdioToolClient({
    command: process.execPath,
    args: ['--import', 'tsx', STDIO_SERVER],
    cwd: PLATFORM_ROOT,
    env: {
      ...baseEnv(),
      MCP_CONTROL_DATABASE_URL: appUrl,
      MCP_BUSINESS_DATABASE_URL: businessUrl,
      MCP_OBJECT_DIR: objectDir,
      MCP_RUN_ID: STDIO_RUN,
      MCP_LEDGER_ID: STDIO_LEDGER,
      MCP_TENANT_ID: TENANT,
      MCP_SPACE_ID: SPACE,
      MCP_SESSION_ID: 'composition-stdio',
    },
    stderr: 'inherit',
    mappings: MAPPINGS,
    validator: createMcpSchemaValidator(),
  })

  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mapping: BusinessObjectMapping = {
    objectRef: OBJECT_B,
    schema: 'public',
    relation: 'energy_readings_b',
    relationKind: 'table',
  }
  postgresAdapter = new PostgresQueryAdapter({ database, mappings: [mapping], sourceRef: SOURCE_B })
}, 300_000)

afterAll(async () => {
  await stdioClient?.close().catch(() => undefined)
  await platformLocal?.close().catch(() => undefined)
  await businessDb?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
  duckdbAdapter.close()
})

describe('X-02 — local and stdio MCP conform to the same gateway contract', () => {
  it('agrees on authorization, error, data and evidence for the same real data_query', async () => {
    const client = stdioClient
    const local = platformLocal
    if (client === undefined) throw new Error('the stdio client was not connected')
    if (local === undefined) throw new Error('the local platform session was not built')
    const localTarget: ToolContractTarget = {
      label: 'local',
      invoke: (call: ToolCall): Promise<ToolResult> => local.gateway.invoke(call, local.context),
    }
    const stdioTarget: ToolContractTarget = {
      label: 'stdio',
      invoke: (call: ToolCall): Promise<ToolResult> => client.invoke(call, local.context),
    }
    const cases = transportCases()
    const localRun = await runContractSuite(localTarget, cases, () => randomUUID())
    const stdioRun = await runContractSuite(stdioTarget, cases, () => randomUUID())

    // Equal status, error code, canonical rows/columns, coverage and logical evidence digest.
    expect(compareRuns(localRun, stdioRun)).toEqual([])

    expect(localRun.get('authorized')?.status).toBe('ok')
    expect(localRun.get('empty')?.coverageReturned).toBe(0)
    expect(localRun.get('forbidden')?.errorCode).toBe('FORBIDDEN')
    expect(stdioRun.get('forbidden')?.errorCode).toBe('FORBIDDEN')
    expect(localRun.get('malformed')?.status).toBe('error')
  }, 120_000)
})

describe('X-03 — PostgreSQL and DuckDB conform to the same structured-query contract', () => {
  it('produces equal canonical columns and rows for the same semantic fixture', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx = gatewayContext({ sourceRefs: [SOURCE_B, SOURCE_C], deadline: '2099-01-01T00:00:00Z' })

    const postgres = await pg.execute(executeRequestFor(MAPPING_B), ctx)
    const duck = await duckdbAdapter.execute(executeRequestFor(MAPPING_C), ctx)

    expect(postgres.columns).toEqual(EXPECTED_COLUMNS)
    expect(duck.columns).toEqual(EXPECTED_COLUMNS)
    expect(postgres.rows).toEqual(duck.rows)
    expect(duck.rows.length).toBeGreaterThan(0)
    expect(duck.snapshot.consistency).toBe(postgres.snapshot.consistency)
  }, 120_000)

  it('agrees on the authorization and unsupported-mode rejections', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const unauthorized = gatewayContext({ sourceRefs: [], deadline: '2099-01-01T00:00:00Z' })

    const postgresDenied = await captureCode(() => pg.execute(executeRequestFor(MAPPING_B), unauthorized))
    const duckDenied = await captureCode(() => duckdbAdapter.execute(executeRequestFor(MAPPING_C), unauthorized))
    expect(postgresDenied).toBe('FORBIDDEN')
    expect(duckDenied).toBe('FORBIDDEN')

    // A semantic plan is not the adapters' job: both report it as an unsupported query.
    const semanticPlanRejection = {
      plan: semanticPlan(MAPPING_B),
      limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
    }
    const postgresValidate = await pg.validate(semanticPlanRejection, unauthorized)
    const duckValidate = await duckdbAdapter.validate(semanticPlanRejection, unauthorized)
    expect(postgresValidate.valid).toBe(false)
    expect(duckValidate.valid).toBe(false)
    expect(postgresValidate.rejectedReason?.code).toBe('UNSUPPORTED_QUERY')
    expect(duckValidate.rejectedReason?.code).toBe('UNSUPPORTED_QUERY')
  }, 120_000)
})
