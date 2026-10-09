import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import {
  COMPETENCY_QUESTION_SCHEMA_ID, SCHEMA_DOCUMENTS,
  CompetencyQuestionError, isToolContext, isUuid,
} from '@ontology/contracts'
import type { CompetencyExpectation, CompetencyQuestionBoundary, CompetencyQuestionSet, CompetencySourceReader, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'
import { CompetencyQuestionService, canonicalJson, sha256DigestOf } from '@ontology/application'
import type { ArtifactRegistry, LocalImmutableBlobStore } from '@ontology/adapter-blob-local'

export function createCompetencyQuestionBoundary(): {
  readonly boundary: CompetencyQuestionBoundary
  readonly validateActual: (value: unknown) => value is CompetencyExpectation
} {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const schema of SCHEMA_DOCUMENTS) ajv.addSchema(schema as SchemaObject)
  return {
    boundary: { schemaId: COMPETENCY_QUESTION_SCHEMA_ID,
      validate: ajv.compile<CompetencyQuestionSet>({ $ref: COMPETENCY_QUESTION_SCHEMA_ID }),
      digestBody: (body) => sha256DigestOf(canonicalJson(body)) },
    validateActual: ajv.compile<CompetencyExpectation>({ $ref: 'https://ontology.local/schema/competency-questions.schema.json#/$defs/CompetencyExpectation' }),
  }
}

/** Adapter-backed artifact lookup and the same authoritative human review store. */
export function createCompetencyQuestionWorkflow(options: {
  readonly blobs: LocalImmutableBlobStore
  readonly registry: Pick<ArtifactRegistry, 'findReference'>
  readonly reviews: Pick<SemanticPublicationStore, 'latestReviewRevision' | 'getReview'>
}) {
  const schema = createCompetencyQuestionBoundary()
  const service = new CompetencyQuestionService({
    ...schema, reviews: options.reviews, artifacts: options.blobs,
    writer: { putBytes: async (request, ctx) => {
      const staged = await options.blobs.stage(request.content, { scopeRef: request.scopeRef }, ctx)
      return options.blobs.putImmutable({ scopeRef: request.scopeRef, contentDigest: staged.contentDigest,
        byteSize: staged.byteSize, mediaType: request.mediaType,
        ...(request.tenantAuthorizedRef === undefined ? {} : { tenantAuthorizedRef: request.tenantAuthorizedRef }) }, ctx)
    } },
    reader: { read: async (request, ctx) => {
      const ref = request.approvedInputRefs[0]
      if (request.approvedInputRefs.length !== 1 || ref === undefined) throw new Error('competency body read requires exactly one approved immutable artifact')
      return options.blobs.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: ref }, ctx)
    } },
    lookup: { findBodyArtifact: async (scope, id) => {
      const found = await options.registry.findReference(scope, id)
      if (found === undefined || found.reference.purpose !== 'artifact') return undefined
      return { id: found.reference.blobRefId, version: '1.0.0', digest: found.reference.contentDigest, kind: 'artifact' }
    } },
  })
  const sources: CompetencySourceReader = { readSource: async (scope, ref, ctx, signal) => {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== scope.tenantId || ctx.allowedResources.spaceId !== scope.spaceId || ctx.allowedResources.tenantId !== scope.tenantId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'competency original read requires the exact trusted scope')
    if (signal.aborted) throw new CompetencyQuestionError('CANCELLED', 'competency original read was cancelled')
    if (!isUuid(ref.id)) return undefined
    const found = await options.registry.findReference(scope, ref.id)
    if (found === undefined || found.reference.purpose !== 'document' || found.reference.contentDigest !== ref.digest || ref.version !== '1.0.0') return undefined
    const blobRef = { ...ref, kind: 'document' as const }
    const metadata = await options.blobs.getAuthorized({ scopeRef: scope, blobRef }, ctx)
    if (!metadata.integrityVerified || metadata.byteSize > 8_388_608) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency original metadata is invalid or exceeds eight MiB')
    const bytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef }, ctx)
    if (signal.aborted) throw new CompetencyQuestionError('CANCELLED', 'competency original read was cancelled')
    return bytes
  } }
  const uploadSource = async (bytes: Uint8Array, mediaType: string, ctx: ToolContext): Promise<VersionRef> => {
    if (!isToolContext(ctx) || !ctx.principal.roles.some((role) => role === 'platform-admin' || role === 'profile-editor')) throw new CompetencyQuestionError('FORBIDDEN', 'competency original upload requires an editor role')
    if (bytes.byteLength === 0 || bytes.byteLength > 8_388_608 || !['text/plain', 'text/csv', 'application/json'].includes(mediaType)) throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency original must be a bounded text, CSV or registered-operation JSON input')
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const staged = await options.blobs.stage(bytes, { scopeRef }, ctx)
    const stored = await options.blobs.publish({ scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType, purpose: 'document' }, ctx)
    return { id: stored.blobRef.id, version: stored.blobRef.version, digest: stored.blobRef.digest }
  }
  return { service, sources, uploadSource, ...schema }
}
