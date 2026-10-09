import { createToolContext, projectCollectionRef } from '@ontology/contracts'
import type { CandidateStore, IdentityDecisionStore, IndustrySchemaSource, InstanceReviewStore, ProjectDocumentStore, ProjectRevision, ProjectStore, ScopedArtifactReader, ToolContext } from '@ontology/contracts'
import { createHash } from 'node:crypto'
import { isRecord } from '@ontology/contracts'
import { InstanceReviewService, canonicalJson, sha256DigestOf } from '@ontology/application'
import { IdentityRecallError, normalizeIdentityText } from '@ontology/semantic-engine'
import type { IdentityIndexEntry, IdentityIndexReader } from '@ontology/semantic-engine'
import { createInstanceIdentityWorkflow } from './instance-identity'
import type { InstanceIdentityWorkflow } from './instance-identity'
import type { AuthenticatedRequest } from '../http/shared'
import { CapabilityNotConfiguredError, ForbiddenError, InvalidRequestFieldError } from '../http/shared'
import { createRequestToolContext } from '../http/context'

export function createCoreInstanceIdentity(options: {
  readonly projects: ProjectStore
  readonly documents: ProjectDocumentStore
  readonly candidates: CandidateStore
  readonly identities: IdentityDecisionStore
  readonly instances: InstanceReviewStore
  readonly schemas: IndustrySchemaSource
  readonly reader: ScopedArtifactReader
}) {
  const service = new InstanceReviewService({ store: options.instances })
  const scope = (ctx: ToolContext) => ({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })
  const revisionFor = async (projectId: string, ctx: ToolContext): Promise<ProjectRevision> => {
    const project = await options.projects.getProject(scope(ctx), projectId, ctx)
    const revision = project === undefined ? undefined : await options.projects.getRevision(scope(ctx), projectId, project.headRevision, ctx)
    if (revision === undefined || project?.state === 'archived') throw new InvalidRequestFieldError('a current visible project is required')
    return revision
  }
  const workflowFor = async (projectId: string, ctx: ToolContext) => {
    const revision = await revisionFor(projectId, ctx)
    const mapping = revision.mappingRefs.find((ref) => ref.role === 'catalog' && ref.sourceObjectRef.objectPath === 'confirmed_identity_index')
    if (mapping === undefined) throw new CapabilityNotConfiguredError('this project has no actual confirmed-identity catalogue; create a project through the normal bootstrap')
    const catalogue = await options.reader.read({ approvedInputRefs: [{ id: mapping.id, version: mapping.version, digest: mapping.digest, kind: 'artifact' }] }, ctx)
    if (catalogue.byteLength > 65_536 || `sha256:${createHash('sha256').update(catalogue).digest('hex')}` !== mapping.digest) throw new InvalidRequestFieldError('the actual identity catalogue failed its immutable byte pin')
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogue))
    const schema = await options.schemas.getSchema(scope(ctx), revision.definitionRef, ctx)
    if (!isRecord(body) || body['schemaVersion'] !== 'core-identity-catalogue@1' || body['projectId'] !== projectId || canonicalJson(body['scopeRef']) !== canonicalJson(scope(ctx)) || canonicalJson(body['definitionRef']) !== canonicalJson(revision.definitionRef) || canonicalJson(body['sourceObjectRef']) !== canonicalJson(mapping.sourceObjectRef) || canonicalJson(body['identityScopes']) !== canonicalJson(schema?.identityScopes)) throw new InvalidRequestFieldError('the actual identity catalogue does not bind the current project definition and index source')
    const index: IdentityIndexReader = { query: async (query, context) => {
      if (query.tenantId !== context.principal.tenantId || query.spaceId !== context.allowedResources.spaceId || !query.scopeDimensions.some((dimension) => dimension.dimension === 'project' && dimension.value === projectId)) throw new IdentityRecallError('SCOPE_MISMATCH', 'identity recall requires the exact project domain')
      const schema = await options.schemas.getSchema(scope(context), revision.definitionRef, context)
      const identity = schema?.identityScopes.find((row) => row.identityScopeId === query.identityScopeId && row.objectId === query.objectId)
      if (identity === undefined || identity.identityAttributeIds.length !== 1) throw new CapabilityNotConfiguredError('the native identity index supports one explicit string identity key per object')
      const stored = await options.identities.listEntities(scope(context), { objectId: query.objectId, projectId, state: 'confirmed', limit: 1000 }, context)
      if (stored.length === 1000) throw new IdentityRecallError('INVALID_REQUEST', 'the confirmed identity catalogue exceeds its bounded complete inventory')
      const entries: IdentityIndexEntry[] = []
      for (const entity of stored) {
        if (entity.identityScopeId !== identity.identityScopeId || !query.scopeDimensions.every((dimension) => entity.scopeDimensions[dimension.dimension] === dimension.value) || entity.createdFromCandidateId === undefined) continue
        const candidate = await options.candidates.getCandidate(scope(context), entity.createdFromCandidateId, context)
        if (candidate?.kind !== 'entity' || candidate.objectId !== query.objectId) continue
        const key = candidate.attributes.find((attribute) => attribute.attributeId === identity.identityAttributeIds[0])?.value
        if (typeof key !== 'string') continue
        const label = candidate.attributes.find((attribute) => attribute.attributeId.endsWith('_name') && typeof attribute.value === 'string') ?? candidate.attributes.find((attribute) => !identity.identityAttributeIds.includes(attribute.attributeId) && !identity.scopeDimensions.includes(attribute.attributeId) && typeof attribute.value === 'string')
        const displayName = entity.displayName ?? (typeof label?.value === 'string' ? label.value : key)
        const normalizedName = normalizeIdentityText(displayName)
        if (query.match.kind === 'confirmed_alias') continue // No alias assertion is invented from a display name.
        if (query.match.kind === 'strong_identifier' ? key !== query.match.nativeId : query.match.normalizedName !== undefined && normalizedName !== query.match.normalizedName || query.match.entityType !== undefined && query.match.entityType !== entity.objectId || query.match.site !== undefined && query.match.site !== entity.scopeDimensions['site']) continue
        entries.push({ tenantId: query.tenantId, spaceId: query.spaceId, entityId: entity.entityId, objectId: entity.objectId,
          identityScopeId: entity.identityScopeId, nativeId: key, displayName, normalizedName, aliasConfirmed: false, entityType: entity.objectId, dimensions: entity.scopeDimensions })
      }
      const after = await options.identities.listEntities(scope(context), { objectId: query.objectId, projectId, state: 'confirmed', limit: 1000 }, context)
      if (canonicalJson(after) !== canonicalJson(stored)) throw new IdentityRecallError('INVALID_REQUEST', 'the confirmed identity catalogue changed while reading')
      entries.sort((left, right) => left.entityId.localeCompare(right.entityId))
      return { entries: entries.slice(0, query.limit), truncated: entries.length > query.limit, knownTotal: entries.length, schemaRevision: '1.0.0',
        snapshot: { sourceRef: mapping.sourceObjectRef.sourceRef, schemaVersion: '1.0.0', readAt: new Date().toISOString(), consistency: 'read_time', resultDigest: sha256DigestOf(canonicalJson(entries)) } }
    } }
    return createInstanceIdentityWorkflow({ service, projects: options.projects, projectDocuments: options.documents, candidates: options.candidates,
      identityStore: options.identities, schemaSource: options.schemas, identityMappingRef: mapping, index })
  }
  const identity: Pick<InstanceIdentityWorkflow, 'recall' | 'createRecord' | 'adjudicateIdentity' | 'validatePublication'> = {
    recall: async (scopeRef, projectId, candidateId, documentId, ctx, limit) => (await workflowFor(projectId, ctx)).recall(scopeRef, projectId, candidateId, documentId, ctx, limit),
    createRecord: async (scopeRef, projectId, input, ctx) => (await workflowFor(projectId, ctx)).createRecord(scopeRef, projectId, input, ctx),
    adjudicateIdentity: async (scopeRef, projectId, recordId, input, ctx) => (await workflowFor(projectId, ctx)).adjudicateIdentity(scopeRef, projectId, recordId, input, ctx),
    validatePublication: async (scopeRef, projectId, recordId, ctx) => (await workflowFor(projectId, ctx)).validatePublication(scopeRef, projectId, recordId, ctx),
  }
  const referenceChoices = async (projectId: string, ctx: ToolContext) => {
    const revision = await revisionFor(projectId, ctx)
    const schema = await options.schemas.getSchema(scope(ctx), revision.definitionRef, ctx)
    if (schema === undefined || schema.objects.length > 64) throw new InvalidRequestFieldError('the target definition reference inventory is unavailable')
    const point = await options.identities.latestReadRevision(scope(ctx), ctx)
    const choices = []
    const targets = new Set(schema.objects.flatMap((object) => object.attributes.flatMap((attribute) => attribute.valueType === 'reference' && attribute.referencesObjectId !== undefined ? [attribute.referencesObjectId] : [])))
    for (const object of schema.objects) {
      if (!targets.has(object.objectId)) continue
      const identity = schema.identityScopes.find((identity) => identity.objectId === object.objectId && identity.identityScopeId === object.identityScopeId)
      if (identity === undefined || !identity.scopeDimensions.includes('project')) continue
      const entities = await options.identities.listEntities(scope(ctx), { objectId: object.objectId, projectId, state: 'confirmed', limit: 1000 }, ctx)
      if (entities.length === 1000) throw new InvalidRequestFieldError('the target identity choice inventory exceeded its complete bounded page')
      for (const entity of entities) {
        if (entity.scopeDimensions['project'] !== projectId || entity.identityScopeId !== identity.identityScopeId || identity.scopeDimensions.some((dimension) => typeof entity.scopeDimensions[dimension] !== 'string' || entity.scopeDimensions[dimension]?.length === 0)) continue
        const candidate = entity.createdFromCandidateId === undefined ? undefined : await options.candidates.getCandidate(scope(ctx), entity.createdFromCandidateId, ctx)
        const native = candidate?.kind === 'entity' ? candidate.attributes.find((attribute) => identity.identityAttributeIds.includes(attribute.attributeId))?.value : undefined
        const displayName = entity.displayName ?? (typeof native === 'string' ? native : undefined)
        if (displayName !== undefined) choices.push({ entityId: entity.entityId, objectId: object.objectId, displayName })
      }
    }
    if (point !== await options.identities.latestReadRevision(scope(ctx), ctx) || canonicalJson(await revisionFor(projectId, ctx)) !== canonicalJson(revision)) throw new InvalidRequestFieldError('the target identity/source domain changed while reading choices')
    return choices
  }
  return { service, identity, referenceChoices, identityContext: async (auth: AuthenticatedRequest, projectId: string, traceId: string) => {
    const ctx = createRequestToolContext({ ...auth, traceId, runId: projectId })
    const revision = await revisionFor(projectId, ctx)
    const sourceRefs = revision.mappingRefs.filter((mapping) => mapping.role === 'catalog' && mapping.sourceObjectRef.objectPath === 'confirmed_identity_index').map((mapping) => mapping.sourceObjectRef.sourceRef)
    if (sourceRefs.length > 1) throw new ForbiddenError('the project has ambiguous identity catalogues')
    return createToolContext({ ...ctx, resolvedProfileHash: revision.profileRef.snapshotHash, allowedResources: { ...ctx.allowedResources,
      resourceKinds: ['document'], sourceRefs, collectionRefs: [projectCollectionRef(projectId)], maxRows: 1000 } })
  }, revisionFor }
}
