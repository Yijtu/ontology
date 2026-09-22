import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import type {
  BudgetLedgerPort,
  DataQueryOutput,
  DirectSqlQueryPlan,
  ScalarValue,
  StructuredQueryExecuteRequest,
  ToolContext,
  ToolResult,
} from '@ontology/contracts'
import {
  InMemorySemanticMappingRegistry,
  compileSemanticQuery,
  renderCompiledQuery,
  type CompilationBudget,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import { DataQueryHandler, createRunToolGateway } from '@ontology/tool-services'
import {
  COMPILE_BUDGET,
  EXPECTED_COLUMNS,
  EXPECTED_ROWS,
  MAPPING_A,
  MAPPING_B,
  MAPPING_C,
  MAPPING_CROSS_SOURCE,
  METER_CONCEPT,
  OBJECT_A,
  OBJECT_B,
  OBJECT_C,
  READING_CONCEPT,
  SOURCE_A,
  SOURCE_B,
  SOURCE_C,
  rowsForMappingA,
  rowsForMappingB,
  rowsForMappingC,
  semanticPlan,
} from '../fixtures/semantic-mapping'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  GATEWAY_LEDGER,
  GATEWAY_RUN,
  InMemoryArtifactWriter,
  InMemoryEvidenceStore,
  canonicalToolValidator,
  fullProfile,
  gatewayContext,
  operationRegistry,
} from '../unit/tool-gateway-fixtures'
import { RecordingControlRepository } from '../unit/component-registry-fixtures'

/**
 * LOCAL-026 acceptance against real engines (V2 X-03).
 *
 * The same semantic concept query is compiled against two different PostgreSQL mappings
 * (different physical columns, status encodings and energy units) and one DuckDB mapping.
 * The normalised results must be equal, and each compiled query carries the actual mapping
 * version it used. The PostgreSQL side runs against a throwaway container; the DuckDB side
 * runs in-process.
 */

const READ_ONLY_ROLE = `semantic_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function executeRequest(
  mapping: SemanticMapping,
  budget: CompilationBudget = COMPILE_BUDGET,
): StructuredQueryExecuteRequest {
  const compiled = compileSemanticQuery(semanticPlan(mapping), mapping, { budget })
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

const duckdbAdapter = new DuckDbQueryAdapter({
  relations: [duckRelation],
  catalogSchemaRevision: '2026-09-01',
  consistency: 'repeatable_read',
})

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let businessAdmin: Client | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
const businessDbName = `semantic_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`

function buildGateway(handler: DataQueryHandler): {
  readonly gateway: ReturnType<typeof createRunToolGateway>
  readonly budget: BudgetLedgerPort
  readonly evidence: InMemoryEvidenceStore
} {
  const ledgerStore = new InMemoryBudgetLedgerStore()
  const inner = new BudgetService({
    store: ledgerStore,
    control: new RecordingControlRepository(),
    now: () => new Date().toISOString(),
  })
  const budget: BudgetLedgerPort = {
    openLedger: (input, ctx) => inner.openLedger(input, ctx),
    reserve: (input, ctx) => inner.reserve(input, ctx),
    recordIntent: (input, ctx) => inner.recordIntent(input, ctx),
    settle: (input, ctx) => inner.settle(input, ctx),
    remaining: (ledgerId, ctx) => inner.remaining(ledgerId, ctx),
  }
  const evidence = new InMemoryEvidenceStore()
  const artifacts = new InMemoryArtifactWriter()
  const gateway = createRunToolGateway(
    { validator: canonicalToolValidator(), budget, evidence, artifacts, handlers: [handler] },
    {
      runId: GATEWAY_RUN,
      ledgerId: GATEWAY_LEDGER,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    },
  )
  return { gateway, budget, evidence }
}

async function invokeSemantic(
  mapping: SemanticMapping,
  adapter: PostgresQueryAdapter,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handler = new DataQueryHandler({
    query: adapter,
    mappings: new InMemorySemanticMappingRegistry([mapping]),
  })
  const harness = buildGateway(handler)
  await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)
  return harness.gateway.invoke(
    {
      callId: '11111111-2222-4333-8444-555555555555',
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'semantic', queryPlan: semanticPlan(mapping) },
    },
    ctx,
  )
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

  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const password = `throwaway_${randomBytes(8).toString('hex')}`
  await adminClient.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${password}'`)

  const adminBusinessUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  businessAdmin = new Client({ connectionString: adminBusinessUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE TABLE public.energy_readings_a (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_wh numeric(18, 1) NOT NULL,
      quality_code integer NOT NULL
    );
    CREATE TABLE public.energy_readings_b (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_kwh numeric(18, 4) NOT NULL,
      quality_label text NOT NULL
    );
  `)
  for (const row of rowsForMappingA()) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_a (reading_id, meter_id, recorded_at, energy_wh, quality_code) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  for (const row of rowsForMappingB()) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_b (reading_id, meter_id, recorded_at, energy_kwh, quality_label) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_a TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_b TO ${READ_ONLY_ROLE}`)

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, password, businessDbName)
  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mappings: BusinessObjectMapping[] = [
    { objectRef: OBJECT_A, schema: 'public', relation: 'energy_readings_a', relationKind: 'table' },
    { objectRef: OBJECT_B, schema: 'public', relation: 'energy_readings_b', relationKind: 'table' },
  ]
  postgresAdapter = new PostgresQueryAdapter({ database, mappings, sourceRef: SOURCE_A })
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
  duckdbAdapter.close()
})

describe('semantic query compilation against real engines', () => {
  it('produces equal normalised results for two different PostgreSQL mappings', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B, SOURCE_C], deadline: '2099-01-01T00:00:00Z' })

    const resultA = await invokeSemantic(MAPPING_A, pg, ctx)
    const resultB = await invokeSemantic(MAPPING_B, pg, ctx)
    expect(resultA.status).toBe('ok')
    expect(resultB.status).toBe('ok')

    const dataA = resultA.inlineData as DataQueryOutput | undefined
    const dataB = resultB.inlineData as DataQueryOutput | undefined
    expect(dataA?.table?.columns).toEqual(EXPECTED_COLUMNS)
    expect(dataA?.table?.rows).toEqual(EXPECTED_ROWS)
    expect(dataB?.table?.rows).toEqual(dataA?.table?.rows)

    // Each result is tagged with the actual mapping version that produced it.
    expect(resultA.warnings[0]?.message).toContain(`${MAPPING_A.mappingRef.id}@${MAPPING_A.mappingRef.version}`)
    expect(resultB.warnings[0]?.message).toContain(`${MAPPING_B.mappingRef.id}@${MAPPING_B.mappingRef.version}`)
    expect(resultA.warnings[0]?.message).not.toBe(resultB.warnings[0]?.message)
  }, 120_000)

  it('produces the same normalised result in DuckDB and PostgreSQL (X-03)', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B, SOURCE_C], deadline: '2099-01-01T00:00:00Z' })

    const postgres = await pg.execute(executeRequest(MAPPING_B), ctx)
    const duck = await duckdbAdapter.execute(executeRequest(MAPPING_C), ctx)

    expect(postgres.columns).toEqual(EXPECTED_COLUMNS)
    expect(duck.columns).toEqual(EXPECTED_COLUMNS)
    expect(postgres.rows).toEqual(EXPECTED_ROWS)
    expect(duck.rows).toEqual(EXPECTED_ROWS)
    expect(duck.snapshot.resultDigest).toBe(postgres.snapshot.resultDigest)
  }, 120_000)

  it('refuses an over-budget cross-source join before any adapter call', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B, SOURCE_C], deadline: '2099-01-01T00:00:00Z' })
    const handler = new DataQueryHandler({
      query: pg,
      mappings: new InMemorySemanticMappingRegistry([MAPPING_CROSS_SOURCE]),
    })
    const harness = buildGateway(handler)
    await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)

    const plan = {
      ...semanticPlan(MAPPING_CROSS_SOURCE),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id'],
      filters: [],
      orderBy: [],
      links: ['reading_meter'],
    }
    const result = await harness.gateway.invoke(
      { callId: '11111111-2222-4333-8444-555555555556', toolId: 'data_query', arguments: { kind: 'query', mode: 'semantic', queryPlan: plan } },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('BUDGET_EXHAUSTED')
    expect(result.evidenceRefs).toHaveLength(0)
  }, 60_000)

  it('keeps the direct path working without the ontology layer', async () => {
    const pg = postgresAdapter
    if (pg === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B, SOURCE_C], deadline: '2099-01-01T00:00:00Z' })
    const handler = new DataQueryHandler({
      query: pg,
      mappings: new InMemorySemanticMappingRegistry([]),
    })
    const harness = buildGateway(handler)
    await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)

    const result = await harness.gateway.invoke(
      {
        callId: '11111111-2222-4333-8444-555555555557',
        toolId: 'data_query',
        arguments: {
          kind: 'query',
          mode: 'direct',
          queryPlan: {
            mode: 'direct',
            statementKind: 'select',
            sql: 'SELECT meter_id, energy_kwh FROM public.energy_readings_b WHERE quality_label = $1 ORDER BY meter_id',
            parameters: ['OK'] as ScalarValue[],
            referencedObjects: [OBJECT_B],
            readOnly: true,
          },
        },
      },
      ctx,
    )
    expect(result.status).toBe('ok')
    const data = result.inlineData as DataQueryOutput | undefined
    const rows = (data?.table?.rows ?? []) as readonly unknown[][]
    expect(rows.length).toBe(4)
    expect(result.evidenceRefs).toHaveLength(1)
  }, 60_000)
})
