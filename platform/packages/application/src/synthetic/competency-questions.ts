import { createHash } from 'node:crypto'
import {
  COMPETENCY_BODY_MEDIA_TYPE, CompetencyQuestionError, assertCompetencyQuestionSet, isToolContext, isUuid,
} from '@ontology/contracts'
import type {
  ApprovedCompetencyQuestionReader, BlobPort, CompetencyArtifactLookup, CompetencyQuestionBoundary,
  CompetencyQuestionReviewReader, CompetencyQuestionSet, CompetencyQuestionSetBody, ImmutableArtifactWriter,
  ResourceRef, ReviewableCandidateView, ScopeRef, ScopedArtifactReader, SemanticPublicationStore,
  ToolContext, VersionRef,
} from '@ontology/contracts'
import { canonicalJson } from '../profiles/canonical'

const MAX_BODY_BYTES = 1_048_576
const EDITOR_ROLES = ['platform-admin', 'profile-editor']

export interface CompetencyQuestionServiceDependencies {
  readonly lookup: CompetencyArtifactLookup
  readonly artifacts: Pick<BlobPort, 'getAuthorized'>
  readonly reader: ScopedArtifactReader
  readonly writer: ImmutableArtifactWriter
  readonly boundary: CompetencyQuestionBoundary
  readonly reviews: Pick<SemanticPublicationStore, 'latestReviewRevision' | 'getReview'>
}

function assertScope(scope: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId || scope.tenantId !== ctx.allowedResources.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) {
    throw new CompetencyQuestionError('SCOPE_MISMATCH', 'competency artifacts require the exact trusted scope')
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  assertScope(scope, ctx)
  return scope
}

function sameRef(a: VersionRef, b: VersionRef): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest }

/** Storage and approval reuse the existing immutable artifacts and candidate review ledger. */
export class CompetencyQuestionService implements ApprovedCompetencyQuestionReader, CompetencyQuestionReviewReader {
  readonly #deps: CompetencyQuestionServiceDependencies
  constructor(dependencies: CompetencyQuestionServiceDependencies) { this.#deps = dependencies }

  async upload(declaration: unknown, ctx: ToolContext): Promise<CompetencyQuestionSet> {
    const scope = scopeOf(ctx)
    if (!EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) throw new CompetencyQuestionError('FORBIDDEN', 'competency upload requires an editor role')
    assertCompetencyQuestionSet(declaration, this.#deps.boundary)
    if (declaration.body.questions.some((question) => question.input.scopeRef.tenantId !== scope.tenantId || question.input.scopeRef.spaceId !== scope.spaceId)) {
      throw new CompetencyQuestionError('SCOPE_MISMATCH', 'competency synthetic inputs must belong to the exact upload scope')
    }
    const bytes = new TextEncoder().encode(canonicalJson(declaration.body))
    if (bytes.byteLength > MAX_BODY_BYTES) throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency body exceeds the one-MiB bound')
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    // The canonical body is archived, not the full transport envelope. These two hashes agree
    // by construction and are checked independently before any review candidate is exposed.
    if (digest !== declaration.ref.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'canonical body bytes differ from the declaration body digest')
    const stored = await this.#deps.writer.putBytes({ scopeRef: scope, content: bytes, mediaType: COMPETENCY_BODY_MEDIA_TYPE }, ctx)
    if (stored.integrity.algorithm !== 'sha256' || stored.integrity.digest !== digest || stored.contentDigest !== digest || stored.blobRef.digest !== digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'stored competency body has an invalid byte digest')
    const ref = { id: stored.blobRef.id, version: stored.blobRef.version, digest }
    const result = { ref, body: declaration.body }
    assertCompetencyQuestionSet(result, this.#deps.boundary, ref)
    return result
  }

  async #read(scope: ScopeRef, ref: ResourceRef, ctx: ToolContext): Promise<CompetencyQuestionSet | undefined> {
    const metadata = await this.#deps.artifacts.getAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
    if (metadata.mediaType !== COMPETENCY_BODY_MEDIA_TYPE) return undefined
    if (!metadata.integrityVerified || metadata.byteSize > MAX_BODY_BYTES || !sameRef(metadata.blobRef, ref) || metadata.contentDigest !== ref.digest) {
      throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency artifact metadata is inconsistent')
    }
    const bytes = await this.#deps.reader.read({ approvedInputRefs: [ref] }, ctx)
    if (bytes.byteLength !== metadata.byteSize || bytes.byteLength > MAX_BODY_BYTES || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref.digest) {
      throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency body bytes are not intact')
    }
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency body must be valid UTF-8 JSON') }
    const result: unknown = { ref: { id: ref.id, version: ref.version, digest: ref.digest }, body }
    assertCompetencyQuestionSet(result, this.#deps.boundary, ref)
    if (canonicalJson(result.body) !== new TextDecoder().decode(bytes)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency artifact must contain canonical body bytes')
    return result
  }

  async readBody(scope: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<CompetencyQuestionSetBody | undefined> {
    assertScope(scope, ctx)
    if (!isUuid(ref.id)) return undefined
    const stored = await this.#deps.lookup.findBodyArtifact(scope, ref.id, ctx)
    if (stored === undefined || !sameRef(stored, ref)) return undefined
    return (await this.#read(scope, stored, ctx))?.body
  }

  async readCandidate(scope: ScopeRef, candidateId: string, ctx: ToolContext): Promise<ReviewableCandidateView | undefined> {
    assertScope(scope, ctx)
    if (!isUuid(candidateId)) return undefined
    const ref = await this.#deps.lookup.findBodyArtifact(scope, candidateId, ctx)
    if (ref === undefined) return undefined
    const set = await this.#read(scope, ref, ctx)
    return set === undefined ? undefined : { candidateId, domain: 'definition', kind: 'competency_questions', state: 'produced', contentDigest: set.ref.digest, sourceRefs: [ref] }
  }

  async readApproved(scope: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<CompetencyQuestionSet | undefined> {
    assertScope(scope, ctx)
    const body = await this.readBody(scope, ref, ctx)
    if (body === undefined) return undefined
    const revision = await this.#deps.reviews.latestReviewRevision(scope, ref.id, ctx)
    const review = await this.#deps.reviews.getReview(scope, ref.id, revision, ctx)
    if (review?.decision !== 'approve' || review.candidateId !== ref.id || review.contentDigest !== ref.digest) return undefined
    // A later same-content approval remains valid; a rejection during the artifact read does not.
    const finalRevision = await this.#deps.reviews.latestReviewRevision(scope, ref.id, ctx)
    const current = await this.#deps.reviews.getReview(scope, ref.id, finalRevision, ctx)
    if (current?.decision !== 'approve' || current.candidateId !== ref.id || current.contentDigest !== ref.digest) return undefined
    const result = { ref, body }
    assertCompetencyQuestionSet(result, this.#deps.boundary, ref)
    return result
  }
}
