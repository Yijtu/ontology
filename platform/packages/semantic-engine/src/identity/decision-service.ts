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
const MAX_IDENTITY_CLUSTER_MEMBERS = 256
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
 * Merge authority is deliberately narrow: a `match` needs a native identity key verified
 * against both candidate and target cluster, or a human justification. A model/JEV score
 * is supporting evidence only. A `cannot-link` or conflicting cluster key blocks the
 * merge even with a justification; target entity revision CAS serialises concurrent
 * membership changes. Cross-object/scope merges are refused from the definition.
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
    return { objectId: candidate.objectId, identityScopeId: identityScope.identityScopeId, identityAttributeIds: identityScope.identityAttributeIds, candidate }
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
        return this.#planReject(request, target, base, scopeRef, ctx)
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
    const conflicting = open.find((assertion) => assertion.entityId !== targetEntityId)
    if (conflicting !== undefined) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `candidate ${candidate.candidateId} is already asserted to entity ${conflicting.entityId}`,
      )
    }

    const members = await this.#compatibleClusterMembers(candidate, target, targetEntityId, scopeRef, ctx)

    const justification = request.justification
    // A candidate's native id proves who the candidate is, not that an unrelated target
    // entity has the same id. A reviewer-provided reason is a separate authority path;
    // do not turn the candidate's own id into a falsely verified target match.
    const strongIdentity = request.strongIdentity ?? (nonEmpty(justification) ? undefined : this.#nativeIdentityOf(candidate))
    const score = request.scoreEvidence
    if (score !== undefined && score.score < this.#scoreThreshold) {
      throw new IdentityDecisionError(
        'IDENTITY_SCORE_BELOW_THRESHOLD',
        `similarity score ${score.score} is below the ${this.#scoreThreshold} threshold and cannot support a merge`,
      )
    }
    if (strongIdentity?.kind === 'native_id') {
      await this.#validateNativeIdentity(candidate, target, targetEntityId, strongIdentity.value, request.expectedRevision, members, scopeRef, ctx)
    }
    // Confirmed aliases need a separately verified alias source, which this service does not
    // receive. A reviewer may still merge with a recorded justification, but an asserted alias
    // string alone is not a hard identity key.
    if (strongIdentity === undefined && !nonEmpty(justification)) {
      throw new IdentityDecisionError(
        'IDENTITY_EVIDENCE_REQUIRED',
        'a match requires a matching native identity key or a human justification; a model score alone never merges',
      )
    }
    if (strongIdentity?.kind === 'confirmed_alias' && !nonEmpty(justification)) {
      throw new IdentityDecisionError('IDENTITY_EVIDENCE_REQUIRED', 'a confirmed alias must be independently verified or accompanied by a reviewer justification')
    }
    const assertion = this.#openAssertion(candidate, targetEntityId, base)
    return {
      draft: {
        ...base,
        kind: 'match',
        targetEntityId,
        ...(strongIdentity === undefined ? {} : { strongIdentity }),
        ...(score === undefined ? {} : { scoreEvidence: score }),
      },
      openAssertion: assertion,
      expectedEntityRevision: entity.revision,
    }
  }

  async #compatibleClusterMembers(
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    entityId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<readonly EntityCandidate[]> {
    const assertions = await this.#deps.store.listAssertions(scopeRef, { entityId, openOnly: true, limit: MAX_IDENTITY_CLUSTER_MEMBERS + 1 }, ctx)
    if (assertions.length > MAX_IDENTITY_CLUSTER_MEMBERS) {
      throw new IdentityDecisionError('IDENTITY_EVIDENCE_REQUIRED', 'the target cluster is too large for a complete automatic consistency check')
    }
    const members: EntityCandidate[] = []
    const candidateKeys = new Map(candidate.attributes
      .filter((attribute) => target.identityAttributeIds.includes(attribute.attributeId))
      .map((attribute) => [attribute.attributeId, attribute.value] as const))
    for (const assertion of assertions) {
      const member = await this.#deps.candidates.getCandidate(scopeRef, assertion.candidateId, ctx)
      if (member?.kind !== 'entity' || member.objectId !== target.objectId || member.identityScopeId !== target.identityScopeId) {
        throw new IdentityDecisionError('IDENTITY_CONFLICT', 'the target cluster contains an unreadable or cross-scope member')
      }
      for (const attribute of member.attributes) {
        if (candidateKeys.has(attribute.attributeId) && candidateKeys.get(attribute.attributeId) !== attribute.value) {
          throw new IdentityDecisionError('IDENTITY_CONFLICT', 'the target cluster has a conflicting identity key')
        }
      }
      if (candidate.nativeId !== undefined && member.nativeId !== undefined && candidate.nativeId !== member.nativeId) {
        throw new IdentityDecisionError('IDENTITY_CONFLICT', 'the target cluster has a conflicting native id')
      }
      members.push(member)
    }
    return members
  }

  async #validateNativeIdentity(
    candidate: EntityCandidate,
    target: ResolvedIdentityTarget,
    targetEntityId: string,
    value: string,
    expectedRevision: RevisionString | undefined,
    members: readonly EntityCandidate[],
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<void> {
    const keys = candidate.attributes
      .filter((attribute) => target.identityAttributeIds.includes(attribute.attributeId) && attribute.value === value)
      .map((attribute) => attribute.attributeId)
    if (candidate.nativeId !== undefined && candidate.nativeId !== value) {
      throw new IdentityDecisionError('IDENTITY_CONFLICT', 'the claimed native id conflicts with the candidate native id')
    }
    if (keys.length === 0 && candidate.nativeId !== value) {
      throw new IdentityDecisionError('IDENTITY_EVIDENCE_REQUIRED', 'the claimed native id is absent from the candidate identity keys')
    }
    const previous = expectedRevision === undefined || expectedRevision === '0'
      ? undefined
      : await this.#deps.store.getDecision(scopeRef, candidate.candidateId, expectedRevision, ctx)
    if (previous?.kind === 'create_pending' && previous.targetEntityId === targetEntityId) return

    let matched = false
    for (const member of members) {
      for (const key of keys) {
        for (const attribute of member.attributes) {
          if (attribute.attributeId !== key) continue
          if (attribute.value === value) matched = true
        }
      }
      if (keys.length === 0 && candidate.nativeId === value && member.nativeId !== undefined) {
        if (member.nativeId === value) matched = true
      }
    }
    if (matched) return
    throw new IdentityDecisionError('IDENTITY_EVIDENCE_REQUIRED', 'the target entity has no confirmed member with the same native identity key')
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
      throw new IdentityDecisionError('IDENTITY_SCOPE_MISMATCH', 'cannot-link target belongs to another object or identity scope')
    }
    const open = await this.#deps.store.listAssertions(scopeRef, { candidateId: base.candidateId, openOnly: true }, ctx)
    if (open.some((assertion) => assertion.entityId === targetEntityId)) {
      throw new IdentityDecisionError('IDENTITY_CONFLICT', 'split the active membership before recording a cannot-link to the same entity')
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
      linkConstraint: constraint,
      expectedEntityRevision: entity.revision,
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
    const separatedCandidateIds = request.separatedCandidateIds ?? [candidate.candidateId]
    if (separatedCandidateIds.length === 0) {
      throw new IdentityDecisionError('INVALID_ARGUMENT', 'a split requires at least one source record to separate')
    }
    const open = await this.#deps.store.listAssertions(scopeRef, { entityId: targetEntityId, openOnly: true }, ctx)
    const separated = new Set(separatedCandidateIds)
    const closeAssertions = open
      .filter((assertion) => separated.has(assertion.candidateId))
      .map((assertion) => ({ assertionId: assertion.assertionId, validTo: base.recordedAt }))
    if (closeAssertions.length === 0) {
      throw new IdentityDecisionError(
        'IDENTITY_CONFLICT',
        `none of the requested source records are currently asserted to entity ${targetEntityId}`,
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
      closeAssertions,
      expectedEntityRevision: entity.revision,
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

  #nativeIdentityOf(candidate: EntityCandidate): IdentityDecisionDraft['strongIdentity'] {
    if (candidate.nativeId !== undefined && candidate.nativeId.length > 0) {
      return { kind: 'native_id', value: candidate.nativeId }
    }
    return undefined
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
