import { candidateSourceRef, isToolContext } from '@ontology/contracts'
import type {
  BudgetSettlementStatus,
  CompletenessStatus,
  EntityCandidate,
  IndustryIdentityScopeSchema,
  IndustrySchema,
  ResourceRef,
  ScopeRef,
  SourceSnapshot,
  ToolContext,
  ToolUsage,
} from '@ontology/contracts'
import { normalizeIdentityText } from './canonical'
import { IdentityRecallError } from './errors'
import type {
  EntityCandidateRecallDependencies,
  EntityRecallRequest,
  IdentityCandidate,
  IdentityDocumentContext,
  IdentityIndexEntry,
  IdentityIndexPage,
  IdentityRecallResult,
  IdentitySimilarityInfo,
  RecallStrategy,
} from './types'

export const DEFAULT_RECALL_LIMIT = 10
export const MAX_RECALL_LIMIT = 100
const DEFAULT_SIMILARITY_TOKEN_ESTIMATE = 1024

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new IdentityRecallError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IdentityRecallError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function worstCompleteness(statuses: readonly CompletenessStatus[]): CompletenessStatus {
  if (statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('partial')) return 'partial'
  if (statuses.includes('truncated')) return 'truncated'
  return 'complete'
}

function identityValueOf(candidate: EntityCandidate, identityAttributeIds: readonly string[]): string | undefined {
  for (const attribute of candidate.attributes) {
    if (!identityAttributeIds.includes(attribute.attributeId)) continue
    return String(attribute.value)
  }
  return undefined
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECALL_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new IdentityRecallError('INVALID_REQUEST', 'the recall limit must be a positive integer')
  }
  return Math.min(limit, MAX_RECALL_LIMIT)
}

/** The exact source chunks a mention was extracted from; the evidence a comparison is grounded in. */
function evidenceRefsOf(candidate: EntityCandidate): ResourceRef[] {
  return candidate.sourceSpans.map((span) =>
    candidateSourceRef(span, candidate.inputVersion.parserVersion),
  )
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
 * Bounded entity-candidate recall and identity scoping (SPEC D4.4, US-014.A1).
 *
 * Given one extracted entity candidate it produces a ranked candidate set by layering
 * strong identifiers → confirmed (valid-time) aliases → type/site/name context, then an
 * optional, explicitly-mounted similarity pass over the already-bounded set. It never
 * scans the corpus pairwise and never calls a model unless a similarity backend was
 * injected.
 *
 * The identity scope (which dimensions and attributes make an identity) is resolved from
 * the published definition, not from a display name. A recall that finds nothing is
 * reported as `undecided` with `coverage.boundedRecall = true`; it is never reported as
 * proof that the entity does not exist.
 *
 * It does not decide `match/create/clarify/reject` and it never publishes (LOCAL-030).
 */
export class EntityCandidateRecallService {
  readonly #deps: EntityCandidateRecallDependencies

  constructor(dependencies: EntityCandidateRecallDependencies) {
    this.#deps = dependencies
  }

  async recall(request: EntityRecallRequest, ctx: ToolContext): Promise<IdentityRecallResult> {
    const scope = scopeOf(ctx)
    const limit = clampLimit(request.limit)
    const candidate = request.candidate
    const extractedUnder = candidate.inputVersion.definitionRef
    if (extractedUnder.id !== request.definitionRef.id || extractedUnder.version !== request.definitionRef.version || extractedUnder.digest !== request.definitionRef.digest) {
      throw new IdentityRecallError('INVALID_REQUEST', 'recall must use the exact definition version stored with the candidate')
    }
    const observedText = request.observedText
    const normalizedText = normalizeIdentityText(observedText)
    if (normalizedText.length === 0) {
      throw new IdentityRecallError('INVALID_REQUEST', 'the observed text is empty after normalisation')
    }

    const schema = await this.#requireSchema(scope, request, ctx)
    const identityScope = this.#requireIdentityScope(schema, candidate)
    const scopeDimensions = this.#scopeDimensions(identityScope, request)
    if (request.projectId !== undefined) {
      const declared = scopeDimensions.find((entry) => entry.dimension === 'project')
      if (declared !== undefined && declared.value !== request.projectId) {
        throw new IdentityRecallError('SCOPE_MISMATCH', 'stored candidate project dimension differs from the pinned project')
      }
      if (declared === undefined) scopeDimensions.push({ dimension: 'project', value: request.projectId })
    }

    const layers = await this.#generateCandidates({
      scope,
      limit,
      candidate,
      identityScope,
      scopeDimensions,
      normalizedText,
      ...(request.validAt === undefined ? {} : { validAt: request.validAt }),
      ctx,
    })

    const documentContext = await this.#documentContext(request, ctx)
    const evidenceRefs = mergeEvidence(evidenceRefsOf(candidate), documentContext.evidenceRefs)
    const similarity = await this.#applySimilarity({
      request,
      normalizedText,
      candidates: layers.candidates,
      limit,
      evidenceRefs,
      ctx,
    })
    const candidates = this.#rank(similarity)

    const outcome = candidates.length === 0 ? 'undecided' : 'candidates'
    const completeness = worstCompleteness([
      layers.completeness,
      ...(documentContext.info.performed ? [documentContext.completeness] : []),
    ])
    const coverage = {
      returned: candidates.length,
      ...(layers.knownTotal === undefined ? {} : { knownTotal: layers.knownTotal }),
      truncated: layers.truncated,
      completeness,
      boundedRecall: true as const,
      strategies: layers.attempted,
      documentContext: documentContext.info,
    }

    return {
      outcome,
      ...(outcome === 'undecided' ? { reason: 'NO_CANDIDATE' as const } : {}),
      candidateId: candidate.candidateId,
      objectId: candidate.objectId,
      identityScopeId: identityScope.identityScopeId,
      observedText,
      normalizedText,
      candidates: candidates.map((entry) => this.#withEvidence(entry, evidenceRefs)),
      strategiesUsed: layers.attempted,
      truncation: { truncated: layers.truncated, limit, boundedCandidateGeneration: true },
      coverage,
      sourceSnapshots: [
        layers.snapshot,
        ...documentContext.snapshots,
      ],
      documentContext: documentContext.info,
      similarity: similarity.info,
      ...(similarity.usage === undefined ? {} : { usage: similarity.usage }),
    }
  }

  async #requireSchema(
    scope: ScopeRef,
    request: EntityRecallRequest,
    ctx: ToolContext,
  ): Promise<IndustrySchema> {
    const schema = await this.#deps.schemaSource.getSchema(scope, request.definitionRef, ctx)
    if (schema === undefined) {
      throw new IdentityRecallError(
        'DEFINITION_NOT_VISIBLE',
        `definition ${request.definitionRef.id}@${request.definitionRef.version} is not visible in this scope`,
      )
    }
    return schema
  }

  #requireIdentityScope(
    schema: IndustrySchema,
    candidate: EntityCandidate,
  ): IndustryIdentityScopeSchema {
    const object = schema.objects.find((entry) => entry.objectId === candidate.objectId)
    if (object === undefined) {
      throw new IdentityRecallError(
        'IDENTITY_SCOPE_NOT_FOUND',
        `object ${candidate.objectId} is not declared by the pinned definition`,
      )
    }
    const identityScope = schema.identityScopes.find(
      (entry) => entry.identityScopeId === object.identityScopeId,
    )
    if (identityScope === undefined) {
      throw new IdentityRecallError(
        'IDENTITY_SCOPE_NOT_FOUND',
        `object ${candidate.objectId} declares identity scope ${object.identityScopeId}, which the definition does not define`,
      )
    }
    if (identityScope.objectId !== candidate.objectId) {
      throw new IdentityRecallError('SCOPE_MISMATCH', 'the definition identity domain belongs to another object')
    }
    if (candidate.identityScopeId !== undefined && candidate.identityScopeId !== identityScope.identityScopeId) {
      throw new IdentityRecallError(
        'SCOPE_MISMATCH',
        `candidate carries identity scope ${candidate.identityScopeId} but the definition declares ${identityScope.identityScopeId}`,
      )
    }
    return identityScope
  }

  #scopeDimensions(
    identityScope: IndustryIdentityScopeSchema,
    request: EntityRecallRequest,
  ): { readonly dimension: string; readonly value: string }[] {
    return identityScope.scopeDimensions.map((dimension) => {
      const value = request.scopeDimensionValues[dimension]
      if (value === undefined || value.length === 0) {
        throw new IdentityRecallError(
          'MISSING_SCOPE_DIMENSION',
          `identity scope dimension "${dimension}" has no value; same-name entities must never be mixed across it`,
        )
      }
      return { dimension, value }
    })
  }

  async #generateCandidates(args: {
    readonly scope: ScopeRef
    readonly limit: number
    readonly candidate: EntityCandidate
    readonly identityScope: IndustryIdentityScopeSchema
    readonly scopeDimensions: readonly { readonly dimension: string; readonly value: string }[]
    readonly normalizedText: string
    readonly validAt?: string
    readonly ctx: ToolContext
  }): Promise<{
    readonly candidates: readonly Omit<IdentityCandidate, 'rank' | 'evidenceRefs'>[]
    readonly attempted: readonly RecallStrategy[]
    readonly truncated: boolean
    readonly knownTotal?: number
    readonly completeness: CompletenessStatus
    readonly snapshot: SourceSnapshot
  }> {
    const attempted: RecallStrategy[] = []
    const base = {
      objectId: args.candidate.objectId,
      identityScopeId: args.identityScope.identityScopeId,
      tenantId: args.scope.tenantId,
      spaceId: args.scope.spaceId,
      scopeDimensions: args.scopeDimensions,
      limit: args.limit,
    }

    const attributeIdentity = identityValueOf(args.candidate, args.identityScope.identityAttributeIds)
    if (args.candidate.nativeId !== undefined && attributeIdentity !== undefined && args.candidate.nativeId !== attributeIdentity) {
      throw new IdentityRecallError('INVALID_REQUEST', 'stored nativeId contradicts the definition identity attribute')
    }
    const strongId = args.candidate.nativeId ?? attributeIdentity
    if (strongId !== undefined && strongId.length > 0) {
      attempted.push('strong_identifier')
      const page = await this.#deps.index.query(
        { ...base, match: { kind: 'strong_identifier', nativeId: strongId } },
        args.ctx,
      )
      if (page.entries.length > 0) {
        return this.#result('strong_identifier', strongId, page, attempted)
      }
    }

    attempted.push('confirmed_alias')
    const aliasPage = await this.#deps.index.query(
      {
        ...base,
        match: {
          kind: 'confirmed_alias',
          normalizedAlias: args.normalizedText,
          ...(args.validAt === undefined ? {} : { validAt: args.validAt }),
        },
      },
      args.ctx,
    )
    if (aliasPage.entries.length > 0) {
      return this.#result('confirmed_alias', args.normalizedText, aliasPage, attempted)
    }

    attempted.push('context')
    const contextPage = await this.#deps.index.query(
      {
        ...base,
        match: {
          kind: 'context',
          normalizedName: args.normalizedText,
          entityType: args.candidate.objectId,
          ...(args.validAt === undefined ? {} : { validAt: args.validAt }),
        },
      },
      args.ctx,
    )
    return this.#result('context', args.normalizedText, contextPage, attempted)
  }

  #result(
    strategy: RecallStrategy,
    matchedValue: string,
    page: IdentityIndexPage,
    attempted: readonly RecallStrategy[],
  ): {
    readonly candidates: readonly Omit<IdentityCandidate, 'rank' | 'evidenceRefs'>[]
    readonly attempted: readonly RecallStrategy[]
    readonly truncated: boolean
    readonly knownTotal?: number
    readonly completeness: CompletenessStatus
    readonly snapshot: SourceSnapshot
  } {
    // An index may expose several alias rows for one entity. Compare and present that identity once.
    const byEntity = new Map<string, IdentityIndexEntry>()
    for (const entry of page.entries) if (!byEntity.has(entry.entityId)) byEntity.set(entry.entityId, entry)
    const candidates = [...byEntity.values()].map((entry) => this.#candidateOf(strategy, matchedValue, entry))
    return {
      candidates,
      attempted,
      truncated: page.truncated,
      ...(page.knownTotal === undefined || byEntity.size !== page.entries.length ? {} : { knownTotal: page.knownTotal }),
      completeness: page.truncated ? 'truncated' : 'complete',
      snapshot: page.snapshot,
    }
  }

  #candidateOf(
    strategy: RecallStrategy,
    matchedValue: string,
    entry: IdentityIndexEntry,
  ): Omit<IdentityCandidate, 'rank' | 'evidenceRefs'> {
    return {
      entityId: entry.entityId,
      objectId: entry.objectId,
      identityScopeId: entry.identityScopeId,
      strategy,
      matchedValue,
      stableId: strategy === 'strong_identifier',
      aliasConfirmed: strategy === 'confirmed_alias' && entry.aliasConfirmed,
      displayName: entry.displayName,
      ...(entry.alias === undefined ? {} : { alias: entry.alias }),
      ...(entry.validFrom === undefined ? {} : { validFrom: entry.validFrom }),
      ...(entry.validTo === undefined ? {} : { validTo: entry.validTo }),
      ...(entry.aliasValidFrom === undefined ? {} : { aliasValidFrom: entry.aliasValidFrom }),
      ...(entry.aliasValidTo === undefined ? {} : { aliasValidTo: entry.aliasValidTo }),
    }
  }

  async #documentContext(
    request: EntityRecallRequest,
    ctx: ToolContext,
  ): Promise<{
    readonly info: IdentityDocumentContext
    readonly evidenceRefs: readonly ResourceRef[]
    readonly snapshots: readonly SourceSnapshot[]
    readonly completeness: CompletenessStatus
  }> {
    const documents = this.#deps.documents
    const collections = request.contextCollections ?? []
    if (documents === undefined || collections.length === 0) {
      return {
        info: { performed: false, spans: 0, completeness: 'unknown' },
        evidenceRefs: [],
        snapshots: [],
        completeness: 'unknown',
      }
    }
    const response = await documents.search(
      {
        query: request.observedText,
        allowedCollectionRefs: [...collections],
        mode: 'keyword',
        limit: 10,
      },
      ctx,
    )
    const evidenceRefs = response.spans.map((span) => span.documentRef)
    return {
      info: {
        performed: true,
        spans: response.spans.length,
        completeness: response.completeness,
      },
      evidenceRefs,
      snapshots: [response.snapshot],
      completeness: response.completeness,
    }
  }

  async #applySimilarity(args: {
    readonly request: EntityRecallRequest
    readonly normalizedText: string
    readonly candidates: readonly Omit<IdentityCandidate, 'rank' | 'evidenceRefs'>[]
    readonly limit: number
    readonly evidenceRefs: readonly ResourceRef[]
    readonly ctx: ToolContext
  }): Promise<{
    readonly candidates: readonly Omit<IdentityCandidate, 'rank' | 'evidenceRefs'>[]
    readonly info: IdentitySimilarityInfo
    readonly usage?: ToolUsage
  }> {
    const backend = this.#deps.similarity
    if (backend === undefined) {
      return { candidates: args.candidates, info: { available: false, reason: 'NOT_CONFIGURED', comparisons: 0 } }
    }
    if (args.candidates.length === 0) {
      return {
        candidates: args.candidates,
        info: { available: true, reason: 'NO_CANDIDATES', backendRef: backend.backendRef, comparisons: 0 },
      }
    }
    if (args.request.allowSimilarity === false) {
      return {
        candidates: args.candidates,
        info: { available: true, reason: 'SKIPPED', backendRef: backend.backendRef, comparisons: 0 },
      }
    }
    const ledgerId = args.request.ledgerId
    const budget = this.#deps.budget
    if (ledgerId === undefined || budget === undefined) {
      throw new IdentityRecallError(
        'BUDGET_REQUIRED',
        'a mounted similarity backend requires a shared ledger id and budget port',
      )
    }
    const reservation = await budget.reserve(
      {
        ledgerId,
        idempotencyKey: `identity-similarity:${args.request.candidate.candidateId}`,
        toolCalls: 0,
        modelTokens: this.#deps.similarityTokenEstimate ?? DEFAULT_SIMILARITY_TOKEN_ESTIMATE,
      },
      args.ctx,
    )
    const reservationId = reservation.reservation?.reservationId
    if (!reservation.granted || reservationId === undefined) {
      throw new IdentityRecallError(
        'BUDGET_REFUSED',
        reservation.denial?.message ?? 'the shared ledger refused the similarity reservation',
      )
    }

    const bounded = args.candidates.slice(0, args.limit)
    const startedAt = Date.now()
    let comparison: Awaited<ReturnType<typeof backend.compare>>
    try {
      comparison = await backend.compare(
        {
          mentionId: args.request.candidate.candidateId,
          mentionText: args.request.observedText,
          candidates: bounded.map((candidate) => ({
            entityId: candidate.entityId,
            label: candidate.displayName ?? candidate.matchedValue,
          })),
        },
        args.ctx,
      )
    } catch (error) {
      await this.#settle(
        budget,
        ledgerId,
        reservationId,
        'failed',
        { durationMs: Date.now() - startedAt, calls: 1, usageUnknown: true },
        args.evidenceRefs,
        args.ctx,
      )
      throw new IdentityRecallError('SIMILARITY_FAILED', 'the similarity backend failed', { cause: error })
    }
    const modelTokens = comparison.usage.inputTokens + comparison.usage.outputTokens
    const usageUnknown = comparison.usage.usageUnknown === true
    const usage: ToolUsage = {
      durationMs: Date.now() - startedAt,
      calls: 1,
      modelTokens,
      ...(usageUnknown ? { usageUnknown: true } : {}),
    }
    await this.#settle(
      budget,
      ledgerId,
      reservationId,
      usageUnknown ? 'usage_unknown' : 'completed',
      usage,
      args.evidenceRefs,
      args.ctx,
    )

    const scores = new Map(comparison.scores.map((score) => [score.entityId, score.score]))
    const withScores = args.candidates.map((candidate) => {
      const score = scores.get(candidate.entityId)
      return score === undefined ? candidate : { ...candidate, score }
    })
    return {
      candidates: withScores,
      info: {
        available: true,
        backendRef: comparison.backendRef,
        comparisons: 1,
        ...(comparison.modelRef === undefined ? {} : { modelRef: comparison.modelRef }),
      },
      usage,
    }
  }

  async #settle(
    budget: NonNullable<EntityCandidateRecallDependencies['budget']>,
    ledgerId: string,
    reservationId: string,
    status: BudgetSettlementStatus,
    usage: ToolUsage,
    evidenceRefs: readonly ResourceRef[],
    ctx: ToolContext,
  ): Promise<void> {
    await budget.settle({ ledgerId, reservationId, status, usage, evidenceRefs: [...evidenceRefs] }, ctx)
  }

  /**
   * Precedence ranking: strong identifier and confirmed alias keep their deterministic
   * index order (a similarity score never demotes a confirmed alias below a fuzzy name);
   * a context-only set is re-ordered by the bounded similarity score when one exists.
   */
  #rank(
    similarity: { readonly candidates: readonly Omit<IdentityCandidate, 'rank' | 'evidenceRefs'>[] },
  ): readonly IdentityCandidate[] {
    const merged = similarity.candidates
    const strategy = merged[0]?.strategy
    const ordered =
      strategy === 'context'
        ? [...merged].sort((left, right) => {
            const leftScore = left.score ?? Number.NEGATIVE_INFINITY
            const rightScore = right.score ?? Number.NEGATIVE_INFINITY
            if (leftScore !== rightScore) return rightScore - leftScore
            return left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0
          })
        : merged
    return ordered.map((candidate, position) => ({ ...candidate, rank: position + 1, evidenceRefs: [] }))
  }

  #withEvidence(candidate: IdentityCandidate, evidenceRefs: readonly ResourceRef[]): IdentityCandidate {
    return evidenceRefs.length === 0 ? candidate : { ...candidate, evidenceRefs: [...evidenceRefs] }
  }
}
