import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresAssetWorkspaceStore, PostgresJobStore } from '@ontology/adapter-control-postgres'
import { ArtifactGroundingDocumentSetReader, LocalDocumentExtractionService, LocalStructuredIngestionService,
  ParsedSourceGroundingReader, PostgresDocumentParseStore, PostgresStructuredIngestionStore,
  publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import { createSourceGroundingService, IndustryWorkspaceService, SourceGroundingBudget } from '@ontology/application'
import type { GroundingSourceApproval, ResourceRef, ToolContext } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { buildXlsx, rowXml, sharedStringCell, numberCellXml, worksheetOf } from '../fixtures/structured/xlsx'

vi.setConfig({ testTimeout: 60_000 })
let db: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let documents: PostgresDocumentParseStore
let tables: PostgresStructuredIngestionStore
let workspaces: PostgresAssetWorkspaceStore
let objectDir = ''

beforeAll(async () => {
  db = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: db.appUrl, maxPoolSize: 2 })
  registry = new PostgresArtifactRegistry({ connectionString: db.appUrl, maxPoolSize: 2 })
  documents = new PostgresDocumentParseStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  tables = new PostgresStructuredIngestionStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  workspaces = new PostgresAssetWorkspaceStore(database)
  objectDir = await mkdtemp(join(tmpdir(), 'ontology-grounding-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  blobs = new LocalImmutableBlobStore({ objectStore, registry })
}, 300_000)

afterAll(async () => {
  await tables?.close()
  await documents?.close()
  await registry?.close()
  await database?.close()
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  await db?.stop()
})

async function context() {
  const scope = await createJobScope(db.adminClient, 'grounding')
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'data-editor'], 'grounding-editor')
  return { scope, ctx }
}
async function original(scope: JobTestScope, ctx: ToolContext, bytes: Uint8Array, mediaType: string): Promise<ResourceRef> {
  const staged = await blobs.stage(bytes, { scopeRef: scope.scopeRef }, ctx)
  return (await blobs.publish({ scopeRef: scope.scopeRef, ...staged, mediaType, purpose: 'document' }, ctx)).blobRef
}
async function workspace(scope: JobTestScope, ctx: ToolContext, approvals: GroundingSourceApproval[]) {
  const workspaceId = randomUUID()
  const setRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId,
    scopeRef: scope.scopeRef, sources: approvals }, ctx)
  const ids = [workspaceId]
  const editor = new IndustryWorkspaceService({ store: workspaces, jobs: new PostgresJobStore(database),
    newId: () => ids.shift() ?? randomUUID() })
  await editor.createWorkspace({ namespace: `grounding_${workspaceId.replaceAll('-', '')}`, displayName: 'Grounding',
    boundary: { goals: ['model'], included: ['approved sources'], excluded: [], applicability: {} },
    documentSetRef: setRef }, randomUUID(), 'integration', ctx)
  const service = createSourceGroundingService({ workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs),
    reader: new ParsedSourceGroundingReader({ blobs, documents, tables }), pageSize: 1 })
  return { workspaceId, editor, service }
}
const budget = () => new SourceGroundingBudget(new AbortController().signal)

describe('source grounding through persisted originals and PostgreSQL RLS', () => {
  it('reads approved text/PDF and CSV/XLSX headers/rows through the real upload/draft seam', async () => {
    const { scope, ctx } = await context()
    const approvals: GroundingSourceApproval[] = []
    for (const [bytes, media] of [
      [new TextEncoder().encode('1.1 Warranty applies only to active accounts.\n\n2.1 Payment is due monthly.'), 'text/plain'],
      [new Uint8Array(readFileSync(new URL('../fixtures/documents/service-terms.pdf', import.meta.url))), 'application/pdf'],
    ] as const) {
      const sourceRef = await original(scope, ctx, bytes, media)
      const parse = await new LocalDocumentExtractionService({ blobs, store: documents }).parse({ scopeRef: scope.scopeRef, originalRef: sourceRef }, ctx)
      approvals.push({ sourceRef, state: 'approved', kind: 'document', parserVersion: parse.parserVersion, parseId: parse.parseId })
    }
    const xlsx = buildXlsx({ sharedStrings: ['name', 'cost', 'A'], sheetXml: worksheetOf([
      rowXml(1, [sharedStringCell('A1', 0), sharedStringCell('B1', 1)]),
      rowXml(2, [sharedStringCell('A2', 2), numberCellXml('B2', '0.10')]),
    ]) })
    for (const [bytes, media] of [[new TextEncoder().encode('name,cost\nA,0.10\nB,0.20'), 'text/csv'],
      [xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']] as const) {
      const sourceRef = await original(scope, ctx, bytes, media)
      const { parse } = await new LocalStructuredIngestionService({ blobs, store: tables }).parse({ scopeRef: scope.scopeRef, originalRef: sourceRef, options: { headerRow: 1 } }, ctx)
      approvals.push({ sourceRef, state: 'approved', kind: 'table', parserVersion: parse.parserVersion,
        parseId: parse.parseId, tableOptions: { headerRow: 1 } })
    }
    const h = await workspace(scope, ctx, approvals)
    const result = await h.service.read({ workspaceId: h.workspaceId, sourceRefs: approvals.map((item) => item.sourceRef) }, ctx, budget())
    expect(result.coverage).toBe('complete')
    expect(result.sources).toHaveLength(4)
    expect(result.sources[0]?.contents[0]).toMatchObject({ kind: 'text', sourceSpan: { precision: 'exact', locator: { kind: 'offset' } } })
    expect(result.sources[1]?.contents[0]).toMatchObject({ kind: 'text', sourceSpan: { locator: { kind: 'page' } } })
    expect(result.sources[2]?.contents[0]).toMatchObject({ kind: 'table', columns: [{ header: 'name' }, { header: 'cost' }] })
    expect(result.sources[3]?.contents[0]).toMatchObject({ kind: 'table', rows: [{ sourceSpan: { kind: 'structured', locator: { kind: 'table_row', format: 'xlsx' } } }] })
    expect(result.usage.pages).toBeGreaterThan(4)
  })

  it('rejects cross-tenant workspaces, wrong source pins and retracts through an appended draft', async () => {
    const { scope, ctx } = await context()
    const sourceRef = await original(scope, ctx, new TextEncoder().encode('Tenant-owned warranty.'), 'text/plain')
    const parse = await new LocalDocumentExtractionService({ blobs, store: documents }).parse({ scopeRef: scope.scopeRef, originalRef: sourceRef }, ctx)
    const approval: GroundingSourceApproval = { sourceRef, state: 'approved', kind: 'document', parseId: parse.parseId, parserVersion: parse.parserVersion }
    const h = await workspace(scope, ctx, [approval])
    const other = await context()
    await expect(h.service.read({ workspaceId: h.workspaceId, sourceRefs: [sourceRef] }, other.ctx, budget())).rejects.toMatchObject({ code: 'NOT_APPROVED' })
    const wrong = await h.service.read({ workspaceId: h.workspaceId, sourceRefs: [{ ...sourceRef, digest: `sha256:${'f'.repeat(64)}` }] }, ctx, budget())
    expect(wrong.sources[0]?.reasons).toEqual(['SOURCE_MISMATCH'])
    const revoked = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', scopeRef: scope.scopeRef,
      workspaceId: h.workspaceId, sources: [{ ...approval, state: 'retracted' }] }, ctx)
    await h.editor.draftOperation(h.workspaceId, { operation: 'edit', expectedRevision: '1',
      reason: 'source withdrawn', documentSetRef: revoked }, randomUUID(), 'integration', ctx)
    const result = await h.service.read({ workspaceId: h.workspaceId, sourceRefs: [sourceRef] }, ctx, budget())
    expect(result.sources[0]).toMatchObject({ status: 'failed', reasons: ['SOURCE_RETRACTED'], contents: [] })
  })

  it('refuses persisted row digests that do not match original cells', async () => {
    const { scope, ctx } = await context()
    const sourceRef = await original(scope, ctx, new TextEncoder().encode('name,cost\nA,0.10'), 'text/csv')
    const { parse } = await new LocalStructuredIngestionService({ blobs, store: tables }).parse({ scopeRef: scope.scopeRef, originalRef: sourceRef, options: { headerRow: 1 } }, ctx)
    const h = await workspace(scope, ctx, [{ sourceRef, state: 'approved', kind: 'table', parseId: parse.parseId,
      parserVersion: parse.parserVersion, tableOptions: { headerRow: 1 } }])
    await db.adminClient.query('UPDATE agent_platform.document_structured_records SET row_digest = $1 WHERE parse_id = $2',
      [`sha256:${'f'.repeat(64)}`, parse.parseId])
    const result = await h.service.read({ workspaceId: h.workspaceId, sourceRefs: [sourceRef] }, ctx, budget())
    expect(result.sources[0]).toMatchObject({ status: 'failed', reasons: ['DIGEST_MISMATCH'], contents: [] })
  })
})
