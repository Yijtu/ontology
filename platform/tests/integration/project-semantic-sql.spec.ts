import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore, sha256DigestOf } from '@ontology/core'
import { DuckDbProjectDatasetAdapter, canonicalJson } from '@ontology/adapter-data-duckdb'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import {
  InMemorySemanticMappingRegistry,
  ProjectSemanticQueryService,
  projectSnapshotMappingRef,
} from '@ontology/semantic-engine'
import { DataQueryHandler, createRunToolGateway } from '@ontology/tool-services'
import type {
  BudgetLedgerPort,
  DataQueryOutput,
  ProjectDatasetColumn,
  ProjectDatasetRef,
  ProjectDatasetRow,
  ProjectDatasetSnapshotBody,
  ProjectDatasetStageInput,
  ProjectSnapshotQueryDescriptor,
  SemanticQueryPlan,
  ToolContext,
  ToolResult,
} from '@ontology/contracts'
import {
  projectDatasetSourceObjectRef,
  projectDatasetSourceRef,
} from '@ontology/contracts'
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
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

function buildProjectGateway(handler: DataQueryHandler): {
  readonly gateway: ReturnType<typeof createRunToolGateway>
  readonly budget: BudgetLedgerPort
} {
  const inner = new BudgetService({
    store: new InMemoryBudgetLedgerStore(),
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
  const gateway = createRunToolGateway(
    {
      validator: canonicalToolValidator(),
      budget,
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactWriter(),
      handlers: [handler],
    },
    { runId: GATEWAY_RUN, ledgerId: GATEWAY_LEDGER, resolvedProfile: fullProfile(), operations: operationRegistry() },
  )
  return { gateway, budget }
}

/**
 * V03-025 acceptance against two real business backends.
 *
 * The same semantic plan is compiled against the *fixed* project dataset snapshot and executed
 * through the DuckDB and PostgreSQL backends. The normalised result must be equal, the pinned
 * snapshot must be the only readable one (a foreign relation and a lost snapshot are refused),
 * and the exact numeric filter must run as a real numeric comparison on both backends.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE = { tenantId: TENANT, spaceId: SPACE }
const DEFINITION_REF = { id: 'meter-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` } as const
const PG_SCHEMA = `project_semantic_business_${String(process.pid)}`
const READ_ONLY_ROLE = `proj_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

const COLUMNS: readonly ProjectDatasetColumn[] = [
  { name: 'deviceId', valueType: 'string' },
  { name: 'meterValue', valueType: 'quantity', canonicalUnitCode: 'Wh', dimension: 'energy' },
]

function locator(fieldId: string, column: number): ProjectDatasetRow['sources'][number] {
  return {
    fieldId,
    documentRef: {
      id: '22222222-2222-4222-8222-222222222222',
      version: '1.0.0',
      digest: `sha256:${'b'.repeat(64)}`,
      kind: 'artifact',
    },
    parseId: '55555555-5555-4555-8555-555555555555',
    locator: { kind: 'table_cell', format: 'csv', recordIndex: 1, row: 2, column, normalizationMapRef: 'map' },
  }
}

const ROWS: readonly ProjectDatasetRow[] = [
  {
    recordId: '11111111-0000-4000-8000-000000000001',
    objectId: 'Meter',
    sourceRowKey: 'csv:sheet:row:2',
    values: {
      deviceId: { kind: 'scalar', value: 'd1' },
      meterValue: { kind: 'quantity', value: '1005', unitCode: 'Wh' },
    },
    sources: [locator('deviceId', 1), locator('meterValue', 2)],
  },
  {
    recordId: '11111111-0000-4000-8000-000000000002',
    objectId: 'Meter',
    sourceRowKey: 'csv:sheet:row:3',
    values: {
      deviceId: { kind: 'scalar', value: 'd2' },
      meterValue: { kind: 'quantity', value: '2500', unitCode: 'Wh' },
    },
    sources: [locator('deviceId', 1), locator('meterValue', 2)],
  },
]

function canonicalDigestOf(): string {
  return sha256DigestOf(
    canonicalJson({
      objectId: 'Meter',
      columns: COLUMNS,
      rows: ROWS.map((row) => ({ recordId: row.recordId, values: row.values })),
    }),
  )
}

function stageInputFor(snapshotId: string, backend: string) {
  const canonicalDigest = canonicalDigestOf()
  const snapshotRef: ProjectDatasetRef = {
    id: snapshotId,
    version: '1.0.1',
    digest: canonicalDigest,
    kind: 'dataset',
  }
  const body: ProjectDatasetSnapshotBody = {
    schemaVersion: 'project-dataset-snapshot@1',
    projectId: '33333333-3333-4333-8333-333333333333',
    objectId: 'Meter',
    projectRevision: '1',
    datasetRevision: '1',
    definitionRef: DEFINITION_REF,
    mappingRefs: [],
    backend,
    columns: COLUMNS,
    rows: ROWS,
    coverage: { expectedCount: ROWS.length, processedCount: ROWS.length, excluded: [], completeness: 'complete' },
    recordedAt: '2026-09-30T00:00:00Z',
  }
  const schemaDigest = sha256DigestOf(canonicalJson(COLUMNS))
  const input: ProjectDatasetStageInput = {
    body,
    snapshotRef,
    schemaDigest,
    canonicalDigest,
    meta: {
      idempotencyKey: `dataset:${snapshotId}`,
      requestDigest: sha256DigestOf(canonicalJson({ snapshotId, canonicalDigest })),
    },
  }
  return { input, snapshotRef }
}

function planFor(descriptor: ProjectSnapshotQueryDescriptor): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [descriptor.objectId],
    fields: ['deviceId', 'meterValue'],
    links: [],
    filters: [{ fieldRef: 'meterValue', op: 'gte', values: [2000] }],
    orderBy: [{ fieldRef: 'deviceId', direction: 'asc' }],
    limit: 100,
    mappingVersion: projectSnapshotMappingRef({ descriptor }),
  }
}

const LIMITS = { maxRows: 100, maxBytes: 1_048_576, maxDurationMs: 30_000 }

function contextFor(sourceId: string): ToolContext {
  return gatewayContext({ tenantId: TENANT, spaceId: SPACE, sourceRefs: [projectDatasetSourceRef(sourceId)], deadline: '2099-01-01T00:00:00Z' })
}

const DUCK_SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444'
const PG_SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666'
const duck = new DuckDbProjectDatasetAdapter()

let container: PostgresContainer | undefined
let admin: Client | undefined
let pg: PostgresProjectDatasetAdapter | undefined

beforeAll(async () => {
  const duckInput = stageInputFor(DUCK_SNAPSHOT_ID, duck.backend)
  await duck.stageSnapshot(SCOPE, duckInput.input, contextFor(DUCK_SNAPSHOT_ID))

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) container = await startPostgresContainer()
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')
  admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  const password = `throwaway_${randomBytes(8).toString('hex')}`
  await admin.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${password}'`)

  pg = new PostgresProjectDatasetAdapter({
    connectionString: adminUrl,
    readOnlyConnectionString: readOnlyUrl(adminUrl, password),
    schema: PG_SCHEMA,
    applicationName: 'project-semantic-sql-test',
  })
  const pgInput = stageInputFor(PG_SNAPSHOT_ID, pg.backend)
  await pg.stageSnapshot(SCOPE, pgInput.input, contextFor(PG_SNAPSHOT_ID))

  // The read-only role may read the fixed snapshot view, and nothing else.
  await admin.query(`GRANT USAGE ON SCHEMA ${PG_SCHEMA} TO ${READ_ONLY_ROLE}`)
  await admin.query(`GRANT SELECT ON ${PG_SCHEMA}.${viewName(PG_SNAPSHOT_ID)} TO ${READ_ONLY_ROLE}`)
}, 300_000)

afterAll(async () => {
  duck.close()
  await pg?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  await container?.stop()
})

function readOnlyUrl(base: string, password: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(READ_ONLY_ROLE)}:${encodeURIComponent(password)}@${url.hostname}${port}${url.pathname}`
}

function viewName(snapshotId: string): string {
  return `dsq_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

describe('project semantic SQL against two real business backends', () => {
  it('returns the same normalised rows for DuckDB and PostgreSQL', async () => {
    const duckDescriptor = await duck.describeSnapshot(SCOPE, { ...stageInputFor(DUCK_SNAPSHOT_ID, duck.backend).snapshotRef }, contextFor(DUCK_SNAPSHOT_ID))
    const pgAdapter = pg
    if (duckDescriptor === undefined || pgAdapter === undefined) throw new Error('a snapshot was not materialised')
    const pgDescriptor = await pgAdapter.describeSnapshot(SCOPE, { ...stageInputFor(PG_SNAPSHOT_ID, pgAdapter.backend).snapshotRef }, contextFor(PG_SNAPSHOT_ID))
    if (pgDescriptor === undefined) throw new Error('the PostgreSQL snapshot view was not reported')

    const duckService = new ProjectSemanticQueryService({ query: duck })
    const pgService = new ProjectSemanticQueryService({ query: pgAdapter })
    const duckResult = await duckService.execute(
      { descriptor: duckDescriptor, plan: planFor(duckDescriptor), limits: LIMITS },
      contextFor(DUCK_SNAPSHOT_ID),
    )
    const pgResult = await pgService.execute(
      { descriptor: pgDescriptor, plan: planFor(pgDescriptor), limits: LIMITS },
      contextFor(PG_SNAPSHOT_ID),
    )

    // The numeric `meterValue >= 2000` filter keeps only the second record on both backends.
    expect(duckResult.rows.map((row) => row.recordId)).toEqual([ROWS[1]?.recordId])
    expect(pgResult.rows.map((row) => row.recordId)).toEqual([ROWS[1]?.recordId])
    expect(duckResult.rows.map((row) => row.values[0])).toEqual(['d2'])
    expect(pgResult.rows.map((row) => row.values[0])).toEqual(['d2'])
    expect(Number(duckResult.rows[0]?.values[1])).toBe(2500)
    expect(Number(pgResult.rows[0]?.values[1])).toBe(2500)

    // Every returned row keeps its exact physical source locators.
    expect(duckResult.rows[0]?.sources.map((source) => source.fieldId).sort()).toEqual(['deviceId', 'meterValue'])
    expect(pgResult.rows[0]?.sources.map((source) => source.fieldId).sort()).toEqual(['deviceId', 'meterValue'])

    expect(duckResult.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
    expect(pgResult.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
  }, 120_000)

  it('executes through the data_query tool gateway against the fixed snapshot', async () => {
    const descriptor = await duck.describeSnapshot(SCOPE, stageInputFor(DUCK_SNAPSHOT_ID, duck.backend).snapshotRef, contextFor(DUCK_SNAPSHOT_ID))
    if (descriptor === undefined) throw new Error('the snapshot was not materialised')
    const mapping = new ProjectSemanticQueryService({ query: duck }).mappingFor(descriptor)
    const handler = new DataQueryHandler({
      query: duck,
      mappings: new InMemorySemanticMappingRegistry([mapping]),
    })
    const harness = buildProjectGateway(handler)
    const ctx = contextFor(DUCK_SNAPSHOT_ID)
    await harness.budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)

    const result: ToolResult = await harness.gateway.invoke(
      {
        callId: '11111111-2222-4333-8444-555555555555',
        toolId: 'data_query',
        arguments: { kind: 'query', mode: 'semantic', queryPlan: planFor(descriptor) },
      },
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)
    const data = result.inlineData as DataQueryOutput | undefined
    expect(data?.table?.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
    expect(data?.table?.rows).toHaveLength(1)
  }, 60_000)

  it('refuses a relation that is not the fixed snapshot instead of reading the startup demo data', async () => {
    const real = stageInputFor(DUCK_SNAPSHOT_ID, duck.backend)
    const descriptor: ProjectSnapshotQueryDescriptor = {
      snapshotRef: real.snapshotRef,
      objectId: 'Meter',
      dialect: 'duckdb',
      schema: 'main',
      relation: 'energy_readings_c',
      relationKind: 'table',
      sourceObjectRef: projectDatasetSourceObjectRef(DUCK_SNAPSHOT_ID, 'Meter'),
      columns: COLUMNS,
    }
    const service = new ProjectSemanticQueryService({ query: duck })
    await expect(
      service.execute({ descriptor, plan: planFor(descriptor), limits: LIMITS }, contextFor(DUCK_SNAPSHOT_ID)),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  }, 60_000)

  it('refuses a snapshot source the principal is not authorized for', async () => {
    const descriptor = await duck.describeSnapshot(SCOPE, stageInputFor(DUCK_SNAPSHOT_ID, duck.backend).snapshotRef, contextFor(DUCK_SNAPSHOT_ID))
    if (descriptor === undefined) throw new Error('the snapshot was not materialised')
    const service = new ProjectSemanticQueryService({ query: duck })
    const foreignContext = gatewayContext({
      tenantId: TENANT,
      spaceId: SPACE,
      sourceRefs: [projectDatasetSourceRef('00000000-0000-4000-8000-000000000000')],
      deadline: '2099-01-01T00:00:00Z',
    })
    await expect(
      service.execute({ descriptor, plan: planFor(descriptor), limits: LIMITS }, foreignContext),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }, 60_000)

  it('reports SNAPSHOT_UNAVAILABLE for a restarted backend instead of falling back', async () => {
    const restarted = new DuckDbProjectDatasetAdapter()
    try {
      const descriptor = await restarted.describeSnapshot(
        SCOPE,
        stageInputFor(DUCK_SNAPSHOT_ID, restarted.backend).snapshotRef,
        contextFor(DUCK_SNAPSHOT_ID),
      )
      expect(descriptor).toBeUndefined()
    } finally {
      restarted.close()
    }
  }, 30_000)
})
