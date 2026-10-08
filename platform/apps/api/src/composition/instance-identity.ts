import { InstanceReviewError, isToolContext, projectCollectionRef } from '@ontology/contracts'
import type {
  CandidateStore, CandidateSourceSpan, IdentityDecisionStore,
  InstanceIdentityBinding, InstanceRecordView, ProjectDocumentMembership,
  ProjectDocumentStore, ProjectRevision, ProjectStore, ScopeRef, SourceLocator, ToolContext, Uuid, VersionRef,
} from '@ontology/contracts'
import type { CreateInstanceRelationInput, IdentityAdjudicationInput, InstanceReviewService } from '@ontology/application'
import { EntityCandidateRecallService, IdentityDecisionError, IdentityDecisionService } from '@ontology/semantic-engine'
import type { EntityCandidateRecallDependencies, IdentityRecallResult } from '@ontology/semantic-engine'

export interface InstanceIdentityWorkflowOptions extends EntityCandidateRecallDependencies {
  /** The confirmed identity-index mapping the host mounted; must be pinned by the project. */
  readonly identityMappingRef: VersionRef
  readonly service: InstanceReviewService
  readonly projects: ProjectStore
  readonly projectDocuments: ProjectDocumentStore
  readonly candidates: CandidateStore
  readonly identityStore: IdentityDecisionStore
  /** Optional host-owned shared ledger; absent explicitly skips a mounted similarity backend. */
  readonly resolveSimilarityLedger?: (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext) => Promise<Uuid | undefined>
}

export interface InstanceIdentityCreateInput {
  readonly candidateId: Uuid
  readonly documentId: Uuid
  readonly idempotencyKey: string
  readonly relations: readonly CreateInstanceRelationInput[]
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function conflict(message: string): InstanceReviewError {
  return new InstanceReviewError('IDENTITY_CONFLICT', message)
}

function locatorOf(span: CandidateSourceSpan): SourceLocator {
  if (span.kind === 'structured') return span.locator
  const locator = span.locator
  if (locator.kind === 'offset' && locator.startOffset !== undefined && locator.endOffset !== undefined) return { ...locator, kind: 'offset', startOffset: locator.startOffset, endOffset: locator.endOffset }
  if (locator.kind === 'page' && locator.page !== undefined) return { ...locator, kind: 'page', page: locator.page }
  if (locator.kind === 'approximate_locator') return { ...locator, kind: 'approximate_locator' }
  throw conflict('stored source locator is incomplete')
}

/**
 * Production instance seam: HTTP supplies selectors only. Stored extraction, current project
 * pins and active document membership determine the recall universe and identity domain.
 * IdentityDecisionService remains the semantic binding authority; confidence never approves.
 */
export class InstanceIdentityWorkflow {
  readonly #deps: InstanceIdentityWorkflowOptions
  readonly #recall: EntityCandidateRecallService
  readonly #decisions: IdentityDecisionService

  constructor(options: InstanceIdentityWorkflowOptions) {
    this.#deps = options
    this.#recall = new EntityCandidateRecallService(options)
    this.#decisions = new IdentityDecisionService({ store: options.identityStore, candidates: options.candidates, schemaSource: options.schemaSource })
  }

  async recall(scope: ScopeRef, projectId: Uuid, candidateId: Uuid, documentId: Uuid, ctx: ToolContext, limit?: number): Promise<IdentityRecallResult> {
    const input = await this.#context(scope, projectId, candidateId, documentId, ctx)
    const ledgerId = this.#deps.similarity === undefined ? undefined : await this.#deps.resolveSimilarityLedger?.(scope, input.revision, ctx)
    const result = await this.#recall.recall({
      projectId,
      candidate: input.candidate,
      definitionRef: input.revision.definitionRef,
      observedText: input.observedText,
      scopeDimensionValues: input.dimensions,
      // The caller's context must already authorize this host-minted collection.
      contextCollections: ctx.allowedResources.collectionRefs.includes(projectCollectionRef(projectId)) ? [projectCollectionRef(projectId)] : [],
      ...(limit === undefined ? {} : { limit }),
      // A request body can never select or reset the host's shared budget ledger.
      ...(ledgerId === undefined ? { allowSimilarity: false } : { ledgerId }),
    }, ctx)
    await this.#checkPins(scope, projectId, input.revision, input.membership, input.visibilityEpoch, ctx)
    return result
  }

  async createRecord(scope: ScopeRef, projectId: Uuid, input: InstanceIdentityCreateInput, ctx: ToolContext): Promise<{ readonly record: InstanceRecordView; readonly recall: IdentityRecallResult }> {
    const stored = await this.#context(scope, projectId, input.candidateId, input.documentId, ctx)
    const recall = await this.recall(scope, projectId, input.candidateId, input.documentId, ctx)
    if (recall.identityScopeId !== stored.identityScopeId) throw conflict('identity scope changed during recall')
    await this.#checkPins(scope, projectId, stored.revision, stored.membership, stored.visibilityEpoch, ctx)
    const span = stored.candidate.sourceSpans[0]
    if (span === undefined) throw conflict('an instance record requires a stored source span')
    const binding: InstanceIdentityBinding = {
      candidateId: input.candidateId, documentId: input.documentId,
      projectRevisionRef: stored.revision.ref, definitionRef: stored.revision.definitionRef,
      membershipRevision: stored.membership.membershipRevision,
      visibilityEpoch: stored.visibilityEpoch, identityScopeId: stored.identityScopeId,
    }
    const record = await this.#deps.service.createRecord(scope, projectId, {
      recordId: input.candidateId,
      objectTypeRef: stored.candidate.objectId, displayName: stored.observedText,
      identityBinding: binding,
      identityCandidates: recall.candidates.map((candidate) => ({
        entityId: candidate.entityId, objectId: candidate.objectId,
        displayName: candidate.displayName ?? candidate.matchedValue,
        strategy: candidate.strategy === 'strong_identifier' ? 'native_id' : candidate.strategy === 'confirmed_alias' ? 'alias' : candidate.strategy,
        rank: candidate.rank, identityScopeId: candidate.identityScopeId,
        evidenceRefs: candidate.evidenceRefs,
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
      })),
      fields: stored.candidate.attributes.map((attribute, index) => {
        const fieldSpan = stored.candidate.inputVersion.projectFact === undefined ? span : stored.candidate.sourceSpans[index]
        if (fieldSpan === undefined) throw conflict('mapped field has no exact stored cell provenance')
        return {
          fieldId: attribute.attributeId, rawValue: attribute.raw ?? (typeof attribute.value === 'boolean' ? attribute.value : String(attribute.value)),
          normalizedValue: attribute.unitCode === undefined ? { kind: 'scalar', value: attribute.value } : { kind: 'quantity', value: attribute.decimal ?? String(attribute.value), unitCode: attribute.unitCode },
          source: { documentRef: stored.membership.documentRef, parseId: fieldSpan.parseId, chunkId: fieldSpan.kind === 'structured' ? fieldSpan.recordId : fieldSpan.chunkId, locator: locatorOf(fieldSpan), textDigest: fieldSpan.kind === 'structured' ? fieldSpan.rowDigest : fieldSpan.textDigest, quoteDigest: fieldSpan.kind === 'structured' ? fieldSpan.rowDigest : fieldSpan.quoteDigest },
        }
      }),
      relations: input.relations, sourceRef: stored.membership.documentRef,
      actor: ctx.principal.subjectId, idempotencyKey: input.idempotencyKey,
    }, ctx)
    return { record, recall }
  }

  async validateRecord(scope: ScopeRef, projectId: Uuid, recordId: Uuid, ctx: ToolContext): Promise<InstanceRecordView> {
    const record = await this.#deps.service.getRecord(scope, projectId, recordId, ctx)
    const binding = record.identity.binding
    if (binding === undefined) throw conflict('record has no trusted extraction/project identity binding; recreate it from a stored candidate')
    const stored = await this.#context(scope, projectId, binding.candidateId, binding.documentId, ctx)
    if (binding.projectRevisionRef.projectId !== projectId || binding.projectRevisionRef.revision !== stored.revision.ref.revision || binding.projectRevisionRef.digest !== stored.revision.ref.digest ||
      !sameRef(binding.definitionRef, stored.revision.definitionRef) || binding.membershipRevision !== stored.membership.membershipRevision || binding.visibilityEpoch !== stored.visibilityEpoch || binding.identityScopeId !== stored.identityScopeId || record.objectTypeRef !== stored.candidate.objectId) {
      throw conflict('record identity pins are stale; the project, definition or source changed')
    }
    for (const attributeId of stored.identityAttributes) {
      const extracted = stored.candidate.attributes.find((attribute) => attribute.attributeId === attributeId)
      const field = record.fields.find((entry) => entry.fieldId === attributeId)
      if (extracted !== undefined && (field?.normalizedValue?.kind !== 'scalar' || field.normalizedValue.value !== extracted.value)) {
        throw conflict('an identity key was edited after recall; extract and recall the corrected source first')
      }
    }
    return record
  }

  async validatePublication(scope: ScopeRef, projectId: Uuid, recordId: Uuid, ctx: ToolContext): Promise<void> {
    const record = await this.validateRecord(scope, projectId, recordId, ctx)
    if (record.identity.state !== 'matched' && record.identity.state !== 'created') throw new InstanceReviewError('PUBLICATION_BLOCKED', 'identity must have a current human binding before approval/publication')
    const binding = record.identity.binding
    if (binding === undefined) throw conflict('identity binding is missing')
    const snapshot = await this.#deps.identityStore.readPublishedBindings(scope, [binding.candidateId], ctx)
    const current = snapshot.bindings[0]
    if (!snapshot.complete || current?.openAssertions.length !== 1 || current.openAssertions[0]?.entityId !== record.identity.matchedEntityId || current.cannotLinkEntityIds.includes(record.identity.matchedEntityId ?? '')) {
      throw conflict('record has no current human identity assertion; a score or a rejected/split identity cannot publish')
    }
    const entity = record.identity.matchedEntityId === undefined ? undefined : await this.#deps.identityStore.getEntity(scope, record.identity.matchedEntityId, ctx)
    if (entity?.state !== 'confirmed' || entity.objectId !== record.objectTypeRef || entity.identityScopeId !== binding.identityScopeId || entity.scopeDimensions['project'] !== projectId) throw conflict('bound identity is no longer confirmed in this project/domain')
  }

  async adjudicateIdentity(scope: ScopeRef, projectId: Uuid, recordId: Uuid, input: IdentityAdjudicationInput, ctx: ToolContext): Promise<InstanceRecordView> {
    if (!ctx.principal.roles.some((role) => role === 'semantic-reviewer' || role === 'platform-admin')) throw new IdentityDecisionError('FORBIDDEN', 'only a semantic reviewer may decide identity')
    const record = await this.validateRecord(scope, projectId, recordId, ctx)
    const prior = record.identity.adjudications.find((decision) => decision.idempotencyKey === input.idempotencyKey)
    if (prior !== undefined) {
      if (prior.kind !== input.kind || prior.targetEntityId !== input.targetEntityId || prior.reason !== input.reason) throw new InstanceReviewError('IDEMPOTENCY_CONFLICT', 'identity decision key was used for a different selection')
      return record
    }
    if (record.recordRevision !== input.expectedRevision) throw new InstanceReviewError('VERSION_CONFLICT', 'record revision changed before identity selection')
    const binding = record.identity.binding
    if (binding === undefined) throw conflict('identity binding is missing')
    if (input.reason.trim().length === 0) throw new InstanceReviewError('INVALID_ARGUMENT', 'human identity decisions require a reason')
    const parseId = record.fields[0]?.source.parseId
    if (parseId === undefined) throw conflict('record has no stored parse source')
    const projectFence = {
      projectRevisionRef: binding.projectRevisionRef, definitionRef: binding.definitionRef,
      documentId: binding.documentId, parseId, membershipRevision: binding.membershipRevision,
      visibilityEpoch: binding.visibilityEpoch,
    }
    if (input.kind === 'create' && input.targetEntityId !== undefined) throw conflict('create cannot select an existing identity target')
    if (input.kind === 'cannot_link' && record.identity.matchedEntityId === input.targetEntityId) throw conflict('split the current identity before cannot-linking it')
    if (input.kind === 'split' && record.identity.matchedEntityId !== input.targetEntityId) throw conflict('split must select the currently bound identity')
    if (input.kind === 'create' && record.identity.matchedEntityId !== undefined) throw conflict('split the current identity before creating another one')
    let entityId = input.targetEntityId
    if (input.kind === 'match') {
      const recalled = await this.recall(scope, projectId, binding.candidateId, binding.documentId, ctx)
      if (!record.identity.candidates.some((entry) => entry.entityId === entityId) || !recalled.candidates.some((entry) => entry.entityId === entityId)) throw conflict('selection is outside the current bounded recall')
      if (record.identity.matchedEntityId === entityId && record.identity.state === 'matched') {
        await this.validatePublication(scope, projectId, recordId, ctx)
        return record
      }
    }
    if (input.kind !== 'create') {
      if (entityId === undefined) throw conflict('an identity target is required')
      await this.#requireProjectEntity(scope, projectId, entityId, ctx)
    }
    let revision = await this.#deps.identityStore.latestRevision(scope, binding.candidateId, ctx)
    if (input.kind === 'create') {
      const priorDecision = revision === '0' ? undefined : await this.#deps.identityStore.getDecision(scope, binding.candidateId, revision, ctx)
      const priorEntity = priorDecision?.targetEntityId === undefined ? undefined : await this.#deps.identityStore.getEntity(scope, priorDecision.targetEntityId, ctx)
      if (priorDecision?.kind === 'create_pending' || (priorDecision?.kind === 'match' && priorDecision.justification === input.reason && priorEntity?.createdFromCandidateId === binding.candidateId && priorEntity.scopeDimensions['project'] === projectId)) entityId = priorDecision.targetEntityId
      else {
        const created = await this.#decisions.decide({ projectId, projectFence, candidateId: binding.candidateId, kind: 'create_pending', expectedRevision: revision, justification: input.reason }, ctx)
        entityId = created.targetEntityId
        revision = created.revision
      }
    }
    const kind = input.kind === 'cannot_link' ? 'reject' : input.kind === 'create' ? 'match' : input.kind
    const latest = revision === '0' ? undefined : await this.#deps.identityStore.getDecision(scope, binding.candidateId, revision, ctx)
    // Recover a decision committed before a record CAS failure without writing a second assertion.
    if (latest?.kind !== kind || latest.targetEntityId !== entityId || latest.justification !== input.reason) {
      await this.#decisions.decide({ projectId, projectFence, candidateId: binding.candidateId, kind, expectedRevision: revision, ...(entityId === undefined ? {} : { targetEntityId: entityId }), justification: input.reason }, ctx)
    }
    await this.validateRecord(scope, projectId, recordId, ctx)
    return this.#deps.service.adjudicateIdentity(scope, projectId, recordId, { ...input, ...(input.kind === 'create' && entityId !== undefined ? { resolvedEntityId: entityId } : {}) }, ctx)
  }

  async #requireProjectEntity(scope: ScopeRef, projectId: Uuid, entityId: string, ctx: ToolContext): Promise<void> {
    const entity = await this.#deps.identityStore.getEntity(scope, entityId, ctx)
    if (entity === undefined || entity.state === 'retired') throw conflict('selected identity is not active in the trusted scope')
    if (entity.scopeDimensions['project'] !== projectId) throw conflict('selected identity belongs to a different project namespace')
  }

  async #context(scope: ScopeRef, projectId: Uuid, candidateId: Uuid, documentId: Uuid, ctx: ToolContext) {
    if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) throw new InstanceReviewError('SCOPE_MISMATCH', 'identity scope differs from the trusted principal')
    const project = await this.#deps.projects.getProject(scope, projectId, ctx)
    if (project === undefined || project.state === 'archived') throw new InstanceReviewError('PROJECT_NOT_FOUND', 'active project is not visible')
    const revision = await this.#deps.projects.getRevision(scope, projectId, project.headRevision, ctx)
    const candidate = await this.#deps.candidates.getCandidate(scope, candidateId, ctx)
    const membership = await this.#deps.projectDocuments.getMembership(scope, projectId, documentId, ctx)
    const visibility = await this.#deps.projectDocuments.getVisibility(scope, projectId, ctx)
    if (revision === undefined || candidate?.kind !== 'entity' || membership?.state !== 'active' || visibility === undefined) throw conflict('stored entity candidate and active source membership are required')
    if (!revision.mappingRefs.some((mapping) => sameRef(mapping, this.#deps.identityMappingRef))) throw conflict('the mounted identity-index mapping is not pinned by this project revision')
    if (!sameRef(revision.definitionRef, candidate.inputVersion.definitionRef) || candidate.inputVersion.parseId !== membership.parseId || candidate.sourceSpans.length === 0 || candidate.sourceSpans.some((span) => span.parseId !== membership.parseId) ||
      (candidate.inputVersion.documentVersionRef !== undefined && !sameRef(candidate.inputVersion.documentVersionRef, membership.documentRef))) throw conflict('candidate definition or source does not match the current project pins')
    const schema = await this.#deps.schemaSource.getSchema(scope, revision.definitionRef, ctx)
    const object = schema?.objects.find((entry) => entry.objectId === candidate.objectId)
    const identity = schema?.identityScopes.find((entry) => entry.identityScopeId === object?.identityScopeId && entry.objectId === candidate.objectId)
    if (schema === undefined || !sameRef(schema.definitionRef, revision.definitionRef) || identity === undefined || (candidate.identityScopeId !== undefined && candidate.identityScopeId !== identity.identityScopeId)) throw conflict('stored candidate identity domain differs from the pinned schema')
    const dimensions: Record<string, string> = {}
    const storedProject = candidate.attributes.filter((attribute) => attribute.attributeId === 'project')
    if (storedProject.length > 1 || (storedProject.length === 1 && storedProject[0]?.value !== projectId)) throw conflict('candidate project dimension differs from its active membership')
    for (const dimension of identity.scopeDimensions) {
      if (dimension === 'project') { dimensions[dimension] = projectId; continue }
      const values = candidate.attributes.filter((attribute) => attribute.attributeId === dimension)
      const value = values[0]?.value
      if (values.length !== 1 || typeof value !== 'string' || value.trim().length === 0) throw conflict(`stored candidate has no unambiguous ${dimension} identity dimension`)
      dimensions[dimension] = value
    }
    const label = candidate.attributes.find((attribute) => attribute.attributeId.endsWith('_name') && typeof attribute.value === 'string') ?? candidate.attributes.find((attribute) => !identity.identityAttributeIds.includes(attribute.attributeId) && !identity.scopeDimensions.includes(attribute.attributeId) && typeof attribute.value === 'string')
    const observedText = label === undefined ? candidate.nativeId ?? String(candidate.attributes.find((attribute) => identity.identityAttributeIds.includes(attribute.attributeId))?.value ?? '') : String(label.value)
    return { revision, candidate, membership, visibilityEpoch: visibility.epoch, identityScopeId: identity.identityScopeId, identityAttributes: identity.identityAttributeIds, dimensions, observedText }
  }

  async #checkPins(scope: ScopeRef, projectId: Uuid, revision: ProjectRevision, membership: ProjectDocumentMembership, visibilityEpoch: string, ctx: ToolContext): Promise<void> {
    const project = await this.#deps.projects.getProject(scope, projectId, ctx)
    const current = await this.#deps.projectDocuments.getMembership(scope, projectId, membership.documentId, ctx)
    const visibility = await this.#deps.projectDocuments.getVisibility(scope, projectId, ctx)
    if (project?.headRevision !== revision.ref.revision || current?.state !== 'active' || current.membershipRevision !== membership.membershipRevision || visibility?.epoch !== visibilityEpoch) throw conflict('project or source changed while identity recall was running')
  }
}

/** GAP-019 registers the returned workflow on instanceReviews.identity. */
export function createInstanceIdentityWorkflow(options: InstanceIdentityWorkflowOptions): InstanceIdentityWorkflow {
  return new InstanceIdentityWorkflow(options)
}
