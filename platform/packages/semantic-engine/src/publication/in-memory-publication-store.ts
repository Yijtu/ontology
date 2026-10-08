import { SemanticPublicationStoreError, isToolContext } from '@ontology/contracts'
import type {
  AppendCandidateReviewInput,
  CandidateReviewRecord,
  MaterializationStore,
  NewOutboxMessage,
  PublicationMaterializationFence,
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  PublicationPublishResult,
  PublishSemanticPublicationInput,
  RevisionString,
  ReviseStatementInput,
  ScopeRef,
  SemanticPublicationStore,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new SemanticPublicationStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SemanticPublicationStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new SemanticPublicationStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

interface ScopeState {
  publicationHead: number
  readRevision: bigint
  readonly publications: Map<Uuid, SemanticPublicationVersion>
  readonly idempotency: Map<string, { readonly digest: string; readonly publicationId: Uuid }>
  readonly reviewHeads: Map<Uuid, number>
  readonly reviews: Map<Uuid, CandidateReviewRecord[]>
  readonly statements: Map<Uuid, PublishedStatement>
  readonly revisions: Map<Uuid, StatementRevisionRecord[]>
  readonly ruleVersions: PublishedRuleVersion[]
  readonly blockedIdentity: Set<string>
  readonly outbox: NewOutboxMessage[]
  readonly fences: PublicationMaterializationFence[]
}

function emptyState(): ScopeState {
  return {
    publicationHead: 0,
    readRevision: 0n,
    publications: new Map(),
    idempotency: new Map(),
    reviewHeads: new Map(),
    reviews: new Map(),
    statements: new Map(),
    revisions: new Map(),
    ruleVersions: [],
    blockedIdentity: new Set(),
    outbox: [],
    fences: [],
  }
}

export interface InMemorySemanticPublicationStoreOptions {
  readonly ruleProjectGuard?: (scope: ScopeRef, input: PublishSemanticPublicationInput, ctx: ToolContext) => Promise<void>
  /**
   * When supplied, the fences carried by a publication/revision are opened through it, so the
   * reference composition observes the same atomic fence-before-advance behaviour as the
   * database store (LOCAL-070).
   */
  readonly materialization?: MaterializationStore
}

/**
 * Reference publication store for unit tests and local composition. It enforces the same
 * invariants as the database implementation — tenant/space scoping, compare-and-swap on the
 * publication and review heads, one-transaction publication, idempotent replay and
 * append-only statement history — so the service is exercised against the real rules, not a
 * permissive fake.
 */
export class InMemorySemanticPublicationStore implements SemanticPublicationStore {
  readonly #scopes = new Map<string, ScopeState>()
  readonly #materialization: MaterializationStore | undefined
  readonly #ruleProjectGuard: InMemorySemanticPublicationStoreOptions['ruleProjectGuard']

  constructor(options?: InMemorySemanticPublicationStoreOptions) {
    this.#materialization = options?.materialization
    this.#ruleProjectGuard = options?.ruleProjectGuard
  }

  #state(scopeRef: ScopeRef): ScopeState {
    const key = scopeKey(scopeRef)
    const existing = this.#scopes.get(key)
    if (existing !== undefined) return existing
    const created = emptyState()
    this.#scopes.set(key, created)
    return created
  }

  /** Test seam: make the transaction refuse a candidate→entity binding. */
  blockIdentity(scopeRef: ScopeRef, candidateId: Uuid, entityId: string): void {
    this.#state(scopeRef).blockedIdentity.add(`${candidateId}\u0000${entityId}`)
  }

  /** Test seam: the outbox messages written by `publish`/`reviseStatement`. */
  outboxMessages(scopeRef: ScopeRef): readonly NewOutboxMessage[] {
    return [...this.#state(scopeRef).outbox]
  }

  /** Test seam: the invalidation fences committed by `publish`/`reviseStatement`. */
  materializationFences(scopeRef: ScopeRef): readonly PublicationMaterializationFence[] {
    return [...this.#state(scopeRef).fences]
  }

  async #openFences(
    scopeRef: ScopeRef,
    fences: readonly PublicationMaterializationFence[],
    ctx: ToolContext,
  ): Promise<void> {
    const state = this.#state(scopeRef)
    for (const fence of fences) {
      state.fences.push(clone(fence))
      await this.#materialization?.openFence(
        scopeRef,
        {
          fenceId: fence.fenceId,
          reason: fence.reason,
          propositionKeys: fence.propositionKeys,
          openedAt: fence.openedAt,
        },
        ctx,
      )
    }
  }

  async latestReviewRevision(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<RevisionString> {
    resolveScope(scopeRef, ctx)
    return String(this.#state(scopeRef).reviewHeads.get(candidateId) ?? 0)
  }

  async appendReview(
    scopeRef: ScopeRef,
    input: AppendCandidateReviewInput,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    const head = state.reviewHeads.get(input.draft.candidateId) ?? 0
    if (String(head) !== input.expectedRevision) {
      throw new SemanticPublicationStoreError(
        'REVISION_CONFLICT',
        `candidate ${input.draft.candidateId} is at review revision ${String(head)}, not ${input.expectedRevision}`,
      )
    }
    const revisionNumber = head + 1
    const record: CandidateReviewRecord = {
      ...input.draft,
      revision: String(revisionNumber),
      ...(revisionNumber === 1 ? {} : { supersedesRevision: String(head) }),
    }
    const history = state.reviews.get(record.candidateId) ?? []
    history.push(clone(record))
    state.reviews.set(record.candidateId, history)
    state.reviewHeads.set(record.candidateId, revisionNumber)
    return clone(record)
  }

  async getReview(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const record = (this.#state(scopeRef).reviews.get(candidateId) ?? []).find(
      (entry) => entry.revision === revision,
    )
    return record === undefined ? undefined : clone(record)
  }

  async listReviews(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord[]> {
    resolveScope(scopeRef, ctx)
    const history = this.#state(scopeRef).reviews.get(candidateId) ?? []
    return [...history].sort((left, right) => Number(left.revision) - Number(right.revision)).map(clone)
  }

  async latestPublicationRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    resolveScope(scopeRef, ctx)
    return String(this.#state(scopeRef).publicationHead)
  }

  async latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    resolveScope(scopeRef, ctx)
    return this.#state(scopeRef).readRevision.toString()
  }

  async publish(
    scopeRef: ScopeRef,
    input: PublishSemanticPublicationInput,
    ctx: ToolContext,
  ): Promise<PublicationPublishResult> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    const replayed = state.idempotency.get(input.idempotencyKey)
    if (replayed !== undefined) {
      if (replayed.digest !== input.requestDigest) {
        throw new SemanticPublicationStoreError(
          'IDEMPOTENCY_CONFLICT',
          `the idempotency key was already used with a different publication payload`,
        )
      }
      const existing = state.publications.get(replayed.publicationId)
      if (existing === undefined) {
        throw new SemanticPublicationStoreError(
          'PUBLICATION_STORE_FAILED',
          'the idempotency record has no publication',
        )
      }
      return { publication: clone(existing), created: false }
    }
    if (input.publication.ruleVersions.some((rule) => rule.projectId !== undefined)) {
      if (this.#ruleProjectGuard === undefined) throw new SemanticPublicationStoreError('IDENTITY_CONSTRAINT_BLOCKED', 'project-tagged rules require an atomic project commit guard')
      await this.#ruleProjectGuard(scopeRef, input, ctx)
    }
    if (String(state.publicationHead) !== input.expectedRevision) {
      throw new SemanticPublicationStoreError(
        'REVISION_CONFLICT',
        `the publication head is at revision ${String(state.publicationHead)}, not ${input.expectedRevision}`,
      )
    }
    for (const binding of input.identityBindings) {
      if (state.blockedIdentity.has(`${binding.candidateId}\u0000${binding.entityId}`)) {
        throw new SemanticPublicationStoreError(
          'IDENTITY_CONSTRAINT_BLOCKED',
          `candidate ${binding.candidateId} is cannot-linked with entity ${binding.entityId}`,
        )
      }
    }

    const revisionNumber = state.publicationHead + 1
    const publication: SemanticPublicationVersion = {
      ...input.publication,
      revision: String(revisionNumber),
    }
    for (const statement of publication.statements) {
      if (!state.statements.has(statement.statementId)) {
        state.statements.set(statement.statementId, clone(statement))
      }
    }
    for (const rule of publication.ruleVersions) {
      const version = state.ruleVersions.filter((entry) => entry.ruleId === rule.ruleId).length + 1
      state.ruleVersions.push(clone({ ...rule, version: String(version) }))
    }
    state.publications.set(publication.publicationId, clone(publication))
    state.idempotency.set(input.idempotencyKey, {
      digest: input.requestDigest,
      publicationId: publication.publicationId,
    })
    state.publicationHead = revisionNumber
    state.readRevision += 1n
    state.outbox.push(clone(input.outbox))
    await this.#openFences(scopeRef, input.materializationFences ?? [], ctx)
    return { publication: clone(publication), created: true }
  }

  async getPublication(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const publication = this.#state(scopeRef).publications.get(publicationId)
    return publication === undefined ? undefined : clone(publication)
  }

  async listPublications(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#state(scopeRef).publications.values()]
      .sort((left, right) => Number(left.revision) - Number(right.revision))
      .slice(0, limit)
      .map(clone)
  }

  async getStatement(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<PublishedStatement | undefined> {
    resolveScope(scopeRef, ctx)
    const statement = this.#state(scopeRef).statements.get(statementId)
    return statement === undefined ? undefined : clone(statement)
  }

  async listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilter,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#state(scopeRef).statements.values()]
    if (filter.propositionKey !== undefined) {
      records = records.filter((record) => record.propositionKey === filter.propositionKey)
    }
    if (filter.objectId !== undefined) records = records.filter((record) => record.objectId === filter.objectId)
    if (filter.sourceCandidateId !== undefined) {
      records = records.filter((record) => record.sourceCandidateId === filter.sourceCandidateId)
    }
    if (filter.publicationId !== undefined) {
      records = records.filter((record) => record.publicationId === filter.publicationId)
    }
    if (filter.status !== undefined) records = records.filter((record) => record.status === filter.status)
    if (filter.afterStatementId !== undefined) {
      records = records.filter((record) => record.statementId > (filter.afterStatementId ?? ''))
    }
    records.sort((left, right) => (left.statementId < right.statementId ? -1 : 1))
    return records.slice(0, filter.limit ?? records.length).map(clone)
  }

  async listRuleVersions(
    scopeRef: ScopeRef,
    filter: PublishedRuleFilter,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]> {
    resolveScope(scopeRef, ctx)
    let records = [...this.#state(scopeRef).ruleVersions]
    if (filter.objectId !== undefined) records = records.filter((record) => record.objectId === filter.objectId)
    if (filter.sourceCandidateId !== undefined) {
      records = records.filter((record) => record.sourceCandidateId === filter.sourceCandidateId)
    }
    if (filter.publicationId !== undefined) {
      records = records.filter((record) => record.publicationId === filter.publicationId)
    }
    const afterRule = filter.afterRule
    if (afterRule !== undefined) {
      const afterVersion = BigInt(afterRule.version)
      records = records.filter((record) => record.ruleId > afterRule.ruleId ||
        (record.ruleId === afterRule.ruleId && BigInt(record.version) > afterVersion))
    }
    records.sort((left, right) => {
      if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1
      const leftVersion = BigInt(left.version)
      const rightVersion = BigInt(right.version)
      return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0
    })
    return records.slice(0, filter.limit ?? records.length).map(clone)
  }

  async reviseStatement(
    scopeRef: ScopeRef,
    input: ReviseStatementInput,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    const statement = state.statements.get(input.statementId)
    if (statement === undefined) {
      throw new SemanticPublicationStoreError(
        'STATEMENT_NOT_FOUND',
        `statement ${input.statementId} is not visible in this scope`,
      )
    }
    if (statement.version !== input.expectedRevision) {
      throw new SemanticPublicationStoreError(
        'REVISION_CONFLICT',
        `statement ${input.statementId} is at version ${statement.version}, not ${input.expectedRevision}`,
      )
    }
    const versionNumber = Number(statement.version) + 1
    const record: StatementRevisionRecord = {
      revisionId: input.revisionId,
      statementId: input.statementId,
      version: String(versionNumber),
      kind: input.kind,
      reason: input.reason,
      ...(input.correctedValue === undefined ? {} : { correctedValue: input.correctedValue }),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      recordedAt: input.recordedAt,
      actor: input.actor,
      supersedesVersion: statement.version,
      invalidationOutboxId: input.outbox.outboxId,
    }
    const history = state.revisions.get(input.statementId) ?? []
    history.push(clone(record))
    state.revisions.set(input.statementId, history)
    state.statements.set(input.statementId, {
      ...statement,
      version: String(versionNumber),
      status: input.kind === 'retraction' ? 'retracted' : 'active',
      ...(input.correctedValue === undefined ? {} : { value: input.correctedValue }),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    })
    state.readRevision += 1n
    state.outbox.push(clone(input.outbox))
    await this.#openFences(scopeRef, input.materializationFences ?? [], ctx)
    return clone(record)
  }

  async getStatementRevision(
    scopeRef: ScopeRef,
    statementId: Uuid,
    version: RevisionString,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const record = (this.#state(scopeRef).revisions.get(statementId) ?? []).find(
      (entry) => entry.version === version,
    )
    return record === undefined ? undefined : clone(record)
  }

  async listStatementRevisions(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord[]> {
    resolveScope(scopeRef, ctx)
    const history = this.#state(scopeRef).revisions.get(statementId) ?? []
    return [...history].sort((left, right) => Number(left.version) - Number(right.version)).map(clone)
  }
}
