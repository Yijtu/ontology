import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import type {
  BudgetLedgerPort,
  DataQueryOutput,
  DirectSqlQueryPlan,
  SemanticQueryCompilerPort,
  SemanticQueryPlan,
  ToolContext,
} from '@ontology/contracts'
import { NoProgressGuard, RunPlanner, SmallPlanExecutor } from '@ontology/application'
import {
  InMemorySemanticMappingRegistry,
  compileSemanticQuery,
  renderCompiledQuery,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import { DataQueryHandler, createRunToolGateway } from '@ontology/tool-services'
import {
  COMPILE_BUDGET,
  MAPPING_JOIN,
  METER_A,
  METER_CONCEPT,
  OBJECT_A,
  READING_CONCEPT,
  SOURCE_A,
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
import { CountingGeneration } from '../unit/workflow-planning-fixtures'
import {
  publishedVocabularyDefinition,
  vocabularyService,
} from '../fixtures/schema-vocabulary'

/**
 * LOCAL-020 acceptance against a real PostgreSQL container.
 *
 * A three-concept/two-link semantic question is compiled by the real semantic compiler
 * into ONE bounded query and executed through the real tool gateway against real tables.
 * The route planner makes no model call per hop, and the bounded loop detects an identical
 * repeat instead of re-executing it. Nothing here is mocked at the database or gateway
 * boundary.
 */

const READ_ONLY_ROLE = `route_plan_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

/** The real semantic compiler wrapped as the application-layer port. */
function compilerFor(mapping: SemanticMapping): SemanticQueryCompilerPort {
  return {
    compile: (plan: SemanticQueryPlan, ctx: ToolContext) => {
      void ctx
      const compiled = compileSemanticQuery(plan, mapping, { budget: COMPILE_BUDGET })
      const rendered = renderCompiledQuery(compiled)
      const directPlan: DirectSqlQueryPlan = {
        mode: 'direct',
        statementKind: 'select',
        sql: rendered.sql,
        parameters: [...rendered.parameters],
        referencedObjects: [...rendered.referencedObjects],
        readOnly: true,
      }
      return Promise.resolve({ plan: directPlan, mappingRef: mapping.mappingRef, warnings: [] })
    },
  }
}

function multiHopPlan(): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [READING_CONCEPT, METER_CONCEPT],
    fields: ['meter_name', 'energy_kwh'],
    links: ['reading_meter'],
    filters: [],
    orderBy: [
      { fieldRef: 'meter_name', direction: 'asc' },
      { fieldRef: 'energy_kwh', direction: 'asc' },
    ],
    limit: 50,
    mappingVersion: MAPPING_JOIN.mappingRef,
  }
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let businessAdmin: Client | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
const businessDbName = `route_plan_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`

beforeAll(async () => {
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
    CREATE TABLE public.meters_a (
      meter_id text PRIMARY KEY,
      meter_name text NOT NULL
    );
  `)
  await businessAdmin.query(
    'INSERT INTO public.meters_a (meter_id, meter_name) VALUES ($1, $2), ($3, $4)',
    ['m1', 'Meter One', 'm2', 'Meter Two'],
  )
  const readings: readonly (readonly (string | number)[])[] = [
    ['r1', 'm1', '2026-01-01T00:00:00Z', 12_500, 1],
    ['r2', 'm1', '2026-01-02T00:00:00Z', 8_250, 0],
    ['r3', 'm2', '2026-01-03T00:00:00Z', 15_000, 1],
  ]
  for (const row of readings) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_a (reading_id, meter_id, recorded_at, energy_wh, quality_code) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_a TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.meters_a TO ${READ_ONLY_ROLE}`)

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, password, businessDbName)
  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mappings: BusinessObjectMapping[] = [
    { objectRef: OBJECT_A, schema: 'public', relation: 'energy_readings_a', relationKind: 'table' },
    { objectRef: METER_A, schema: 'public', relation: 'meters_a', relationKind: 'table' },
  ]
  postgresAdapter = new PostgresQueryAdapter({ database, mappings, sourceRef: SOURCE_A })
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

interface RealGatewayHarness {
  readonly gateway: ReturnType<typeof createRunToolGateway>
  readonly budget: BudgetLedgerPort
}

function buildRealGateway(adapter: PostgresQueryAdapter): RealGatewayHarness {
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
  const handler = new DataQueryHandler({
    query: adapter,
    mappings: new InMemorySemanticMappingRegistry([MAPPING_JOIN]),
  })
  const gateway = createRunToolGateway(
    {
      validator: canonicalToolValidator(),
      budget,
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactWriter(),
      handlers: [handler],
    },
    {
      runId: GATEWAY_RUN,
      ledgerId: GATEWAY_LEDGER,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    },
  )
  return { gateway, budget }
}

describe('route, small plan and bounded loop against real PostgreSQL', () => {
  it('compiles a multi-hop question to one query and executes it once through the real gateway', async () => {
    const adapter = postgresAdapter
    if (adapter === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const harness = buildRealGateway(adapter)
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A], deadline: '2099-01-01T00:00:00Z' })
    await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)

    const generation = new CountingGeneration()
    const planner = new RunPlanner({
      vocabulary: vocabularyService([MAPPING_JOIN], [publishedVocabularyDefinition()]),
      compiler: compilerFor(MAPPING_JOIN),
      generation,
    })
    const routed = await planner.route(
      {
        runId: GATEWAY_RUN,
        question: 'which meters consumed the most energy and what are they called',
        context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
        preferences: { route: 'auto', allowWeb: false },
        candidatePlan: multiHopPlan(),
      },
      ctx,
    )

    expect(routed.route).toBe('small_plan')
    expect(routed.plan?.steps).toHaveLength(1)
    expect(routed.plan?.singleQuery).toBe(true)
    expect(generation.calls).toHaveLength(0)
    const plan = routed.plan
    if (plan === undefined) throw new Error('the planner returned no plan')

    let gatewayCalls = 0
    const countingGateway = {
      invoke: (call: Parameters<typeof harness.gateway.invoke>[0], callCtx: ToolContext) => {
        gatewayCalls += 1
        return harness.gateway.invoke(call, callCtx)
      },
    }
    const executor = new SmallPlanExecutor({
      gateway: countingGateway,
      guard: new NoProgressGuard({ maxRounds: 4 }),
      remaining: async (remainingCtx) =>
        (await harness.budget.remaining(GATEWAY_LEDGER, remainingCtx)).remaining,
    })

    const first = await executor.execute(plan, ctx)
    expect(first.executedStepIds).toEqual(['q1'])
    expect(first.skippedStepIds).toEqual([])
    expect(first.stopped).toBe(false)
    expect(gatewayCalls).toBe(1)
    expect(first.evidenceRefs).toHaveLength(1)

    // Re-running the identical plan is detected as a repeat and never re-executes.
    const second = await executor.execute(plan, ctx)
    expect(second.executedStepIds).toEqual([])
    expect(second.skippedStepIds).toEqual(['q1'])
    expect(second.stopCode).toBe('NO_PROGRESS')
    expect(gatewayCalls).toBe(1)
  }, 120_000)

  it('executes the compiled multi-hop query through the real gateway and joins real rows', async () => {
    const adapter = postgresAdapter
    if (adapter === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const harness = buildRealGateway(adapter)
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A], deadline: '2099-01-01T00:00:00Z' })
    await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)

    const result = await harness.gateway.invoke(
      {
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        arguments: { kind: 'query', mode: 'direct', queryPlan: compileToDirect(multiHopPlan()) },
      },
      ctx,
    )

    expect(result.status).toBe('ok')
    const data = result.inlineData as DataQueryOutput | undefined
    expect(data?.table?.columns.map((column) => column.name)).toEqual(['meter_name', 'energy_kwh'])
    expect(data?.table?.rows).toEqual([
      ['Meter One', '8.2500000000'],
      ['Meter One', '12.5000000000'],
      ['Meter Two', '15.0000000000'],
    ])
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)
  }, 120_000)
})

function compileToDirect(plan: SemanticQueryPlan): DirectSqlQueryPlan {
  const compiled = compileSemanticQuery(plan, MAPPING_JOIN, { budget: COMPILE_BUDGET })
  const rendered = renderCompiledQuery(compiled)
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: rendered.sql,
    parameters: [...rendered.parameters],
    referencedObjects: [...rendered.referencedObjects],
    readOnly: true,
  }
}
