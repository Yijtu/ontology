import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresCandidateSourceStore,
  PostgresCandidateSubmissionStore,
  PostgresJobStore,
  PostgresSourceAdmissionStore,
} from '@ontology/adapter-control-postgres'
import {
  ArtifactGroundingDocumentSetReader,
  ParsedSourceGroundingReader,
  PostgresDocumentParseStore,
  PostgresStructuredIngestionStore,
  publishGroundingDocumentSet,
} from '@ontology/adapter-extraction-document'
import {
  CandidateReviewHandoffService,
  CandidateSourceIngestionService,
  CandidateSourceReviewService,
  CandidateSubmissionService,
  IndustryWorkspaceService,
  StaticDefinitionTerminologySource,
  WorkspaceSourceAdmissionService,
  createSourceGroundingService,
} from '@ontology/application'
import { createSourceAdmissionPorts } from '@ontology/app-api'
import type {
  CandidateEvidencePort,
  CandidateSourceRecord,
  CandidateSourceReviewCommand,
  CandidateSubmission,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopeRef,
  SourceAdmissionCommand,
  SourceTierPromotionCommand,
  SubmitCandidatesCommand,
  SubmitCandidatesRequest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 180_000 })

const TEXT = 'GB 50500 load tables: the suspension condition is a monthly average above 85 degrees.'

let db: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let objectStore: FileSystemObjectStore
let objectDir = ''
let workspaces: PostgresAssetWorkspaceStore
let sources: PostgresCandidateSourceStore
let jobs: PostgresJobStore
let documents: PostgresDocumentParseStore
let tables: PostgresStructuredIngestionStore

beforeAll(async () => {
  db = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: db.appUrl, maxPoolSize: 6 })
  registry = new PostgresArtifactRegistry({ connectionString: db.appUrl, maxPoolSize: 2 })
  workspaces = new PostgresAssetWorkspaceStore(database)
  sources = new PostgresCandidateSourceStore(database)
  jobs = new PostgresJobStore(database)
  documents = new PostgresDocumentParseStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  tables = new PostgresStructuredIngestionStore({ connectionString: db.appUrl, maxPoolSize: 2 })
  objectDir = await mkdtemp(join(tmpdir(), 'ontology-reground-'))
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
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly promoter: ToolContext
  readonly workspaceId: Uuid
  readonly submission: CandidateSubmissionService
  readonly review: CandidateSourceReviewService
  readonly admission: WorkspaceSourceAdmissionService
  readonly handoff: CandidateReviewHandoffService
  readonly definitionCandidates: PostgresAssetCandidateStore
}

async function fixture(prefix: string): Promise<Fixture> {
  const scope = await createJobScope(db.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['profile-editor', 'researcher'], `${prefix}-editor`)
  const promoter = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'], `${prefix}-promoter`)
  const workspaceId = randomUUID()
  const setRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId, scopeRef: scope.scopeRef, sources: [] }, ctx)
  const ids = [workspaceId]
  await new IndustryWorkspaceService({ store: workspaces, jobs, newId: () => ids.shift() ?? randomUUID() }).createWorkspace(
    { namespace: `reground_${workspaceId.replaceAll('-', '')}`, displayName: 'Reground', boundary: { goals: ['model'], included: [], excluded: [], applicability: {} }, documentSetRef: setRef },
    randomUUID(), 'integration', ctx,
  )

  const definitionCandidates = new PostgresAssetCandidateStore(database)
  const receipts = new PostgresCandidateSubmissionStore(database)
  const admissionStore = new PostgresSourceAdmissionStore(database)
  const ports = createSourceAdmissionPorts({ blobs, objectStore, registry, parses: documents, structured: tables })
  const admission = new WorkspaceSourceAdmissionService({
    sources, workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs),
    content: ports.content, parser: ports.parser, writer: ports.writer, admissions: admissionStore, jobs,
  })
  const review = new CandidateSourceReviewService({ sources, retractions: sources })
  const sourceGrounding = createSourceGroundingService({
    workspaces,
    documentSets: new ArtifactGroundingDocumentSetReader(blobs),
    reader: new ParsedSourceGroundingReader({ blobs, documents, tables }),
  })
  const submission = new CandidateSubmissionService({
    workspaces,
    definitionCandidates,
    terminology: new StaticDefinitionTerminologySource(),
    // The evidence port is the only thing the unit-level path stubs: it resolves the archived page
    // to the source pin the platform already stored, exactly as the real research material reader does.
    evidence: archivedEvidence(),
    receipts,
    sourceIngestion: new CandidateSourceIngestionService({ artifacts: artifactsWriter(), sources }),
    sourceGrounding,
    now: () => new Date().toISOString(),
  })
  const handoff = new CandidateReviewHandoffService({
    receipts, sources, admissions: admissionStore, definitionCandidates,
  })
  return { scope, scopeRef: scope.scopeRef, ctx, promoter, workspaceId, submission, review, admission, handoff, definitionCandidates }
}

/**
 * Archive bytes through the real blob store as a readable document; the returned ref is the
 * immutable content pin the research flow stages, and it is exactly the ref a candidate cites.
 */
async function archivedPage(ctx: ToolContext, scopeRef: ScopeRef): Promise<ResourceRef> {
  const bytes = new TextEncoder().encode(TEXT)
  const staged = await blobs.stage(bytes, { scopeRef }, ctx)
  const published = await blobs.publish({ scopeRef, ...staged, mediaType: 'text/plain', purpose: 'document' }, ctx)
  return published.blobRef
}

/**
 * A real immutable-artifact writer over the same blob store, so a source candidate's content pin is
 * the archived snapshot the admission later parses. (The platform's own composition wires the same
 * writer; this test builds it directly to keep the fixture small.)
 */
function artifactsWriter(): ImmutableArtifactWriter {
  return {
    async putBytes(input, ctx) {
      const staged = await blobs.stage(input.content, { scopeRef: input.scopeRef }, ctx)
      const published = await blobs.publish({ scopeRef: input.scopeRef, ...staged, mediaType: input.mediaType, purpose: 'document' }, ctx)
      return { blobRef: published.blobRef, contentDigest: published.contentDigest, integrity: published.integrity }
    },
  }
}

/** Resolve `web_page` evidence to the exact archived pin this test wrote (never a forged one). */
function archivedEvidence(): CandidateEvidencePort {
  return {
    async resolve(request) {
      return request.evidence.map((item, index) => ({
        index,
        sourceRef: item.kind === 'web_page' ? item.snapshotRef : item.sourceRef,
        parserVersion: item.parserVersion,
        contentDigest: item.kind === 'web_page' ? item.contentDigest : item.sourceRef.digest,
        trustTier: 'agent_researched' as const,
        reReadVerified: true,
        ...(item.kind === 'web_page' ? { url: item.url } : {}),
      }))
    },
  }
}

function reviewCommand(f: Fixture, source: CandidateSourceRecord, key = `rv-${randomUUID().slice(0, 12)}`): CandidateSourceReviewCommand {
  return {
    schemaVersion: 'candidate-source-review@1', sourceId: source.sourceId, workspaceId: source.workspaceId,
    reviewState: 'approved', reviewedBy: f.ctx.principal.subjectId,
    reason: 'human confirmed the standard version and its scope', expectedRevision: String(source.revision),
    basisRefs: [], idempotencyKey: key,
  }
}

function promotionCommand(f: Fixture, source: CandidateSourceRecord, key = `tp-${randomUUID().slice(0, 12)}`): SourceTierPromotionCommand {
  return {
    schemaVersion: 'source-tier-promotion@1', workspaceId: source.workspaceId, sourceId: source.sourceId,
    expectedRevision: String(source.revision), nextTrustTier: 'public_standard',
    promotedBy: f.promoter.principal.subjectId, reason: 'public standard confirmed by a platform admin',
    basisRefs: [], idempotencyKey: key,
  }
}

function admissionCommand(f: Fixture, source: CandidateSourceRecord, workspaceRevision: string, key = `ad-${randomUUID().slice(0, 12)}`): SourceAdmissionCommand {
  return {
    schemaVersion: 'source-admission-command@1', workspaceId: f.workspaceId, sourceId: source.sourceId,
    expectedSourceRevision: String(source.revision), expectedWorkspaceRevision: workspaceRevision,
    idempotencyKey: key,
  }
}

describe('source review -> admission -> re-grounding (real PostgreSQL, R09 end to end)', () => {
  it('unblocks a researched candidate only after every source is reviewed, promoted, admitted and re-grounded', async () => {
    const f = await fixture('reground-happy')
    const pageRef = await archivedPage(f.ctx, f.scopeRef)
    const manifestRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: pageRef.digest, kind: 'artifact' }
    const webEvidence = {
      kind: 'web_page' as const,
      url: 'https://standards.example.org/gb50500',
      snapshotRef: pageRef,
      snapshotManifestRef: manifestRef,
      contentDigest: pageRef.digest,
      fetchedAt: '2026-10-16T00:00:00Z',
      parserVersion: '1.0.0',
    }
    const candidates: CandidateSubmission[] = [
      {
        kind: 'source',
        reason: 'the archived standard page is the material this candidate is built on',
        origin: { url: webEvidence.url, publisher: 'Example Standards Body', fetchedAt: webEvidence.fetchedAt },
        evidence: [webEvidence],
      },
      {
        kind: 'definition',
        definitionKind: 'object',
        reason: 'the archived page defines the load-table suspension condition',
        evidence: [webEvidence],
        payload: {
          kind: 'object',
          logicalId: 'LoadTableSuspension',
          displayName: 'Load table suspension',
          businessMeaning: 'A load table whose monthly average exceeds the threshold is suspended.',
          suggestedReason: 'The archived standard states the suspension condition.',
          identityAttributeIds: [],
        },
      },
    ]
    const command: SubmitCandidatesCommand = {
      schemaVersion: 'submit-candidates@1', commandKind: 'submit_candidates', workspaceId: f.workspaceId, candidates,
    }
    const request: SubmitCandidatesRequest = { command, runId: randomUUID(), logicalActionId: 'action-1', idempotencyKey: `submit-${randomUUID().slice(0, 12)}` }
    const receipt = await f.submission.submit(f.scopeRef, request, f.ctx)
    expect(receipt.rejected).toEqual([])
    const sourceEntry = receipt.accepted.find((entry) => entry.kind === 'source')
    const definitionEntry = receipt.accepted.find((entry) => entry.kind === 'definition')
    if (sourceEntry === undefined || definitionEntry === undefined) throw new Error('expected one source and one definition candidate')
    expect(definitionEntry.pendingConfirmation).toBe(true)
    expect(definitionEntry.issues.some((issue) => issue.code === 'SOURCE_TRUST_BLOCKED')).toBe(true)

    // The hand-off reports each cited source separately and the candidate stays blocked.
    const before = await f.handoff.readHandoff(f.workspaceId, f.ctx)
    const blocked = before.candidates.find((entry) => entry.candidateId === definitionEntry.candidateId)
    expect(blocked?.readiness).toBe('pending_sources')
    expect(blocked?.links).toHaveLength(1)
    expect(blocked?.links[0]).toMatchObject({ reviewState: 'proposed', admitted: false, groundsPublication: false })

    // Review only records the human decision; it does not raise the tier (a separate admin command).
    const sourceRecord = await sources.getSource(f.scopeRef, sourceEntry.candidateId, f.ctx)
    if (sourceRecord === undefined) throw new Error('the source candidate was not persisted')
    const reviewed = await f.review.review(reviewCommand(f, sourceRecord), f.ctx)
    expect(reviewed).toMatchObject({ reviewState: 'approved', trustTier: 'agent_researched' })

    // Approved but still agent-researched: it cannot ground a publication yet.
    const approvedOnly = await f.handoff.readHandoff(f.workspaceId, f.ctx)
    const stillBlocked = approvedOnly.candidates.find((entry) => entry.candidateId === definitionEntry.candidateId)
    expect(stillBlocked?.readiness).toBe('pending_sources')
    expect(stillBlocked?.links[0]).toMatchObject({ reviewState: 'approved', trustTier: 'agent_researched', groundsPublication: false })

    // Promotion reads the *record* (it carries the workspace), not the review receipt.
    const approvedRecord = await sources.getSource(f.scopeRef, sourceEntry.candidateId, f.ctx)
    if (approvedRecord === undefined) throw new Error('the reviewed source was not persisted')
    const promoted = await f.review.promoteTier(promotionCommand(f, approvedRecord), f.promoter)
    expect(promoted).toMatchObject({ reviewState: 'approved', trustTier: 'public_standard' })

    // Reviewed + promoted but not admitted: the source is not in the workspace corpus yet.
    const notAdmitted = await f.handoff.readHandoff(f.workspaceId, f.ctx)
    expect(notAdmitted.candidates.find((entry) => entry.candidateId === definitionEntry.candidateId)?.readiness).toBe('pending_sources')

    const workspace = await workspaces.getWorkspace(f.scopeRef, f.workspaceId, f.ctx)
    const promotedRecord = await sources.getSource(f.scopeRef, sourceEntry.candidateId, f.ctx)
    if (promotedRecord === undefined) throw new Error('the promoted source was not persisted')
    const admitted = await f.admission.admit(admissionCommand(f, promotedRecord, workspace?.headRevision ?? '1'), f.ctx)
    expect(admitted).toMatchObject({ trustTier: 'public_standard', replayed: false })

    // Every source is now confirmed, but the candidate still cites the pre-admission block: it must
    // be re-grounded before asset review.
    const awaitingReground = await f.handoff.readHandoff(f.workspaceId, f.ctx)
    const regroundTarget = awaitingReground.candidates.find((entry) => entry.candidateId === definitionEntry.candidateId)
    expect(regroundTarget?.readiness).toBe('regrounding_required')
    expect(regroundTarget?.blockCodes).toEqual(['REGROUNDING_REQUIRED'])

    // Re-grounding re-reads the now-approved source and appends a new version; the original stays.
    const original = await f.definitionCandidates.getCandidate(f.scopeRef, definitionEntry.candidateId, f.ctx)
    if (original === undefined) throw new Error('the original candidate was not persisted')
    const regrounded = await f.submission.reground(f.workspaceId, definitionEntry.candidateId, original.contentDigest, `reground-${randomUUID().slice(0, 12)}`, f.ctx)
    expect(regrounded.newCandidateId).not.toBe(definitionEntry.candidateId)
    const successor = await f.definitionCandidates.getCandidate(f.scopeRef, regrounded.newCandidateId, f.ctx)
    expect(successor?.replacesCandidateId).toBe(definitionEntry.candidateId)
    expect(successor?.pendingConfirmation).toBe(false)
    expect(successor?.issues.some((issue) => issue.code === 'SOURCE_TRUST_BLOCKED')).toBe(false)
    expect(successor?.sourceSpans.length).toBeGreaterThan(0)
    // The blocked original is preserved, not edited in place.
    expect((await f.definitionCandidates.getCandidate(f.scopeRef, definitionEntry.candidateId, f.ctx))?.pendingConfirmation).toBe(true)

    // The hand-off now reports the candidate ready for formal asset review.
    const ready = await f.handoff.readHandoff(f.workspaceId, f.ctx)
    const readyEntry = ready.candidates.find((entry) => entry.candidateId === definitionEntry.candidateId)
    expect(readyEntry?.readiness).toBe('ready_for_review')
    expect(readyEntry?.blocked).toBe(false)
    expect(readyEntry?.regroundedCandidateId).toBe(regrounded.newCandidateId)
    expect(readyEntry?.allSourcesConfirmed).toBe(true)
  }, 180_000)
})
