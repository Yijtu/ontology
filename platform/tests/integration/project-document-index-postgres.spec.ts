import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresProjectDocumentStore,
  PostgresProjectStore,
  PostgresProjectReadinessStore,
  PostgresRunExecutionBindingStore,
  PostgresEvidenceStore,
  PostgresProfileStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
  PostgresStructuredIngestionStore,
} from '@ontology/adapter-extraction-document'
import {
  PostgresKeywordIndexStore,
  ProjectDocumentIndexService,
} from '@ontology/adapter-search-bm25'
import type { DocumentParseRecord, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'
import { projectCollectionRef } from '@ontology/contracts'
import { coreScenarioTaskBindings, createCoreApi, createCoreLocalComposition, createCoreStructuredImportWorkflow, loadCoreExamples } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import type { ProjectRevisionBody, ResourceRef, RunExecutionBinding } from '@ontology/contracts'
import { buildXlsx, rowXml, sharedStringCell, worksheetOf } from '../fixtures/structured/xlsx'
import { createTestToolContext } from '../fixtures/documents/test-doubles'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 120_000 })

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function textDocument(label: string): Uint8Array {
  return new TextEncoder().encode(
    [
      `SERVICE TERMS ${label.toUpperCase()}`,
      `1.1 The battery warranty covers five years for ${label}.`,
      `1.2 The solar inverter is maintained by the customer for ${label}.`,
    ].join('\n'),
  )
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let scopedClient: Client
let appUrl = ''
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parseStore: PostgresDocumentParseStore
let indexStore: PostgresKeywordIndexStore
let projectStore: PostgresProjectDocumentStore
let parseService: LocalDocumentExtractionService
let service: ProjectDocumentIndexService
let database: ControlPostgresDatabase
let structuredStore: PostgresStructuredIngestionStore
let workflow: ReturnType<typeof createCoreStructuredImportWorkflow>
let readinessStore: PostgresProjectReadinessStore

async function publishText(label: string): Promise<DocumentParseRecord> {
  const bytes = textDocument(label)
  const staged = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, CTX_A)
  const published = await blobStore.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    CTX_A,
  )
  return parseService.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, CTX_A)
}

async function createProject(projectId: Uuid, title: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'active', $5, $6, 'integration', now(), now())`,
    [TENANT_A, SPACE_A, projectId, title, `proj-${projectId}`, `sha256:${'a'.repeat(64)}`],
  )
}

async function register(projectId: Uuid, parse: DocumentParseRecord): Promise<void> {
  await service.importDocument(
    projectId,
    {
      documentId: randomUUID(),
      documentRef: parse.originalRef,
      documentDigest: parse.originalRef.digest,
      parseId: parse.parseId,
      parseRef: parse.spanMapRef,
      textDigest: parse.spanMapRef.digest,
      precision: 'exact',
      actor: 'integration',
      recordedAt: new Date().toISOString(),
    },
    CTX_A,
  )
}

async function withAppScope(
  tenantId: string,
  spaceId: string,
  run: () => Promise<void>,
): Promise<void> {
  await scopedClient.query('BEGIN')
  try {
    await scopedClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
      [tenantId, spaceId],
    )
    await run()
    await scopedClient.query('ROLLBACK')
  } catch (error) {
    await scopedClient.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function appScopeCount(table: string, tenantId: string): Promise<number> {
  const result = await scopedClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE tenant_id = $1`,
    [tenantId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'project-doc-tenant-a'), ($2, 'project-doc-tenant-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'project-doc-space-a'), ($3, $4, 'project-doc-space-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'project-document-index-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  indexStore = new PostgresKeywordIndexStore({ connectionString: appUrl, maxPoolSize: 4 })
  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  projectStore = new PostgresProjectDocumentStore(database)
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: appUrl, maxPoolSize: 4 })
  readinessStore = new PostgresProjectReadinessStore(database)
  workflow = createCoreStructuredImportWorkflow({ blobs: blobStore, parses: parseStore, ingestion: structuredStore,
    projects: new PostgresProjectStore(database), documents: projectStore, indexStore,
    readiness: readinessStore, executionBindings: new PostgresRunExecutionBindingStore(database) })
  parseService = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => new Date().toISOString(),
  })
  service = new ProjectDocumentIndexService({
    store: projectStore,
    parseStore,
    indexStore,
    spanReader: new DocumentSpanReader({ blobs: blobStore, store: parseStore, now: () => new Date().toISOString() }),
    now: () => new Date().toISOString(),
  })
  scopedClient = new Client({ connectionString: appUrl })
  await scopedClient.connect()
}, 300_000)

afterAll(async () => {
  await scopedClient?.end().catch(() => undefined)
  await indexStore?.close().catch(() => undefined)
  await parseStore?.close().catch(() => undefined)
  await structuredStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

const CSV = 'equipment,inspection_interval\npump,ninety days\nfan,thirty days\n'
const XLSX = buildXlsx({ sheetName: 'Maintenance', sharedStrings: ['equipment', 'inspection_interval', 'pump', 'ninety days'],
  sheetXml: worksheetOf([rowXml(1, [sharedStringCell('A1', 0), sharedStringCell('B1', 1)]), rowXml(2, [sharedStringCell('A2', 2), sharedStringCell('B2', 3)])]) })

function structuredInput(format: 'csv' | 'xlsx', content?: Uint8Array) {
  return { format, content: content ?? (format === 'csv' ? new TextEncoder().encode(CSV) : XLSX),
    mediaType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

describe('real structured import/index membership bridge', () => {
  it('converges concurrent normal imports on one stored original/projection and one membership', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'concurrent imports')
    const source = structuredInput('csv', new TextEncoder().encode('equipment,inspection_interval\nconcurrent,ninety days\n'))
    const [first, second] = await Promise.all([workflow.imports.importStructuredSource(projectId, source, CTX_A), workflow.imports.importStructuredSource(projectId, source, CTX_A)])
    expect(first.parseId).toBe(second.parseId)
    expect(first.originalRef).toEqual(second.originalRef)
    expect(first.documentId).toBe(second.documentId)
    expect((await projectStore.listDocuments(SCOPE_A, projectId, { state: 'active', limit: 10 }, CTX_A)).memberships).toHaveLength(1)
    expect((await projectStore.getVisibility(SCOPE_A, projectId, CTX_A))?.epoch).toBe('1')
  })
  it('indexes bounded CSV/XLSX projections with genuine individual cell origins and idempotent imports', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
      const projectId = randomUUID()
      await createProject(projectId, `structured ${format}`)
      const imported = await workflow.imports.importStructuredSource(projectId, structuredInput(format), CTX_A)
      expect(imported.documentIndexState).toBe('pending')
      const visibility = await projectStore.getVisibility(SCOPE_A, projectId, CTX_A)
      const reused = await workflow.imports.importStructuredSource(projectId, structuredInput(format), CTX_A)
      expect(reused.documentId).toBe(imported.documentId)
      expect(reused.documentSetRef?.digest).toBe(imported.documentSetRef?.digest)
      expect(reused.originalRef).toEqual(imported.originalRef)
      expect(await projectStore.getVisibility(SCOPE_A, projectId, CTX_A)).toEqual(visibility)
      const built = await workflow.index.buildIndex(projectId, CTX_A)
      expect(built.state).toBe('ready')
      const result = await workflow.index.search({ projectId, query: 'pump' }, CTX_A)
      const fragment = result.fragments[0]
      if (fragment === undefined) throw new Error('the actual source row was not indexed')
      expect(fragment.precision).toBe('approximate')
      expect(fragment.locator.kind).toBe('approximate_locator')
      expect(fragment.documentRef).toEqual(imported.originalRef)
      const membership = await projectStore.getMembership(SCOPE_A, projectId, String(imported.documentId), CTX_A)
      expect(membership?.parseId).toBe(imported.parseId)
      expect((await parseStore.getParse(SCOPE_A, imported.parseId, CTX_A))?.spanMapRef).toEqual(membership?.parseRef)
      const origin = await workflow.spanReader.readOrigin({ documentRef: fragment.documentRef, locator: fragment.locator }, CTX_A)
      expect(origin?.parseId).toBe(imported.parseId)
      expect(origin?.cells[1]?.locator).toMatchObject({ kind: 'table_cell', format, row: 2, column: 2, address: 'B2' })
      if (format === 'csv') {
        const cell = origin?.cells[1]?.locator
        if (cell?.kind !== 'table_cell' || cell.startByte === undefined || cell.endByte === undefined) throw new Error('CSV cell lost its original byte range')
        expect(new TextDecoder().decode(structuredInput(format).content.subarray(cell.startByte, cell.endByte))).toBe('ninety days')
      } else expect(origin?.cells[1]?.locator).toMatchObject({ sheetId: '1', sheetName: 'Maintenance' })
      await expect(workflow.spanReader.readOrigin({ documentRef: fragment.documentRef, locator: { ...fragment.locator, startOffset: (fragment.locator.startOffset ?? 0) + 1 } }, CTX_A)).rejects.toThrow('complete projected source row')
      const otherProject = randomUUID()
      await createProject(otherProject, 'isolated structured corpus')
      expect((await workflow.index.search({ projectId: otherProject, query: 'pump' }, CTX_A)).fragments).toEqual([])
      expect((await workflow.index.search({ projectId, query: 'pump' }, CTX_B)).fragments).toEqual([])
    }
  })

  it('retains explicit projection truncation above 1000 rows without widening parser/query defaults', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'bounded structured corpus')
    const bytes = new TextEncoder().encode('equipment,inspection_interval\n' + Array.from({ length: 1001 }, (_, i) => `pump${i},ninety days\n`).join(''))
    const imported = await workflow.imports.importStructuredSource(projectId, structuredInput('csv', bytes), CTX_A)
    expect(imported.counts.succeeded).toBe(1001)
    const built = await workflow.index.buildIndex(projectId, CTX_A)
    expect(built.documentCount).toBe(1000)
    expect(built.completeness).toBe('truncated')
    expect((await workflow.index.search({ projectId, query: 'pump1000' }, CTX_A)).fragments).toEqual([])
  })

  it('fences a delayed build before retraction, rejects reimport revival, and replaces versions explicitly', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'structured withdrawal')
    const imported = await workflow.imports.importStructuredSource(projectId, structuredInput('csv'), CTX_A)
    await workflow.index.buildIndex(projectId, CTX_A)
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const activate = indexStore.activateGeneration.bind(indexStore)
    vi.spyOn(indexStore, 'activateGeneration').mockImplementationOnce(async (...args) => { entered(); await barrier; return activate(...args) })
    const build = workflow.index.buildIndex(projectId, CTX_A)
    await paused
    if (imported.documentId === undefined) throw new Error('import did not register a source')
    await workflow.index.reviseDocument(projectId, { documentId: imported.documentId, op: 'retract', reason: 'source withdrawn', actor: 'integration', recordedAt: new Date().toISOString() }, CTX_A)
    release()
    expect((await build).state).toBe('stale')
    expect((await workflow.index.search({ projectId, query: 'pump' }, CTX_A)).fragments).toEqual([])
    await expect(workflow.imports.importStructuredSource(projectId, structuredInput('csv'), CTX_A)).rejects.toThrow('cannot revive')
    vi.restoreAllMocks()

    const freshProject = randomUUID()
    await createProject(freshProject, 'structured replacement')
    const old = await workflow.imports.importStructuredSource(freshProject, structuredInput('csv'), CTX_A)
    const updated = await workflow.imports.importStructuredSource(freshProject, structuredInput('csv', new TextEncoder().encode('equipment,inspection_interval\npump,revised interval\n')), CTX_A)
    if (old.documentId === undefined || updated.documentId === undefined) throw new Error('version membership was not registered')
    const member = await projectStore.getMembership(SCOPE_A, freshProject, updated.documentId, CTX_A)
    if (member === undefined) throw new Error('replacement source is missing')
    await workflow.index.reviseDocument(freshProject, { documentId: old.documentId, op: 'replace', reason: 'new original version', replacement: member, actor: 'integration', recordedAt: new Date().toISOString() }, CTX_A)
    await workflow.index.buildIndex(freshProject, CTX_A)
    expect((await workflow.index.search({ projectId: freshProject, query: 'ninety' }, CTX_A)).fragments).toEqual([])
    expect((await workflow.index.search({ projectId: freshProject, query: 'revised' }, CTX_A)).fragments[0]?.documentRef).toEqual(updated.originalRef)
  })

  it('reports a real index write failure, retries the same source, and discards a cancelled late build', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'retry/cancel')
    await workflow.imports.importStructuredSource(projectId, structuredInput('csv'), CTX_A)
    const trigger = `gap018_index_failure_${randomUUID().replaceAll('-', '')}`
    await adminClient.query(`CREATE FUNCTION agent_platform.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.collection_ref = 'project:${projectId}' THEN RAISE EXCEPTION 'GAP018 injected real index transaction failure' USING ERRCODE = '08006'; END IF; RETURN NEW; END $$`)
    await adminClient.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON agent_platform.keyword_index_generations FOR EACH ROW EXECUTE FUNCTION agent_platform.${trigger}()`)
    try {
      await expect(workflow.index.buildIndex(projectId, CTX_A)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      expect((await indexStore.listGenerations(SCOPE_A, projectCollectionRef(projectId), CTX_A))).toEqual([])
    } finally {
      await adminClient.query(`DROP TRIGGER ${trigger} ON agent_platform.keyword_index_generations`)
      await adminClient.query(`DROP FUNCTION agent_platform.${trigger}()`)
    }
    expect((await workflow.index.getStatus(projectId, CTX_A)).state).toBe('pending')
    expect((await workflow.index.buildIndex(projectId, CTX_A)).state).toBe('ready')
    const cancelledProject = randomUUID()
    await createProject(cancelledProject, 'cancelled actual write')
    await workflow.imports.importStructuredSource(cancelledProject, structuredInput('xlsx'), CTX_A)
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const write = indexStore.writeGeneration.bind(indexStore)
    vi.spyOn(indexStore, 'writeGeneration').mockImplementationOnce(async (...args) => { entered(); await barrier; return write(...args) })
    const cancellation = new AbortController()
    const build = workflow.index.buildIndex(cancelledProject, CTX_A, { signal: cancellation.signal })
    const rejected = expect(build).rejects.toThrow('cancelled index')
    await paused
    cancellation.abort(new Error('cancelled index'))
    release()
    await rejected
    expect((await workflow.index.getStatus(cancelledProject, CTX_A)).state).toBe('pending')
    expect((await workflow.index.search({ projectId: cancelledProject, query: 'pump' }, CTX_A)).fragments).toEqual([])
    vi.restoreAllMocks()
  })

  it('does not return a withdrawn cell when visibility changes during the genuine source read', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'withdraw during cell read')
    const imported = await workflow.imports.importStructuredSource(projectId, structuredInput('csv'), CTX_A)
    await workflow.index.buildIndex(projectId, CTX_A)
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const read = workflow.spanReader.readSpan.bind(workflow.spanReader)
    vi.spyOn(workflow.spanReader, 'readSpan').mockImplementationOnce(async (...args) => { entered(); await barrier; return read(...args) })
    const pending = workflow.index.search({ projectId, query: 'pump' }, CTX_A)
    await paused
    if (imported.documentId === undefined) throw new Error('source membership is missing')
    await workflow.index.reviseDocument(projectId, { documentId: imported.documentId, op: 'retract', reason: 'withdraw while reading', actor: 'integration', recordedAt: new Date().toISOString() }, CTX_A)
    release()
    const result = await pending
    expect(result.state).toBe('stale')
    expect(result.fragments).toEqual([])
    vi.restoreAllMocks()
  })

  it('keeps normal text exact and JSON projections located in their original pointers', async () => {
    for (const format of ['text', 'json'] as const) {
      const projectId = randomUUID()
      await createProject(projectId, `other declared ${format}`)
      const content = new TextEncoder().encode(format === 'text' ? 'pump inspection interval ninety days' : '[{"equipment":"pump","interval":"ninety days"}]')
      const imported = await workflow.imports.importStructuredSource(projectId, { format, content, mediaType: format === 'text' ? 'text/plain' : 'application/json' }, CTX_A)
      expect(imported.documentId).toBeDefined()
      await workflow.index.buildIndex(projectId, CTX_A)
      const fragment = (await workflow.index.search({ projectId, query: 'pump' }, CTX_A)).fragments[0]
      if (fragment === undefined) throw new Error('a declared structured format lost its index')
      expect(fragment.precision).toBe(format === 'text' ? 'exact' : 'approximate')
      if (format === 'json') expect((await workflow.spanReader.readOrigin({ documentRef: fragment.documentRef, locator: fragment.locator }, CTX_A))?.cells[0]?.locator.kind).toBe('json_pointer')
    }
  })
})

describe('normal structured import → real BM25 → fixed-run document QA → actual cells', () => {
  it('publishes honest limited @3 projections for CSV/XLSX and retains frozen history after withdrawal', async () => {
    const composition = await createCoreLocalComposition({ databaseUrl: appUrl, objectDirectory: objectDir, scopeRef: SCOPE_A,
      examples: loadCoreExamples({ targetScopeRef: SCOPE_A }), allowLocalOperator: true, projectStructuredImports: createCoreStructuredImportWorkflow })
    const api = createCoreApi(composition.dependencies)
    try {
      const base = await api.listen({ host: '127.0.0.1', port: 0 })
      const request = async (path: string, body?: object, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, signal: AbortSignal.timeout(30_000) })
        const payload = await response.json() as { data: Record<string, unknown> }
        if (response.status >= 400) throw new Error(`normal route ${path} failed ${response.status}: ${JSON.stringify(payload)}`)
        return payload.data
      }
      const scenario = loadCoreExamples({ targetScopeRef: SCOPE_A }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
      if (scenario === undefined) throw new Error('the real mounted scenario was not found')
      const deployment = await request('/api/v1/core/deployment')
      const mounted = (deployment['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]).find((entry) => entry.scenarioId === scenario.scenarioId)
      const binding = coreScenarioTaskBindings(scenario).find((entry) => entry.kind === 'document_qa')
      if (mounted === undefined || binding === undefined) throw new Error('the actual host profile/task is unavailable')
      const profiles = new PostgresProfileStore(database)
      const active = await profiles.getActiveProfile(mounted.profileRef.id, SCOPE_A, CTX_A)
      if (active === undefined) throw new Error('the actual host profile was not activated')
      const resolved = await profiles.findResolvedProfile(active.profileRef, active.snapshotHash, SCOPE_A, CTX_A)
      if (resolved === undefined) throw new Error('the actual host profile resolution is missing')
      const mappingRefs = scenario.physicalMappings.flatMap((loaded) => {
        const object = loaded.mapping.objects[0]
        return object === undefined ? [] : [{ ...loaded.ref, role: 'catalog' as const, sourceObjectRef: object.sourceObjectRef }]
      })
      for (const format of ['csv', 'xlsx'] as const) {
        const projectId = randomUUID()
        await createProject(projectId, `ordinary ${format} QA`)
        const source = structuredInput(format)
        const imported = await request(`/api/v1/projects/${projectId}/structured-imports`, { format, mediaType: source.mediaType, contentEncoding: 'base64', content: Buffer.from(source.content).toString('base64') })
        const originalRef = imported['originalRef'] as ResourceRef
        const body: ProjectRevisionBody = { schemaVersion: 'project-revision@1', projectId, revision: '1', industryPackRef: resolved.resolved.industryRef, definitionRef: scenario.definitionRef,
          mappingRefs,
          profileRef: { ...active.profileRef, snapshotHash: active.snapshotHash }, documentSetRef: imported['documentSetRef'] as ResourceRef, approvedInputRef: originalRef,
          semanticPublicationRefs: [scenario.definitionRef], sourceVisibilityEpoch: '1', changeReason: 'actual imported document corpus' }
        // Only project configuration is seeded. Input bytes, corpus, index, run and evidence use the ordinary host paths.
        const revisionRef = { projectId, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
        await adminClient.query(`INSERT INTO agent_platform.project_revisions (tenant_id,space_id,project_id,revision,digest,body,source_visibility_epoch,change_reason,idempotency_key,request_digest,actor,recorded_at)
          VALUES ($1,$2,$3,1,$4,$5::jsonb,1,$6,$7,$4,'integration',now())`, [TENANT_A, SPACE_A, projectId, revisionRef.digest, JSON.stringify(body), body.changeReason, randomUUID()])
        const built = await request(`/api/v1/projects/${projectId}/document-index`, {})
        expect(built['status']).toMatchObject({ state: 'ready' })
        const readiness = await new PostgresProjectReadinessStore(database).listProjections(SCOPE_A, revisionRef, CTX_A)
        expect(readiness.find((entry) => entry.kind === 'document_index')?.state).toBe('ready')
        expect(readiness.some((entry) => entry.kind === 'dataset')).toBe(false)
        const admitted = await request('/api/v1/runs', { profileRef: mounted.profileRef, question: 'read the pump inspection interval', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false },
          task: { mode: 'task', projectRevisionRef: revisionRef, inputSnapshotRef: originalRef, inputSnapshotDigest: originalRef.digest, taskBindingRef: binding.taskBindingRef, parameters: { query: 'pump', limit: 5 } } })
        const runId = String(admitted['runId'])
        let answer: Record<string, unknown> | undefined
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const response = await fetch(`${base}/api/v1/runs/${runId}/answer`, { signal: AbortSignal.timeout(30_000) })
          if (response.status === 200) { answer = (await response.json() as { data: Record<string, unknown> }).data; break }
          if (response.status !== 202) {
            const verification = await adminClient.query<{ record: unknown }>('SELECT record FROM agent_platform.workflow_verifications WHERE run_id=$1', [runId])
            const events = await fetch(`${base}/api/v1/runs/${runId}/events`)
            throw new Error(`ordinary QA answer failed ${response.status}: ${await response.text()}; verification=${JSON.stringify(verification.rows)}; events=${await events.text()}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(answer).toBeDefined()
        const v3 = answer?.['v3Body'] as { schemaVersion: string; limitations: string[]; assertions: { kind: string; summary?: string; references: { evidenceRef: ResourceRef }[] }[] }
        expect(v3.schemaVersion).toBe('answer-draft@3')
        expect(v3.limitations).toContain('limited_factual_result')
        expect(v3.limitations).toContain('approximate_document_source')
        expect(v3.assertions[0]).toMatchObject({ kind: 'artifact_summary' })
        expect(v3.assertions[0]?.summary).toContain('ninety days')
        const evidenceRef = v3.assertions[0]?.references[0]?.evidenceRef
        if (evidenceRef === undefined) throw new Error('the real QA result has no source evidence')
        expect(await request(`/api/v1/evidence/${evidenceRef.id}`)).toMatchObject({ integrityVerified: true, outcome: 'verifiable' })
        const evidence = await adminClient.query<{ envelope: { payloadRef: ResourceRef } }>('SELECT envelope FROM agent_platform.evidence_records WHERE evidence_id=$1', [evidenceRef.id])
        const payloadRef = evidence.rows[0]?.envelope.payloadRef
        if (payloadRef === undefined) throw new Error('actual QA source payload is missing')
        const payload = JSON.parse(new TextDecoder().decode(await blobStore.readAuthorized({ scopeRef: SCOPE_A, blobRef: payloadRef }, CTX_A))) as { spans: { documentRef: ResourceRef; sourceOrigin: { parseId: string; cells: { locator: { kind: string; row: number; column: number; address: string } }[] } }[] }
        expect(payload.spans[0]?.documentRef).toEqual(originalRef)
        expect(payload.spans[0]?.sourceOrigin.parseId).toBe(imported['parseId'])
        expect(payload.spans[0]?.sourceOrigin.cells[1]?.locator).toMatchObject({ kind: 'table_cell', row: 2, column: 2, address: 'B2' })
        const ctx = createTestToolContext(TENANT_A, SPACE_A, runId)
        const record = await new PostgresEvidenceStore(database).get(SCOPE_A, evidenceRef.id, ctx)
        if (record === undefined) throw new Error('the published actual evidence record is missing')
        expect((await workflow.publicationValidator.validate({ record, payload, ctx, now: new Date().toISOString() })).state).toBe('current')
        const forgedPayload = structuredClone(payload)
        const wrongCell = forgedPayload.spans[0]?.sourceOrigin.cells[1]?.locator
        if (wrongCell === undefined) throw new Error('the actual cell origin is missing')
        wrongCell.column = 3
        expect((await workflow.publicationValidator.validate({ record, payload: forgedPayload, ctx, now: new Date().toISOString() })).state).toBe('blocked')
        expect((await workflow.publicationValidator.validate({ record, payload: { quote: 'forged source-family downgrade' }, ctx, now: new Date().toISOString() })).state).toBe('blocked')
        if (format === 'csv') {
          for (const finalPhase of ['readiness', 'status'] as const) {
            let entered: () => void = () => undefined
            let release: () => void = () => undefined
            const paused = new Promise<void>((resolve) => { entered = resolve })
            const barrier = new Promise<void>((resolve) => { release = resolve })
            if (finalPhase === 'readiness') {
              const write = readinessStore.upsertProjection.bind(readinessStore)
              vi.spyOn(readinessStore, 'upsertProjection').mockImplementationOnce(async (...args) => { entered(); await barrier; return write(...args) })
            } else {
              const read = indexStore.getActiveGeneration.bind(indexStore)
              vi.spyOn(indexStore, 'getActiveGeneration').mockImplementationOnce(async (...args) => { entered(); await barrier; return read(...args) })
            }
            const cancellation = new AbortController()
            const pending = workflow.index.buildIndex(projectId, CTX_A, { signal: cancellation.signal })
            const refusal = expect(pending).rejects.toThrow(`cancelled final ${finalPhase}`)
            await paused
            cancellation.abort(new Error(`cancelled final ${finalPhase}`))
            release()
            await refusal
            vi.restoreAllMocks()
            // A pre-existing/concurrent valid winner remains ready; the cancelled
            // caller must not report success or globally revoke another build.
            expect((await workflow.index.getStatus(projectId, CTX_A)).state).toBe('ready')
          }
        }
        const archived = await adminClient.query<{ binding: RunExecutionBinding }>('SELECT binding FROM agent_platform.run_execution_bindings WHERE run_id=$1', [runId])
        expect(archived.rows[0]?.binding.projectDocumentIndexSnapshotRef).toBeDefined()
        await request(`/api/v1/projects/${projectId}/document-memberships/${String(imported['documentId'])}/revisions`, { op: 'retract', reason: 'withdraw the original source' })
        expect((await new PostgresProjectReadinessStore(database).listProjections(SCOPE_A, revisionRef, CTX_A)).find((entry) => entry.kind === 'document_index')?.state).toBe('revoked')
        expect((await workflow.publicationValidator.validate({ record, payload, ctx, now: new Date().toISOString() })).state).toBe('blocked')
        await expect(workflow.handler.execute({ callId: randomUUID(), toolId: 'document_search', arguments: { query: 'pump', mode: 'keyword', allowedCollectionRefs: [projectCollectionRef(projectId)] },
          ctx, signal: new AbortController().signal, deadline: ctx.deadline, traceId: ctx.traceId, resultLimits: { maxRows: 10, maxBytes: 16_384, maxDurationMs: 10_000 } })).rejects.toThrow('changed or withdrawn')
        expect(await request(`/api/v1/answers/${String(answer?.['answerId'])}/result`)).toMatchObject({ answerId: answer?.['answerId'] })
      }
    } finally { await api.close(); await composition.close() }
  }, 180_000)
})

describe('migration 069', () => {
  it('enables RLS on the project document index tables and keeps tenant/space in the keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN (
            'project_visibility', 'project_document_memberships',
            'project_document_index_receipts', 'keyword_index_generation_counters')
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.project_visibility',
            'agent_platform.project_document_memberships')
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.project_visibility')).toEqual([
      'tenant_id',
      'space_id',
      'project_id',
    ])
    expect(byTable.get('agent_platform.project_document_memberships')).toEqual([
      'tenant_id',
      'space_id',
      'project_id',
      'document_id',
      'membership_revision',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('069_project_document_index.sql')
  })
})

describe('project document BM25 index against real PostgreSQL', () => {
  it('imports authorised text, builds the index and searches real fragments of this project', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'battery project')
    const parse = await publishText('alpha')
    await register(projectId, parse)

    expect((await service.getStatus(projectId, CTX_A)).state).toBe('pending')
    const built = await service.buildIndex(projectId, CTX_A)
    expect(built.state).toBe('ready')
    expect(built.generation).toBe('1')
    expect(built.sourceDocumentCount).toBe(1)
    expect(built.indexRef?.id).toBe(projectCollectionRef(projectId))

    const result = await service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(result.state).toBe('ready')
    expect(result.fragments.length).toBeGreaterThan(0)
    const fragment = result.fragments[0]
    if (fragment === undefined) throw new Error('expected a fragment')
    expect(fragment.text.toLowerCase()).toContain('battery warranty')
    expect(fragment.revision).toBe('1')
    expect(result.scoreKind).toBe('bm25')
  })

  it('moves index visibility on retraction and never serves the withdrawn fragment from a stale index', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'retraction project')
    const parse = await publishText('beta')
    await register(projectId, parse)
    await service.buildIndex(projectId, CTX_A)
    expect((await service.search({ projectId, query: 'battery warranty' }, CTX_A)).fragments.length).toBeGreaterThan(0)

    const page = await projectStore.listDocuments(SCOPE_A, projectId, { limit: 10 }, CTX_A)
    const documentId = page.memberships[0]?.documentId
    if (documentId === undefined) throw new Error('expected a membership')
    const revised = await service.reviseDocument(
      projectId,
      { documentId, op: 'retract', reason: 'withdrawn', actor: 'integration', recordedAt: new Date().toISOString() },
      CTX_A,
    )
    expect(revised.state).toBe('stale')
    const stale = await service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(stale.state).toBe('stale')
    expect(stale.fragments).toHaveLength(0)

    const rebuilt = await service.buildIndex(projectId, CTX_A)
    expect(rebuilt.state).toBe('ready')
    expect(rebuilt.sourceDocumentCount).toBe(0)
  })

  it('does not surface another project or another tenant corpus', async () => {
    const projectA = randomUUID()
    const projectB = randomUUID()
    await createProject(projectA, 'isolated A')
    await createProject(projectB, 'isolated B')
    const parse = await publishText('gamma')
    await register(projectA, parse)
    await service.buildIndex(projectA, CTX_A)

    expect((await service.search({ projectId: projectB, query: 'battery warranty' }, CTX_A)).fragments).toHaveLength(0)
    expect((await service.search({ projectId: projectA, query: 'battery warranty' }, CTX_B)).fragments).toHaveLength(0)

    await withAppScope(TENANT_B, SPACE_B, async () => {
      expect(await appScopeCount('project_document_memberships', TENANT_A)).toBe(0)
      expect(await appScopeCount('project_document_index_receipts', TENANT_A)).toBe(0)
    })
    await withAppScope(TENANT_A, SPACE_A, async () => {
      expect(await appScopeCount('project_document_memberships', TENANT_A)).toBeGreaterThan(0)
    })
  })

  it('refuses to activate a receipt built under an older visibility epoch', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'cas project')
    const parse = await publishText('delta')
    await register(projectId, parse)
    const visibility = await projectStore.getVisibility(SCOPE_A, projectId, CTX_A)
    if (visibility === undefined) throw new Error('expected visibility')

    // A receipt carrying a stale epoch is refused, so a late build cannot reactivate.
    const refused = await projectStore.recordIndexReceipt(
      SCOPE_A,
      projectId,
      {
        collectionRef: projectCollectionRef(projectId),
        generation: '99',
        visibilityEpoch: (BigInt(visibility.epoch) - 1n).toString(),
        membershipRevision: visibility.membershipRevision,
        targetDigest: `sha256:${'b'.repeat(64)}`,
        indexRef: { id: projectCollectionRef(projectId), version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
        documentCount: 1,
        sourceDocumentCount: 1,
        completeness: 'complete',
        recordedAt: new Date().toISOString(),
      },
      CTX_A,
    )
    expect(refused.activated).toBe(false)
    expect(await projectStore.getIndexReceipt(SCOPE_A, projectId, '99', CTX_A)).toBeUndefined()
  })
})
