import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore, sha256DigestOf } from '@ontology/core'
import { DuckDbProjectDatasetAdapter, DuckDbEngine, canonicalJson } from '@ontology/adapter-data-duckdb'
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
  createToolContext,
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
let bulkDuckDescriptor: ProjectSnapshotQueryDescriptor | undefined

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
  it('keeps exact DECIMAL, declared text and every cell origin across 1001 paged rows on both backends', async () => {
    const pgAdapter = pg
    if (pgAdapter === undefined || admin === undefined) throw new Error('the PG business backend is unavailable')
    const columns: ProjectDatasetColumn[] = [{ name: 'code', valueType: 'string' }, { name: 'amount', valueType: 'number' }]
    const rows: ProjectDatasetRow[] = Array.from({ length: 1001 }, (_unused, index) => ({
      recordId: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`, objectId: 'Meter', sourceRowKey: `csv:bulk:row:${String(index + 2)}`,
      values: { code: { kind: 'scalar', value: '000123' }, amount: { kind: 'scalar', value: index % 2 === 0 ? '9007199254740993.000000000001' : '-9007199254740994.000000000002' } },
      sources: ['code', 'amount'].map((fieldId, column) => ({ ...locator(fieldId, column + 1), locator: { kind: 'table_cell', format: 'csv', recordIndex: index + 1, row: index + 2, column: column + 1, normalizationMapRef: 'bulk-map' } })),
    }))
    for (const backend of [duck, pgAdapter]) {
      const id = randomUUID()
      const canonicalDigest = sha256DigestOf(canonicalJson({ objectId: 'Meter', columns, rows: rows.map((row) => ({ recordId: row.recordId, values: row.values })) }))
      const base = stageInputFor(id, backend.backend).input
      const input: ProjectDatasetStageInput = { ...base, snapshotRef: { ...base.snapshotRef, digest: canonicalDigest }, canonicalDigest,
        schemaDigest: sha256DigestOf(canonicalJson(columns)), body: { ...base.body, columns, rows, coverage: { expectedCount: rows.length, processedCount: rows.length, excluded: [], completeness: 'complete' } } }
      const normal = contextFor(id)
      const ctx = createToolContext({ ...normal, allowedResources: { ...normal.allowedResources, maxRows: 250 } })
      await backend.stageSnapshot(SCOPE, input, ctx)
      if (backend === pgAdapter) await admin.query(`GRANT SELECT ON ${PG_SCHEMA}.${viewName(id)} TO ${READ_ONLY_ROLE}`)
      const descriptor = await backend.describeSnapshot(SCOPE, input.snapshotRef, ctx)
      if (descriptor === undefined) throw new Error('the bulk descriptor is missing')
      if (backend === duck) bulkDuckDescriptor = descriptor
      const service = new ProjectSemanticQueryService({ query: backend })
      const plan: SemanticQueryPlan = { mode: 'semantic', concepts: ['Meter'], fields: ['code', 'amount'], links: [], filters: [],
        orderBy: [{ fieldRef: 'record_id', direction: 'asc' }], limit: 1001, mappingVersion: projectSnapshotMappingRef({ descriptor }) }
      const all = []
      let cursor: string | undefined
      do {
        const result = await service.execute({ descriptor, plan, limits: { ...LIMITS, maxRows: 1001 }, ...(cursor === undefined ? {} : { cursor }) }, ctx)
        expect(result.rows.length).toBeLessThanOrEqual(250)
        all.push(...result.rows)
        expect(result.coverage.truncated).toBe(all.length < 1001)
        cursor = result.coverage.cursor
      } while (cursor !== undefined)
      expect(all).toHaveLength(1001)
      expect(new Set(all.map((row) => row.recordId)).size).toBe(1001)
      expect(all[0]?.values).toEqual(['000123', '9007199254740993.000000000001'])
      expect(all[1]?.values).toEqual(['000123', '-9007199254740994.000000000002'])
      expect(all[1000]?.sources.find((source) => source.fieldId === 'amount')?.locator).toMatchObject({ kind: 'table_cell', row: 1002, column: 2 })
      expect(await backend.describeSnapshot(SCOPE, { ...input.snapshotRef, digest: `sha256:${'f'.repeat(64)}` }, ctx)).toBeUndefined()
      const foreign = gatewayContext({ tenantId: '99999999-9999-4999-8999-999999999999', spaceId: SPACE, sourceRefs: [projectDatasetSourceRef(id)] })
      expect(await backend.describeSnapshot({ tenantId: foreign.principal.tenantId, spaceId: SPACE }, input.snapshotRef, foreign)).toBeUndefined()
      await expect(backend.execute({ plan: { mode: 'direct', statementKind: 'select', sql: `SELECT code FROM ${backend === pgAdapter ? `${PG_SCHEMA}.${viewName(id)}` : descriptor.relation}`, parameters: [], referencedObjects: [descriptor.sourceObjectRef], readOnly: true }, limits: LIMITS, snapshotRequest: { consistency: 'immutable' } }, foreign)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
      await expect(backend.stageSnapshot(SCOPE, { ...input, body: { ...input.body, rows: rows.map((row, index) => index === 0 ? { ...row, sources: [] } : row) } }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    }
  }, 120_000)

  it('interrupts a real PG read without returning a late success and refuses a foreign cancellation', async () => {
    const backend = pg
    if (backend === undefined || admin === undefined || container === undefined) throw new Error('the isolated PG backend is unavailable')
    const descriptor = await backend.describeSnapshot(SCOPE, stageInputFor(PG_SNAPSHOT_ID, backend.backend).snapshotRef, contextFor(PG_SNAPSHOT_ID))
    if (descriptor === undefined) throw new Error('the PG descriptor is missing')
    const blocker = new Client({ connectionString: container.adminUrl })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query(`LOCK TABLE ${PG_SCHEMA}.project_dataset_rows IN ACCESS EXCLUSIVE MODE`)
    const ctx = contextFor(PG_SNAPSHOT_ID)
    const pending = backend.execute({ plan: { mode: 'direct', statementKind: 'select', sql: `SELECT "meterValue" FROM ${PG_SCHEMA}.${descriptor.relation}`, parameters: [], referencedObjects: [descriptor.sourceObjectRef], readOnly: true }, limits: LIMITS, snapshotRequest: { consistency: 'immutable' } }, ctx)
    const outcome = pending.then(() => 'late_success', (error: unknown) => error)
    try {
      const endAt = Date.now() + 10_000
      let blocked = false
      while (Date.now() < endAt) {
        const state = await admin.query<{ count: string }>("SELECT count(*)::text FROM pg_stat_activity WHERE application_name IN ('project-semantic-sql-test','project-semantic-sql-test-readonly') AND wait_event_type='Lock'")
        if (state.rows[0]?.count !== '0') { blocked = true; break }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      const targetRef = backend.activeTargets()[0]
      if (targetRef === undefined) throw new Error('the blocked query has no cancellation target')
      const foreign = gatewayContext({ tenantId: TENANT, spaceId: SPACE, runId: randomUUID(), sourceRefs: [projectDatasetSourceRef(PG_SNAPSHOT_ID)] })
      await expect(backend.cancel({ targetRef, reason: 'foreign run' }, foreign)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect((await backend.cancel({ targetRef, reason: 'human cancelled read' }, ctx)).state).toBe('cancelling')
      const result = await outcome
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toMatch(/cancel/i)
      expect(backend.activeTargets()).toEqual([])
    } finally { await blocker.query('ROLLBACK'); await blocker.end() }
  }, 60_000)

  it('interrupts a real DuckDB query and prevents its late result from succeeding', async () => {
    const descriptor = bulkDuckDescriptor
    if (descriptor === undefined) throw new Error('the bulk DuckDB snapshot is missing')
    const ctx = contextFor(descriptor.snapshotRef.id)
    const pending = duck.execute({ plan: { mode: 'direct', statementKind: 'select', sql: `SELECT COUNT(*) FROM "${descriptor.relation}" a CROSS JOIN "${descriptor.relation}" b CROSS JOIN "${descriptor.relation}" c WHERE a.amount + b.amount + c.amount > 0`, parameters: [], referencedObjects: [descriptor.sourceObjectRef], readOnly: true }, limits: LIMITS, snapshotRequest: { consistency: 'immutable' } }, ctx)
    const outcome = pending.then(() => 'late_success', (error: unknown) => error)
    const endAt = Date.now() + 10_000
    while (duck.runningTargets().length === 0 && Date.now() < endAt) await new Promise((resolve) => setTimeout(resolve, 1))
    const targetRef = duck.runningTargets()[0]
    if (targetRef === undefined) throw new Error('the DuckDB query has no cancellation target')
    expect((await duck.cancel({ targetRef, reason: 'human cancelled the real projection read' }, ctx)).state).toBe('cancelling')
    expect(await outcome).toMatchObject({ code: 'CANCELLED' })
    expect(duck.activeTargets()).toEqual([])
  }, 60_000)

  it('refuses canonical JSON and typed-column tampering after reopening either backend', async () => {
    if (container === undefined || admin === undefined) throw new Error('the isolated business backend is unavailable')
    const directory = await mkdtemp(join(tmpdir(), 'project-integrity-'))
    try {
      for (const tamper of ['canonical', 'typed'] as const) {
        const id = randomUUID()
        const path = join(directory, `${id}.duckdb`)
        const first = new DuckDbProjectDatasetAdapter({ instancePath: path })
        const staged = stageInputFor(id, first.backend)
        await first.stageSnapshot(SCOPE, staged.input, contextFor(id))
        first.close()
        const owner = new DuckDbEngine({ instancePath: path, writableProjection: true })
        await owner.start()
        if (tamper === 'typed') await owner.runTrusted(`UPDATE "ds_${id.replaceAll('-', '_')}" SET "meterValue" = 9999 WHERE "record_id" = ?`, [ROWS[0]!.recordId])
        else await owner.runTrusted(`UPDATE "ds_${id.replaceAll('-', '_')}" SET "values_json" = ? WHERE "record_id" = ?`, [JSON.stringify({ ...ROWS[0]!.values, meterValue: { kind: 'quantity', value: '9999', unitCode: 'Wh' } }), ROWS[0]!.recordId])
        owner.close()
        const reopened = new DuckDbProjectDatasetAdapter({ instancePath: path })
        try { await expect(reopened.describeSnapshot(SCOPE, staged.snapshotRef, contextFor(id))).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' }) } finally { reopened.close() }
      }
      const id = randomUUID()
      const config = { connectionString: container.adminUrl, schema: PG_SCHEMA }
      const first = new PostgresProjectDatasetAdapter(config)
      const staged = stageInputFor(id, first.backend)
      await first.stageSnapshot(SCOPE, staged.input, contextFor(id))
      await first.close()
      await admin.query(`UPDATE ${PG_SCHEMA}.project_dataset_rows SET values = jsonb_set(values, '{meterValue,value}', '"9999"'::jsonb) WHERE snapshot_id=$1::uuid AND record_id=$2::uuid`, [id, ROWS[0]!.recordId])
      const reopened = new PostgresProjectDatasetAdapter(config)
      try { await expect(reopened.describeSnapshot(SCOPE, staged.snapshotRef, contextFor(id))).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' }) } finally { await reopened.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 60_000)

  it('fences accepted cancellation between the final read check and the actual PostgreSQL COMMIT', async () => {
    if (container === undefined) throw new Error('the isolated business backend is unavailable')
    let entered: () => void = () => undefined
    let release: () => void = () => undefined
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const continueCommit = new Promise<void>((resolve) => { release = resolve })
    const backend = new PostgresProjectDatasetAdapter({ connectionString: container.adminUrl, schema: PG_SCHEMA, faultInjection: { beforeReadCommit: async () => { entered(); await continueCommit } } })
    const id = randomUUID()
    const ctx = contextFor(id)
    const staged = stageInputFor(id, backend.backend)
    try {
      await backend.stageSnapshot(SCOPE, staged.input, ctx)
      const descriptor = await backend.describeSnapshot(SCOPE, staged.snapshotRef, ctx)
      if (descriptor === undefined) throw new Error('the exact commit-race snapshot is missing')
      const pending = backend.execute({ plan: { mode: 'direct', statementKind: 'select', sql: `SELECT "meterValue" FROM ${PG_SCHEMA}.${descriptor.relation}`, parameters: [], referencedObjects: [descriptor.sourceObjectRef], readOnly: true }, limits: LIMITS, snapshotRequest: { consistency: 'immutable' } }, ctx)
      const outcome = pending.then(() => 'late_success', (error: unknown) => error)
      await paused
      const targetRef = backend.activeTargets()[0]
      if (targetRef === undefined) throw new Error('the actual read/COMMIT has no target')
      expect((await backend.cancel({ targetRef, reason: 'accepted during real COMMIT boundary' }, ctx)).state).toBe('cancelling')
      release()
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/cancelled after commit/i) })
      expect(backend.activeTargets()).toEqual([])
    } finally { release(); await backend.close() }
  }, 60_000)

})
