import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresProjectMappingStore,
  PostgresProjectReadinessStore,
  PostgresProjectRecordStore,
  PostgresProjectStore,
} from '@ontology/adapter-control-postgres'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { PostgresStructuredIngestionStore, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import {
  InMemoryIndustrySchemaSource,
  ProjectDataMaterializationService,
  ProjectMappingService,
} from '@ontology/application'
import type { ProjectMappingServiceDependencies } from '@ontology/application'
import type {
  ColumnMappingEntry,
  ColumnMappingRequest,
  ImportMappingVersion,
  IndustrySchema,
  NewProjectRecordVersion,
  ResourceRef,
  ScopeRef,
  StructuredParseRecord,
  StructuredRecordEntry,
  ToolContext,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RECORDED_AT = '2026-09-30T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'
const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const PROJECT_C = '33333333-3333-4333-8333-333333333333'
const PARSE_ID = '55555555-5555-4555-8555-555555555555'
const BIG_PARSE_ID = '66666666-6666-4666-8666-666666666666'
const RECORD_A = '33333333-3333-4333-8333-333333333333'
const RECORD_B = '44444444-4444-4444-8444-444444444444'
const DEFINITION_REF = { id: 'meter-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` } as const
const ORIGINAL_REF: ResourceRef = { id: '22222222-2222-4222-8222-222222222222', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' }
const BIG_ORIGINAL_REF: ResourceRef = { id: 'abababab-abab-4bab-8bab-abababababab', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}`, kind: 'artifact' }
const CSV = 'device_id,value_wh,value_kwh\nd1,1005,1.005\nd2,2500,2.5\n'
const MEDIA = 'text/csv'
const BIG_ROW_COUNT = 1001
const BIG_CSV = [
  'device_id,value_wh,value_kwh',
  ...Array.from({ length: BIG_ROW_COUNT }, (_unused, index) => {
    const device = `bulk-${String(index).padStart(4, '0')}`
    const wh = String(1000 + index)
    return `${device},${wh},${(1000 + index) / 1000}`
  }),
].join('\n').concat('\n')

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

const parsedSource = new StructuredDocumentParser().parse(new TextEncoder().encode(CSV), { mediaType: MEDIA, headerRow: 1 })
const table = parsedSource.tables[0]
if (table === undefined) throw new Error('the CSV fixture did not parse')
const sheetKey = table.sheetId ?? table.sheetName ?? 'sheet'
const columnDigests = table.columns.map((column) => column.headerDigest)
const rowKeys = table.rows.map((row) => `csv:${sheetKey}:row:${row.row}`)

function schemaFor(): IndustrySchema {
  return {
    namespace: 'demo',
    definitionRef: DEFINITION_REF,
    objects: [
      {
        objectId: 'Meter',
        displayName: 'Meter',
        identityScopeId: 'meter-scope',
        attributes: [
          { attributeId: 'deviceId', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'meterValue', valueType: 'quantity', minCardinality: 1, maxCardinality: 1, identityKey: false, unitCode: 'Wh', dimension: 'energy' },
        ],
      },
    ],
    relations: [],
    identityScopes: [
      { identityScopeId: 'meter-scope', objectId: 'Meter', scopeDimensions: ['site'], identityAttributeIds: ['deviceId'] },
    ],
  }
}

function revisionBody(projectId: string, revisionNumber: string): Record<string, unknown> {
  return {
    schemaVersion: 'project-revision@1',
    projectId,
    revision: revisionNumber,
    industryPackRef: { id: 'demo-pack', version: '1.0.0', digest: sha('a') },
    definitionRef: DEFINITION_REF,
    mappingRefs: [
      { id: 'seed-mapping', version: '1.0.0', digest: sha('c'), role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src' }, objectPath: 'Meter' } },
    ],
    profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: sha('f') },
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: sha('d'), kind: 'artifact' },
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '1',
    changeReason: 'seed',
  }
}

function mappingRequest(idColumn: number, valueColumn: number, valueHeader: string, sourceUnit: string, conversion?: { numerator: string; denominator: string }): ColumnMappingRequest {
  const entries: ColumnMappingEntry[] = [
    { fieldRef: 'deviceId', header: 'device_id', headerDigest: columnDigests[0] ?? sha('9'), columnIndex: idColumn },
    {
      fieldRef: 'meterValue',
      header: valueHeader,
      headerDigest: columnDigests[valueColumn] ?? sha('9'),
      columnIndex: valueColumn,
      sourceUnitCode: sourceUnit,
      canonicalUnitCode: 'Wh',
      ...(conversion === undefined ? {} : { unitConversion: { fromUnitCode: sourceUnit, toUnitCode: 'Wh', numerator: conversion.numerator, denominator: conversion.denominator } }),
    },
  ]
  return {
    format: 'csv',
    parseId: PARSE_ID,
    originalRef: ORIGINAL_REF,
    originalMediaType: MEDIA,
    options: { headerRow: 1 },
    objectId: 'Meter',
    entries,
  }
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let projectStore: PostgresProjectStore
let readinessStore: PostgresProjectReadinessStore
let mappingStore: PostgresProjectMappingStore
let recordStore: PostgresProjectRecordStore
let structuredStore: PostgresStructuredIngestionStore
let mappingService: ProjectMappingService
let duckAdapter: DuckDbProjectDatasetAdapter
let datasetService: ProjectDataMaterializationService

const editorCtx = (target: ScopeRef): ToolContext => toolContext(target.tenantId, target.spaceId, ['platform-admin', 'operator'], 'editor-1', RUN_ID)

async function seedProject(projectId: string, target: ScopeRef): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'Meter project', 1, 'draft', $4, $5, 'editor-1', now(), now())`,
    [target.tenantId, target.spaceId, projectId, `project-seed-${projectId}`, sha('2')],
  )
  await harness.adminClient.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason,
        idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, 'seed', $6, $7, 'editor-1', $8::timestamptz)`,
    [target.tenantId, target.spaceId, projectId, sha('1'), JSON.stringify(revisionBody(projectId, '1')), `revision-seed-${projectId}`, sha('3'), RECORDED_AT],
  )
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'project-materialization')
  otherScope = await createJobScope(harness.adminClient, 'project-materialization-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  projectStore = new PostgresProjectStore(database)
  readinessStore = new PostgresProjectReadinessStore(database)
  mappingStore = new PostgresProjectMappingStore(database)
  recordStore = new PostgresProjectRecordStore(database)
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 4, applicationName: 'project-materialization-test' })

  await seedProject(PROJECT_A, scope.scopeRef)
  await seedProject(PROJECT_B, scope.scopeRef)
  await seedProject(PROJECT_C, scope.scopeRef)

  const parseRecord: StructuredParseRecord = {
    parseId: PARSE_ID,
    scopeRef: scope.scopeRef,
    format: 'csv',
    originalMediaType: MEDIA,
    originalRef: ORIGINAL_REF,
    parserId: 'ontology.structured-parser',
    parserVersion: '1.0.0',
    status: 'complete',
    coverage: { status: 'complete', completeness: 'complete', totalUnits: 2, parsedUnits: 2, skippedUnits: 0, skippedReasons: [], notes: [] },
    counts: { total: 2, succeeded: 2, pending: 0, failed: 0, skipped: 0 },
    sheets: [],
    diagnostics: [],
    createdAt: RECORDED_AT,
  }
  const entries: StructuredRecordEntry[] = [
    { recordId: RECORD_A, sourceRowKey: rowKeys[0] ?? '', recordIndex: 1, row: 2, state: 'parsed', locator: { kind: 'table_row', format: 'csv', recordIndex: 1, row: 2, columnFrom: 1, columnTo: 3, normalizationMapRef: 'map' }, rowDigest: sha('c'), columnCount: 3 },
    { recordId: RECORD_B, sourceRowKey: rowKeys[1] ?? '', recordIndex: 2, row: 3, state: 'parsed', locator: { kind: 'table_row', format: 'csv', recordIndex: 2, row: 3, columnFrom: 1, columnTo: 3, normalizationMapRef: 'map' }, rowDigest: sha('d'), columnCount: 3 },
  ]
  await structuredStore.recordParse(parseRecord, entries, editorCtx(scope.scopeRef))

  const bigParsed = new StructuredDocumentParser().parse(new TextEncoder().encode(BIG_CSV), { mediaType: MEDIA, headerRow: 1 })
  const bigTable = bigParsed.tables[0]
  if (bigTable === undefined) throw new Error('the bulk CSV fixture did not parse')
  const bigSheetKey = bigTable.sheetId ?? bigTable.sheetName ?? 'sheet'
  const bigParseRecord: StructuredParseRecord = {
    ...parseRecord,
    parseId: BIG_PARSE_ID,
    originalRef: BIG_ORIGINAL_REF,
    coverage: { status: 'complete', completeness: 'complete', totalUnits: BIG_ROW_COUNT, parsedUnits: BIG_ROW_COUNT, skippedUnits: 0, skippedReasons: [], notes: [] },
    counts: { total: BIG_ROW_COUNT, succeeded: BIG_ROW_COUNT, pending: 0, failed: 0, skipped: 0 },
  }
  const bigEntries: StructuredRecordEntry[] = bigTable.rows.map((row, index) => ({
    recordId: `c${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`,
    sourceRowKey: `csv:${bigSheetKey}:row:${row.row}`,
    recordIndex: row.recordIndex,
    row: row.row,
    state: 'parsed',
    locator: { kind: 'table_row', format: 'csv', recordIndex: row.recordIndex, row: row.row, columnFrom: 1, columnTo: 3, normalizationMapRef: 'map' },
    rowDigest: sha('c'),
    columnCount: 3,
  }))
  await structuredStore.recordParse(bigParseRecord, bigEntries, editorCtx(scope.scopeRef))

  const dependencies: ProjectMappingServiceDependencies = {
    projects: projectStore,
    revisions: projectStore,
    mappings: mappingStore,
    records: recordStore,
    ingestion: structuredStore,
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }]),
    originals: {
      read: async (request) =>
        new TextEncoder().encode(
          request.approvedInputRefs[0]?.id === BIG_ORIGINAL_REF.id ? BIG_CSV : CSV,
        ),
    },
    parser: new StructuredDocumentParser(),
  }
  mappingService = new ProjectMappingService(dependencies)
  duckAdapter = new DuckDbProjectDatasetAdapter()
  datasetService = new ProjectDataMaterializationService({
    projects: projectStore,
    records: recordStore,
    mappings: mappingStore,
    readiness: readinessStore,
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }]),
    writer: duckAdapter,
    query: duckAdapter,
  })
}, 300_000)

afterAll(async () => {
  duckAdapter?.close()
  await structuredStore?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

async function bind(projectId: string, request: ColumnMappingRequest, tag: string): Promise<{ mapping: ImportMappingVersion; records: readonly { recordId: string; fields: readonly { fieldId: string; normalized: unknown }[] }[] }> {
  const ctx = editorCtx(scope.scopeRef)
  const confirmed = await mappingService.confirmMapping(projectId, request, `map-${tag}-${projectId}`, 'editor-1', ctx)
  const bound = await mappingService.bindRecords(projectId, { parseId: request.parseId, mappingId: confirmed.mapping.mappingId, mappingVersion: confirmed.mapping.version }, `bind-${tag}-${projectId}`, 'editor-1', ctx)
  return { mapping: confirmed.mapping, records: bound.records }
}

describe('project dataset materialisation (real control PostgreSQL + DuckDB business backend)', () => {
  it('materialises two client mappings of the same data into semantically identical canonical snapshots', async () => {
    const boundA = await bind(PROJECT_A, mappingRequest(0, 1, 'value_wh', 'Wh'), 'a')
    const boundB = await bind(PROJECT_B, mappingRequest(0, 2, 'value_kwh', 'kWh', { numerator: '1000', denominator: '1' }), 'b')

    const valuesA = boundA.records.map((record) => record.fields.find((field) => field.fieldId === 'meterValue')?.normalized)
    const valuesB = boundB.records.map((record) => record.fields.find((field) => field.fieldId === 'meterValue')?.normalized)
    expect(valuesA).toEqual(valuesB)
    expect(valuesA).toEqual([
      { kind: 'quantity', value: '1005', unitCode: 'Wh' },
      { kind: 'quantity', value: '2500', unitCode: 'Wh' },
    ])

    const ctx = editorCtx(scope.scopeRef)
    const statusA = await datasetService.materialize(PROJECT_A, { objectId: 'Meter' }, ctx)
    const statusB = await datasetService.materialize(PROJECT_B, { objectId: 'Meter' }, ctx)
    expect(statusA.state).toBe('ready')
    expect(statusB.state).toBe('ready')
    expect(statusA.coverage).toMatchObject({ expectedCount: 2, processedCount: 2, completeness: 'complete' })
    // Same business data via different client column names/units => the same canonical digest.
    expect(statusB.snapshotRef?.digest).toBe(statusA.snapshotRef?.digest)

    const readA = await datasetService.queryActive({ projectId: PROJECT_A }, ctx)
    const readB = await datasetService.queryActive({ projectId: PROJECT_B }, ctx)
    expect(readA.rows.map((row) => row.values['meterValue'])).toEqual(readB.rows.map((row) => row.values['meterValue']))

    // Each row's source locates the actual physical cell it was read from.
    const sourceA = readA.rows.find((row) => row.recordId === RECORD_A)?.sources.find((source) => source.fieldId === 'meterValue')
    const sourceB = readB.rows.find((row) => row.recordId === RECORD_A)?.sources.find((source) => source.fieldId === 'meterValue')
    expect(sourceA).toMatchObject({ documentRef: ORIGINAL_REF, parseId: PARSE_ID })
    expect(sourceB).toMatchObject({ documentRef: ORIGINAL_REF, parseId: PARSE_ID })
    expect(sourceA?.locator).toMatchObject({ kind: 'table_cell', column: 2, row: 2 })
    expect(sourceB?.locator).toMatchObject({ kind: 'table_cell', column: 3, row: 2 })
  }, 60_000)

  it('reports SNAPSHOT_UNAVAILABLE for an unactivated snapshot, a restarted backend, and another scope', async () => {
    const ctx = editorCtx(scope.scopeRef)
    const status = await datasetService.materialize(PROJECT_A, { objectId: 'Meter' }, ctx)
    const foreign = { ...status.snapshotRef!, id: '99999999-9999-4999-8999-999999999999' }
    await expect(
      datasetService.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: foreign }, ctx),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', httpStatus: 409 })

    // A fresh in-process backend (a restart) has lost the staged snapshot: readiness is `ready`
    // but the pinned data is gone, so the reader must not fall back to any other dataset.
    const restarted = new DuckDbProjectDatasetAdapter()
    const restartedService = new ProjectDataMaterializationService({
      projects: projectStore,
      records: recordStore,
      mappings: mappingStore,
      readiness: readinessStore,
      schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }]),
      writer: restarted,
      query: restarted,
    })
    try {
      await expect(restartedService.queryActive({ projectId: PROJECT_A }, ctx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
    } finally {
      restarted.close()
    }

    await expect(datasetService.queryActive({ projectId: PROJECT_A }, editorCtx(otherScope.scopeRef))).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    })
  }, 60_000)

  it('blocks an unconfirmed record until a partial snapshot is explicitly allowed', async () => {
    const ctx = editorCtx(scope.scopeRef)
    const pending: NewProjectRecordVersion = {
      schemaVersion: 'project-record@1',
      projectId: PROJECT_A,
      recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mappingId: (await mappingService.listMappings(PROJECT_A, ctx))[0]!.mappingId,
      mappingVersion: '1.0.0',
      objectId: 'Meter',
      sourceRowKey: 'csv:sheet:row:99',
      sourceDigest: sha('9'),
      contentDigest: sha('8'),
      fields: [
        { fieldId: 'deviceId', raw: 'd9', normalized: { kind: 'scalar', value: 'd9' }, status: 'confirmed', locator: { kind: 'table_cell', format: 'csv', recordIndex: 9, row: 99, column: 1, normalizationMapRef: 'map' } },
        { fieldId: 'meterValue', raw: '10', normalized: { kind: 'scalar', value: '10' }, status: 'pending', reason: 'MISSING_UNIT', locator: { kind: 'table_cell', format: 'csv', recordIndex: 9, row: 99, column: 2, normalizationMapRef: 'map' } },
      ],
      status: 'pending',
      actor: 'editor-1',
      recordedAt: RECORDED_AT,
    }
    await recordStore.appendRecords(scope.scopeRef, PROJECT_A, [pending], { idempotencyKey: `pending-${PROJECT_A}`, requestDigest: sha('7') }, ctx)
    await expect(datasetService.materialize(PROJECT_A, { objectId: 'Meter' }, ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
  }, 60_000)

  it('freezes a fixed revision and keeps the historical snapshot readable after an incremental change', async () => {
    const ctx = editorCtx(scope.scopeRef)
    const before = await datasetService.materialize(PROJECT_B, { objectId: 'Meter' }, ctx)
    const beforeRead = await datasetService.query({ projectRevisionRef: before.projectRevisionRef, snapshotRef: before.snapshotRef! }, ctx)
    const original = beforeRead.rows.find((row) => row.recordId === RECORD_A)?.values['meterValue']
    expect(original).toEqual({ kind: 'quantity', value: '1005', unitCode: 'Wh' })

    const base = (await recordStore.listRecords(scope.scopeRef, PROJECT_B, { objectId: 'Meter', limit: 1 }, ctx)).records[0]!
    const corrected: NewProjectRecordVersion = {
      ...base,
      contentDigest: sha('5'),
      fields: base.fields.map((field) => field.fieldId === 'meterValue'
        ? { ...field, raw: '9999', normalized: { kind: 'quantity' as const, value: '9999', unitCode: 'Wh' } }
        : field),
    }
    await recordStore.appendRecords(scope.scopeRef, PROJECT_B, [corrected], { idempotencyKey: `correct-${PROJECT_B}`, requestDigest: sha('6') }, ctx)

    await harness.adminClient.query(
      `INSERT INTO agent_platform.project_revisions
         (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason,
          idempotency_key, request_digest, actor, recorded_at)
       VALUES ($1, $2, $3, 2, $4, $5::jsonb, 1, 'field corrected', $6, $7, 'editor-1', $8::timestamptz)`,
      [scope.tenantId, scope.spaceId, PROJECT_B, sha('4'), JSON.stringify(revisionBody(PROJECT_B, '2')), `revision-2-${PROJECT_B}`, sha('5'), RECORDED_AT],
    )
    await harness.adminClient.query(
      `UPDATE agent_platform.projects SET head_revision = 2, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND project_id = $3`,
      [scope.tenantId, scope.spaceId, PROJECT_B],
    )

    const after = await datasetService.materialize(PROJECT_B, { objectId: 'Meter' }, ctx)
    expect(after.projectRevisionRef.revision).toBe('2')
    const afterRead = await datasetService.query({ projectRevisionRef: after.projectRevisionRef, snapshotRef: after.snapshotRef! }, ctx)
    expect(afterRead.rows.find((row) => row.recordId === RECORD_A)?.values['meterValue']).toEqual({ kind: 'quantity', value: '9999', unitCode: 'Wh' })

    // The earlier revision's pinned snapshot is still readable and still shows the old value.
    const historical = await datasetService.query({ projectRevisionRef: before.projectRevisionRef, snapshotRef: before.snapshotRef! }, ctx)
    expect(historical.rows.find((row) => row.recordId === RECORD_A)?.values['meterValue']).toEqual(original)
    expect(after.snapshotRef?.id).not.toBe(before.snapshotRef?.id)
  }, 60_000)

  it('materialises 1001 approved rows with bounded paging under one fixed revision', async () => {
    const ctx = editorCtx(scope.scopeRef)
    const parsed = new StructuredDocumentParser().parse(new TextEncoder().encode(BIG_CSV), { mediaType: MEDIA, headerRow: 1 })
    const parsedTable = parsed.tables[0]
    if (parsedTable === undefined) throw new Error('the bulk CSV fixture did not parse')
    const digests = parsedTable.columns.map((column) => column.headerDigest)
    const request: ColumnMappingRequest = {
      format: 'csv',
      parseId: BIG_PARSE_ID,
      originalRef: BIG_ORIGINAL_REF,
      originalMediaType: MEDIA,
      options: { headerRow: 1 },
      objectId: 'Meter',
      entries: [
        { fieldRef: 'deviceId', header: 'device_id', headerDigest: digests[0] ?? sha('9'), columnIndex: 0 },
        { fieldRef: 'meterValue', header: 'value_wh', headerDigest: digests[1] ?? sha('9'), columnIndex: 1, sourceUnitCode: 'Wh', canonicalUnitCode: 'Wh' },
      ],
    }
    await bind(PROJECT_C, request, 'c')
    const status = await datasetService.materialize(PROJECT_C, { objectId: 'Meter' }, ctx)
    expect(status.coverage).toMatchObject({ expectedCount: BIG_ROW_COUNT, processedCount: BIG_ROW_COUNT, completeness: 'complete' })

    let cursor: string | undefined
    let total = 0
    for (;;) {
      const page = await datasetService.queryActive(
        { projectId: PROJECT_C, limit: 250, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      total += page.rows.length
      expect(page.coverage.truncated).toBe(total < BIG_ROW_COUNT)
      cursor = page.coverage.cursor
      if (cursor === undefined) break
    }
    expect(total).toBe(BIG_ROW_COUNT)
  }, 120_000)

  it('materialises the same dataset through the PostgreSQL business backend', async () => {
    const ctx = editorCtx(scope.scopeRef)
    const pgAdapter = new PostgresProjectDatasetAdapter({
      connectionString: harness.adminUrl,
      schema: 'project_dataset_business_test',
      applicationName: 'project-materialization-pg-test',
    })
    try {
      const pgService = new ProjectDataMaterializationService({
        projects: projectStore,
        records: recordStore,
        mappings: mappingStore,
        readiness: readinessStore,
        schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }]),
        writer: pgAdapter,
        query: pgAdapter,
      })
      const status = await pgService.materialize(PROJECT_B, { objectId: 'Meter', revision: '2' }, ctx)
      const read = await pgService.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: status.snapshotRef! }, ctx)
      expect(read.rows.length).toBeGreaterThanOrEqual(2)
      const source = read.rows.find((row) => row.recordId === RECORD_A)?.sources[0]
      expect(source).toMatchObject({ documentRef: ORIGINAL_REF, parseId: PARSE_ID })
    } finally {
      await pgAdapter.close()
    }
  }, 60_000)
})
