import { describe, expect, it } from 'vitest'
import { IMPORT_MAPPING_SCHEMA_VERSION } from '@ontology/contracts'
import type {
  AppendProjectRecordResult,
  ColumnMappingEntry,
  ColumnMappingRequest,
  ImportMappingVersion,
  IndustrySchema,
  InsertMappingResult,
  NewProjectRecordVersion,
  ProjectMappingStore,
  ProjectMappingWriteMeta,
  ProjectRecordPage,
  ProjectRecordQuery,
  ProjectRecordStore,
  ProjectRecordVersion,
  ScopeRef,
  Semver,
  StructuredDocumentParserPort,
  StructuredIngestionStore,
  StructuredParseResult,
  StructuredRecordEntry,
  StructuredRecordPage,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { InMemoryIndustrySchemaSource, ProjectMappingService, applyExactFactor } from '@ontology/application'
import { StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { ProjectMappingServiceDependencies } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const DEFINITION_REF: VersionRef = { id: 'meter-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` }
const DIGEST = `sha256:${'a'.repeat(64)}`

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

const CSV = 'device_id,meter_value,unit\nd1,1.005,kWh\nd2,2.5,kWh\n'
const MEDIA = 'text/csv'
const ORIGINAL_REF = { id: '22222222-2222-4222-8222-222222222222', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' as const }

interface Source {
  readonly bytes: Uint8Array
  readonly parsed: StructuredParseResult
  readonly columnDigests: readonly string[]
  readonly sheetKey: string
  readonly rowKeys: readonly string[]
}

function loadSource(): Source {
  const bytes = new TextEncoder().encode(CSV)
  const parsed = new StructuredDocumentParser().parse(bytes, { mediaType: MEDIA, headerRow: 1 })
  const table = parsed.tables[0]
  if (table === undefined) throw new Error('the CSV fixture did not parse into one table')
  const sheetKey = table.sheetId ?? table.sheetName ?? 'sheet'
  return {
    bytes,
    parsed,
    columnDigests: table.columns.map((column) => column.headerDigest),
    sheetKey,
    rowKeys: table.rows.map((row) => `csv:${sheetKey}:row:${row.row}`),
  }
}

const SOURCE = loadSource()

class InMemoryMappingStore implements ProjectMappingStore {
  readonly #byKey = new Map<string, ImportMappingVersion>()
  readonly #byIdempotency = new Map<string, ImportMappingVersion>()

  async insertMapping(
    _scopeRef: ScopeRef,
    mapping: ImportMappingVersion,
    meta: ProjectMappingWriteMeta,
  ): Promise<InsertMappingResult> {
    const replay = this.#byIdempotency.get(meta.idempotencyKey)
    if (replay !== undefined) {
      return { mapping: replay, created: false }
    }
    const key = `${mapping.projectId}:${mapping.mappingId}:${mapping.version}`
    const existing = this.#byKey.get(key)
    if (existing !== undefined) return { mapping: existing, created: false }
    this.#byKey.set(key, mapping)
    this.#byIdempotency.set(meta.idempotencyKey, mapping)
    return { mapping, created: true }
  }

  async getMapping(_scopeRef: ScopeRef, projectId: Uuid, mappingId: Uuid, version: Semver): Promise<ImportMappingVersion | undefined> {
    return this.#byKey.get(`${projectId}:${mappingId}:${version}`)
  }

  async listMappings(_scopeRef: ScopeRef, projectId: Uuid): Promise<ImportMappingVersion[]> {
    return [...this.#byKey.values()].filter((mapping) => mapping.projectId === projectId)
  }

  async latestVersion(_scopeRef: ScopeRef, projectId: Uuid, mappingId: Uuid): Promise<Semver | undefined> {
    const versions = [...this.#byKey.values()]
      .filter((mapping) => mapping.projectId === projectId && mapping.mappingId === mappingId)
      .map((mapping) => mapping.version)
    return versions[versions.length - 1]
  }
}

class InMemoryRecordStore implements ProjectRecordStore {
  readonly #latest = new Map<string, ProjectRecordVersion>()
  readonly appended: ProjectRecordVersion[] = []

  async appendRecords(
    _scopeRef: ScopeRef,
    projectId: Uuid,
    records: readonly NewProjectRecordVersion[],
  ): Promise<AppendProjectRecordResult> {
    const results: ProjectRecordVersion[] = []
    let created = false
    for (const record of records) {
      const key = `${projectId}:${record.recordId}`
      const existing = this.#latest.get(key)
      if (existing !== undefined && existing.contentDigest === record.contentDigest) {
        results.push(existing)
        continue
      }
      const revision = existing === undefined ? '1' : (BigInt(existing.revision) + 1n).toString()
      const body: ProjectRecordVersion = { ...record, revision }
      this.#latest.set(key, body)
      this.appended.push(body)
      results.push(body)
      created = true
    }
    return { records: results, created }
  }

  async listRecords(_scopeRef: ScopeRef, projectId: Uuid, query: ProjectRecordQuery): Promise<ProjectRecordPage> {
    const all = [...this.#latest.values()].filter((record) => record.projectId === projectId)
    const filtered = query.status === undefined ? all : all.filter((record) => record.status === query.status)
    return { records: filtered, total: filtered.length }
  }

  async getRecord(_scopeRef: ScopeRef, projectId: Uuid, recordId: Uuid): Promise<ProjectRecordVersion | undefined> {
    return this.#latest.get(`${projectId}:${recordId}`)
  }
}

class FakeIngestionStore implements StructuredIngestionStore {
  constructor(private readonly entries: readonly StructuredRecordEntry[]) {}
  recordParse(): Promise<{ created: boolean }> {
    return Promise.reject(new Error('not used'))
  }
  findParseByDigest(): Promise<undefined> {
    return Promise.resolve(undefined)
  }
  listRecords(): Promise<StructuredRecordPage> {
    return Promise.resolve({ records: this.entries, total: this.entries.length })
  }
  countRecords(): Promise<{ total: number; succeeded: number; pending: number; failed: number; skipped: number }> {
    return Promise.resolve({ total: this.entries.length, succeeded: this.entries.length, pending: 0, failed: 0, skipped: 0 })
  }
  listFailures(): Promise<readonly StructuredRecordEntry[]> {
    return Promise.resolve([])
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function entry(recordId: string, rowKey: string, index: number, row: number): StructuredRecordEntry {
  return {
    recordId,
    sourceRowKey: rowKey,
    recordIndex: index,
    row,
    state: 'parsed',
    locator: { kind: 'table_row', format: 'csv', recordIndex: index, row, columnFrom: 1, columnTo: 3, normalizationMapRef: 'map' },
    rowDigest: DIGEST,
    columnCount: 3,
  }
}

const RECORD_A = '33333333-3333-4333-8333-333333333333'
const RECORD_B = '44444444-4444-4444-8444-444444444444'

function buildService(options: { entries?: readonly StructuredRecordEntry[] } = {}): {
  readonly service: ProjectMappingService
  readonly mappings: InMemoryMappingStore
  readonly records: InMemoryRecordStore
  readonly ctx: ToolContext
} {
  const mappings = new InMemoryMappingStore()
  const records = new InMemoryRecordStore()
  const schemaSource = new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schemaFor() }])
  const parser: StructuredDocumentParserPort = new StructuredDocumentParser()
  const entries = options.entries ?? [
    entry(RECORD_A, SOURCE.rowKeys[0] ?? '', 1, 2),
    entry(RECORD_B, SOURCE.rowKeys[1] ?? '', 2, 3),
  ]
  const dependencies: ProjectMappingServiceDependencies = {
    projects: { getProject: async () => ({ headRevision: '1' }) },
    revisions: { getRevision: async () => ({ definitionRef: DEFINITION_REF }) },
    mappings,
    records,
    ingestion: new FakeIngestionStore(entries),
    schemaSource,
    originals: { read: async () => SOURCE.bytes },
    parser,
  }
  const ctx = toolContext()
  return { service: new ProjectMappingService(dependencies), mappings, records, ctx }
}

function baseRequest(): ColumnMappingRequest {
  const entries: ColumnMappingEntry[] = [
    {
      fieldRef: 'deviceId',
      header: 'device_id',
      headerDigest: SOURCE.columnDigests[0] ?? DIGEST,
      columnIndex: 0,
    },
    {
      fieldRef: 'meterValue',
      header: 'meter_value',
      headerDigest: SOURCE.columnDigests[1] ?? DIGEST,
      columnIndex: 1,
      sourceUnitCode: 'kWh',
      canonicalUnitCode: 'Wh',
      unitConversion: { fromUnitCode: 'kWh', toUnitCode: 'Wh', numerator: '1000', denominator: '1' },
    },
  ]
  return {
    format: 'csv',
    parseId: '55555555-5555-4555-8555-555555555555',
    originalRef: ORIGINAL_REF,
    originalMediaType: MEDIA,
    options: { headerRow: 1 },
    objectId: 'Meter',
    entries,
  }
}

describe('project column mapping, unit normalisation and record binding', () => {
  it('previews canonical values against the original cells and confirms an exact mapping', async () => {
    const { service, ctx } = buildService()
    const preview = await service.previewMapping(PROJECT_ID, baseRequest(), ctx)
    expect(preview.confirmable).toBe(true)
    expect(preview.rowCount).toBe(2)
    const valueColumn = preview.columns.find((column) => column.fieldRef === 'meterValue')
    expect(valueColumn?.normalization).toBe('exact')
    expect(valueColumn?.samples[0]).toMatchObject({ raw: '1.005', canonical: '1005' })
    expect(preview.unmappedColumns.map((column) => column.header)).toContain('unit')

    const confirmed = await service.confirmMapping(PROJECT_ID, baseRequest(), 'idem-confirm-1', 'editor-1', ctx)
    expect(confirmed.created).toBe(true)
    expect(confirmed.mapping.ref.role).toBe('catalog')
    const stored = await service.getMapping(PROJECT_ID, confirmed.mapping.mappingId, confirmed.mapping.version, ctx)
    expect(stored?.digest).toBe(confirmed.mapping.digest)
  })

  it('binds rows to stable record identities with exact canonical quantities', async () => {
    const { service, ctx } = buildService()
    const confirmed = await service.confirmMapping(PROJECT_ID, baseRequest(), 'idem-confirm-2', 'editor-1', ctx)
    const result = await service.bindRecords(
      PROJECT_ID,
      {
        parseId: confirmed.mapping.parseId,
        mappingId: confirmed.mapping.mappingId,
        mappingVersion: confirmed.mapping.version,
      },
      'idem-bind-1',
      'editor-1',
      ctx,
    )
    expect(result.counts).toMatchObject({ total: 2, confirmed: 2, pending: 0, conflict: 0 })
    const first = result.records.find((record) => record.recordId === RECORD_A)
    expect(first?.status).toBe('confirmed')
    expect(first?.fields.find((field) => field.fieldId === 'meterValue')?.normalized).toEqual({
      kind: 'quantity',
      value: '1005',
      unitCode: 'Wh',
    })
    expect(first?.fields.find((field) => field.fieldId === 'deviceId')?.normalized).toEqual({ kind: 'scalar', value: 'd1' })

    const replay = await service.bindRecords(
      PROJECT_ID,
      {
        parseId: confirmed.mapping.parseId,
        mappingId: confirmed.mapping.mappingId,
        mappingVersion: confirmed.mapping.version,
      },
      'idem-bind-2',
      'editor-1',
      ctx,
    )
    expect(replay.created).toBe(false)
    expect(replay.records.every((record) => record.revision === '1')).toBe(true)
  })

  it('never guesses a column: a header mismatch is located and blocks confirmation', async () => {
    const { service, ctx } = buildService()
    const request = baseRequest()
    const tampered: ColumnMappingRequest = {
      ...request,
      entries: [{ ...request.entries[0]!, header: 'device' }, request.entries[1]!],
    }
    const preview = await service.previewMapping(PROJECT_ID, tampered, ctx)
    expect(preview.confirmable).toBe(false)
    expect(preview.issues.some((entry) => entry.code === 'HEADER_MISMATCH' && entry.severity === 'error')).toBe(true)
    await expect(service.confirmMapping(PROJECT_ID, tampered, 'idem-bad-header', 'editor-1', ctx)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('blocks an unknown unit that has no declared exact conversion', async () => {
    const { service, ctx } = buildService()
    const request = baseRequest()
    const unknown: ColumnMappingRequest = {
      ...request,
      entries: [
        request.entries[0]!,
        {
          fieldRef: 'meterValue',
          header: 'meter_value',
          headerDigest: SOURCE.columnDigests[1] ?? DIGEST,
          columnIndex: 1,
          sourceUnitCode: 'BTU',
          canonicalUnitCode: 'Wh',
        },
      ],
    }
    const preview = await service.previewMapping(PROJECT_ID, unknown, ctx)
    expect(preview.confirmable).toBe(false)
    expect(preview.issues.some((entry) => entry.code === 'MISSING_UNIT_CONVERSION')).toBe(true)
  })

  it('marks an unconvertible quantity pending instead of coercing it to the canonical unit', async () => {
    const { service, mappings, ctx } = buildService()
    const mappingId = '66666666-6666-4666-8666-666666666666'
    const entryPart: ImportMappingVersion = {
      schemaVersion: IMPORT_MAPPING_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      mappingId,
      version: '1.0.0',
      ref: { id: mappingId, version: '1.0.0', digest: DIGEST, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'project-import', sourceId: mappingId }, objectPath: 'Meter' } },
      definitionRef: DEFINITION_REF,
      format: 'csv',
      parseId: '55555555-5555-4555-8555-555555555555',
      originalRef: ORIGINAL_REF,
      originalMediaType: MEDIA,
      options: { headerRow: 1 },
      objectId: 'Meter',
      entries: [
        { fieldRef: 'deviceId', header: 'device_id', headerDigest: SOURCE.columnDigests[0] ?? DIGEST, columnIndex: 0 },
        { fieldRef: 'meterValue', header: 'meter_value', headerDigest: SOURCE.columnDigests[1] ?? DIGEST, columnIndex: 1, sourceUnitCode: 'BTU', canonicalUnitCode: 'Wh' },
      ],
      digest: DIGEST,
      actor: 'editor-1',
      recordedAt: '2026-09-30T00:00:00Z',
    }
    await mappings.insertMapping({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, entryPart, { idempotencyKey: 'seed-mapping-key', requestDigest: DIGEST })

    const result = await service.bindRecords(
      PROJECT_ID,
      {
        parseId: entryPart.parseId,
        mappingId,
        mappingVersion: '1.0.0',
      },
      'idem-pending-bind',
      'editor-1',
      ctx,
    )
    const first = result.records.find((record) => record.recordId === RECORD_A)
    expect(first?.status).toBe('pending')
    const value = first?.fields.find((field) => field.fieldId === 'meterValue')
    expect(value?.status).toBe('pending')
    expect(value?.reason).toBe('MISSING_UNIT_CONVERSION')
    expect(value?.normalized).toEqual({ kind: 'scalar', value: '1.005' })
  })

  it('applies exact rational factors without introducing floating point error', () => {
    expect(applyExactFactor('1.005', '1000', '1')).toBe('1005')
    expect(applyExactFactor('2.5', '1000', '1')).toBe('2500')
    expect(applyExactFactor('1', '1', '3')).toBeUndefined()
    expect(applyExactFactor('0.1', '1', '1')).toBe('0.1')
  })
})
