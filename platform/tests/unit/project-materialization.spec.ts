import { describe, expect, it } from 'vitest'
import { controlledPublishedDatasetSource } from '../fixtures/controlled-published-dataset'
import {
  InMemoryProjectReadinessStore,
  InMemoryIndustrySchemaSource,
  ProjectDataMaterializationService,
} from '@ontology/application'
import type { ProjectDataMaterializationDependencies } from '@ontology/application'
import { ProjectDatasetError } from '@ontology/contracts'
import type {
  AppendProjectRecordResult,
  ImportMappingVersion,
  IndustrySchema,
  InsertMappingResult,
  MappingRef,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryRequest,
  ProjectDatasetQueryResult,
  ProjectDatasetStageInput,
  ProjectDatasetStageResult,
  ProjectDatasetWriterPort,
  NewProjectRecordVersion,
  ProjectMappingStore,
  ProjectMappingWriteMeta,
  ProjectRecordPage,
  ProjectRecordQuery,
  ProjectRecordStore,
  ProjectRecordVersion,
  ProjectRevision,
  ScopeRef,
  Semver,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222'
const RECORD_A = '33333333-3333-4333-8333-333333333333'
const RECORD_B = '44444444-4444-4444-8444-444444444444'
const MAPPING_ID = '55555555-5555-4555-8555-555555555555'
const DEFINITION_REF = { id: 'meter-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` } as const
const ORIGINAL_REF = { id: '66666666-6666-4666-8666-666666666666', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' } as const
const SCOPES: ScopeRef = { tenantId: 'tenant-a', spaceId: 'space-a' }

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function schema(): IndustrySchema {
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

function mapping(): ImportMappingVersion {
  const ref: MappingRef = {
    id: MAPPING_ID,
    version: '1.0.0',
    digest: sha('c'),
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src' }, objectPath: 'Meter' },
  }
  return {
    schemaVersion: 'import-mapping@1',
    projectId: PROJECT_ID,
    mappingId: MAPPING_ID,
    version: '1.0.0',
    ref,
    definitionRef: DEFINITION_REF,
    format: 'csv',
    parseId: '77777777-7777-4777-8777-777777777777',
    originalRef: ORIGINAL_REF,
    originalMediaType: 'text/csv',
    options: { headerRow: 1 },
    objectId: 'Meter',
    entries: [],
    digest: sha('c'),
    actor: 'tester',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function record(recordId: string, value: string, status: ProjectRecordVersion['status'] = 'confirmed'): ProjectRecordVersion {
  return {
    schemaVersion: 'project-record@1',
    projectId: PROJECT_ID,
    recordId,
    revision: '1',
    mappingId: MAPPING_ID,
    mappingVersion: '1.0.0',
    objectId: 'Meter',
    sourceRowKey: `csv:sheet:row:${value}`,
    sourceDigest: sha('d'),
    contentDigest: sha(value.padEnd(1, '0')),
    fields: [
      { fieldId: 'deviceId', raw: `d-${value}`, normalized: { kind: 'scalar', value: `d-${value}` }, status: 'confirmed', locator: { kind: 'table_cell', format: 'csv', recordIndex: 1, row: 2, column: 1, normalizationMapRef: 'map' } },
      { fieldId: 'meterValue', raw: value, normalized: { kind: 'quantity', value, unitCode: 'Wh' }, status, ...(status === 'confirmed' ? {} : { reason: 'PENDING' }), locator: { kind: 'table_cell', format: 'csv', recordIndex: 1, row: 2, column: 2, normalizationMapRef: 'map' } },
    ],
    status,
    actor: 'tester',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function revision(projectId: string, revisionNumber: string): ProjectRevision {
  return {
    ref: { projectId, revision: revisionNumber, digest: sha('f') },
    industryPackRef: { id: 'pack', version: '1.0.0', digest: sha('a') },
    definitionRef: DEFINITION_REF,
    mappingRefs: [mapping().ref],
    profileRef: { id: 'profile', version: '1.0.0', snapshotHash: sha('9') },
    documentSetRef: { id: '88888888-8888-4888-8888-888888888888', version: '1.0.0', digest: sha('d'), kind: 'artifact' },
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '1',
    changeReason: 'seed',
  }
}

class FakeProjects {
  readonly #projects = new Map<string, { headRevision: string }>()
  readonly #revisions = new Map<string, ProjectRevision>()

  seed(projectId: string, head: string): void {
    this.#projects.set(projectId, { headRevision: head })
    this.#revisions.set(`${projectId}:${head}`, revision(projectId, head))
  }

  async getProject(_scope: ScopeRef, projectId: string): Promise<{ headRevision: string } | undefined> {
    return this.#projects.get(projectId)
  }

  async getRevision(_scope: ScopeRef, projectId: string, revisionNumber: string): Promise<ProjectRevision | undefined> {
    return this.#revisions.get(`${projectId}:${revisionNumber}`)
  }
}

class FakeRecords implements ProjectRecordStore {
  constructor(private readonly rows: ProjectRecordVersion[]) {}

  async appendRecords(
    _scope: ScopeRef,
    _projectId: Uuid,
    _records: readonly NewProjectRecordVersion[],
    _meta: ProjectMappingWriteMeta,
    _ctx: ToolContext,
  ): Promise<AppendProjectRecordResult> {
    void _ctx
    return { records: [], created: false }
  }

  async listRecords(_scope: ScopeRef, _projectId: Uuid, _query: ProjectRecordQuery): Promise<ProjectRecordPage> {
    void _query
    return { records: this.rows, total: this.rows.length }
  }

  async getRecord(): Promise<ProjectRecordVersion | undefined> {
    return undefined
  }
}

class FakeMappings implements ProjectMappingStore {
  async insertMapping(
    _scope: ScopeRef,
    incoming: ImportMappingVersion,
  ): Promise<InsertMappingResult> {
    void _scope
    return { mapping: incoming, created: true }
  }

  async getMapping(
    _scope: ScopeRef,
    _projectId: Uuid,
    _mappingId: Uuid,
    _version: Semver,
  ): Promise<ImportMappingVersion | undefined> {
    void _version
    return mapping()
  }

  async listMappings(): Promise<ImportMappingVersion[]> {
    return [mapping()]
  }

  async latestVersion(): Promise<Semver | undefined> {
    return '1.0.0'
  }
}

class FakeBackend implements ProjectDatasetWriterPort, ProjectDatasetQueryPort {
  readonly backend = 'test-memory'
  readonly snapshots = new Map<string, ProjectDatasetQueryResult>()
  failNext = false

  async stageSnapshot(_scope: ScopeRef, input: ProjectDatasetStageInput): Promise<ProjectDatasetStageResult> {
    if (this.failNext) {
      this.failNext = false
      return {
        snapshotRef: input.snapshotRef,
        rowCount: input.body.rows.length + 1,
        schemaDigest: input.schemaDigest,
        canonicalDigest: sha('0'),
        created: true,
      }
    }
    this.snapshots.set(input.snapshotRef.id, {
      snapshotRef: input.snapshotRef,
      columns: input.body.columns,
      rows: input.body.rows,
      coverage: { returned: input.body.rows.length, truncated: false, completeness: input.body.coverage.completeness },
    })
    return {
      snapshotRef: input.snapshotRef,
      rowCount: input.body.rows.length,
      schemaDigest: input.schemaDigest,
      canonicalDigest: input.canonicalDigest,
      created: true,
    }
  }

  async discardSnapshot(_scope: ScopeRef, snapshotRef: { readonly id: string }): Promise<void> {
    this.snapshots.delete(snapshotRef.id)
  }

  async querySnapshot(_scope: ScopeRef, request: ProjectDatasetQueryRequest): Promise<ProjectDatasetQueryResult> {
    const stored = this.snapshots.get(request.snapshotRef.id)
    if (stored === undefined) {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'not materialised')
    }
    return stored
  }
}

function serviceWith(rows: readonly ProjectRecordVersion[], backend = new FakeBackend()) {
  const projects = new FakeProjects()
  projects.seed(PROJECT_ID, '1')
  projects.seed(OTHER_PROJECT, '1')
  const dependencies: ProjectDataMaterializationDependencies = {
    projects,
    publishedSource: controlledPublishedDatasetSource(new FakeRecords([...rows]), new FakeMappings()),
    readiness: new InMemoryProjectReadinessStore(),
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: schema() }]),
    writer: backend,
    query: backend,
    now: () => '2026-09-30T00:00:00Z',
  }
  const service = new ProjectDataMaterializationService(dependencies)
  const ctx = toolContext(SCOPES.tenantId, SCOPES.spaceId, ['operator'])
  return { service, backend, ctx, dependencies }
}

describe('ProjectDataMaterializationService (unit)', () => {
  it('materialises confirmed records into a canonical dataset and gates reads on activation', async () => {
    const { service, ctx } = serviceWith([record(RECORD_A, '1005'), record(RECORD_B, '2500')])
    const status = await service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)
    expect(status.state).toBe('ready')
    expect(status.coverage).toMatchObject({ expectedCount: 2, processedCount: 2, completeness: 'complete' })

    const result = await service.query(
      { projectRevisionRef: status.projectRevisionRef, snapshotRef: status.snapshotRef! },
      ctx,
    )
    expect(result.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.values['meterValue']).toEqual({ kind: 'quantity', value: '1005', unitCode: 'Wh' })
    expect(result.rows[0]?.sources[0]).toMatchObject({ documentRef: ORIGINAL_REF, parseId: mapping().parseId })

    expect((await service.queryActive({ projectId: PROJECT_ID }, ctx)).snapshotRef.id).toBe(status.snapshotRef!.id)
  })

  it('refuses a pinned snapshot that is not the active dataset instead of reading a newer one', async () => {
    const { service, ctx } = serviceWith([record(RECORD_A, '1005')])
    const status = await service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)
    const foreign = { ...status.snapshotRef!, id: '99999999-9999-4999-8999-999999999999' }
    await expect(
      service.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: foreign }, ctx),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', httpStatus: 409 })
  })

  it('blocks a dataset with unconfirmed records unless a partial snapshot is explicitly allowed', async () => {
    const { service, ctx } = serviceWith([record(RECORD_A, '1005'), record(RECORD_B, '2500', 'pending')])
    await expect(service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)).rejects.toMatchObject({
      code: 'INPUT_NOT_READY',
    })
    await expect(service.queryActive({ projectId: PROJECT_ID }, ctx)).rejects.toMatchObject({
      code: 'SNAPSHOT_UNAVAILABLE',
    })

    const partial = await service.materialize(PROJECT_ID, { objectId: 'Meter', allowPartial: true }, ctx)
    expect(partial.coverage).toMatchObject({ expectedCount: 2, processedCount: 1, completeness: 'partial' })
  })

  it('refuses a backend that persisted a different row count or digest', async () => {
    const backend = new FakeBackend()
    backend.failNext = true
    const { service, ctx } = serviceWith([record(RECORD_A, '1005')], backend)
    await expect(service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)).rejects.toMatchObject({
      code: 'MATERIALIZATION_MISMATCH',
    })
  })

  it('keeps the dataset invisible to another project scope', async () => {
    const { service, ctx } = serviceWith([record(RECORD_A, '1005')])
    await service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)
    await expect(service.queryActive({ projectId: OTHER_PROJECT }, ctx)).rejects.toMatchObject({
      code: 'SNAPSHOT_UNAVAILABLE',
    })
  })
  it('requires the official publication port even when legacy records are confirmed', async () => {
    const { dependencies, ctx } = serviceWith([record(RECORD_A, '1005')])
    const { publishedSource: _published, ...withoutSource } = dependencies
    void _published
    const service = new ProjectDataMaterializationService({ ...withoutSource, records: new FakeRecords([record(RECORD_A, '1005')]), mappings: new FakeMappings() })
    await expect(service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
  })

  it('discards a newly staged snapshot when official sources change during the build and never activates it', async () => {
    const { dependencies, backend, ctx } = serviceWith([record(RECORD_A, '1005')])
    const source = dependencies.publishedSource
    if (source === undefined) throw new Error('the controlled publication source is missing')
    let changed = false
    const stage = backend.stageSnapshot.bind(backend)
    backend.stageSnapshot = async (...args) => { const result = await stage(...args); changed = true; return result }
    const service = new ProjectDataMaterializationService({ ...dependencies, publishedSource: { read: async (...args) => {
      const result = await source.read(...args)
      return changed ? { ...result, sourceDigest: sha('a') } : result
    } } })
    await expect(service.materialize(PROJECT_ID, { objectId: 'Meter' }, ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
    expect(backend.snapshots.size).toBe(0)
    await expect(service.queryActive({ projectId: PROJECT_ID }, ctx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
  })

})
