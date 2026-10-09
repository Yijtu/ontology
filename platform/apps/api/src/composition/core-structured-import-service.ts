import { LocalDocumentExtractionService, LocalStructuredIngestionService, StructuredDocumentProjectionService, StructuredDocumentSpanReader, deterministicUuid, sha256DigestOfBytes } from '@ontology/adapter-extraction-document'
import type { DocumentArtifactStore } from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, ProjectDocumentIndexService } from '@ontology/adapter-search-bm25'
import type { KeywordIndexStore } from '@ontology/adapter-search-bm25'
import { isRecord, isResourceRef, isRevisionString, isToolContext, isVersionRef, projectCollectionRef, sha256OfCanonical } from '@ontology/contracts'
import type { DocumentParseStore, ProjectDocumentStore, ProjectReadinessStore, ProjectRevision, ProjectStore, ReadSpanRequest, ResourceRef, RunExecutionBindingStore, ScopeRef, StructuredIngestionStore, ToolContext, VersionRef } from '@ontology/contracts'
import { createCoreDocumentSearchHandler } from './core-document-search-handler'
import type { ProjectStructuredImportService } from '../http/project-imports'
import { ForbiddenError, InvalidRequestFieldError } from '../http/shared'
import type { PublicationEvidenceValidator } from '@ontology/application'

export interface CoreStructuredImportOptions {
  readonly blobs: DocumentArtifactStore
  readonly parses: DocumentParseStore
  readonly ingestion: StructuredIngestionStore
  readonly projects: ProjectStore
  readonly documents: ProjectDocumentStore
  readonly indexStore: KeywordIndexStore
  readonly readiness: ProjectReadinessStore
  readonly executionBindings: RunExecutionBindingStore
  readonly now?: () => string
}

interface IndexSnapshot {
  readonly projectRevisionRef: ProjectRevision['ref']
  readonly documentSetRef: ResourceRef
  readonly visibilityEpoch: string
  readonly membershipRevision: string
  readonly indexRef: VersionRef
  readonly generation: string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new ForbiddenError('a consistent host-minted context is required')
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/** Complete narrow leaf for normal imports, source reading, index readiness and fixed-run QA. */
export function createCoreStructuredImportWorkflow(options: CoreStructuredImportOptions) {
  const projection = new StructuredDocumentProjectionService(options)
  const spanReader = new StructuredDocumentSpanReader(options)
  const ingestion = new LocalStructuredIngestionService({ blobs: options.blobs, store: options.ingestion, ...(options.now === undefined ? {} : { now: options.now }) })
  const index = new ProjectDocumentIndexService({ store: options.documents, parseStore: options.parses, indexStore: options.indexStore,
    spanReader, projects: options.projects, readiness: options.readiness, ...(options.now === undefined ? {} : { now: options.now }) })
  const writeArtifact = async (body: unknown, ctx: ToolContext): Promise<ResourceRef> => {
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const staged = await options.blobs.stage(bytes, { scopeRef: scopeOf(ctx) }, ctx)
    return (await options.blobs.publish({ scopeRef: scopeOf(ctx), contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'application/json', purpose: 'artifact' }, ctx)).blobRef
  }
  const documentSet = async (projectId: string, ctx: ToolContext) => {
    const members = []
    let cursor: string | undefined
    do {
      const page = await options.documents.listDocuments(scopeOf(ctx), projectId, { state: 'active', limit: 200, ...(cursor === undefined ? {} : { cursor }) }, ctx)
      members.push(...page.memberships.map((member) => ({ documentId: member.documentId, documentRef: member.documentRef, parseId: member.parseId, parseRef: member.parseRef, membershipRevision: member.membershipRevision, precision: member.precision })))
      if (members.length > 1_000) throw new InvalidRequestFieldError('the document set exceeds 1000 sources')
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return writeArtifact({ schemaVersion: 'project-document-set@1', projectId, members }, ctx)
  }
  const imports: ProjectStructuredImportService = {
    async importStructuredSource(projectId, input, ctx) {
      const scope = scopeOf(ctx)
      if (!ctx.principal.roles.some((role) => ['platform-admin', 'operator', 'data-editor'].includes(role))) throw new ForbiddenError('structured imports require an operator role')
      const project = await options.projects.getProject(scope, projectId, ctx)
      if (project === undefined || project.state !== 'active') throw new InvalidRequestFieldError('an active project visible in this scope is required')
      const staged = await options.blobs.stage(input.content, { scopeRef: scope }, ctx)
      const written = await options.blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: input.mediaType, purpose: 'document' }, ctx)
      const parsed = await ingestion.parse({ scopeRef: scope, originalRef: written.blobRef, options: {}, ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }) }, ctx)
      if (input.format !== parsed.parse.format) throw new InvalidRequestFieldError('the declared format differs from the authorized source media type')
      const base = { parseId: parsed.parse.parseId, originalRef: parsed.parse.originalRef, originalMediaType: parsed.parse.originalMediaType, format: parsed.parse.format,
        status: parsed.parse.status, counts: parsed.parse.counts, coverage: parsed.parse.coverage, reused: parsed.reused }
      const projected = parsed.parse.format === 'text'
        ? await new LocalDocumentExtractionService({ blobs: options.blobs, store: options.parses }).parse({ scopeRef: scope, originalRef: parsed.parse.originalRef,
            ...(parsed.parse.sourceRef === undefined ? {} : { sourceRef: parsed.parse.sourceRef }) }, ctx)
        : await projection.project(parsed.parse, ctx)
      const documentId = deterministicUuid(`${scope.tenantId}|${scope.spaceId}|${projectId}|${parsed.parse.parseId}`)
      const status = await index.importDocument(projectId, { documentId, documentRef: parsed.parse.originalRef, documentDigest: parsed.parse.originalRef.digest,
        parseId: projected.parseId, parseRef: projected.spanMapRef, textDigest: projected.normalizedRef.digest, precision: parsed.parse.format === 'text' ? 'exact' : 'approximate',
        ...(parsed.parse.sourceRef === undefined ? {} : { sourceRef: parsed.parse.sourceRef }), actor: ctx.principal.subjectId, recordedAt: options.now?.() ?? new Date().toISOString() }, ctx)
      return { ...base, documentId, documentSetRef: await documentSet(projectId, ctx), documentIndexState: status.state }
    },
  }
  const resolveForCreation = async (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext): Promise<ResourceRef> => {
    if (sha256OfCanonical(scope) !== sha256OfCanonical(scopeOf(ctx))) throw new ForbiddenError('the document snapshot scope differs from the trusted run')
    const currentProject = await options.projects.getProject(scope, revision.ref.projectId, ctx)
    if (currentProject === undefined || currentProject.state !== 'active' || (currentProject.activeRevision ?? currentProject.headRevision) !== revision.ref.revision) throw new InvalidRequestFieldError('a new document QA run requires the current active project revision')
    const status = await index.getStatus(revision.ref.projectId, ctx)
    if (status.state !== 'ready' || status.indexRef === undefined || status.generation === undefined) throw new InvalidRequestFieldError('the project document index is not ready')
    const currentSet = await documentSet(revision.ref.projectId, ctx)
    if (currentSet.digest !== revision.documentSetRef.digest || revision.documentSetRef.kind !== 'artifact') throw new InvalidRequestFieldError('the current project corpus differs from the fixed revision document set')
    const savedSet = await options.blobs.getAuthorized({ scopeRef: scope, blobRef: revision.documentSetRef }, ctx)
    if (!savedSet.integrityVerified || savedSet.byteSize > 1_048_576 || sha256DigestOfBytes(await options.blobs.readAuthorized({ scopeRef: scope, blobRef: revision.documentSetRef }, ctx)) !== currentSet.digest) throw new InvalidRequestFieldError('the fixed document set failed authorized readback')
    const ref = await writeArtifact({ schemaVersion: 'project-document-index-snapshot@1', projectRevisionRef: revision.ref, documentSetRef: revision.documentSetRef,
      visibilityEpoch: status.visibilityEpoch, membershipRevision: status.membershipRevision, indexRef: status.indexRef, generation: status.generation }, ctx)
    const after = await options.documents.getVisibility(scope, revision.ref.projectId, ctx)
    if (after?.epoch !== status.visibilityEpoch) throw new InvalidRequestFieldError('the document corpus changed during run admission')
    return ref
  }
  const readSnapshot = async (ctx: ToolContext): Promise<IndexSnapshot | undefined> => {
    const scope = scopeOf(ctx)
    const archived = await options.executionBindings.getBindingByRun(scope, ctx.runId, ctx)
    if (archived === undefined) return undefined
    if (sha256OfCanonical(archived.binding) !== archived.ref.digest) throw new InvalidRequestFieldError('the archived document run binding failed its immutable digest')
    const ref = archived.binding.projectDocumentIndexSnapshotRef
    if (ref === undefined) throw new InvalidRequestFieldError('the document QA run has no fixed document index snapshot')
    const metadata = await options.blobs.getAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
    if (!metadata.integrityVerified || metadata.byteSize > 16_384) throw new InvalidRequestFieldError('the document index snapshot failed integrity or its bound')
    const bytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
    if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== ref.digest) throw new InvalidRequestFieldError('the document index snapshot bytes differ from the archived run')
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isRecord(body) || body['schemaVersion'] !== 'project-document-index-snapshot@1' || !isResourceRef(body['documentSetRef']) || !isVersionRef(body['indexRef'])
      || !isRevisionString(body['visibilityEpoch']) || !isRevisionString(body['membershipRevision']) || !isRevisionString(body['generation'])
      || sha256OfCanonical(body['projectRevisionRef']) !== sha256OfCanonical(archived.binding.request.projectRevisionRef)) throw new InvalidRequestFieldError('the fixed document snapshot has invalid project/index pins')
    const pin: IndexSnapshot = { projectRevisionRef: archived.binding.request.projectRevisionRef, documentSetRef: body['documentSetRef'], indexRef: body['indexRef'],
      visibilityEpoch: body['visibilityEpoch'], membershipRevision: body['membershipRevision'], generation: body['generation'] }
    const revision = await options.projects.getRevision(scope, pin.projectRevisionRef.projectId, pin.projectRevisionRef.revision, ctx)
    const project = await options.projects.getProject(scope, pin.projectRevisionRef.projectId, ctx)
    const visibility = await options.documents.getVisibility(scope, pin.projectRevisionRef.projectId, ctx)
    if (project?.state !== 'active' || revision === undefined || sha256OfCanonical(revision.ref) !== sha256OfCanonical(pin.projectRevisionRef) || sha256OfCanonical(revision.documentSetRef) !== sha256OfCanonical(pin.documentSetRef)
      || visibility?.epoch !== pin.visibilityEpoch || visibility.membershipRevision !== pin.membershipRevision) throw new InvalidRequestFieldError('the fixed run document set was changed or withdrawn')
    const generation = await options.indexStore.getGeneration(scope, projectCollectionRef(pin.projectRevisionRef.projectId), pin.generation, ctx)
    if (generation === undefined || sha256OfCanonical(generation.indexRef) !== sha256OfCanonical(pin.indexRef)) throw new InvalidRequestFieldError('the fixed document index generation is unavailable or changed')
    return pin
  }
  const handler = createCoreDocumentSearchHandler({ service: new Bm25DocumentSearchService({ indexStore: options.indexStore, spanReader }), spanReader, dataMode: 'observed', maxSpans: 10,
    fixedCollections: async (ctx) => {
      const pin = await readSnapshot(ctx)
      if (pin === undefined) throw new InvalidRequestFieldError('document QA requires an archived project execution binding')
      return [{ collectionRef: projectCollectionRef(pin.projectRevisionRef.projectId), generation: pin.generation }]
    }, checkCurrent: async (ctx) => { await readSnapshot(ctx) }, readOrigin: (request, ctx) => spanReader.readOrigin(request, ctx),
  })
  const publicationValidator: PublicationEvidenceValidator = { evidenceKind: 'document_span',
    async validate({ payload, ctx }) {
      try {
        const snapshot = await readSnapshot(ctx)
        if (snapshot === undefined || !isRecord(payload) || !Array.isArray(payload['spans'])) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        if (payload['spans'].length > 10) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        const setMetadata = await options.blobs.getAuthorized({ scopeRef: scopeOf(ctx), blobRef: snapshot.documentSetRef }, ctx)
        if (!setMetadata.integrityVerified || setMetadata.byteSize > 1_048_576) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        const setBytes = await options.blobs.readAuthorized({ scopeRef: scopeOf(ctx), blobRef: snapshot.documentSetRef }, ctx)
        if (sha256DigestOfBytes(setBytes) !== snapshot.documentSetRef.digest) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        const set: unknown = JSON.parse(new TextDecoder().decode(setBytes))
        if (!isRecord(set) || set['schemaVersion'] !== 'project-document-set@1' || set['projectId'] !== snapshot.projectRevisionRef.projectId || !Array.isArray(set['members']) || set['members'].length > 1_000) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        for (const span of payload['spans']) {
          if (!isRecord(span) || !isResourceRef(span['documentRef']) || !isRecord(span['locator'])) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
          const member = set['members'].find((candidate: unknown) => isRecord(candidate) && sha256OfCanonical(candidate['documentRef']) === sha256OfCanonical(span['documentRef']))
          if (!isRecord(member) || typeof member['parseId'] !== 'string' || !isResourceRef(member['parseRef'])) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
          const parse = await options.parses.getParse(scopeOf(ctx), member['parseId'], ctx)
          if (parse === undefined || sha256OfCanonical(parse.originalRef) !== sha256OfCanonical(span['documentRef']) || sha256OfCanonical(parse.spanMapRef) !== sha256OfCanonical(member['parseRef'])) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
          const locator = span['locator']
          if (locator['kind'] !== 'approximate_locator' && locator['kind'] !== 'page' && locator['kind'] !== 'offset') return { state: 'blocked', reasons: ['evidence_unverifiable'] }
          const request: ReadSpanRequest = { documentRef: span['documentRef'], locator: { kind: locator['kind'],
            ...(typeof locator['startOffset'] === 'number' ? { startOffset: locator['startOffset'] } : {}),
            ...(typeof locator['endOffset'] === 'number' ? { endOffset: locator['endOffset'] } : {}),
            ...(typeof locator['page'] === 'number' ? { page: locator['page'] } : {}),
            ...(typeof locator['normalizationMapRef'] === 'string' ? { normalizationMapRef: locator['normalizationMapRef'] } : {}) } }
          const origin = await spanReader.readOrigin(request, ctx)
          const read = await spanReader.readParsedSpan(parse, { ...request, maxBytes: 16_384 }, ctx)
          if (sha256OfCanonical(origin ?? null) !== sha256OfCanonical(span['sourceOrigin'] ?? null) || read.truncated === true || read.text !== span['quote'] || read.textDigest !== span['textDigest'] || read.textDigest !== span['quoteDigest']) return { state: 'blocked', reasons: ['evidence_unverifiable'] }
        }
        await readSnapshot(ctx)
        return { state: 'current' }
      } catch {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['the fixed document corpus or original cell source is no longer authorized/current'] }
      }
    },
  }
  return { imports, index, spanReader, projection, documentSet, resolveForCreation, handler, publicationValidator }
}
