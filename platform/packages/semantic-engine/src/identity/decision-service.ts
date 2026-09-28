import { isToolContext } from '@ontology/contracts'
import type {
  AppendIdentityDecisionInput,
  EntityCandidate,
  IdentityAssertionRecord,
  IdentityDecisionDraft,
  IdentityDecisionRecord,
  IdentityEntityRecord,
  IdentityInvalidationEvent,
  IdentityLinkConstraintRecord,
  IndustryIdentityScopeSchema,
  IndustrySchema,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { IdentityDecisionStoreError } from '@ontology/contracts'
import { IdentityDecisionError } from './decision-types'
import type {
  IdentityDecisionListFilter,
  IdentityDecisionRequest,
  IdentityDecisionServiceDependencies,
  IdentityDecisionView,
  ResolvedIdentityTarget,
} from './decision-types'

const DEFAULT_SCORE_THRESHOLD = 0.8
const REVIEWER_ROLES: readonly string[] = ['semantic-reviewer', 'platform-admin']

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new IdentityDecisionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IdentityDecisionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertReviewer(ctx: ToolContext): void {
  if (REVIEWER_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new IdentityDecisionError('FORBIDDEN', 'only a semantic-reviewer may adjudicate identity candidates')
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function scopeDimensionValues(
  candidate: EntityCandidate,
  identityScope: IndustryIdentityScopeSchema,
): Readonly<Record<string, string>> {
  const dimensions: Record<string, string> = {}
  for (const dimension of identityScope.scopeDimensions) {
    const matches = candidate.attributes.filter((attribute) => attribute.attributeId === dimension)
    const value = matches[0]?.value
    if (matches.length !== 1 || typeof value !== 'string' || !nonEmpty(value)) continue
    dimensions[dimension] = value
  }
  return dimensions
}

function sameDimensions(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function requireCompatibleDimensions(
  entity: IdentityEntityRecord,
  target: ResolvedIdentityTarget,
  candidateId: Uuid,
  operation: string,
): void {
  if (!sameDimensions(entity.scopeDimensions, target.scopeDimensions)) {
    throw new IdentityDecisionError(
      'IDENTITY_SCOPE_MISMATCH',
      `${operation} target ${entity.entityId} has different identity-scope dimension values`,
    )
  }
  const complete = target.scopeDimensionIds.every(
    (dimension) => target.scopeDimensions[dimension] !== undefined && entity.scopeDimensions[dimension] !== undefined,
  )
  if (!complete && entity.createdFromCandidateId !== candidateId) {
    throw new IdentityDecisionError(
      'IDENTITY_SCOPE_MISMATCH',
      `${operation} cannot combine candidates while an identity-scope dimension is unknown`,
    )
  }
}

function nextRevision(revision: RevisionString): RevisionString {
  if (!/^(?:0|[1-9]\d*)$/.test(revision)) {
    throw new IdentityDecisionError('INVALID_ARGUMENT', `identity entity revision ${revision} is not a canonical integer`)
  }
  return String(BigInt(revision) + 1n)
}

/** The exact source chunks a mention came from, carried into the decision evidence. */
function candidateEvidence(candidate: EntityCandidate): ResourceRef[] {
  return candidate.sourceSpans.map((span) => ({
    id: span.chunkId,
    version: candidate.inputVersion.parserVersion,
    digest: span.quoteDigest,
    kind: 'chunk',
  }))
}

function mergeEvidence(...groups: readonly (readonly ResourceRef[])[]): ResourceRef[] {
  const seen = new Set<string>()
  const out: ResourceRef[] = []
  for (const group of groups) {
    for (const ref of group) {
      const key = `${ref.kind}\u0000${ref.id}\u0000${ref.version}\u0000${ref.digest}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}

/**
 * The entity adjudication service (SPEC D4.5/D4.6, C6).
 *
 * It resolves the candidate's identity scope from the published definition, applies the
 * merge rules and appends one immutable decision version. It never recalls candidates,
 * never evaluates rules and never publishes semantics.
 *
 * Merge authority is deliberately narrow: a `match` is authorised by a strong identity
 * (native id / confirmed alias) or a human justification. A model/JEV score is recorded
 * as supporting evidence and can never merge on its own; a below-threshold score is
 * refused. A `cannot-link` constraint or a conflicting cluster membership blocks the
 * merge, and a cross-object/scope merge (device vs sensor) is refused from the
 * definition.
 */
export class IdentityDecisionService {
  readonly #deps: IdentityDecisionServiceDependencies
  readonly #scoreThreshold: number
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: IdentityDecisionServiceDependencies) {
    this.#deps = dependencies
    this.#scoreThreshold = dependencies.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async decide(request: IdentityDecisionRequest, ctx: ToolContext): Promise<IdentityDecisionView> {
    const scopeRef = scopeOf(ctx)
    assertReviewer(ctx)
    if (!nonEmpty(request.candidateId)) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'candidateId must be a non-empty uuid')
    }
    if (request.expectedRevision === undefined) {
      throw new IdentityDecisionError('REVISION_REQUIRED', 'this update requires an If-Match expected revision')
    }
    const expectedRevision = request.expectedRevision
    const candidate = await this.#requireCandidate(scopeRef, request.candidateId, ctx)
    const target = await this.#resolveTarget(scopeRef, candidate, ctx)
    const currentRevision = await this.#currentRevision(scopeRef, candidate.candidateId, ctx)
    if (currentRevision !== expectedRevision) {
      throw new IdentityDecisionError(
        'VERSION_CONFLICT',
        `the candidate is at decision revision ${currentRevision}, not ${expectedRevision}`,
      )
    }

    const recordedAt = this.#now()
    const evidenceRefs = mergeEvidence(candidateEvidence(candidate), request.evidenceRefs ?? [])
    const base = {
      decisionId: this.#newId(),
      candidateId: candidate.candidateId,
      objectId: target.objectId,
      identityScopeId: target.identityScopeId,
      evidenceRefs,
      recordedAt,
      actor: ctx.principal.subjectId,
      ...(request.validFrom === undefined ? {} : { validFrom: request.validFrom }),
      ...(request.validTo === undefined ? {} : { validTo: request.validTo }),
      ...(request.justification === undefined ? {} : { justification: request.justification }),
    } satisfies Omit<IdentityDecisionDraft, 'kind'>

    const plan = await this.#plan(request, candidate, target, base, scopeRef, ctx)
    try {
      const record = await this.#deps.store.appendDecision(
        scopeRef,
        { expectedRevision, ...plan },
        ctx,
      )
      return this.#toView(record, plan.entity)
    } catch (error) {
      if (error instanceof IdentityDecisionStoreError && error.code === 'REVISION_CONFLICT') {
        throw new IdentityDecisionError('VERSION_CONFLICT', error.message, { cause: error })
      }
      throw error
    }
  }

  async getDecision(
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<IdentityDecisionView> {
    const scopeRef = scopeOf(ctx)
    const record = await this.#deps.store.getDecision(scopeRef, candidateId, revision, ctx)
    if (record === undefined) {
      throw new IdentityDecisionError(
        'CANDIDATE_NOT_FOUND',
        `decision revision ${revision} for candidate ${candidateId} is not visible in this scope`,
      )
    }
    return this.#toView(record, undefined)
  }

  /** Every decision version for one candidate, oldest first. History is never rewritten. */
  async listDecisionHistory(
    candidateId: Uuid,
    filter: IdentityDecisionListFilter,
    ctx: ToolContext,
  ): Promise<IdentityDecisionView[]> {
    const scopeRef = scopeOf(ctx)
    const records = await this.#deps.store.listDecisions(scopeRef, candidateId, ctx)
    const limit = filter.limit ?? records.length
    return records.slice(0, limit).map((record) => this.#toView(record, undefined))
  }

  async #requireCandidate(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<EntityCandidate> {
    const candidate = await this.#deps.candidates.getCandidate(scopeRef, candidateId, ctx)
    if (candidate === undefined) {
      throw new IdentityDecisionError('CANDIDATE_NOT_FOUND', `candidate ${candidateId} is not visible in this scope`)
    }
    if (candidate.kind !== 'entity') {
      throw new IdentityDecisionError(
        'INVALID_ARGUMENT',
        `candidate ${candidateId} is a ${candidate.kind} candidate, not an entity candidate`,
      )
    }
    return candidate
  }

  /**
   * Resolve the identity scope the definition declares for the candidate's object. A
   * candidate whose own `identityScopeId` contradicts the definition is refused, so a
   * caller cannot widen the scope by editing the candidate.
   */
  async #resolveTarget(
    scopeRef: ScopeRef,
    candidate: EntityCandidate,
    ctx: ToolContext,
  ): Promise<ResolvedIdentityTarget> {
    const schema = await this.#deps.schemaSource.getSchema(scopeRef, candidate.inputVersion.definitionRef, ctx)
    if (schema === undefined) {
      throw new IdentityDecisionError(
        'IDENTITY_SCOPE_MISMATCH',
        `definition ${candidate.inputVersion.definitionRef.id}@${candidate.inputVersion.definitionRef.version} is not visible in this scope`,
      )
    }
    const identityScope = this.#identityScopeOf(schema, candidate.objectId)
    if (candidate.identityScopeId !== undefined && candidate.identityScopeId !== identityScope.identityScopeId) {
      throw new IdentityDecisionError(
        'IDENTITY_SCOPE_MISMATCH',
        `candidate declares identity scope ${candidate.identityScopeId} but the definition declares ${identityScope.identityScopeId}`,
      )
    }
    return {
      objectId: candidate.objectId,
      identityScopeId: identityScope.identityScopeId,
      identityAttributeIds: identityScope.identityAttributeIds,
      scopeDimensionIds: identityScope.scopeDimensions,
      scopeDimensions: scopeDimensionValues(candidate, identityScope),
      candidate,
    }
  }

  #identityScopeOf(schema: IndustrySchema, objectId: string): IndustryIdentityScopeSchema {
    const object = schema.objects.find((entry) => entry.objectId === objectId)
    if (object === undefined) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', `object ${objectId} is not declared by the pinned definition`)
    }
    const identityScope = schema.identityScopes.find((entry) => entry.identityScopeId === object.identityScopeId)
    if (identityScope === undefined) {
      throw new IdentityDecisionError(
        'IDENTITY_SCOPE_MISMATCH',
        `object ${objectId} declares identity scope ${object.identityScopeId}, which the definition does not define`,
      )
    }
    return identityScope
  }

  async #currentRevision(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RevisionString> {
    return this.#deps.store.latestRevision(scopeRef, candidateId, ctx)
  }

  async #plan(
    request: IdentityDecisionRequest,
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    base: Omit<IdentityDecisionDraft, 'kind'>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Omit<AppendIdentityDecisionInput, 'expectedRevision'>> {
    switch (request.kind) {
      case 'match':
        return this.#planMatch(request, candidate, target, base, scopeRef, ctx)
      case 'create_pending':
        return this.#planCreatePending(request, target, base)
      case 'clarify':
        return { draft: { ...base, kind: 'clarify' } }
      case 'reject':
        return this.#planReject(request, candidate, target, base, scopeRef, ctx)
      case 'split':
        return this.#planSplit(request, candidate, target, base, scopeRef, ctx)
    }
  }

  async #planMatch(
    request: IdentityDecisionRequest,
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    base: Omit<IdentityDecisionDraft, 'kind'>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Omit<AppendIdentityDecisionInput, 'expectedRevision'>> {
    const targetEntityId = request.targetEntityId
    if (!nonEmpty(targetEntityId)) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'a match requires a targetEntityId')
    }
    const entity = await this.#deps.store.getEntity(scopeRef, targetEntityId, ctx)
    if (entity === undefined) {
      throw new IdentityDecisionError('ENTITY_NOT_FOUND', `entity ${targetEntityId} is not visible in this scope`)
    }
    // Identity scope/type constraint from the definition: a device and a sensor are
    // different objects with different scopes and must never merge, even when their
    // display names are identical (D4.6).
    if (entity.objectId !== target.objectId || entity.identityScopeId !== target.identityScopeId) {
      throw new IdentityDecisionError(
        'IDENTITY_SCOPE_MISMATCH',
        `entity ${targetEntityId} is a ${entity.objectId}/${entity.identityScopeId}, which cannot merge with ${target.objectId}/${target.identityScopeId}`,
      )
    }
    requireCompatibleDimensions(entity, target, candidate.candidateId, 'match')
    if (entity.state === 'retired') {
      throw new IdentityDecisionError('IDENTITY_CONFLICT', `entity ${targetEntityId} is retired and cannot receive a merge`)
    }
    // A hard negative link blocks the merge; it is never dropped to force a match.
    const constraints = await this.#deps.store.listLinkConstraints(scopeRef, candidate.candidateId, ctx)
    if (constraints.some((constraint) => constraint.entityId === targetEntityId)) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `candidate ${candidate.candidateId} is cannot-linked with entity ${targetEntityId}`,
      )
    }
    // Consistent cluster: one source record belongs to at most one entity.
    const open = await this.#deps.store.listAssertions(
      scopeRef,
      { candidateId: candidate.candidateId, openOnly: true },
      ctx,
    )
    if (open.some((assertion) => assertion.entityId === targetEntityId)) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `candidate ${candidate.candidateId} is already asserted to entity ${targetEntityId}`,
      )
    }
    const conflicting = open.find((assertion) => assertion.entityId !== targetEntityId)
    if (conflicting !== undefined) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `candidate ${candidate.candidateId} is already asserted to entity ${conflicting.entityId}`,
      )
    }

    const strongIdentity =
      request.strongIdentity === undefined
        ? undefined
        : this.#validateSourceIdentity(
            candidate,
            target.identityAttributeIds,
            request.strongIdentity,
            entity.createdFromCandidateId === candidate.candidateId,
          )
    const justification = request.justification
    const score = request.scoreEvidence
    if (strongIdentity !== undefined) {
      if (
        entity.createdFromCandidateId !== candidate.candidateId &&
        !(await this.#hasReviewedIdentity(scopeRef, entity, strongIdentity, ctx))
      ) {
        throw new IdentityDecisionError(
          'IDENTITY_EVIDENCE_REQUIRED',
          'the target cluster has no previously reviewed matching identity; provide a human justification or match a confirmed identity',
        )
      }
    }
    // A score is supporting evidence only: it can never authorise a merge by itself.
    if (strongIdentity === undefined && !nonEmpty(justification)) {
      if (score !== undefined && score.score < this.#scoreThreshold) {
        throw new IdentityDecisionError(
          'IDENTITY_SCORE_BELOW_THRESHOLD',
          `similarity score ${score.score} is below the ${this.#scoreThreshold} threshold and cannot support a merge`,
        )
      }
      throw new IdentityDecisionError(
        'IDENTITY_EVIDENCE_REQUIRED',
        'a match requires a strong identity (native id / confirmed alias) or a human justification; a model score alone never merges',
      )
    }
    const assertion = this.#openAssertion(candidate, targetEntityId, base)
    const updatedEntity: IdentityEntityRecord = {
      ...entity,
      state: 'confirmed',
      revision: nextRevision(entity.revision),
      updatedAt: base.recordedAt,
    }
    return {
      draft: {
        ...base,
        kind: 'match',
        targetEntityId,
        ...(strongIdentity === undefined ? {} : { strongIdentity }),
        ...(score === undefined ? {} : { scoreEvidence: score }),
      },
      entity: updatedEntity,
      expectedTargetEntityRevision: entity.revision,
      openAssertion: assertion,
    }
  }

  #planCreatePending(
    request: IdentityDecisionRequest,
    target: ResolvedIdentityTarget,
    base: Omit<IdentityDecisionDraft, 'kind'>,
  ): Omit<AppendIdentityDecisionInput, 'expectedRevision'> {
    const entityId = this.#newId()
    const entity: IdentityEntityRecord = {
      entityId,
      objectId: target.objectId,
      identityScopeId: target.identityScopeId,
      scopeDimensions: target.scopeDimensions,
      createdFromCandidateId: base.candidateId,
      state: 'pending',
      revision: '1',
      recordedAt: base.recordedAt,
      updatedAt: base.recordedAt,
    }
    return {
      draft: {
        ...base,
        kind: 'create_pending',
        targetEntityId: entityId,
        ...(request.scoreEvidence === undefined ? {} : { scoreEvidence: request.scoreEvidence }),
      },
      entity,
    }
  }

  async #planReject(
    request: IdentityDecisionRequest,
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    base: Omit<IdentityDecisionDraft, 'kind'>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Omit<AppendIdentityDecisionInput, 'expectedRevision'>> {
    const targetEntityId = request.targetEntityId
    if (targetEntityId === undefined) {
      return { draft: { ...base, kind: 'reject' } }
    }
    const entity = await this.#deps.store.getEntity(scopeRef, targetEntityId, ctx)
    if (entity === undefined) {
      throw new IdentityDecisionError('ENTITY_NOT_FOUND', `entity ${targetEntityId} is not visible in this scope`)
    }
    if (entity.objectId !== target.objectId || entity.identityScopeId !== target.identityScopeId) {
      throw new IdentityDecisionError(
        'IDENTITY_SCOPE_MISMATCH',
        `cannot-link target ${targetEntityId} is outside the candidate's object identity scope`,
      )
    }
    requireCompatibleDimensions(entity, target, candidate.candidateId, 'cannot-link')
    const open = await this.#deps.store.listAssertions(scopeRef, { candidateId: candidate.candidateId, openOnly: true }, ctx)
    if (open.some((assertion) => assertion.entityId === targetEntityId)) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `candidate ${candidate.candidateId} is already merged into ${targetEntityId}; split it before recording a cannot-link`,
      )
    }
    const constraint: IdentityLinkConstraintRecord = {
      constraintId: this.#newId(),
      candidateId: base.candidateId,
      entityId: targetEntityId,
      kind: 'cannot_link',
      decisionId: base.decisionId,
      recordedAt: base.recordedAt,
    }
    return {
      draft: { ...base, kind: 'reject', targetEntityId },
      expectedTargetEntityRevision: entity.revision,
      linkConstraint: constraint,
    }
  }

  async #planSplit(
    request: IdentityDecisionRequest,
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    base: Omit<IdentityDecisionDraft, 'kind'>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Omit<AppendIdentityDecisionInput, 'expectedRevision'>> {
    const targetEntityId = request.targetEntityId
    if (!nonEmpty(targetEntityId)) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'a split requires the targetEntityId to separate from')
    }
    const entity = await this.#deps.store.getEntity(scopeRef, targetEntityId, ctx)
    if (entity === undefined) {
      throw new IdentityDecisionError('ENTITY_NOT_FOUND', `entity ${targetEntityId} is not visible in this scope`)
    }
    if (entity.objectId !== target.objectId || entity.identityScopeId !== target.identityScopeId) {
      throw new IdentityDecisionError('IDENTITY_SCOPE_MISMATCH', `split target ${targetEntityId} is outside the candidate's identity scope`)
    }
    requireCompatibleDimensions(entity, target, candidate.candidateId, 'split')
    const separatedCandidateIds = request.separatedCandidateIds ?? [candidate.candidateId]
    if (separatedCandidateIds.length === 0) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'a split requires at least one source record to separate')
    }
    if (new Set(separatedCandidateIds).size !== separatedCandidateIds.length) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'a split cannot repeat a source candidate id')
    }
    const open = await this.#deps.store.listAssertions(scopeRef, { entityId: targetEntityId, openOnly: true }, ctx)
    const separated = new Set(separatedCandidateIds)
    const closeAssertions = open
      .filter((assertion) => separated.has(assertion.candidateId))
      .map((assertion) => ({ assertionId: assertion.assertionId, validTo: base.recordedAt }))
    const foundCandidates = new Set(open.filter((assertion) => separated.has(assertion.candidateId)).map((assertion) => assertion.candidateId))
    if (closeAssertions.length === 0 || foundCandidates.size !== separated.size) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `every requested source record must currently be asserted to entity ${targetEntityId}`,
      )
    }
    const invalidation: IdentityInvalidationEvent = {
      eventId: this.#newId(),
      topic: 'identity.decision.split',
      decisionId: base.decisionId,
      entityId: targetEntityId,
      objectId: target.objectId,
      identityScopeId: target.identityScopeId,
      separatedCandidateIds,
      reason: request.justification ?? 'identity split',
      recordedAt: base.recordedAt,
      actor: base.actor,
    }
    return {
      draft: {
        ...base,
        kind: 'split',
        targetEntityId,
        separatedCandidateIds,
      },
      expectedTargetEntityRevision: entity.revision,
      closeAssertions,
      invalidation,
      outboxJobId: candidate.jobId,
    }
  }

  #openAssertion(
    candidate: EntityCandidate,
    entityId: string,
    base: Omit<IdentityDecisionDraft, 'kind'>,
  ): IdentityAssertionRecord {
    return {
      assertionId: this.#newId(),
      candidateId: candidate.candidateId,
      entityId,
      objectId: base.objectId,
      identityScopeId: base.identityScopeId,
      decisionId: base.decisionId,
      validFrom: base.validFrom ?? base.recordedAt,
      ...(base.validTo === undefined ? {} : { validTo: base.validTo }),
      recordedAt: base.recordedAt,
    }
  }

  #validateSourceIdentity(
    candidate: EntityCandidate,
    identityAttributeIds: readonly string[],
    identity: NonNullable<IdentityDecisionRequest['strongIdentity']>,
    allowSelfIdentityReview: boolean,
  ): NonNullable<IdentityDecisionRequest['strongIdentity']> {
    if (!nonEmpty(identity.value)) {
      throw new IdentityDecisionError('IDENTITY_EVIDENCE_INVALID', 'a strong identity needs a non-empty exact value')
    }
    if (identity.kind === 'native_id') {
      if (identityAttributeIds.length === 0) {
        throw new IdentityDecisionError(
          'IDENTITY_EVIDENCE_INVALID',
          'native_id evidence is unavailable because the pinned identity scope declares no identity attributes',
        )
      }
      if (identity.attributeId !== undefined) {
        if (!identityAttributeIds.includes(identity.attributeId)) {
          throw new IdentityDecisionError(
            'IDENTITY_EVIDENCE_INVALID',
            'native_id evidence must name an identity attribute from the candidate definition',
          )
        }
        const matches = candidate.attributes.filter((attribute) => attribute.attributeId === identity.attributeId)
        if (matches.length !== 1 || matches[0]?.value !== identity.value) {
          throw new IdentityDecisionError(
            'IDENTITY_EVIDENCE_INVALID',
            'native_id evidence must exactly match the candidate value for the pinned identity attribute',
          )
        }
        return identity
      }

      const matches = candidate.attributes.filter(
        (attribute) => identityAttributeIds.includes(attribute.attributeId) && attribute.value === identity.value,
      )
      if (matches.length > 1) {
        throw new IdentityDecisionError('IDENTITY_EVIDENCE_INVALID', 'native_id value matches multiple identity attributes')
      }
      if (matches.length === 1) {
        const attributeId = matches[0]?.attributeId
        if (attributeId === undefined) {
          throw new IdentityDecisionError('IDENTITY_EVIDENCE_INVALID', 'native_id attribute could not be resolved')
        }
        return { ...identity, attributeId }
      }
      if (candidate.nativeId !== identity.value) {
        if (allowSelfIdentityReview && identityAttributeIds.length === 1) {
          const attributeId = identityAttributeIds[0]
          if (attributeId !== undefined) return { ...identity, attributeId }
        }
        throw new IdentityDecisionError(
          'IDENTITY_EVIDENCE_INVALID',
          'native_id evidence must exactly match the candidate native ID or one pinned identity attribute',
        )
      }
      return identity
    }
    if (!candidate.attributes.some((attribute) => attribute.value === identity.value)) {
      throw new IdentityDecisionError(
        'IDENTITY_EVIDENCE_INVALID',
        'confirmed_alias evidence must match a value on the source candidate',
      )
    }
    return identity
  }

  async #hasReviewedIdentity(
    scopeRef: ScopeRef,
    entity: IdentityEntityRecord,
    identity: NonNullable<IdentityDecisionRequest['strongIdentity']>,
    ctx: ToolContext,
  ): Promise<boolean> {
    return this.#deps.store.hasReviewedIdentity(scopeRef, entity.entityId, identity, ctx)
  }

  #toView(record: IdentityDecisionRecord, entity: IdentityEntityRecord | undefined): IdentityDecisionView {
    return {
      decisionId: record.decisionId,
      candidateId: record.candidateId,
      kind: record.kind,
      revision: record.revision,
      objectId: record.objectId,
      identityScopeId: record.identityScopeId,
      ...(record.targetEntityId === undefined ? {} : { targetEntityId: record.targetEntityId }),
      ...(record.separatedCandidateIds === undefined
        ? {}
        : { separatedCandidateIds: record.separatedCandidateIds }),
      ...(record.supersedesRevision === undefined ? {} : { supersedesRevision: record.supersedesRevision }),
      ...(entity === undefined ? {} : { entity }),
      ...(record.invalidationOutboxId === undefined
        ? {}
        : { invalidationOutboxId: record.invalidationOutboxId }),
      recordedAt: record.recordedAt,
    }
  }
}
