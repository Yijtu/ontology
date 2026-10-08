import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { ProjectDataMaterializationService } from '@ontology/application'
import type { ProjectDatasetQueryPort, ProjectDatasetWriterPort, SemanticDefinitionVersion } from '@ontology/contracts'
import { definitionVersionDigest, ProjectSemanticQueryService, projectSnapshotMappingRef } from '@ontology/semantic-engine'
import { createToolContext, projectDatasetSourceRef } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { relationDefinition } from '../unit/rule-relation-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { seedIdentityProject } from './instance-identity-fixtures'
import { projectQueryPublicationFixture } from './project-query-publication-fixtures'

let harness: JobDbHarness
let db: ControlPostgresDatabase
let structured: PostgresStructuredIngestionStore
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let directory = ''
beforeAll(async () => {
  harness = await startJobDatabase()
  db = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  structured = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  directory = await mkdtemp(join(tmpdir(), 'published-project-dataset-'))
  const objects = new FileSystemObjectStore(directory)
  await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
}, 300_000)
afterAll(async () => {
  await structured?.close()
  await registry?.close()
  await db?.close()
  if (directory !== '') await rm(directory, { recursive: true, force: true })
  await harness?.stop()
})

async function fixture(label: string, csv = 'device,power,on,reading,label\nM-1,12.000000000000001,true,9007199254740993,9007199254740993\nM-2,-0.000000000000001,false,-9007199254740994,000123\n', fieldIds: readonly string[] = ['meter_id', 'power', 'active', 'reading', 'label'], units: Parameters<ReturnType<typeof projectQueryPublicationFixture>['importCsv']>[3] = { power: 'kW' }) {
  const scoped = await createJobScope(harness.adminClient, label)
  const scope = scoped.scopeRef
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'operator', 'profile-editor', 'semantic-reviewer', 'semantic-publisher'])
  const projectId = randomUUID()
  const base = relationDefinition(scope)
  const extended = { ...base, attributes: [...base.attributes,
    { namespace: base.namespace, standardProvenance: [], kind: 'attribute' as const, id: 'reading', objectId: 'meter', valueType: 'number' as const, cardinality: { min: 1, max: 1 } },
    { namespace: base.namespace, standardProvenance: [], kind: 'attribute' as const, id: 'label', objectId: 'meter', valueType: 'string' as const, cardinality: { min: 1, max: 1 } },
  ] }
  const definition: SemanticDefinitionVersion = { ...extended, ref: { ...base.ref, digest: definitionVersionDigest(extended) } }
  await seedIdentityProject(harness.adminClient, scope, projectId, definition.ref)
  const publication = projectQueryPublicationFixture({ db, blobs, structured, scope, ctx, projectId, definition })
  const source = await publication.importCsv('meter', csv, fieldIds, units)
  return { ...publication, source, scope, ctx, projectId, definition }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function service(p: Fixture, backend: ProjectDatasetQueryPort & ProjectDatasetWriterPort) {
  return new ProjectDataMaterializationService({ projects: p.projects, publishedSource: p.publishedSource, readiness: p.readiness, schemaSource: p.schemas, writer: backend, query: backend })
}

describe('official published facts → fixed project dataset (real control PG and business backends)', () => {
  it('keeps field-confirmed/staged records out of the dataset until human identity, review and publication complete', async () => {
    const p = await fixture('query-official')
    const backend = new DuckDbProjectDatasetAdapter()
    try {
      const materializer = service(p, backend)
      await expect(materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
      await p.approveAndPublish(p.source)
      const status = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      const result = await materializer.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: status.snapshotRef! }, p.ctx)
      expect(result.rows).toHaveLength(2)
      expect(result.rows.map((row) => row.values['reading']?.value).sort()).toEqual(['-9007199254740994', '9007199254740993'])
      expect(result.rows.find((row) => row.values['meter_id']?.value === 'M-1')?.values['power']).toEqual({ kind: 'quantity', value: '12.000000000000001', unitCode: 'kW' })
      const descriptor = await backend.describeSnapshot(p.scope, status.snapshotRef!, p.ctx)
      expect(descriptor?.metadata?.body).toMatchObject({ projectRevisionRef: status.projectRevisionRef, definitionRef: p.definition.ref, factRecordedPoint: { semantic: expect.any(String), identity: expect.any(String) }, sourceDigest: expect.stringMatching(/^sha256:/) })
      const cell = result.rows.find((row) => row.values['meter_id']?.value === 'M-1')?.sources.find((source) => source.fieldId === 'power')
      expect(cell).toMatchObject({ parseId: p.source.mapping.parseId, documentRef: p.source.mapping.originalRef, locator: { kind: 'table_cell', row: 2, column: 2 }, factSource: { projectRevisionRef: status.projectRevisionRef, mappingRef: p.source.mapping.ref }, statementVersion: '1' })
      const replay = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      expect(replay.snapshotRef).toEqual(status.snapshotRef)
    } finally { backend.close() }
  }, 120_000)

  it('uses scoped project identity and refuses foreign, missing and changed-version snapshots', async () => {
    const p = await fixture('query-scope')
    await p.approveAndPublish(p.source)
    const backend = new DuckDbProjectDatasetAdapter()
    try {
      const materializer = service(p, backend)
      const status = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      await expect(materializer.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: { ...status.snapshotRef!, id: randomUUID() } }, p.ctx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
      expect(await backend.describeSnapshot(p.scope, { ...status.snapshotRef!, version: '99.0.0' }, p.ctx)).toBeUndefined()
      const other = await createJobScope(harness.adminClient, 'query-foreign')
      const foreign = toolContext(other.tenantId, other.spaceId, ['operator'])
      await expect(backend.describeSnapshot(p.scope, status.snapshotRef!, foreign)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
      expect(await backend.describeSnapshot(other.scopeRef, status.snapshotRef!, foreign)).toBeUndefined()
      await expect(materializer.queryActive({ projectId: randomUUID() }, p.ctx)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    } finally { backend.close() }
  }, 120_000)

  it('keeps history fixed after a new real input is published, and never substitutes the latest snapshot', async () => {
    const p = await fixture('query-history')
    await p.approveAndPublish(p.source)
    const backend = new DuckDbProjectDatasetAdapter()
    try {
      const materializer = service(p, backend)
      const old = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      const original = await materializer.query({ projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef! }, p.ctx)
      const changed = await p.importCsv('meter', 'device,power,on,reading,label\nM-3,99.000000000000001,true,9007199254740995,000789\n', ['meter_id', 'power', 'active', 'reading', 'label'], { power: 'kW' })
      await p.approveAndPublish(changed)
      const current = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      expect(current.snapshotRef).not.toEqual(old.snapshotRef)
      expect((await materializer.queryActive({ projectId: p.projectId }, p.ctx)).rows[0]?.values['reading']?.value).toBe('9007199254740995')
      expect((await materializer.query({ projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef! }, p.ctx)).rows).toEqual(original.rows)
    } finally { backend.close() }
  }, 120_000)

  it('reads the same ready historical PG and DuckDB snapshots after restart', async () => {
    const p = await fixture('query-restart')
    await p.approveAndPublish(p.source)
    const path = join(directory, `${randomUUID()}.duckdb`)
    let canonicalRows: Awaited<ReturnType<ProjectDatasetQueryPort['querySnapshot']>>['rows'] | undefined
    for (const kind of ['duckdb', 'postgres'] as const) {
      const options = { connectionString: harness.adminUrl, schema: `business_${randomUUID().replaceAll('-', '')}` }
      const first = kind === 'duckdb' ? new DuckDbProjectDatasetAdapter({ instancePath: path }) : new PostgresProjectDatasetAdapter(options)
      const status = await service(p, first).materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      const before = await first.querySnapshot(p.scope, { snapshotRef: status.snapshotRef! }, p.ctx)
      if (canonicalRows === undefined) canonicalRows = before.rows
      else expect(before.rows).toEqual(canonicalRows)
      await first.close()
      const restarted = kind === 'duckdb' ? new DuckDbProjectDatasetAdapter({ instancePath: path }) : new PostgresProjectDatasetAdapter(options)
      try {
        expect((await restarted.describeSnapshot(p.scope, status.snapshotRef!, p.ctx))?.metadata?.snapshotRef).toEqual(status.snapshotRef)
        expect((await service(p, restarted).query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: status.snapshotRef! }, p.ctx)).rows).toEqual(before.rows)
      } finally { await restarted.close() }
    }
  }, 120_000)

  it('refuses withdrawn sources and a mutated definition when building a new projection', async () => {
    const p = await fixture('query-withdrawn')
    await p.approveAndPublish(p.source)
    const backend = new DuckDbProjectDatasetAdapter()
    try {
      const materializer = service(p, backend)
      const pinned = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      await p.documents.reviseDocument(p.scope, p.projectId, { documentId: p.source.documentId, op: 'retract', reason: 'human withdrew source', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
      await expect(materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
      expect((await materializer.query({ projectRevisionRef: pinned.projectRevisionRef, snapshotRef: pinned.snapshotRef! }, p.ctx)).rows).toHaveLength(2)
      const revision = await p.projects.getRevision(p.scope, p.projectId, pinned.projectRevisionRef.revision, p.ctx)
      if (revision === undefined) throw new Error('missing pinned revision')
      p.replaceReadDefinition({ ...p.definition, attributes: [...p.definition.attributes, { ...p.definition.attributes[0]!, id: 'tampered_attribute' }] })
      await expect(p.publishedSource.read(p.scope, revision, 'meter', p.ctx)).rejects.toMatchObject({ code: 'INPUT_NOT_READY' })
    } finally { backend.close() }
  }, 120_000)
  it('materializes and pages 1001 actually mapped, human-approved and published rows on both business backends', async () => {
    const csv = ['device,power,on,reading,label', ...Array.from({ length: 1001 }, (_unused, index) =>
      `bulk-${String(index).padStart(4, '0')},12.000000000000001,true,${index % 2 === 0 ? '9007199254740993' : '-9007199254740994'},000123`)].join('\n') + '\n'
    const p = await fixture('query-official-1001', csv)
    expect(p.source.records).toHaveLength(1001)
    expect(p.source.entities).toHaveLength(1001)
    await p.approveAndPublish(p.source)
    expect(await p.publications.latestPublicationRevision(p.scope, p.ctx)).toBe('6')
    const business = new PostgresProjectDatasetAdapter({ connectionString: harness.adminUrl, schema: `bulk_business_${randomUUID().replaceAll('-', '')}` })
    const duck = new DuckDbProjectDatasetAdapter()
    let canonicalRows: Awaited<ReturnType<ProjectDatasetQueryPort['querySnapshot']>>['rows'] | undefined
    try {
      for (const backend of [duck, business]) {
        const materializer = service(p, backend)
        const status = await materializer.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
        expect(status.coverage).toMatchObject({ expectedCount: 1001, processedCount: 1001, completeness: 'complete' })
        const rows = []
        let cursor: string | undefined
        do {
          const page = await materializer.query({ projectRevisionRef: status.projectRevisionRef, snapshotRef: status.snapshotRef!, limit: 250, ...(cursor === undefined ? {} : { cursor }) }, p.ctx)
          rows.push(...page.rows)
          expect(page.rows.length).toBeLessThanOrEqual(250)
          expect(page.coverage.truncated).toBe(rows.length < 1001)
          cursor = page.coverage.cursor
        } while (cursor !== undefined)
        expect(rows).toHaveLength(1001)
        expect(new Set(rows.map((row) => row.recordId)).size).toBe(1001)
        const last = rows.find((row) => row.values['meter_id']?.value === 'bulk-1000')
        expect(last?.values['reading']).toEqual({ kind: 'scalar', value: '9007199254740993' })
        expect(last?.values['label']).toEqual({ kind: 'scalar', value: '000123' })
        expect(last?.values['power']).toEqual({ kind: 'quantity', value: '12.000000000000001', unitCode: 'kW' })
        expect(last?.sources.find((source) => source.fieldId === 'power')).toMatchObject({ statementVersion: '1', locator: { kind: 'table_cell', row: 1002, column: 2 }, factSource: { projectRevisionRef: status.projectRevisionRef, recordId: last?.recordId } })
        if (canonicalRows === undefined) canonicalRows = rows
        else expect(rows).toEqual(canonicalRows)
      }
    } finally { duck.close(); await business.close() }
  }, 300_000)

  it('projects two actual client column/unit mappings to equal semantics with distinct exact cell origins', async () => {
    const a = await fixture('query-client-watts', 'device_label,watts,on,reading,label\nM-1,12000.000000000001,true,9007199254740993,000123\n', ['meter_id', 'power', 'active', 'reading', 'label'], { power: { source: 'W', canonical: 'kW', numerator: '1', denominator: '1000' } })
    const b = await fixture('query-client-kilowatts', 'kilowatts,code,enabled,number,text\n12.000000000000001,M-1,true,9007199254740993,000123\n', ['power', 'meter_id', 'active', 'reading', 'label'], { power: 'kW' })
    await a.approveAndPublish(a.source)
    await b.approveAndPublish(b.source)
    const backendA = new DuckDbProjectDatasetAdapter()
    const backendB = new PostgresProjectDatasetAdapter({ connectionString: harness.adminUrl, schema: `client_business_${randomUUID().replaceAll('-', '')}` })
    try {
      const statusA = await service(a, backendA).materialize(a.projectId, { objectId: 'meter' }, a.ctx)
      const statusB = await service(b, backendB).materialize(b.projectId, { objectId: 'meter' }, b.ctx)
      const rowsA = await service(a, backendA).query({ projectRevisionRef: statusA.projectRevisionRef, snapshotRef: statusA.snapshotRef! }, a.ctx)
      const rowsB = await service(b, backendB).query({ projectRevisionRef: statusB.projectRevisionRef, snapshotRef: statusB.snapshotRef! }, b.ctx)
      expect(rowsA.columns).toEqual(rowsB.columns)
      expect(rowsA.rows.map((row) => row.values)).toEqual(rowsB.rows.map((row) => row.values))
      expect(rowsA.rows[0]?.values['power']).toEqual({ kind: 'quantity', value: '12.000000000000001', unitCode: 'kW' })
      expect(statusA.snapshotRef).not.toEqual(statusB.snapshotRef)
      const originA = rowsA.rows[0]?.sources.find((source) => source.fieldId === 'power')
      const originB = rowsB.rows[0]?.sources.find((source) => source.fieldId === 'power')
      expect(originA?.locator).toMatchObject({ kind: 'table_cell', row: 2, column: 2 })
      expect(originB?.locator).toMatchObject({ kind: 'table_cell', row: 2, column: 1 })
      expect(originA?.documentRef).not.toEqual(originB?.documentRef)
      expect(originA?.factSource?.mappingRef).toEqual(a.source.mapping.ref)
      expect(originB?.factSource?.mappingRef).toEqual(b.source.mapping.ref)
      const queries = []
      for (const [client, backend, status] of [[a, backendA, statusA], [b, backendB, statusB]] as const) {
        const ctx = createToolContext({ ...client.ctx, deadline: new Date(Date.now() + 60_000).toISOString(), allowedResources: { ...client.ctx.allowedResources, sourceRefs: [projectDatasetSourceRef(status.snapshotRef!.id)] } })
        const descriptor = await backend.describeSnapshot(client.scope, status.snapshotRef!, ctx)
        if (descriptor === undefined) throw new Error('the client snapshot descriptor is missing')
        queries.push(await new ProjectSemanticQueryService({ query: backend }).execute({ descriptor,
          plan: { mode: 'semantic', concepts: ['meter'], fields: ['meter_id', 'power'], links: [], filters: [{ fieldRef: 'power', op: 'gte', values: ['12.000000000000001'] }],
            orderBy: [{ fieldRef: 'meter_id', direction: 'asc' }], limit: 100, mappingVersion: projectSnapshotMappingRef({ descriptor }) },
          limits: { maxRows: 100, maxBytes: 1_048_576, maxDurationMs: 30_000 } }, ctx))
      }
      expect(queries[0]?.rows.map((row) => row.values)).toEqual([['M-1', '12.000000000000001']])
      expect(queries[1]?.rows.map((row) => row.values)).toEqual(queries[0]?.rows.map((row) => row.values))
      expect(queries.every((query) => query.columns[1]?.unit === 'kW')).toBe(true)

    } finally { backendA.close(); await backendB.close() }
  }, 120_000)

})
