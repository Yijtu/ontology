import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresCandidateSourceStore,
  PostgresJobStore,
  PostgresSourceAdmissionStore,
} from '@ontology/adapter-control-postgres'
import {
  ArtifactGroundingDocumentSetReader,
  PostgresDocumentParseStore,
  PostgresStructuredIngestionStore,
  publishGroundingDocumentSet,
} from '@ontology/adapter-extraction-document'
import { CandidateSourceReviewService, IndustryWorkspaceService, SourceGroundingBudget, WorkspaceSourceAdmissionService } from '@ontology/application'
import { createSourceAdmissionPorts } from '@ontology/app-api'
import { SourceAdmissionError } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceRecord,
  CandidateSourceReviewCommand,
  ScopeRef,
  SourceAdmissionCommand,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 120_000 })

let db: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let documents: PostgresDocumentParseStore
let tables: PostgresStructuredIngestionStore
let jobs: PostgresJobStore
let objectStore: FileSystemObjectStore
let objectDir = ''

beforeAll(async () => {
  db = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: db.appUrl, maxPoolSize: 4 })
  registry = new PostgresArtifactRegistry({ connectionString: db.appUrl, maxPoolSize: 2 })
  documents = new PostgresDocumentParseStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  tables = new PostgresStructuredIngestionStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  jobs = new PostgresJobStore(database)
  objectDir = await mkdtemp(join(tmpdir(), 'ontology-admission-'))
  objectStore = new FileSystemObjectStore(objectDir)
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

interface Fixture {
  readonly scope: JobTestScope
  readonly ctx: ToolContext
  readonly scopeRef: ScopeRef
  readonly sources: PostgresCandidateSourceStore
  readonly review: CandidateSourceReviewService
  readonly admissions: PostgresSourceAdmissionStore
  readonly admissionService: WorkspaceSourceAdmissionService
  readonly workspaces: PostgresAssetWorkspaceStore
  readonly workspaceId: Uuid
}

async function fixture(prefix: string): Promise<Fixture> {
  const scope = await createJobScope(db.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['profile-editor', 'platform-admin'], `${prefix}-editor`)
  const sources = new PostgresCandidateSourceStore(database)
  const admissions = new PostgresSourceAdmissionStore(database)
  const workspaces = new PostgresAssetWorkspaceStore(database)
  const ports = createSourceAdmissionPorts({ blobs, objectStore, registry, parses: documents, structured: tables })
  const admissionService = new WorkspaceSourceAdmissionService({
    sources, workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs),
    content: ports.content, parser: ports.parser, writer: ports.writer, admissions, jobs,
  })
  const review = new CandidateSourceReviewService({ sources, retractions: sources })
  const workspaceId = randomUUID()
  const setRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId, scopeRef: scope.scopeRef, sources: [] }, ctx)
  const ids = [workspaceId]
  const editor = new IndustryWorkspaceService({ store: workspaces, jobs, newId: () => ids.shift() ?? randomUUID() })
  await editor.createWorkspace({ namespace: `admission_${workspaceId.replaceAll('-', '')}`, displayName: 'Admission',
    boundary: { goals: ['model'], included: [], excluded: [], applicability: {} }, documentSetRef: setRef }, randomUUID(), 'integration', ctx)
  return { scope, ctx, scopeRef: scope.scopeRef, sources, review, admissions, admissionService, workspaces, workspaceId }
}

async function proposedArtifact(f: Fixture, text: string, mediaType: string): Promise<CandidateSourceRecord> {
  const bytes = new TextEncoder().encode(text)
  const staged = await blobs.stage(bytes, { scopeRef: f.scopeRef }, f.ctx)
  const uploaded = await blobs.publish({ scopeRef: f.scopeRef, ...staged, mediaType, purpose: 'artifact' }, f.ctx)
  const source: CandidateSource = {
    schemaVersion: 'candidate-source@1', sourceId: randomUUID(), workspaceId: f.workspaceId, kind: 'web_fetch',
    trustTier: 'agent_researched', origin: { url: 'https://standards.example.org/gb50500', fetchedAt: '2026-10-13T00:00:00Z' },
    contentRef: uploaded.blobRef, contentDigest: uploaded.contentDigest, reviewState: 'proposed',
    proposedBy: 'researcher', recordedAt: '2026-10-13T00:00:00Z',
  }
  return f.sources.putSource(f.scopeRef, { source, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, f.ctx)
}

function reviewCommand(f: Fixture, source: CandidateSourceRecord, reviewState: 'approved' | 'rejected', trustTier?: CandidateSource['trustTier'], key = `rv-${randomUUID().slice(0, 12)}`): CandidateSourceReviewCommand {
  return {
    schemaVersion: 'candidate-source-review@1', sourceId: source.sourceId, workspaceId: source.workspaceId,
    reviewState, ...(trustTier === undefined ? {} : { trustTier }), reviewedBy: f.ctx.principal.subjectId,
    reason: '人工核对公开规范版本与适用范围', expectedRevision: String(source.revision), basisRefs: [],
    idempotencyKey: key,
  }
}

function admissionCommand(f: Fixture, source: CandidateSourceRecord, workspaceRevision: string, options: { key?: string; parseOptions?: SourceAdmissionCommand['parseOptions'] } = {}): SourceAdmissionCommand {
  return {
    schemaVersion: 'source-admission-command@1', workspaceId: f.workspaceId, sourceId: source.sourceId,
    expectedSourceRevision: String(source.revision), expectedWorkspaceRevision: workspaceRevision,
    ...(options.parseOptions === undefined ? {} : { parseOptions: options.parseOptions }),
    idempotencyKey: options.key ?? `ad-${randomUUID().slice(0, 12)}`,
  }
}

describe('source review, admission and retraction (real PostgreSQL)', () => {
  it('appends an auditable review event, is idempotent on the key and rejects cross-workspace reviews', async () => {
    const f = await fixture('admission-review')
    const source = await proposedArtifact(f, '1.1 Warranty applies only to active accounts.', 'text/plain')
    const key = `rv-${randomUUID().slice(0, 12)}`
    const reviewed = await f.review.review(reviewCommand(f, source, 'approved', 'public_standard', key), f.ctx)
    expect(reviewed).toMatchObject({ trustTier: 'public_standard', reviewState: 'approved', replayed: false, revision: '2' })
    const replay = await f.review.review(reviewCommand(f, source, 'approved', 'public_standard', key), f.ctx)
    expect(replay.replayed).toBe(true)
    const events = await f.review.listReviewEvents(f.workspaceId, source.sourceId, { limit: 10 }, f.ctx)
    expect(events.events).toHaveLength(1)
    expect(events.events[0]).toMatchObject({ nextState: 'approved', nextTrustTier: 'public_standard', actor: 'admission-review-editor' })

    const other = await fixture('admission-review-other')
    await expect(f.review.review({ ...reviewCommand(f, source, 'approved'), workspaceId: other.workspaceId }, f.ctx))
      .rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('admits a reviewed source with its reviewed tier, appends a draft and replays idempotently', async () => {
    const f = await fixture('admission-happy')
    const source = await proposedArtifact(f, 'GB 50500 load tables apply to this scope.', 'text/plain')
    const approved = await f.review.review(reviewCommand(f, source, 'approved', 'public_standard'), f.ctx)
    expect(approved.revision).toBe('2')
    const key = `ad-${randomUUID().slice(0, 12)}`
    const receipt = await f.admissionService.admit(admissionCommand(f, { ...source, revision: '2' }, '1', { key }), f.ctx)
    expect(receipt).toMatchObject({ sourceRevision: '2', trustTier: 'public_standard', draftRevision: '2', replayed: false })
    const workspace = await f.workspaces.getWorkspace(f.scopeRef, f.workspaceId, f.ctx)
    expect(workspace?.headRevision).toBe('2')
    const draft = await f.workspaces.getDraft(f.scopeRef, f.workspaceId, '2', f.ctx)
    expect(draft?.documentSetRef).toEqual(receipt.documentSetRef)
    const manifest = await new ArtifactGroundingDocumentSetReader(blobs).read(f.scopeRef, receipt.documentSetRef, f.ctx, budget())
    expect(manifest.sources).toHaveLength(1)
    expect(manifest.sources[0]).toMatchObject({ state: 'approved', kind: 'document', trustTier: 'public_standard' })

    const replay = await f.admissionService.admit(admissionCommand(f, { ...source, revision: '2' }, '2', { key }), f.ctx)
    expect(replay.replayed).toBe(true)
    expect((await f.workspaces.getWorkspace(f.scopeRef, f.workspaceId, f.ctx))?.headRevision).toBe('2')
  })

  it('admits a CSV table with an explicit parse selection and refuses an unconfirmed tier default', async () => {
    const f = await fixture('admission-table')
    const source = await proposedArtifact(f, 'name,cost\nA,0.10\nB,0.20', 'text/csv')
    await f.review.review(reviewCommand(f, source, 'approved', 'public_standard'), f.ctx)
    const receipt = await f.admissionService.admit(admissionCommand(f, { ...source, revision: '2' }, '1', { parseOptions: { headerRow: 1 } }), f.ctx)
    const manifest = await new ArtifactGroundingDocumentSetReader(blobs).read(f.scopeRef, receipt.documentSetRef, f.ctx, budget())
    expect(manifest.sources[0]).toMatchObject({ kind: 'table', trustTier: 'public_standard', tableOptions: { headerRow: 1 } })
  })

  it('refuses an unapproved source, a stale workspace revision and a cross-workspace admission', async () => {
    const f = await fixture('admission-guards')
    const source = await proposedArtifact(f, 'Vendor guide.', 'text/plain')
    await expect(f.admissionService.admit(admissionCommand(f, source, '1'), f.ctx)).rejects.toMatchObject({ code: 'NOT_APPROVED' })

    await f.review.review(reviewCommand(f, source, 'approved'), f.ctx)
    const approved: CandidateSourceRecord = { ...source, revision: '2' }
    await expect(f.admissionService.admit(admissionCommand(f, approved, '9'), f.ctx)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    const other = await fixture('admission-guards-other')
    await expect(f.admissionService.admit({ ...admissionCommand(f, approved, '1'), workspaceId: other.workspaceId }, f.ctx))
      .rejects.toBeInstanceOf(SourceAdmissionError)
  })

  it('retracts with an event and a fence, preserves history and blocks re-admission', async () => {
    const f = await fixture('admission-retract')
    const source = await proposedArtifact(f, 'Superseded standard.', 'text/plain')
    await f.review.review(reviewCommand(f, source, 'approved', 'public_standard'), f.ctx)
    const approved = { ...source, revision: '2' }

    const retraction = await f.review.retract({ schemaVersion: 'source-retraction-command@1', workspaceId: f.workspaceId,
      sourceId: source.sourceId, expectedRevision: '2', reason: '标准已被替代，撤回当前依据', idempotencyKey: `rt-${randomUUID().slice(0, 12)}` }, f.ctx)
    expect(retraction.replayed).toBe(false)
    const after = await f.sources.getSource(f.scopeRef, source.sourceId, f.ctx)
    expect(after).toMatchObject({ reviewState: 'rejected', revision: '3' })
    expect(typeof after?.retractedAt).toBe('string')

    const events = await f.review.listReviewEvents(f.workspaceId, source.sourceId, { limit: 10 }, f.ctx)
    expect(events.events).toHaveLength(1)
    const retractions = await f.review.listRetractions(f.workspaceId, source.sourceId, { limit: 10 }, f.ctx)
    expect(retractions.retractions).toHaveLength(1)
    expect(retractions.retractions[0]).toMatchObject({ previousState: 'approved' })

    await expect(f.admissionService.admit(admissionCommand(f, approved, '1'), f.ctx)).rejects.toMatchObject({ code: 'NOT_APPROVED' })
  })

  it('isolates review history and admissions across scopes', async () => {
    const f = await fixture('admission-rls')
    const source = await proposedArtifact(f, 'Tenant-only source.', 'text/plain')
    await f.review.review(reviewCommand(f, source, 'approved', 'public_standard'), f.ctx)
    const other = await fixture('admission-rls-other')
    expect(await other.sources.getSource(other.scopeRef, source.sourceId, other.ctx)).toBeUndefined()
    const result = await other.admissions.listAdmissions(other.scopeRef, f.workspaceId, { limit: 10 }, other.ctx)
    expect(result.admissions).toHaveLength(0)
  })
})

function budget() {
  return new SourceGroundingBudget(new AbortController().signal)
}
