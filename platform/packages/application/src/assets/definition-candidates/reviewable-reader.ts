import { candidateSourceRef } from '@ontology/contracts'
import type {
  AssetCandidateStore,
  CandidateStore,
  ReviewableCandidateReader,
  ReviewableCandidateView,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

export interface CompositeReviewableCandidateReaderDependencies {
  readonly definition: AssetCandidateStore
  readonly instance: CandidateStore
}

/**
 * Resolve a candidate id against both candidate families and project it to the one review
 * shape (SPEC v0.3a §3.1: 抽出可注入的 ReviewableCandidateReader). Instance candidates and
 * definition (TBox) candidates stay in physically separate stores, yet the same review tables,
 * routes and If-Match/history algorithm serve both. The reader only reads; the review store
 * still owns the decision, so there is no second approve truth.
 */
export class CompositeReviewableCandidateReader implements ReviewableCandidateReader {
  readonly #definition: AssetCandidateStore
  readonly #instance: CandidateStore

  constructor(dependencies: CompositeReviewableCandidateReaderDependencies) {
    this.#definition = dependencies.definition
    this.#instance = dependencies.instance
  }

  async readCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<ReviewableCandidateView | undefined> {
    const definition = await this.#definition.getCandidate(scopeRef, candidateId, ctx)
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
    const instance = await this.#instance.getCandidate(scopeRef, candidateId, ctx)
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
