import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresJobStore,
  PostgresProjectMappingStore,
  PostgresProjectReadinessStore,
  PostgresProjectRecordStore,
  PostgresProjectStore,
} from '@ontology/adapter-control-postgres'
import { PostgresStructuredIngestionStore, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import { InMemoryIndustrySchemaSource, ProjectMappingService, ProjectService } from '@ontology/application'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  ColumnMappingEntry,
  ColumnMappingRequest,
  IndustryPackCatalogue,
  IndustrySchema,
  ProjectRevisionBody,
  ResourceRef,
  ScopeRef,
  StructuredParseRecord,
  StructuredRecordEntry,
  ToolContext,
} from '@ontology/contracts'
import type { ProjectMappingServiceDependencies } from '@ontology/application'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RECORDED_AT = '2026-09-30T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const PARSE_ID = '55555555-5555-4555-8555-555555555555'
const RECORD_A = '33333333-3333-4333-8333-333333333333'
const RECORD_B = '44444444-4444-4444-8444-444444444444'
const DEFINITION_REF = { id: 'meter-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` } as const
const ORIGINAL_REF: ResourceRef = { id: '22222222-2222-4222-8222-222222222222', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' }
const CSV = 'device_id,meter_value,unit\nd1,1.005,kWh\nd2,2.5,kWh\n'
const MEDIA = 'text/csv'

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

function revisionBody(): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'demo-pack', version: '1.0.0', digest: sha('a') },
    definitionRef: DEFINITION_REF,
    mappingRefs: [
      { id: 'seed-mapping', version: '1.0.0', digest: sha('c'), role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src' }, objectPath: 'records' } },
    ],
    profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: sha('f') },
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: sha('d'), kind: 'artifact' },
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '1',
    changeReason: 'seed project',
  }
}

function mappingRequest(): ColumnMappingRequest {
  const entries: ColumnMappingEntry[] = [
    { fieldRef: 'deviceId', header: 'device_id', headerDigest: columnDigests[0] ?? sha('9'), columnIndex: 0 },
    {
      fieldRef: 'meterValue',
      header: 'meter_value',
      headerDigest: columnDigests[1] ?? sha('9'),
      columnIndex: 1,
      sourceUnitCode: 'kWh',
      canonicalUnitCode: 'Wh',
      unitConversion: { fromUnitCode: 'kWh', toUnitCode: 'Wh', numerator: '1000', denominator: '1' },
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
let mappingStore: PostgresProjectMappingStore
let recordStore: PostgresProjectRecordStore
let structuredStore: PostgresStructuredIngestionStore
let app: ReturnType<typeof createApiServer>
let projectService: ProjectService
let mappingService: ProjectMappingService

const editorCtx = (target: ScopeRef): ToolContext => toolContext(target.tenantId, target.spaceId, ['platform-admin'], 'editor-1', RUN_ID)

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return {
    principal: { tenantId: chosen.tenantId, subjectId: subject, roles: ['platform-admin'], scopes: [], authEpoch: 1 },
    spaceId: chosen.spaceId,
  }
}

function headers(options: { idempotencyKey?: string; scope?: 'primary' | 'other'; subject?: string | null } = {}): Record<string, string> {
  const result: Record<string, string> = { 'content-type': 'application/json', 'x-test-scope': options.scope ?? 'primary' }
  if (options.subject !== null) result['x-test-subject'] = options.subject ?? 'editor-1'
  result['idempotency-key'] = options.idempotencyKey ?? `idem-${randomUUID()}`
  return result
}

async function post(url: string, body: object, options: { idempotencyKey?: string; scope?: 'primary' | 'other'; subject?: string | null } = {}) {
  return app.inject({ method: 'POST', url, headers: headers(options), payload: body })
}

async function get(url: string, options: { scope?: 'primary' | 'other'; subject?: string | null } = {}) {
  const h = headers(options)
  delete h['idempotency-key']
  return app.inject({ method: 'GET', url, headers: h })
}

const CATALOGUE: IndustryPackCatalogue = {
  listEntries: async () => [],
  findPack: async () => undefined,
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'project-mapping')
  otherScope = await createJobScope(harness.adminClient, 'project-mapping-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  mappingStore = new PostgresProjectMappingStore(database)
  recordStore = new PostgresProjectRecordStore(database)
  const projectStore = new PostgresProjectStore(database)
  const readinessStore = new PostgresProjectReadinessStore(database)
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 4, applicationName: 'project-mapping-test' })

  const body = revisionBody()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'Meter project', 1, 'draft', $4, $5, 'editor-1', now(), now())`,
    [scope.tenantId, scope.spaceId, PROJECT_ID, `project-seed-${PROJECT_ID}`, sha('2')],
  )
  await harness.adminClient.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason,
        idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, 'seed', $6, $7, 'editor-1', $8::timestamptz)`,
    [scope.tenantId, scope.spaceId, PROJECT_ID, sha('1'), JSON.stringify(body), `revision-seed-${PROJECT_ID}`, sha('3'), RECORDED_AT],
  )

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

  const schemaSource = new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }])
  const mappingDependencies: ProjectMappingServiceDependencies = {
    projects: projectStore,
    revisions: projectStore,
    mappings: mappingStore,
    records: recordStore,
    ingestion: structuredStore,
    schemaSource,
    originals: { read: async () => new TextEncoder().encode(CSV) },
    parser: new StructuredDocumentParser(),
  }
  mappingService = new ProjectMappingService(mappingDependencies)
  projectService = new ProjectService({
    projects: projectStore,
    readiness: readinessStore,
    jobs: new PostgresJobStore(database),
    catalogue: CATALOGUE,
  })
  app = createApiServer({ authenticate: testAuthenticator, projects: { service: projectService, mappings: mappingService } })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await structuredStore?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('project mapping, unit normalisation and record binding (real PostgreSQL + HTTP)', () => {
  let mappingId = ''
  let mappingVersion = ''

  it('previews and confirms an exact column mapping', async () => {
    const preview = await post(`/api/v1/projects/${PROJECT_ID}/mappings/preview`, mappingRequest())
    expect(preview.statusCode).toBe(200)
    const previewData = preview.json().data as { preview: { confirmable: boolean; columns: { fieldRef: string; normalization: string; samples: { raw: string; canonical?: string }[] }[] } }
    expect(previewData.preview.confirmable).toBe(true)
    const valueColumn = previewData.preview.columns.find((column) => column.fieldRef === 'meterValue')
    expect(valueColumn?.normalization).toBe('exact')
    expect(valueColumn?.samples[0]).toMatchObject({ raw: '1.005', canonical: '1005' })

    const confirmed = await post(`/api/v1/projects/${PROJECT_ID}/mappings`, mappingRequest(), { idempotencyKey: 'idem-confirm-pg' })
    expect(confirmed.statusCode).toBe(201)
    const data = confirmed.json().data as { mapping: { mappingId: string; version: string; digest: string; ref: { role: string } } }
    mappingId = data.mapping.mappingId
    mappingVersion = data.mapping.version
    expect(data.mapping.ref.role).toBe('catalog')

    const replay = await post(`/api/v1/projects/${PROJECT_ID}/mappings`, mappingRequest(), { idempotencyKey: 'idem-confirm-pg' })
    expect(replay.statusCode).toBe(200)
    expect((replay.json().data as { created: boolean }).created).toBe(false)

    const read = await get(`/api/v1/projects/${PROJECT_ID}/mappings/${mappingId}/versions/${mappingVersion}`)
    expect(read.statusCode).toBe(200)
    expect((read.json().data as { mapping: { digest: string } }).mapping.digest).toBe(data.mapping.digest)

    const list = await get(`/api/v1/projects/${PROJECT_ID}/mappings`)
    expect((list.json().data as { mappings: unknown[] }).mappings).toHaveLength(1)
  })

  it('binds parsed rows to stable records with canonical units', async () => {
    const bound = await post(
      `/api/v1/projects/${PROJECT_ID}/records`,
      { parseId: PARSE_ID, mappingId, mappingVersion },
      { idempotencyKey: 'idem-bind-pg' },
    )
    expect(bound.statusCode).toBe(201)
    const data = bound.json().data as { counts: { total: number; confirmed: number }; records: { recordId: string; fields: { fieldId: string; normalized: unknown }[] }[] }
    expect(data.counts).toMatchObject({ total: 2, confirmed: 2 })
    const first = data.records.find((record) => record.recordId === RECORD_A)
    expect(first?.fields.find((field) => field.fieldId === 'meterValue')?.normalized).toEqual({ kind: 'quantity', value: '1005', unitCode: 'Wh' })

    const replay = await post(
      `/api/v1/projects/${PROJECT_ID}/records`,
      { parseId: PARSE_ID, mappingId, mappingVersion },
      { idempotencyKey: 'idem-bind-pg-2' },
    )
    expect(replay.statusCode).toBe(200)
    expect((replay.json().data as { created: boolean }).created).toBe(false)
  })

  it('reads the bound records back through the API', async () => {
    const response = await get(`/api/v1/projects/${PROJECT_ID}/records`)
    expect(response.statusCode).toBe(200)
    const data = response.json().data as { total: number; records: { recordId: string; status: string; revision: string }[] }
    expect(data.total).toBe(2)
    expect(data.records.every((record) => record.status === 'confirmed')).toBe(true)
    expect(data.records.every((record) => record.revision === '1')).toBe(true)
  })

  it('keeps one project mapping invisible to another scope and requires authentication', async () => {
    const crossScope = await get(`/api/v1/projects/${PROJECT_ID}/mappings`, { scope: 'other' })
    expect(crossScope.statusCode).toBe(404)
    expect((crossScope.json() as { error: { code: string } }).error.code).toBe('PROJECT_NOT_FOUND')

    const unauthenticated = await get(`/api/v1/projects/${PROJECT_ID}`, { subject: null })
    expect(unauthenticated.statusCode).toBe(401)
  })
})
