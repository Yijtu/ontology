import { isToolContext, ReviewableCandidateReadError } from '@ontology/contracts'
import type {
  AppendCandidateReviewInput,
  CandidateRecord,
  CandidateReviewDraft,
  CandidateReviewRecord,
  CandidateReviewRequest,
  EntityCandidate,
  IndustrySchema,
  NewOutboxMessage,
  PropositionView,
  PublicationCandidateRef,
  PublicationIdentityBinding,
  PublicationMaterializationFence,
  ProjectFactPublicationFence,
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  PublishSemanticPublicationInput,
  RevisionString,
  ReviseStatementInput,
  ScopeRef,
  SemanticPublicationRequest,
  SemanticPublicationStore,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  StatementRevisionRequest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { SemanticPublicationStoreError, assertProjectFactInputShape, assertRuleDependencyShape, candidateSourceRef } from '@ontology/contracts'
import { validateRuleConclusionBinding } from '@ontology/core'
import { sha256DigestOf } from '../definitions/canonical'
import { SemanticPublicationError } from './errors'
import type { PublicationRejectionReason } from './errors'
import type { SemanticPublicationServiceDependencies } from './types'
import { publishedRuleRef } from '../rules/dependencies'

const REVIEWER_ROLES: readonly string[] = ['semantic-reviewer', 'platform-admin']
const PUBLISHER_ROLES: readonly string[] = ['semantic-publisher', 'platform-admin']
const DEFAULT_PAGE = 1_000

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new SemanticPublicationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SemanticPublicationError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (roles.some((role) => ctx.principal.roles.includes(role))) return
  throw new SemanticPublicationError('FORBIDDEN', `${action} requires one of the roles: ${roles.join(', ')}`)
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

function sortedAttributes(candidate: EntityCandidate): readonly EntityCandidate['attributes'][number][] {
  return [...candidate.attributes].sort((left, right) => (left.attributeId < right.attributeId ? -1 : 1))
}

function issueReasons(candidate: CandidateRecord): readonly PublicationRejectionReason[] {
  return candidate.issues.map((issue) => ({
    candidateId: candidate.candidateId,
    code: issue.code,
    message: issue.message,
  }))
}

/**
 * The semantic publication service (SPEC D4.6/D5/D6, C6, US-011/US-012/US-015).
 *
 * It owns the only transition from an approved candidate to a versioned fact or rule. A
 * candidate is loaded from the candidate store (never trusted from the request body), its
 * review is read back, its identity binding is resolved from the decision store, and then
 * the whole publication — facts, rules, identity checks and the outbox event — is committed
 * by the injected store in one transaction.
 *
 * It never recalls candidates, never evaluates rules and never materialises a projection;
 * those are later nodes. A revision preserves history and emits its downstream invalidation
 * through the real transactional outbox, so a conclusion supported by another active
 * statement is not deleted (INV-06).
 */
export class SemanticPublicationService {
  readonly #store: SemanticPublicationStore
  readonly #candidates: SemanticPublicationServiceDependencies['candidates']
  readonly #schemaSource: SemanticPublicationServiceDependencies['schemaSource']
  readonly #identity: SemanticPublicationServiceDependencies['identity']
  readonly #instanceRecords: SemanticPublicationServiceDependencies['instanceRecords']
  readonly #reviewableCandidates: SemanticPublicationServiceDependencies['reviewableCandidates']
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: SemanticPublicationServiceDependencies) {
    this.#store = dependencies.store
    this.#candidates = dependencies.candidates
    this.#schemaSource = dependencies.schemaSource
    this.#identity = dependencies.identity
    this.#instanceRecords = dependencies.instanceRecords
    this.#reviewableCandidates = dependencies.reviewableCandidates
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** `POST /candidates/{id}/reviews`: approve or reject one candidate. */
  async reviewCandidate(request: CandidateReviewRequest, ctx: ToolContext): Promise<CandidateReviewRecord> {
    const scopeRef = scopeOf(ctx)
    assertRole(ctx, REVIEWER_ROLES, 'reviewing a candidate')
    if (request.expectedRevision === undefined) {
      throw new SemanticPublicationError('REVISION_REQUIRED', 'this review requires an If-Match expected revision')
    }
    if (!nonEmpty(request.reason)) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'a review requires a reason')
    }
    // A TBox candidate is reviewed through exactly this store/route; the reader only proves the
    // candidate is visible (instance OR definition) in the scope. No second decision table.
    let contentDigest: CandidateReviewRecord['contentDigest']
    if (this.#reviewableCandidates === undefined) {
      const candidate = await this.#requireCandidate(scopeRef, request.candidateId, ctx)
      if (candidate.inputVersion.projectFact !== undefined) contentDigest = candidate.idempotencyKey
    } else {
      const view = await this.#reviewableCandidates.readCandidate(scopeRef, request.candidateId, ctx).catch((error: unknown) => {
        if (error instanceof ReviewableCandidateReadError) throw new SemanticPublicationError('CANDIDATE_DOMAIN_UNPUBLISHABLE', error.message, { cause: error })
        throw error
      })
      if (view === undefined) {
        throw new SemanticPublicationError(
          'CANDIDATE_NOT_FOUND',
          `candidate ${request.candidateId} is not visible in this scope`,
        )
      }
      contentDigest = view.contentDigest
    }
    const draft: CandidateReviewDraft = {
      reviewId: this.#newId(),
      candidateId: request.candidateId,
      decision: request.decision,
      reason: request.reason,
      evidenceRefs: request.evidenceRefs ?? [],
      recordedAt: this.#now(),
      actor: ctx.principal.subjectId,
      ...(contentDigest === undefined ? {} : { contentDigest }),
    }
    const input: AppendCandidateReviewInput = { expectedRevision: request.expectedRevision, draft }
    return this.#mapStoreError(() => this.#store.appendReview(scopeRef, input, ctx))
  }

  async listReviews(candidateId: Uuid, ctx: ToolContext): Promise<CandidateReviewRecord[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listReviews(scopeRef, candidateId, ctx)
  }

  async getReview(candidateId: Uuid, revision: RevisionString, ctx: ToolContext): Promise<CandidateReviewRecord> {
    const scopeRef = scopeOf(ctx)
    const record = await this.#store.getReview(scopeRef, candidateId, revision, ctx)
    if (record === undefined) {
      throw new SemanticPublicationError(
        'REVIEW_NOT_FOUND',
        `review revision ${revision} for candidate ${candidateId} is not visible in this scope`,
      )
    }
    return record
  }

  /** `POST /semantic-publications`: publish approved candidates atomically. */
  async publish(request: SemanticPublicationRequest, ctx: ToolContext): Promise<SemanticPublicationVersion> {
    const scopeRef = scopeOf(ctx)
    assertRole(ctx, PUBLISHER_ROLES, 'publishing semantics')
    if (request.expectedRevision === undefined) {
      throw new SemanticPublicationError('REVISION_REQUIRED', 'this publication requires an If-Match expected revision')
    }
    if (!nonEmpty(request.idempotencyKey)) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
    }
    if (request.approvedCandidateRefs.length === 0) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'a publication needs at least one approved candidate')
    }
    const schema = await this.#requireSchema(scopeRef, request.schemaRef, ctx)

    const publicationId = this.#newId()
    const publishedAt = this.#now()
    const approvedCandidateRefs: PublicationCandidateRef[] = []
    const statements: PublishedStatement[] = []
    const ruleVersions: PublishedRuleVersion[] = []
    const identityBindings: PublicationIdentityBinding[] = []
    const projectFactFences: ProjectFactPublicationFence[] = []
    let outboxJobId: Uuid | undefined

    for (const ref of request.approvedCandidateRefs) {
      if (this.#reviewableCandidates !== undefined) {
        const view = await this.#reviewableCandidates.readCandidate(scopeRef, ref.candidateId, ctx)
        if (view !== undefined && view.domain === 'definition') {
          throw new SemanticPublicationError(
            'CANDIDATE_DOMAIN_UNPUBLISHABLE',
            `candidate ${ref.candidateId} is a definition candidate and was not published as a fact or rule`,
            { reasons: [{ candidateId: ref.candidateId, code: 'DEFINITION_DOMAIN', message: 'definition candidates publish through the definition publication flow' }] },
          )
        }
      }
      const candidate = await this.#requireCandidate(scopeRef, ref.candidateId, ctx)
      if (candidate.kind !== ref.kind) {
        throw new SemanticPublicationError(
          'INVALID_ARGUMENT',
          `candidate ${ref.candidateId} is a ${candidate.kind} candidate, not a ${ref.kind}`,
        )
      }
      await this.#requireApproved(scopeRef, candidate, ctx)
      this.#assertSource(candidate)
      this.#assertSchemaPin(candidate, request.schemaRef)
      const mapped = await this.#mappedFences(scopeRef, candidate, ctx)
      projectFactFences.push(...mapped)
      for (const fence of mapped) identityBindings.push({ candidateId: fence.source.entityCandidateId, entityId: fence.entityId })
      outboxJobId ??= candidate.jobId

      if (candidate.kind === 'entity') {
        const binding = await this.#resolveIdentity(scopeRef, candidate, ctx)
        identityBindings.push(binding)
        statements.push(this.#statementOfEntity(candidate, binding.entityId, publicationId, publishedAt))
      } else if (candidate.kind === 'relation') {
        statements.push(this.#statementOfRelation(candidate, publicationId, publishedAt, mapped))
      } else if (candidate.kind === 'rule') {
        await this.#assertRuleDependencies(scopeRef, candidate, request.schemaRef, ctx)
        if (candidate.conflicts.length > 0) {
          throw new SemanticPublicationError(
            'CANDIDATE_CONFLICTED',
            `rule candidate ${candidate.candidateId} has unresolved conflicts and was not published`,
            {
              reasons: candidate.conflicts.map((conflict) => ({
                candidateId: candidate.candidateId,
                code: 'CONFLICTING_RULE',
                message: conflict.reason,
              })),
            },
          )
        }
        const conclusion = candidate.conclusion === undefined
          ? undefined
          : validateRuleConclusionBinding(candidate.conclusion, candidate.objectId, schema)
        if (conclusion?.reason !== undefined) {
          throw new SemanticPublicationError(
            'CANDIDATE_FAILED',
            `rule candidate ${candidate.candidateId} has an invalid business conclusion binding`,
            { reasons: [{ candidateId: candidate.candidateId, code: 'INVALID_RULE_CONCLUSION', message: conclusion.reason }] },
          )
        }
        ruleVersions.push(this.#ruleVersionOf(
          candidate,
          publicationId,
          publishedAt,
          conclusion?.binding,
        ))
      } else {
        throw new SemanticPublicationError(
          'CANDIDATE_UNREPRESENTABLE',
          `rule candidate ${candidate.candidateId} could not be represented faithfully and was not published`,
          {
            reasons: [
              {
                candidateId: candidate.candidateId,
                code: candidate.reason,
                message: candidate.detail,
              },
            ],
          },
        )
      }
      approvedCandidateRefs.push({ candidateId: candidate.candidateId, kind: candidate.kind })
    }

    if (outboxJobId === undefined) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'a publication needs at least one approved candidate')
    }

    // The invalidation fences are committed with the publication and its outbox event, so the
    // window between the publish commit and the worker consuming the event cannot serve a stale
    // conclusion (SPEC D5.1, ADR-13, LOCAL-070). The affected fan-out is not enumerated here, so
    // each fence conservatively covers the scope; the worker only advances afterwards.
    const materializationFences: PublicationMaterializationFence[] = [
      ...statements.map((statement) =>
        this.#fenceFor(statement.statementId, 'assertion_published', publishedAt),
      ),
      ...ruleVersions.map((rule) => this.#fenceFor(rule.ruleVersionId, 'rule_changed', publishedAt)),
    ]

    const contentDigest = sha256DigestOf({ schemaRef: request.schemaRef, statements, ruleVersions })
    const versionRef: VersionRef = { id: publicationId, version: '1.0.0', digest: contentDigest }
    const outbox: NewOutboxMessage = {
      outboxId: this.#newId(),
      topic: 'semantic.publication.published',
      payload: {
        publicationId,
        versionRef,
        schemaRef: request.schemaRef,
        statementIds: statements.map((statement) => statement.statementId),
        ruleVersionIds: ruleVersions.map((rule) => rule.ruleVersionId),
        approvedCandidateRefs,
        materializationFences: materializationFences.map((fence) => ({
          changeId: fence.changeId,
          fenceId: fence.fenceId,
        })),
      },
      idempotencyKey: `semantic-publication:${publicationId}`,
      availableAt: publishedAt,
      createdAt: publishedAt,
    }
    const requestDigest = sha256DigestOf({
      schemaRef: request.schemaRef,
      approvedCandidateRefs: [...request.approvedCandidateRefs].sort((left, right) =>
        left.candidateId < right.candidateId ? -1 : 1,
      ),
    })
    const input: PublishSemanticPublicationInput = {
      expectedRevision: request.expectedRevision,
      publication: {
        publicationId,
        versionRef,
        schemaRef: request.schemaRef,
        approvedCandidateRefs,
        statements,
        ruleVersions,
        outboxId: outbox.outboxId,
        publishedAt,
        actor: ctx.principal.subjectId,
      },
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      identityBindings,
      outbox,
      outboxJobId,
      materializationFences,
      projectFactFences,
    }
    const result = await this.#mapStoreError(() => this.#store.publish(scopeRef, input, ctx))
    return result.publication
  }

  async getPublication(publicationId: Uuid, ctx: ToolContext): Promise<SemanticPublicationVersion> {
    const scopeRef = scopeOf(ctx)
    const publication = await this.#store.getPublication(scopeRef, publicationId, ctx)
    if (publication === undefined) {
      throw new SemanticPublicationError(
        'PUBLICATION_NOT_FOUND',
        `publication ${publicationId} is not visible in this scope`,
      )
    }
    return publication
  }

  async listPublications(limit: number | undefined, ctx: ToolContext): Promise<SemanticPublicationVersion[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listPublications(scopeRef, limit ?? DEFAULT_PAGE, ctx)
  }

  /** The official read view. It reads only published statements, never candidates. */
  async listStatements(filter: PublishedStatementFilter, ctx: ToolContext): Promise<PublishedStatement[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listStatements(scopeRef, { ...filter, status: filter.status ?? 'active' }, ctx)
  }

  async listRuleVersions(filter: PublishedRuleFilter, ctx: ToolContext): Promise<PublishedRuleVersion[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listRuleVersions(scopeRef, filter, ctx)
  }

  async getStatement(statementId: Uuid, ctx: ToolContext): Promise<PublishedStatement> {
    const scopeRef = scopeOf(ctx)
    const statement = await this.#store.getStatement(scopeRef, statementId, ctx)
    if (statement === undefined) {
      throw new SemanticPublicationError(
        'STATEMENT_NOT_FOUND',
        `statement ${statementId} is not visible in this scope`,
      )
    }
    return statement
  }

  /**
   * The proposition-level read view. A retraction of one statement leaves the proposition
   * `supported` while another active statement still asserts it (INV-06).
   */
  async getPropositionView(propositionKey: string, ctx: ToolContext): Promise<PropositionView> {
    const scopeRef = scopeOf(ctx)
    const statements = await this.#store.listStatements(scopeRef, { propositionKey, limit: DEFAULT_PAGE }, ctx)
    const activeStatements = statements.filter((statement) => statement.status === 'active')
    return {
      propositionKey,
      status: activeStatements.length > 0 ? 'supported' : 'withdrawn',
      activeStatements,
      statements,
    }
  }

  /** `POST /statements/{id}/revisions`: append a correction or retraction, preserving history. */
  async reviseStatement(request: StatementRevisionRequest, ctx: ToolContext): Promise<StatementRevisionRecord> {
    const scopeRef = scopeOf(ctx)
    assertRole(ctx, PUBLISHER_ROLES, 'revising a statement')
    if (request.expectedRevision === undefined) {
      throw new SemanticPublicationError('REVISION_REQUIRED', 'this revision requires an If-Match expected revision')
    }
    if (!nonEmpty(request.idempotencyKey)) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
    }
    if (!nonEmpty(request.reason)) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'a revision requires a reason')
    }
    const statement = await this.getStatement(request.statementId, ctx)
    if (statement.status === 'retracted') {
      throw new SemanticPublicationError(
        'STATEMENT_RETRACTED',
        `statement ${request.statementId} is already retracted and cannot be revised again`,
      )
    }
    const recordedAt = this.#now()
    const revisionId = this.#newId()
    const topic =
      request.kind === 'retraction' ? 'semantic.statement.retracted' : 'semantic.statement.corrected'
    // A correction or retraction invalidates the affected conclusions just like a publication:
    // the fence is committed with the revision and its outbox event (SPEC D5.1, LOCAL-070).
    const materializationFences: PublicationMaterializationFence[] = [
      this.#fenceFor(
        revisionId,
        request.kind === 'retraction' ? 'assertion_retracted' : 'assertion_corrected',
        recordedAt,
      ),
    ]
    const outbox: NewOutboxMessage = {
      outboxId: this.#newId(),
      topic,
      payload: {
        statementId: statement.statementId,
        propositionKey: statement.propositionKey,
        kind: request.kind,
        reason: request.reason,
        supersedesVersion: statement.version,
        revisionId,
        materializationFences: materializationFences.map((fence) => ({
          changeId: fence.changeId,
          fenceId: fence.fenceId,
        })),
      },
      idempotencyKey: `statement-revision:${revisionId}`,
      availableAt: recordedAt,
      createdAt: recordedAt,
    }
    const input: ReviseStatementInput = {
      expectedRevision: request.expectedRevision,
      revisionId,
      statementId: statement.statementId,
      kind: request.kind,
      reason: request.reason,
      ...(request.correctedValue === undefined ? {} : { correctedValue: request.correctedValue }),
      ...(request.validFrom === undefined ? {} : { validFrom: request.validFrom }),
      ...(request.validTo === undefined ? {} : { validTo: request.validTo }),
      recordedAt,
      actor: ctx.principal.subjectId,
      outbox,
      materializationFences,
    }
    return this.#mapStoreError(() => this.#store.reviseStatement(scopeRef, input, ctx))
  }

  async listStatementRevisions(statementId: Uuid, ctx: ToolContext): Promise<StatementRevisionRecord[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listStatementRevisions(scopeRef, statementId, ctx)
  }

  async getStatementRevision(
    statementId: Uuid,
    version: RevisionString,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord> {
    const scopeRef = scopeOf(ctx)
    const record = await this.#store.getStatementRevision(scopeRef, statementId, version, ctx)
    if (record === undefined) {
      throw new SemanticPublicationError(
        'STATEMENT_NOT_FOUND',
        `revision ${version} of statement ${statementId} is not visible in this scope`,
      )
    }
    return record
  }

  async #requireCandidate(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<CandidateRecord> {
    const candidate = await this.#candidates.getCandidate(scopeRef, candidateId, ctx)
    if (candidate === undefined) {
      throw new SemanticPublicationError(
        'CANDIDATE_NOT_FOUND',
        `candidate ${candidateId} is not visible in this scope`,
      )
    }
    return candidate
  }

  async #requireSchema(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<IndustrySchema> {
    const schema = await this.#schemaSource.getSchema(scopeRef, ref, ctx)
    if (schema === undefined) {
      throw new SemanticPublicationError(
        'DEFINITION_NOT_VISIBLE',
        `definition ${ref.id}@${ref.version} is not visible in this scope`,
      )
    }
    return schema
  }

  /**
   * A candidate may be published only when it validated into `pending_review` and a reviewer
   * approved it. A failed, rejected, still-produced or unapproved candidate is refused with a
   * specific reason; the candidate itself is never modified.
   */
  async #requireApproved(scopeRef: ScopeRef, candidate: CandidateRecord, ctx: ToolContext): Promise<void> {
    if (candidate.state === 'failed') {
      throw new SemanticPublicationError(
        'CANDIDATE_FAILED',
        `candidate ${candidate.candidateId} failed validation and cannot be published`,
        { reasons: issueReasons(candidate) },
      )
    }
    if (candidate.state === 'rejected') {
      throw new SemanticPublicationError(
        'CANDIDATE_REJECTED',
        `candidate ${candidate.candidateId} was rejected and cannot be published`,
      )
    }
    if (candidate.state !== 'pending_review') {
      throw new SemanticPublicationError(
        'CANDIDATE_NOT_APPROVED',
        `candidate ${candidate.candidateId} is in state ${candidate.state} and is not ready for publication`,
      )
    }
    const reviews = await this.#store.listReviews(scopeRef, candidate.candidateId, ctx)
    const latest = reviews[reviews.length - 1]
    if (latest === undefined) {
      throw new SemanticPublicationError(
        'CANDIDATE_NOT_APPROVED',
        `candidate ${candidate.candidateId} has no review decision and was not approved`,
      )
    }
    if (latest.decision !== 'approve') {
      throw new SemanticPublicationError(
        'CANDIDATE_REJECTED',
        `candidate ${candidate.candidateId} was rejected by review ${latest.reviewId}: ${latest.reason}`,
      )
    }
    if (candidate.inputVersion.projectFact !== undefined && latest.contentDigest !== candidate.idempotencyKey) {
      throw new SemanticPublicationError('CANDIDATE_NOT_APPROVED', 'mapped facts require approval of the exact stored candidate content')
    }
  }

  async #mappedFences(scopeRef: ScopeRef, candidate: CandidateRecord, ctx: ToolContext): Promise<ProjectFactPublicationFence[]> {
    const mapped = candidate.inputVersion.projectFact
    if (mapped === undefined) return []
    assertProjectFactInputShape(mapped)
    const projectId = mapped.sources[0]?.projectRevisionRef.projectId
    if ((candidate.kind === 'entity' && (mapped.sources.length !== 1 || mapped.sources[0]?.entityCandidateId !== candidate.candidateId)) ||
      (candidate.kind === 'relation' && (mapped.sources.length !== 2 || mapped.sources[0]?.entityCandidateId !== candidate.from.candidateId || mapped.sources[1]?.entityCandidateId !== candidate.to.candidateId)) ||
      (candidate.kind !== 'entity' && candidate.kind !== 'relation') ||
      mapped.sources.some((source) => source.projectRevisionRef.projectId !== projectId || !sameRef(source.definitionRef, candidate.inputVersion.definitionRef))) {
      throw new SemanticPublicationError('CANDIDATE_NOT_APPROVED', 'mapped source pins must describe this entity or both same-project relation endpoints')
    }
    if (this.#instanceRecords === undefined || mapped.sources.length === 0 || mapped.sources.length > 2) {
      throw new SemanticPublicationError('CANDIDATE_NOT_APPROVED', 'mapped fact publication requires bounded stored human field confirmations')
    }
    const fences: ProjectFactPublicationFence[] = []
    for (const source of mapped.sources) {
      const entityCandidate = await this.#requireCandidate(scopeRef, source.entityCandidateId, ctx)
      const record = await this.#instanceRecords.getRecord(scopeRef, source.projectRevisionRef.projectId, source.entityCandidateId, ctx)
      const binding = record?.identity.binding
      if (entityCandidate.kind !== 'entity' || record === undefined || binding?.candidateId !== entityCandidate.candidateId || binding.documentId !== source.documentId || binding.projectRevisionRef.projectId !== source.projectRevisionRef.projectId ||
        binding.projectRevisionRef.revision !== source.projectRevisionRef.revision || binding.projectRevisionRef.digest !== source.projectRevisionRef.digest ||
        !sameRef(binding.definitionRef, source.definitionRef) || binding.membershipRevision !== source.membershipRevision || binding.visibilityEpoch !== source.visibilityEpoch ||
        (record.identity.state !== 'matched' && record.identity.state !== 'created') || record.identity.matchedEntityId === undefined ||
        record.fields.length !== entityCandidate.attributes.length || record.fields.some((field) => {
          const value = entityCandidate.attributes.find((attribute) => attribute.attributeId === field.fieldId)
          const span = entityCandidate.sourceSpans[entityCandidate.attributes.findIndex((attribute) => attribute.attributeId === field.fieldId)]
          return field.status !== 'confirmed' || field.actor === undefined || field.confirmedAt === undefined || value === undefined ||
            field.rawValue !== value.raw || span?.kind !== 'structured' || field.source.parseId !== span.parseId || field.source.textDigest !== span.rowDigest || sha256DigestOf(field.source.locator) !== sha256DigestOf(span.locator) ||
            (field.normalizedValue?.kind === 'quantity' ? field.normalizedValue.value !== value.value || field.normalizedValue.unitCode !== value.unitCode : field.normalizedValue?.kind !== 'scalar' || field.normalizedValue.value !== value.value)
        })) {
        throw new SemanticPublicationError('CANDIDATE_NOT_APPROVED', 'mapped fields or authoritative human identity are missing, edited or stale')
      }
      const entity = await this.#identity.getEntity(scopeRef, record.identity.matchedEntityId, ctx)
      if (entity?.state !== 'confirmed' || entity.scopeDimensions['project'] !== source.projectRevisionRef.projectId || entity.objectId !== entityCandidate.objectId || entity.identityScopeId !== binding.identityScopeId) {
        throw new SemanticPublicationError('IDENTITY_CONSTRAINT_BLOCKED', 'mapped identity must be confirmed in the same project/domain')
      }
      fences.push({ candidateId: candidate.candidateId, candidateDigest: candidate.idempotencyKey, source, instanceRevision: record.recordRevision, entityId: entity.entityId })
    }
    return fences
  }

  #assertSource(candidate: CandidateRecord): void {
    if (candidate.sourceSpans.length === 0) {
      throw new SemanticPublicationError(
        'MISSING_SOURCE',
        `candidate ${candidate.candidateId} carries no source span and cannot be published`,
      )
    }
  }

  #assertSchemaPin(candidate: CandidateRecord, schemaRef: VersionRef): void {
    if (!sameRef(candidate.inputVersion.definitionRef, schemaRef)) {
      throw new SemanticPublicationError(
        'SCHEMA_MISMATCH',
        `candidate ${candidate.candidateId} was extracted against ${candidate.inputVersion.definitionRef.id}@${candidate.inputVersion.definitionRef.version}, not the requested schema`,
      )
    }
  }

  async #resolveIdentity(
    scopeRef: ScopeRef,
    candidate: EntityCandidate,
    ctx: ToolContext,
  ): Promise<PublicationIdentityBinding> {
    const assertions = await this.#identity.listAssertions(
      scopeRef,
      { candidateId: candidate.candidateId, openOnly: true },
      ctx,
    )
    const assertion = assertions[0]
    if (assertion === undefined) {
      throw new SemanticPublicationError(
        'IDENTITY_UNRESOLVED',
        `candidate ${candidate.candidateId} has no open identity assertion and cannot be published as a fact`,
      )
    }
    return { candidateId: candidate.candidateId, entityId: assertion.entityId }
  }

  #statementOfEntity(
    candidate: EntityCandidate,
    entityId: string,
    publicationId: Uuid,
    recordedAt: string,
  ): PublishedStatement {
    const attributes = sortedAttributes(candidate)
    const propositionKey = sha256DigestOf({
      kind: 'entity',
      subjectEntityId: entityId,
      objectId: candidate.objectId,
      ...(candidate.inputVersion.projectFact === undefined ? {} : { definitionRef: candidate.inputVersion.definitionRef }),
      attributes: candidate.inputVersion.projectFact === undefined ? attributes : attributes.map(({ attributeId, value, unitCode }) => ({ attributeId, value, ...(unitCode === undefined ? {} : { unitCode }) })),
    })
    return {
      statementId: candidate.candidateId,
      propositionKey,
      kind: 'entity',
      objectId: candidate.objectId,
      subjectEntityId: entityId,
      predicate: candidate.objectId,
      value: { attributes, ...(candidate.inputVersion.projectFact === undefined ? {} : { provenance: { ...candidate.inputVersion.projectFact, sourceSpans: candidate.sourceSpans } }) },
      ...(candidate.inputVersion.projectFact?.validFrom === undefined ? {} : { validFrom: candidate.inputVersion.projectFact.validFrom }),
      ...(candidate.inputVersion.projectFact?.validTo === undefined ? {} : { validTo: candidate.inputVersion.projectFact.validTo }),
      recordedAt,
      sourceCandidateId: candidate.candidateId,
      sourceRefs: candidate.sourceSpans.map((span) =>
        candidateSourceRef(span, candidate.inputVersion.parserVersion),
      ),
      publicationId,
      version: '1',
      status: 'active',
    }
  }

  #statementOfRelation(
    candidate: CandidateRecord & { readonly kind: 'relation' },
    publicationId: Uuid,
    recordedAt: string,
    mapped: readonly ProjectFactPublicationFence[],
  ): PublishedStatement {
    const propositionKey = sha256DigestOf({
      kind: 'relation',
      relationId: candidate.relationId,
      ...(candidate.inputVersion.projectFact === undefined ? { from: candidate.from, to: candidate.to } : {
        definitionRef: candidate.inputVersion.definitionRef,
        from: { objectId: candidate.from.objectId, entityId: mapped.find((fence) => fence.source.entityCandidateId === candidate.from.candidateId)?.entityId },
        to: { objectId: candidate.to.objectId, entityId: mapped.find((fence) => fence.source.entityCandidateId === candidate.to.candidateId)?.entityId },
      }),
    })
    return {
      statementId: candidate.candidateId,
      propositionKey,
      kind: 'relation',
      relationId: candidate.relationId,
      predicate: candidate.relationId,
      value: { from: candidate.from, to: candidate.to, ...(candidate.inputVersion.projectFact === undefined ? {} : { provenance: { ...candidate.inputVersion.projectFact, sourceSpans: candidate.sourceSpans } }) },
      ...(candidate.inputVersion.projectFact?.validFrom === undefined ? {} : { validFrom: candidate.inputVersion.projectFact.validFrom }),
      ...(candidate.inputVersion.projectFact?.validTo === undefined ? {} : { validTo: candidate.inputVersion.projectFact.validTo }),
      recordedAt,
      sourceCandidateId: candidate.candidateId,
      sourceRefs: candidate.sourceSpans.map((span) =>
        candidateSourceRef(span, candidate.inputVersion.parserVersion),
      ),
      publicationId,
      version: '1',
      status: 'active',
    }
  }

  #ruleVersionOf(
    candidate: CandidateRecord & { readonly kind: 'rule' },
    publicationId: Uuid,
    recordedAt: string,
    conclusion?: PublishedRuleVersion['conclusion'],
  ): PublishedRuleVersion {
    return {
      ruleVersionId: candidate.candidateId,
      ruleId: candidate.ruleId,
      version: '1',
      objectId: candidate.objectId,
      severity: candidate.severity,
      impact: candidate.impact,
      expression: candidate.expression,
      exceptions: candidate.exceptions,
      ...(conclusion === undefined ? {} : { conclusion }),
      ...((candidate.ruleDependencies?.length ?? 0) === 0 ? {} : { ruleDependencies: candidate.ruleDependencies, dependencyRefs: candidate.dependencyRefs }),
      ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
      recordedAt,
      sourceCandidateId: candidate.candidateId,
      publicationId,
    }
  }

  async #assertRuleDependencies(scopeRef: ScopeRef, candidate: CandidateRecord & { readonly kind: 'rule' }, definitionRef: VersionRef, ctx: ToolContext): Promise<void> {
    const refs = candidate.dependencyRefs ?? []
    try { assertRuleDependencyShape(candidate.ruleDependencies ?? [], refs) } catch (error) {
      throw new SemanticPublicationError('CANDIDATE_FAILED', 'every rule dependency needs an exact reviewed version', { cause: error })
    }
    for (const ref of refs) {
      if (ref.scopeRef.tenantId !== scopeRef.tenantId || ref.scopeRef.spaceId !== scopeRef.spaceId || !sameRef(ref.definitionRef, definitionRef) ||
        ref.objectId !== candidate.objectId || ref.projectId !== candidate.projectId || ref.publishedPackRef !== undefined) {
        throw new SemanticPublicationError('CANDIDATE_FAILED', 'rule dependencies must bind the same object, project and definition')
      }
      const versions = await this.#store.listRuleVersions(scopeRef, { sourceCandidateId: ref.ruleRef.id, limit: 1_000 }, ctx)
      if (versions.length === 1_000) throw new SemanticPublicationError('CANDIDATE_FAILED', 'rule dependency version lookup exceeded its bounded page')
      const upstream = versions.find((rule) => rule.ruleVersionId === ref.ruleRef.id && sameRef(publishedRuleRef(rule), ref.ruleRef) &&
        rule.ruleId === ref.ruleId && rule.objectId === ref.objectId && rule.projectId === ref.projectId && rule.conclusion?.predicate === ref.predicate)
      const publication = upstream === undefined ? undefined : await this.#store.getPublication(scopeRef, upstream.publicationId, ctx)
      if (publication === undefined || !sameRef(publication.schemaRef, definitionRef)) throw new SemanticPublicationError('CANDIDATE_FAILED', 'rule dependency does not resolve to its fixed published consequence')
    }
  }

  /**
   * Build one scope-wide invalidation fence for a change committed by the publication
   * transaction. The dependency index is not consulted here: at publication time the affected
   * fan-out has not been enumerated, so the fence conservatively withholds the whole scope until
   * the worker has advanced it (SPEC D5.1, ADR-13).
   */
  #fenceFor(changeId: Uuid, kind: string, openedAt: string): PublicationMaterializationFence {
    return {
      changeId,
      fenceId: this.#newId(),
      reason: `change ${changeId} (${kind})`,
      propositionKeys: [],
      openedAt,
    }
  }

  async #mapStoreError<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof SemanticPublicationStoreError) {
        if (error.code === 'REVISION_CONFLICT') {
          throw new SemanticPublicationError('VERSION_CONFLICT', error.message, { cause: error })
        }
        if (error.code === 'IDEMPOTENCY_CONFLICT') {
          throw new SemanticPublicationError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
        }
        if (error.code === 'IDENTITY_CONSTRAINT_BLOCKED') {
          throw new SemanticPublicationError('IDENTITY_CONSTRAINT_BLOCKED', error.message, { cause: error })
        }
      }
      throw error
    }
  }
}
