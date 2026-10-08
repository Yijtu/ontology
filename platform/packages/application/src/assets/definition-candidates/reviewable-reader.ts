import { candidateSourceRef, isToolContext, ReviewableCandidateReadError } from '@ontology/contracts'
import type {
  AssetCandidateStore,
  CandidateStore,
  ReviewableCandidateReader,
  ReviewableCandidateView,
  ScopeRef,
  ToolContext,
  Uuid,
  RuleActionCandidateStore,
} from '@ontology/contracts'

export interface CompositeReviewableCandidateReaderDependencies {
  readonly ruleActions?: Pick<RuleActionCandidateStore, 'get'>
  readonly definition: Pick<AssetCandidateStore, 'getCandidate'>
  readonly instance: Pick<CandidateStore, 'getCandidate'>
}

/**
 * Resolve a candidate id against both candidate families and project it to the one review
 * shape (SPEC v0.3a §3.1: 抽出可注入的 ReviewableCandidateReader). Instance candidates and
 * definition (TBox) candidates stay in physically separate stores, yet the same review tables,
 * routes and If-Match/history algorithm serve both. The reader only reads; the review store
 * still owns the decision, so there is no second approve truth.
 */
export class CompositeReviewableCandidateReader implements ReviewableCandidateReader {
  readonly #definition: CompositeReviewableCandidateReaderDependencies['definition']
  readonly #instance: CompositeReviewableCandidateReaderDependencies['instance']
  readonly #ruleActions: CompositeReviewableCandidateReaderDependencies['ruleActions']

  constructor(dependencies: CompositeReviewableCandidateReaderDependencies) {
    this.#definition = dependencies.definition
    this.#instance = dependencies.instance
    this.#ruleActions = dependencies.ruleActions
  }

  async readCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<ReviewableCandidateView | undefined> {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== scopeRef.tenantId || ctx.allowedResources.tenantId !== scopeRef.tenantId || ctx.allowedResources.spaceId !== scopeRef.spaceId) throw new ReviewableCandidateReadError('SCOPE_MISMATCH', 'candidate review requires the trusted scope')
    const [definition, ruleAction, instance] = await Promise.all([this.#definition.getCandidate(scopeRef, candidateId, ctx), this.#ruleActions?.get(scopeRef, candidateId, ctx), this.#instance.getCandidate(scopeRef, candidateId, ctx)])
    if ([definition, ruleAction, instance].filter((row) => row !== undefined).length > 1) throw new ReviewableCandidateReadError('AMBIGUOUS_CANDIDATE', 'candidate id belongs to multiple review domains; approval cannot choose one implicitly')
    if (definition !== undefined) {
      return {
        candidateId: definition.candidateId,
        domain: 'definition',
        kind: definition.kind,
        state: definition.state,
        contentDigest: definition.contentDigest,
        sourceRefs: definition.sourceRefs,
      }
    }
    if (ruleAction !== undefined) return { candidateId: ruleAction.candidateId, domain: 'definition', kind: ruleAction.kind, state: ruleAction.lifecycle,
      contentDigest: ruleAction.contentDigest, sourceRefs: ruleAction.sourceRefs }
    if (instance !== undefined) {
      return {
        candidateId: instance.candidateId,
        domain: 'instance',
        kind: instance.kind,
        state: instance.state,
        contentDigest: instance.idempotencyKey,
        sourceRefs: instance.sourceSpans.map((span) =>
          candidateSourceRef(span, instance.inputVersion.parserVersion),
        ),
      }
    }
    return undefined
  }
}
