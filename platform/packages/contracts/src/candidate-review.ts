import type { ResourceRef, ScopeRef, Sha256Digest, Uuid } from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Reviewable candidate dispatch (SPEC v0.3a asset-data-ui §3.1: 审核继续写现有
 * semantic_candidate_reviews/candidate_review_heads; 抽出可注入的 ReviewableCandidateReader).
 *
 * Instance candidates (`extraction_candidates`) and definition (TBox) candidates
 * (`asset_candidate_versions`) live in physically separate stores, but both are reviewed
 * through the SAME review tables, routes and If-Match/history algorithm. This reader is the
 * one seam that lets the review service verify "this candidate id is visible in this scope"
 * for either domain without the review service learning about either store. There is no
 * second approve truth: the reader only reads, the review store still owns the decision.
 */
export type ReviewableCandidateDomain = 'instance' | 'definition'

/** The read-only projection a review needs: identity, domain, state and content pin. */
export interface ReviewableCandidateView {
  readonly candidateId: Uuid
  readonly domain: ReviewableCandidateDomain
  readonly kind: string
  readonly state: string
  /** A digest that pins the reviewed content, so an edit is detectable as a new candidate. */
  readonly contentDigest: Sha256Digest
  readonly sourceRefs: readonly ResourceRef[]
}

export interface ReviewableCandidateReader {
  /** Resolve a candidate of either domain; `undefined` means not visible in this scope. */
  readCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<ReviewableCandidateView | undefined>
}
