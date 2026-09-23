import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  CancelRequest,
  CancelResponse,
  DirectSqlQueryPlan,
  ScalarValue,
  SourceObjectRef,
  SourceRef,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryPort,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolContext,
} from '@ontology/contracts'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { ToolExecutionRequest, ToolExecutionOutcome } from '@ontology/tool-services'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import {
  READINGS_OBJECT,
  READINGS_ROWS,
  duckdbContext,
  readingsRelation,
} from '../fixtures/data-query/duckdb-relations'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const READ_ONLY_ROLE = 'ontology_reader'
const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '33333333-3333-4333-8333-333333333333'
const SOURCE: SourceRef = { namespace: 'demo', sourceId: 'business-db' }
const ORDERS: SourceObjectRef = { sourceRef: SOURCE, objectPath: 'sales.orders' }

const MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: ORDERS,
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer', type: 'string' },
      { name: 'amount', type: 'decimal' },
    ],
  },
]

function postgresContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId: 'precheck-postgres',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: RUN,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [SOURCE],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-precheck-postgres',
  })
}

function directPlan(sql: string, parameters: readonly ScalarValue[], objects: readonly SourceObjectRef[]): DirectSqlQueryPlan {
  return { mode: 'direct', statementKind: 'select', sql, parameters: [...parameters], referencedObjects: [...objects], readOnly: true }
}

function request(plan: DirectSqlQueryPlan, ctx: ToolContext): ToolExecutionRequest {
  return {
    callId: randomUUID(),
    toolId: 'data_query',
    arguments: { kind: 'query', mode: 'direct', queryPlan: plan },
    resultLimits: { maxRows: 100, maxBytes: 1_048_576, maxDurationMs: 30_000 },
    deadline: ctx.deadline,
    traceId: ctx.traceId,
    ctx,
    signal: new AbortController().signal,
  }
}

/**
 * A recording `StructuredQueryPort` around a real adapter. It delegates validation and
 * execution to the real backend and counts executions, so a test can prove the pre-check
 * refused the plan *without* reaching the execution path.
 */
class RecordingQueryPort implements StructuredQueryPort {
  executeCalls = 0
  readonly #inner: StructuredQueryPort

  constructor(inner: StructuredQueryPort) {
    this.#inner = inner
  }

  validate(request: StructuredQueryValidateRequest, ctx: ToolContext): Promise<StructuredQueryValidateResponse> {
    return this.#inner.validate(request, ctx)
  }

  execute(request: StructuredQueryExecuteRequest, ctx: ToolContext): Promise<StructuredQueryExecuteResponse> {
    this.executeCalls += 1
    return this.#inner.execute(request, ctx)
  }

  cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    return this.#inner.cancel(request, ctx)
  }
}

let container: PostgresContainer | undefined
let adminClient: Client
let businessAdmin: Client
let businessDb: BusinessPostgresDatabase
let adapter: RecordingQueryPort
let handler: DataQueryHandler
let ctx: ToolContext

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const adminUrl = provided !== undefined && provided.length > 0 ? provided : (container = await startPostgresContainer()).adminUrl

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  const businessDbName = `precheck_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await adminClient.query(`CREATE DATABASE ${businessDbName}`)

  const password = `throwaway_${randomBytes(8).toString('hex')}`
  const roleExists = await adminClient.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AS exists',
    [READ_ONLY_ROLE],
  )
  const statement = await adminClient.query<{ statement: string }>(
    "SELECT format($1::text || ' ROLE ' || quote_ident($2) || ' LOGIN PASSWORD %L', $3::text) AS statement",
    [roleExists.rows[0]?.exists === true ? 'ALTER' : 'CREATE', READ_ONLY_ROLE, password],
  )
  const roleStatement = statement.rows[0]?.statement
  if (roleStatement === undefined) throw new Error('could not build the read-only role statement')
  await adminClient.query(roleStatement)

  const url = new URL(adminUrl)
  const port = url.port === '' ? '' : `:${url.port}`
  const businessUrl = `${url.protocol}//${encodeURIComponent(READ_ONLY_ROLE)}:${encodeURIComponent(password)}@${url.hostname}${port}/${businessDbName}`
  const businessAdminUrl = `${url.protocol}//postgres:${encodeURIComponent(url.password)}@${url.hostname}${port}/${businessDbName}`

  businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE SCHEMA sales;
    CREATE TABLE sales.orders (
      id integer PRIMARY KEY,
      customer text NOT NULL,
      amount numeric(12, 2) NOT NULL
    );
    INSERT INTO sales.orders (id, customer, amount) VALUES
      (1, 'acme', 10.50), (2, 'beta', 20.00), (3, 'acme', 30.25);
    GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READ_ONLY_ROLE};
  `)

  businessDb = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  const real = new PostgresQueryAdapter({ database: businessDb, mappings: MAPPINGS, sourceRef: SOURCE })
  adapter = new RecordingQueryPort(real)
  handler = new DataQueryHandler({ query: adapter, mappings: new InMemorySemanticMappingRegistry([]) })
  ctx = postgresContext()
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('data_query pre-check against real PostgreSQL', () => {
  it('passes a valid read-only SELECT through the pre-check and executes it', async () => {
    const plan = directPlan('SELECT id, amount FROM sales.orders WHERE id <= $1 ORDER BY id', [2], [ORDERS])
    const outcome: ToolExecutionOutcome = await handler.execute(request(plan, ctx))
    expect(outcome.status).toBe('ok')
    expect(outcome.coverage.returned).toBe(2)
    expect(outcome.sources[0]?.consistency).toBe('repeatable_read')
    expect(adapter.executeCalls).toBe(1)
  })

  it('rejects EXPLAIN, DESCRIBE and SHOW in the static pre-check and never executes', async () => {
    for (const sql of [
      'EXPLAIN SELECT id FROM sales.orders',
      'DESCRIBE sales.orders',
      'SHOW search_path',
    ]) {
      const before = adapter.executeCalls
      await expect(handler.execute(request(directPlan(sql, [], [ORDERS]), ctx))).rejects.toMatchObject({
        platformCode: 'UNSUPPORTED_QUERY',
      })
      expect(adapter.executeCalls, sql).toBe(before)
    }
  })

  it('reports a locatable reason for an unmapped relation and a missing parameter', async () => {
    await expect(
      handler.execute(request(directPlan('SELECT id FROM sales.secret', [], [ORDERS]), ctx)),
    ).rejects.toMatchObject({
      platformCode: 'FORBIDDEN',
      message: expect.stringContaining('sales.secret'),
    })

    await expect(
      handler.execute(request(directPlan('SELECT id FROM sales.orders WHERE id = $2', [1], [ORDERS]), ctx)),
    ).rejects.toMatchObject({
      platformCode: 'INVALID_ARGUMENT',
      message: expect.stringContaining('$2'),
    })
  })
})

describe('data_query pre-check against the real DuckDB engine', () => {
  const adapter = new DuckDbQueryAdapter({
    relations: [readingsRelation()],
    catalogSchemaRevision: '2026-09-01',
    now: () => '2026-09-21T00:00:00.000Z',
  })
  const recording = new RecordingQueryPort(adapter)
  const handler = new DataQueryHandler({ query: recording, mappings: new InMemorySemanticMappingRegistry([]) })
  const ctx = duckdbContext()

  beforeAll(async () => {
    await adapter.start()
    await adapter.materialiseRelation('readings', READINGS_ROWS)
  })

  afterAll(() => {
    adapter.close()
  })

  it('passes a valid parameterised SELECT through the pre-check and executes it', async () => {
    const plan: DirectSqlQueryPlan = {
      mode: 'direct',
      statementKind: 'select',
      sql: 'SELECT reading_id FROM readings WHERE quality_flag = ? ORDER BY reading_id',
      parameters: [1],
      referencedObjects: [READINGS_OBJECT],
      readOnly: true,
    }
    const outcome = await handler.execute(request(plan, ctx))
    expect(outcome.status).toBe('ok')
    expect(outcome.coverage.returned).toBeGreaterThan(0)
    expect(recording.executeCalls).toBe(1)
  })

  it('rejects EXPLAIN, DESCRIBE and SHOW in the static pre-check and never executes', async () => {
    for (const sql of [
      'EXPLAIN SELECT reading_id FROM readings',
      'DESCRIBE readings',
      'SHOW TABLES',
    ]) {
      const before = recording.executeCalls
      await expect(
        handler.execute(
          request(
            {
              mode: 'direct',
              statementKind: 'select',
              sql,
              parameters: [],
              referencedObjects: [READINGS_OBJECT],
              readOnly: true,
            },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ platformCode: 'UNSUPPORTED_QUERY' })
      expect(recording.executeCalls, sql).toBe(before)
    }
  })
})
