import type { AssetCandidateState } from './asset-candidates'
import type { CandidateSourceReviewState } from './candidate-source'
import type { CandidateSourceSpan } from './extraction'
import type { ResourceRef, RevisionString, Rfc3339UtcTimestamp, ScopeRef, Uuid } from './generated/contracts'
import type { SourceTrustTier } from './source-grounding'
import type { CandidateSubmissionKind } from './submit-candidates'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isRevisionString, isUuid } from './asset-workspace'

/**
 * The source→asset review hand-off projection (design §3/§4/§7).
 *
 * A candidate submitted by an agent cites one or more sources, each fixed to
 * `trustTier=agent_researched / reviewState=proposed`. This projection makes the hand-off
 * explicit and readable: it keeps **every** source of a candidate separate, reports the review and
 * admission state of each one, and states whether the candidate is still blocked. It is a
 * read-only projection — it never becomes a second approval truth; executing a step re-authorizes
 * in the owning service (design §2.5).
 *
 * The critical rule it exposes (design §4/§7): a candidate only enters formal asset review after
 * **all** its related sources are reviewed, admitted and re-grounded. Approving only the sources,
 * or only the candidate, can never satisfy the publication gate.
 */

/** The review state of one cited source as seen from the hand-off. `unknown` = source not visible yet. */
export type SourceReviewHandoffState = CandidateSourceReviewState | 'unknown'

/** One cited source of a candidate, with its own review/admission/grounding status. */
export interface SourceReviewHandoffLink {
  /** The evidence index inside the submission, so the rows line up with the submit receipt. */
  readonly index: number
  readonly sourceRef: ResourceRef
  readonly sourceSpan?: CandidateSourceSpan
  /** The candidate source's current review state, or `unknown` when it is not (yet) a candidate source. */
  readonly reviewState: SourceReviewHandoffState
  /** The current tier of the source. The model never chose this. */
  readonly trustTier: SourceTrustTier
  /** Whether an approved source admission binds this source into the workspace corpus. */
  readonly admitted: boolean
  /** Whether this source's tier may ground a publishable candidate (a promotion is separate). */
  readonly groundsPublication: boolean
  /** True while this one source still holds the candidate behind a human confirmation. */
  readonly pendingConfirmation: boolean
  /** A stable machine reason for a remaining block, when there is one. */
  readonly blockReason?: string
}

/** How close a candidate is to formal asset review. */
export type CandidateReviewHandoffReadiness =
  | 'ready_for_review'
  | 'pending_sources'
  | 'regrounding_required'
  | 'unknown'

/**
 * One candidate's hand-off. `links` carries **every** cited source separately; `allSourcesConfirmed`
 * is true only when each of them is reviewed + admitted + grounding. `blocked` stays true until the
 * candidate is re-grounded into a new version.
 */
export interface CandidateReviewHandoff {
  readonly candidateId: Uuid
  readonly candidateKind: CandidateSubmissionKind
  readonly state: AssetCandidateState | 'proposed' | 'approved' | 'rejected'
  readonly blocked: boolean
  /** The stable codes that still block the candidate (`SOURCE_TRUST_BLOCKED`, ...). */
  readonly blockCodes: readonly string[]
  readonly pendingConfirmation: boolean
  readonly readiness: CandidateReviewHandoffReadiness
  /** The successor candidate this version was re-grounded into, when it has been. */
  readonly regroundedCandidateId?: Uuid
  readonly links: readonly SourceReviewHandoffLink[]
  readonly allSourcesConfirmed: boolean
}

/** The workspace-scoped, fixed-read projection of every candidate that still cites open sources. */
export interface WorkspaceReviewHandoff {
  readonly schemaVersion: 'review-handoff@1'
  readonly scopeRef: ScopeRef
  readonly workspaceId: Uuid
  readonly candidates: readonly CandidateReviewHandoff[]
  readonly asOf: Rfc3339UtcTimestamp
}

/** A read-only hand-off reader. It runs every query inside the trusted scope and never writes. */
export interface WorkspaceReviewHandoffReader {
  readHandoff(workspaceId: Uuid, ctx: ToolContext): Promise<WorkspaceReviewHandoff>
}

export type ReviewHandoffErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'SCOPE_MISMATCH' | 'SOURCE_TRUST_BLOCKED' | 'STORE_FAILED'

export class ReviewHandoffError extends Error {
  constructor(readonly code: ReviewHandoffErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ReviewHandoffError'
    this.code = code
  }
}

/**
 * Promoting a source's provenance tier is deliberately **separate** from reviewing it (design §7):
 * accepting a source only changes its review state; raising `agent_researched` to
 * `public_standard`/`customer_authoritative` is its own, permissioned, audited operation. The
 * command carries the exact revision the promoter read and a mandatory reason.
 */
export interface SourceTierPromotionCommand {
  readonly schemaVersion: 'source-tier-promotion@1'
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  /** A compare-and-swap against the source revision the promoter read. */
  readonly expectedRevision: RevisionString
  readonly nextTrustTier: SourceTrustTier
  readonly reason: string
  readonly basisRefs: readonly ResourceRef[]
  readonly promotedBy: string
  readonly idempotencyKey: string
}

export interface SourceTierPromotionReceipt {
  readonly sourceId: Uuid
  readonly revision: RevisionString
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier: SourceTrustTier
  readonly eventId: Uuid
  /** False when an earlier idempotent promotion returned the stored outcome. */
  readonly replayed: boolean
}

export const REVIEW_HANDOFF_READINESS: readonly CandidateReviewHandoffReadiness[] = [
  'ready_for_review',
  'pending_sources',
  'regrounding_required',
  'unknown',
]

const SOURCE_TRUST_TIERS: readonly SourceTrustTier[] = ['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic']
const SOURCE_REVIEW_HANDOFF_STATES: readonly SourceReviewHandoffState[] = ['proposed', 'approved', 'rejected', 'unknown']
const CANDIDATE_KINDS: readonly CandidateSubmissionKind[] = ['source', 'definition', 'rule', 'action']
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function assertLink(value: unknown): void {
  if (!isRecord(value)
    || !Number.isSafeInteger(value['index']) || (value['index'] as number) < 0
    || !isResourceRef(value['sourceRef'])
    || (value['sourceSpan'] !== undefined && !isRecord(value['sourceSpan']))
    || !SOURCE_REVIEW_HANDOFF_STATES.includes(value['reviewState'] as SourceReviewHandoffState)
    || !SOURCE_TRUST_TIERS.includes(value['trustTier'] as SourceTrustTier)
    || typeof value['admitted'] !== 'boolean'
    || typeof value['groundsPublication'] !== 'boolean'
    || typeof value['pendingConfirmation'] !== 'boolean'
    || (value['blockReason'] !== undefined && !isNonEmptyString(value['blockReason']))) {
    throw new ReviewHandoffError('INVALID_REQUEST', 'invalid source review hand-off link')
  }
}

/** Runtime validation of one candidate hand-off entry. */
export function assertCandidateReviewHandoffShape(value: unknown): asserts value is CandidateReviewHandoff {
  if (!isRecord(value) || !isUuid(value['candidateId'])
    || !CANDIDATE_KINDS.includes(value['candidateKind'] as CandidateSubmissionKind)
    || !isNonEmptyString(value['state'])
    || typeof value['blocked'] !== 'boolean'
    || !Array.isArray(value['blockCodes']) || !value['blockCodes'].every(isNonEmptyString)
    || typeof value['pendingConfirmation'] !== 'boolean'
    || !REVIEW_HANDOFF_READINESS.includes(value['readiness'] as CandidateReviewHandoffReadiness)
    || (value['regroundedCandidateId'] !== undefined && !isUuid(value['regroundedCandidateId']))
    || !Array.isArray(value['links'])
    || typeof value['allSourcesConfirmed'] !== 'boolean') {
    throw new ReviewHandoffError('INVALID_REQUEST', 'invalid candidate review hand-off')
  }
  value['links'].forEach(assertLink)
}

/** Runtime validation of the workspace hand-off projection. */
export function assertWorkspaceReviewHandoffShape(value: unknown): asserts value is WorkspaceReviewHandoff {
  if (!isRecord(value) || value['schemaVersion'] !== 'review-handoff@1'
    || !isRecord(value['scopeRef']) || !isUuid(value['scopeRef']['tenantId']) || !isUuid(value['scopeRef']['spaceId'])
    || !isUuid(value['workspaceId']) || !isNonEmptyString(value['asOf'])
    || !Array.isArray(value['candidates'])) {
    throw new ReviewHandoffError('INVALID_REQUEST', 'invalid workspace review hand-off')
  }
  value['candidates'].forEach(assertCandidateReviewHandoffShape)
}

/** Runtime validation of a tier promotion command before any audit event is appended. */
export function assertSourceTierPromotionCommandShape(value: unknown): asserts value is SourceTierPromotionCommand {
  if (!isRecord(value) || value['schemaVersion'] !== 'source-tier-promotion@1'
    || !isUuid(value['workspaceId']) || !isUuid(value['sourceId'])
    || !isRevisionString(value['expectedRevision'])
    || !SOURCE_TRUST_TIERS.includes(value['nextTrustTier'] as SourceTrustTier)
    || !isNonEmptyString(value['reason']) || value['reason'].length > 4000
    || !Array.isArray(value['basisRefs']) || value['basisRefs'].length > 64 || !value['basisRefs'].every(isResourceRef)
    || !isNonEmptyString(value['promotedBy']) || !isNonEmptyString(value['idempotencyKey'])) {
    throw new ReviewHandoffError('INVALID_REQUEST', 'invalid source tier promotion command')
  }
}

/** A stable machine code for one still-blocking link, or `undefined` when the link is confirmed. */
export function sourceLinkBlockReason(link: SourceReviewHandoffLink): string | undefined {
  if (link.reviewState === 'rejected') return 'SOURCE_REJECTED'
  if (link.reviewState !== 'approved') return 'SOURCE_TRUST_BLOCKED'
  if (!link.admitted) return 'SOURCE_NOT_ADMITTED'
  if (!link.groundsPublication) return 'SOURCE_TRUST_BLOCKED'
  return undefined
}

/** The persisted projection schema version, so a reader can recognise it. */
export const REVIEW_HANDOFF_SCHEMA_VERSION = 'review-handoff@1'

/** Whether a digest string is a sha256 digest; used when a caller projects a persisted projection. */
export function isReviewHandoffDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}
