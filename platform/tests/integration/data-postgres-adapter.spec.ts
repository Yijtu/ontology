import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createBlobArtifactWriter, createToolGatewayComposition } from '@ontology/app-api'
import { createToolContext, SecretValue } from '@ontology/contracts'
import type {
  DirectSqlQueryPlan,
  ScopeRef,
  ScalarValue,
  SourceObjectRef,
  SourceRef,
  StructuredQueryExecuteRequest,
  ToolContext,
  ToolGateway,
} from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import {
  ToolGatewayError,
  type RunToolBinding,
  type ToolExecutionOutcome,
  type ToolExecutionRequest,
  type ToolHandler,
} from '@ontology/tool-services'
import {
  BusinessPostgresDatabase,
  isPostgresQueryError,
  PostgresQueryAdapter,
} from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../unit/tool-gateway-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const READ_ONLY_ROLE = 'ontology_reader'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '33333333-3333-4333-8333-333333333333'
const LEDGER = '88888888-8888-4888-8888-888888888888'
const PROFILE_HASH = `sha256:${'a'.repeat(64)}`
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const SOURCE: SourceRef = { namespace: 'demo', sourceId: 'business-db' }

const MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: { sourceRef: SOURCE, objectPath: 'sales.orders' },
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
    objectRef: { sourceRef: SOURCE, objectPath: 'sales.customers' },
    schema: 'sales',
    relation: 'customers',
    relationKind: 'table',
  },
  {
    objectRef: { sourceRef: SOURCE, objectPath: 'sales.slow_view' },
    schema: 'sales',
    relation: 'slow_view',
    relationKind: 'view',
  },
]

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function toolContext(sourceRefs: readonly SourceRef[] = [SOURCE]): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId: 'data-postgres-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: PROFILE_HASH,
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
      sourceRefs: [...sourceRefs],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-data-postgres',
  })
}

const CONTEXT = toolContext()

function declared(...objectPaths: readonly string[]): SourceObjectRef[] {
  return objectPaths.map((objectPath) => ({ sourceRef: SOURCE, objectPath }))
}

function directPlan(sql: string, parameters: ScalarValue[], objects: SourceObjectRef[]): DirectSqlQueryPlan {
  return { mode: 'direct', statementKind: 'select', sql, parameters, referencedObjects: objects, readOnly: true }
}

function executeRequest(
  plan: DirectSqlQueryPlan,
  overrides?: {
    readonly maxRows?: number
    readonly maxBytes?: number
    readonly maxDurationMs?: number
    readonly consistency?: 'repeatable_read' | 'immutable'
    readonly cursor?: string
  },
): StructuredQueryExecuteRequest {
  return {
    plan,
    limits: {
      maxRows: overrides?.maxRows ?? 1000,
      maxBytes: overrides?.maxBytes ?? 1_048_576,
      maxDurationMs: overrides?.maxDurationMs ?? 60_000,
    },
    snapshotRequest: { consistency: overrides?.consistency ?? 'repeatable_read' },
    ...(overrides?.cursor === undefined ? {} : { cursor: overrides.cursor }),
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(20)
  }
  return predicate()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A thin `data_query` handler that routes the direct branch to the real adapter. */
class PostgresDataQueryHandler implements ToolHandler {
  readonly toolId = 'data_query'
  constructor(
    private readonly adapter: PostgresQueryAdapter,
    private readonly ctx: ToolContext,
  ) {}

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const plan = directPlanOf(request.arguments)
    const response = await this.adapter.execute(
      {
        plan,
        limits: {
          maxRows: request.resultLimits.maxRows,
          maxBytes: request.resultLimits.maxBytes,
          maxDurationMs: request.resultLimits.maxDurationMs,
        },
        snapshotRequest: { consistency: 'repeatable_read' },
      },
      this.ctx,
    )
    const status: ToolExecutionOutcome['status'] = response.coverage.truncated
      ? 'partial'
      : response.coverage.returned === 0
        ? 'empty'
        : 'ok'
    return {
      payload: { resultKind: 'table', table: { columns: response.columns, rows: response.rows } },
      status,
      coverage: response.coverage,
      sources: [
        {
          sourceRef: response.snapshot.sourceRef,
          schemaVersion: response.snapshot.schemaVersion,
          consistency: response.snapshot.consistency,
          ...(response.snapshot.asOf === undefined ? {} : { asOf: response.snapshot.asOf }),
          resultDigest: response.snapshot.resultDigest,
        },
      ],
      usage: { rows: response.coverage.returned },
    }
  }
}

function directPlanOf(args: Readonly<Record<string, unknown>>): DirectSqlQueryPlan {
  if (args.kind !== 'query' || args.mode !== 'direct') {
    throw new ToolGatewayError('HANDLER_FAILED', 'this handler only serves direct data_query plans')
  }
  const candidate = args.queryPlan
  if (
    !isRecord(candidate) ||
    candidate.mode !== 'direct' ||
    candidate.statementKind !== 'select' ||
    typeof candidate.sql !== 'string' ||
    !Array.isArray(candidate.parameters) ||
    !Array.isArray(candidate.referencedObjects) ||
    candidate.readOnly !== true
  ) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'the direct query plan is malformed')
  }
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: candidate.sql,
    parameters: candidate.parameters as ScalarValue[],
    referencedObjects: candidate.referencedObjects as SourceObjectRef[],
    readOnly: true,
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let businessAdmin: Client
let businessDbName = ''
let businessUrl = ''
let businessDb: BusinessPostgresDatabase
let adapter: PostgresQueryAdapter
let adapterWithoutArchiver: PostgresQueryAdapter
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let gateway: ToolGateway

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

  businessDbName = `business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
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

  businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, password, businessDbName)
  const businessAdminUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  businessAdmin = new Client({ connectionString: businessAdminUrl })
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
      (2, 'beta', 20.00, '2026-01-02T00:00:00Z'),
      (3, 'acme', 30.25, '2026-01-03T00:00:00Z'),
      (4, 'gamma', 40.00, '2026-01-04T00:00:00Z');
    INSERT INTO sales.customers (id, name, region) VALUES
      (1, 'acme', 'north'), (2, 'beta', 'south'), (3, 'gamma', 'north');
    CREATE VIEW sales.slow_view AS SELECT count(*) AS n FROM generate_series(1, 2000000000);
    GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READ_ONLY_ROLE};
  `)

  businessDb = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 6 })
  adapterWithoutArchiver = new PostgresQueryAdapter({
    database: businessDb,
    mappings: MAPPINGS,
    sourceRef: SOURCE,
  })

  // Control side (a separate database and role) for the real gateway plug-in test.
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'data-postgres-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'data-postgres-space') ON CONFLICT DO NOTHING`,
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
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres')

  objectDir = await mkdtemp(join(tmpdir(), 'data-postgres-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  adapter = new PostgresQueryAdapter({
    database: businessDb,
    mappings: MAPPINGS,
    sourceRef: SOURCE,
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
    archiver: createBlobArtifactWriter(blobStore),
  })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  const handler = new PostgresDataQueryHandler(adapter, CONTEXT)
  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  })
  const binding: RunToolBinding = {
    runId: RUN,
    ledgerId: LEDGER,
    resolvedProfile: fullProfile(),
    operations: operationRegistry(),
  }
  gateway = composition.forRun(binding)
  await budget.openLedger({ ledgerId: LEDGER, kind: 'run', runId: RUN }, CONTEXT)
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('real business PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', () => {
  it('reports the real server, image and read-only role', async () => {
    const result = await adminClient.query<{ version: string; current_user: string }>(
      'SELECT version() AS version, current_user AS current_user',
    )
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    const reader = await businessDb.query<{ usename: string; is_superuser: boolean }>(
      'SELECT current_user AS usename, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser',
    )
    expect(reader[0]?.usename).toBe(READ_ONLY_ROLE)
    expect(reader[0]?.is_superuser).toBe(false)
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[data-postgres] image=${container.image} container=${container.containerName} role=${READ_ONLY_ROLE} database=${businessDbName}\n`,
      )
    }
  })

  it('enforces read-only at the database level, independent of the AST', async () => {
    await expect(
      businessDb.query("INSERT INTO sales.orders (id, customer, amount) VALUES (99, 'x', 1)"),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      businessDb.withReadOnlySnapshot({
        statementTimeoutMs: 2_000,
        operation: (session) =>
          session.client.query("INSERT INTO sales.orders (id, customer, amount) VALUES (100, 'x', 1)"),
      }),
    ).rejects.toMatchObject({ code: '25006' })
  })
})

describe('catalog discovery', () => {
  it('describes only visible mapped structures with a schema revision', async () => {
    const described = await adapter.describe({ scopeRef: SCOPE }, CONTEXT)
    const paths = described.resources.map((resource) => resource.objectRef.objectPath)
    expect(paths).toEqual(['sales.customers', 'sales.orders', 'sales.slow_view'])
    const orders = described.resources.find((resource) => resource.objectRef.objectPath === 'sales.orders')
    expect(orders?.columns.map((column) => column.name)).toEqual(['id', 'customer', 'amount', 'created_at'])
    expect(orders?.columns.map((column) => column.type)).toEqual([
      'integer',
      'string',
      'decimal',
      'timestamp',
    ])
    expect(described.schemaRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('paginates with an opaque cursor and an exhausted page', async () => {
    const first = await adapter.listResources({ scopeRef: SCOPE, limit: 2 }, CONTEXT)
    expect(first.resources).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const cursor = first.nextCursor
    if (cursor === null) throw new Error('expected a next cursor')
    const second = await adapter.listResources({ scopeRef: SCOPE, limit: 2, cursor }, CONTEXT)
    expect(second.resources).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(second.schemaRevision).toBe(first.schemaRevision)
  })
})

describe('structured query execution', () => {
  it('returns rows, typed columns and a repeatable_read snapshot', async () => {
    const plan = directPlan(
      'SELECT id, customer, amount FROM sales.orders WHERE amount >= $1 ORDER BY id',
      [20],
      declared('sales.orders'),
    )
    const response = await adapter.execute(executeRequest(plan), CONTEXT)
    expect(response.coverage.returned).toBe(3)
    expect(response.coverage.truncated).toBe(false)
    expect(response.snapshot.consistency).toBe('repeatable_read')
    expect(response.snapshot.archivedResultRef).toBeUndefined()
    expect(response.snapshot.asOf).toBeDefined()
    expect(response.snapshot.watermark).toBeUndefined()
    expect(response.columns.map((column) => column.type)).toEqual(['integer', 'string', 'decimal'])
    expect(response.rows[0]).toEqual([2, 'beta', '20.00'])
  })

  it('reports an empty match as empty, not as an error', async () => {
    const plan = directPlan('SELECT id FROM sales.orders WHERE customer = $1', ['nobody'], declared('sales.orders'))
    const response = await adapter.execute(executeRequest(plan), CONTEXT)
    expect(response.coverage.returned).toBe(0)
    expect(response.coverage.truncated).toBe(false)
    expect(response.rows).toEqual([])
  })

  it('binds filter values instead of interpolating them', async () => {
    const match = directPlan('SELECT id FROM sales.orders WHERE customer = $1 ORDER BY id', ['acme'], declared('sales.orders'))
    const matched = await adapter.execute(executeRequest(match), CONTEXT)
    expect(matched.rows.map((row) => row[0])).toEqual([1, 3])

    const injection = directPlan(
      'SELECT id FROM sales.orders WHERE customer = $1 ORDER BY id',
      ["acme' OR 1=1 --"],
      declared('sales.orders'),
    )
    const injected = await adapter.execute(executeRequest(injection), CONTEXT)
    expect(injected.rows).toEqual([])
  })

  it('marks row-limit truncation and continues from the cursor', async () => {
    const plan = directPlan('SELECT id FROM sales.orders ORDER BY id', [], declared('sales.orders'))
    const first = await adapter.execute(executeRequest(plan, { maxRows: 2 }), CONTEXT)
    expect(first.coverage.returned).toBe(2)
    expect(first.coverage.truncated).toBe(true)
    expect(first.coverage.completeness).toBe('truncated')
    expect(first.rows.map((row) => row[0])).toEqual([1, 2])
    const cursor = first.nextCursor
    if (cursor === null || cursor === undefined) throw new Error('expected a next cursor')
    const second = await adapter.execute(executeRequest(plan, { maxRows: 2, cursor }), CONTEXT)
    expect(second.coverage.returned).toBe(2)
    expect(second.coverage.truncated).toBe(false)
    expect(second.rows.map((row) => row[0])).toEqual([3, 4])
  })

  it('marks byte-limit truncation instead of silently dropping rows', async () => {
    const plan = directPlan('SELECT id, customer FROM sales.orders ORDER BY id', [], declared('sales.orders'))
    const response = await adapter.execute(executeRequest(plan, { maxBytes: 15 }), CONTEXT)
    expect(response.coverage.truncated).toBe(true)
    expect(response.coverage.returned).toBe(1)
    expect(response.nextCursor).not.toBeNull()
  })

  it('enforces the time limit and reports a deadline failure', async () => {
    const plan = directPlan('SELECT * FROM sales.slow_view', [], declared('sales.slow_view'))
    await expect(
      adapter.execute(executeRequest(plan, { maxDurationMs: 500 }), CONTEXT),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  }, 30_000)

  it('rejects an unauthorised object before touching the database', async () => {
    const plan = directPlan('SELECT * FROM public.orders', [], declared('sales.orders'))
    await expect(adapter.execute(executeRequest(plan), CONTEXT)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects a writable CTE even though the root is a SELECT', async () => {
    const plan = directPlan(
      'WITH x AS (DELETE FROM sales.orders RETURNING id) SELECT id FROM x',
      [],
      declared('sales.orders'),
    )
    await expect(adapter.execute(executeRequest(plan), CONTEXT)).rejects.toMatchObject({
      code: 'UNSUPPORTED_QUERY',
    })
  })

  it('validates without executing and returns a normalized plan', async () => {
    const plan = directPlan('SELECT id FROM sales.orders WHERE id = $1', [1], declared('sales.orders'))
    const validation = await adapter.validate(
      { plan, limits: { maxRows: 10, maxBytes: 1024, maxDurationMs: 1000 } },
      CONTEXT,
    )
    expect(validation.valid).toBe(true)
    expect(validation.normalizedPlan?.mode).toBe('direct')
    expect(validation.warnings).toEqual([])

    const bad = directPlan('DROP TABLE sales.orders', [], declared('sales.orders'))
    const rejected = await adapter.validate(
      { plan: bad, limits: { maxRows: 10, maxBytes: 1024, maxDurationMs: 1000 } },
      CONTEXT,
    )
    expect(rejected.valid).toBe(false)
    expect(rejected.rejectedReason?.code).toBe('UNSUPPORTED_QUERY')
  })
})

describe('cancellation', () => {
  it('actually cancels the running query and settles it', async () => {
    const plan = directPlan('SELECT * FROM sales.slow_view', [], declared('sales.slow_view'))
    const pending = adapter.execute(executeRequest(plan), CONTEXT).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    const registered = await waitUntil(() => adapter.activeTargets().length > 0, 5_000)
    expect(registered).toBe(true)
    const targetRef = adapter.activeTargets()[0]
    if (targetRef === undefined) throw new Error('no in-flight query to cancel')
    const response = await adapter.cancel({ targetRef, reason: 'test cancellation' }, CONTEXT)
    expect(response.state).toBe('cancelled')

    const outcome = await pending
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(isPostgresQueryError(outcome.error)).toBe(true)
      if (isPostgresQueryError(outcome.error)) {
        expect(outcome.error.remoteStateUnknown).toBe(false)
      }
    }

    const again = await adapter.cancel({ targetRef, reason: 'again' }, CONTEXT)
    expect(again.state).toBe('already_terminal')
  }, 60_000)
})

describe('snapshot and consistency boundary', () => {
  it('does not present a finished transaction as a re-readable version', async () => {
    const plan = directPlan('SELECT id, amount FROM sales.orders ORDER BY id', [], declared('sales.orders'))
    const before = await adapter.execute(executeRequest(plan), CONTEXT)
    expect(before.snapshot.consistency).toBe('repeatable_read')
    expect(before.snapshot.archivedResultRef).toBeUndefined()

    await businessAdmin.query("INSERT INTO sales.orders (id, customer, amount) VALUES (5, 'delta', 50.00)")
    const after = await adapter.execute(executeRequest(plan), CONTEXT)
    expect(after.coverage.returned).toBe(5)
    expect(after.snapshot.resultDigest).not.toBe(before.snapshot.resultDigest)
    // The repeatable_read snapshot from the finished transaction carries no replayable version.
    expect(before.snapshot.archivedResultRef).toBeUndefined()
  })

  it('archives on demand so an immutable snapshot can be reproduced', async () => {
    const plan = directPlan('SELECT id, amount FROM sales.orders ORDER BY id', [], declared('sales.orders'))
    const immutable = await adapter.execute(executeRequest(plan, { consistency: 'immutable' }), CONTEXT)
    expect(immutable.snapshot.consistency).toBe('immutable')
    const blobRef = immutable.snapshot.archivedResultRef
    if (blobRef === undefined) throw new Error('expected an archived result reference')
    const bytes = await blobStore.readAuthorized({ blobRef, scopeRef: SCOPE }, CONTEXT)
    expect(sha256DigestOf(new TextDecoder().decode(bytes))).toBe(immutable.snapshot.resultDigest)
  })

  it('refuses an immutable snapshot when no archiver is configured', async () => {
    const plan = directPlan('SELECT id FROM sales.orders', [], declared('sales.orders'))
    await expect(
      adapterWithoutArchiver.execute(executeRequest(plan, { consistency: 'immutable' }), CONTEXT),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
  })

  it('refuses a historical as-of or read_time request instead of inventing one', async () => {
    const plan = directPlan('SELECT id FROM sales.orders', [], declared('sales.orders'))
    await expect(
      adapterWithoutArchiver.execute(
        {
          plan,
          limits: { maxRows: 10, maxBytes: 1024, maxDurationMs: 1000 },
          snapshotRequest: { consistency: 'read_time' },
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
  })
})

describe('source probe', () => {
  it('reports the real catalog, pagination, cancellation and snapshot', async () => {
    const observation = await adapter.probe(
      {
        role: 'catalog',
        secretRef: 'secret://data-postgres/test',
        secret: new SecretValue('postgresql://redacted'),
        requestedCapabilities: [],
      },
      CONTEXT,
    )
    expect(observation.adapterRef.id).toBe('@ontology/adapter-data-postgres')
    expect(observation.catalog.resources.length).toBeGreaterThan(0)
    expect(observation.catalog.schemaRevision).toBe(observation.snapshot.schemaRevision)
    expect(observation.pagination.kind).toBe('opaque_cursor')
    expect(observation.pagination.pagesFetched).toBe(1)
    expect(observation.cancellation).toEqual({ support: 'supported', attempted: true })
    expect(observation.snapshot.consistency).toBe('repeatable_read')
    expect(observation.capabilities.map((capability) => capability.name)).toContain(
      'structured_query.execute',
    )
  }, 60_000)

  it('fails the probe instead of reporting ready when no mapped relation is visible', async () => {
    await expect(
      adapter.probe(
        {
          role: 'catalog',
          secretRef: 'secret://data-postgres/test',
          secret: new SecretValue('postgresql://redacted'),
          requestedCapabilities: [],
        },
        toolContext([]),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  }, 60_000)
})

describe('gateway plug-in as the real data_query backend', () => {
  it('runs a direct query through the gateway and archives evidence', async () => {
    const plan = directPlan('SELECT id, amount FROM sales.orders WHERE id <= $1 ORDER BY id', [2], declared('sales.orders'))
    const result = await gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: { kind: 'query', mode: 'direct', queryPlan: plan },
      },
      CONTEXT,
    )
    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)
    expect(result.sourceSnapshots[0]?.consistency).toBe('repeatable_read')
    expect(result.coverage.returned).toBe(2)
    expect(result.dataRef?.kind).toBe('artifact')
  })
})
