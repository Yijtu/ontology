import type { ResourceRef, RevisionString, Sha256Digest, ScopeRef, Uuid, VersionRef } from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid } from './asset-workspace'
import type { SourceTrustTier } from './source-grounding'

/**
 * A proposed authoring source that is not yet part of an approved workspace corpus. It carries the
 * provenance tier the grounding gate reads (`customer_authoritative` / `public_standard` /
 * `agent_researched` / `synthetic`) plus where it came from and when it was retrieved, so a
 * human can review — promote or reject — it before it may ground a publishable candidate.
 *
 * Design §2.1 adds three presentation/audit fields to the proposal without changing its version:
 * a human-readable `title`, the `researchRunId` a researched candidate was discovered under, and
 * the `reviewRecordRefs` its review history is pinned to. All three are optional, so a legacy
 * `candidate-source@1` proposal written before this increment stays readable.
 */
export type CandidateSourceKind = 'upload' | 'web_fetch' | 'standard_ref'
export type CandidateSourceReviewState = 'proposed' | 'approved' | 'rejected'

export interface CandidateSourceOrigin {
  readonly url?: string
  readonly publisher?: string
  /** A versioned standard the source cites (e.g. a national standard revision). */
  readonly standardRef?: VersionRef
  readonly fetchedAt?: string
}

export interface CandidateSourceFreshness {
  readonly retrievedAt: string
  readonly validUntil?: string
}

export interface CandidateSource {
  readonly schemaVersion: 'candidate-source@1'
  readonly sourceId: Uuid
  readonly workspaceId: Uuid
  readonly kind: CandidateSourceKind
  readonly trustTier: SourceTrustTier
  readonly origin: CandidateSourceOrigin
  readonly contentRef: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly freshness?: CandidateSourceFreshness
  readonly reviewState: CandidateSourceReviewState
  readonly proposedBy: string
  readonly reviewedBy?: string
  /** A human-readable title shown in the source library; never used as an authority signal. */
  readonly title?: string
  /** The research run that discovered this source, when it came from AI research. */
  readonly researchRunId?: Uuid
  /** Immutable references to this source's appended review records. */
  readonly reviewRecordRefs?: readonly ResourceRef[]
  readonly recordedAt: string
}

/**
 * A persisted candidate source: the proposal plus the store-assigned `revision` a review must
 * compare-and-swap against. The proposal itself carries no revision, so a review can only be
 * applied to the exact revision the reviewer saw.
 */
export interface CandidateSourceRecord extends CandidateSource {
  readonly revision: RevisionString
}

export type CandidateSourceErrorCode =
  | 'INVALID_SOURCE' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'STORE_FAILED' | 'SCOPE_MISMATCH'

export class CandidateSourceError extends Error {
  constructor(readonly code: CandidateSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CandidateSourceError'
  }
}

export interface CandidateSourceListFilter {
  readonly reviewState?: CandidateSourceReviewState
  readonly trustTier?: SourceTrustTier
  readonly limit?: number
}

/**
 * The versioned review command (design §2.1). It names the workspace the review is applied to so
 * the service can reject a command whose source belongs to another workspace, carries a mandatory
 * `reason` and the `basisRefs` the decision rests on, and versions the audit fields that a legacy
 * `reviewSource` call never had. It never carries a secret.
 */
export interface CandidateSourceReviewCommand {
  readonly schemaVersion: 'candidate-source-review@1'
  readonly sourceId: Uuid
  readonly workspaceId: Uuid
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier?: SourceTrustTier
  readonly reviewedBy: string
  readonly reason: string
  readonly expectedRevision: RevisionString
  readonly basisRefs: readonly ResourceRef[]
  readonly idempotencyKey: string
}

/** One append-only review event; the current source row is only the latest projection of these. */
export interface CandidateSourceReviewEvent {
  readonly schemaVersion: 'candidate-source-review-event@1'
  readonly eventId: Uuid
  readonly sourceId: Uuid
  readonly workspaceId: Uuid
  readonly previousState: CandidateSourceReviewState
  readonly nextState: CandidateSourceReviewState
  readonly previousTrustTier?: SourceTrustTier
  readonly nextTrustTier?: SourceTrustTier
  readonly reason: string
  readonly basisRefs: readonly ResourceRef[]
  readonly actor: string
  readonly recordedAt: string
  readonly idempotencyKey: string
}

/**
 * The idempotent receipt of a review command. `replayed` is true when the same idempotency key
 * returned the stored outcome instead of appending a second event.
 */
export interface CandidateSourceReviewReceipt {
  readonly sourceId: Uuid
  /** The new current-projection revision after the event; unchanged when replayed. */
  readonly revision: RevisionString
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier: SourceTrustTier
  readonly eventId: Uuid
  readonly replayed: boolean
}

/** A bounded, cursor-paged listing. `complete` is false when the page is a truncated window. */
export interface CandidateSourcePage {
  readonly sources: readonly CandidateSourceRecord[]
  readonly nextCursor?: string
  readonly complete: boolean
  readonly totalKnown?: number
}

export interface CandidateSourcePageRequest {
  readonly limit?: number
  readonly cursor?: string
  readonly filter?: Omit<CandidateSourceListFilter, 'limit'>
}

/**
 * Control persistence for candidate sources (design §2.1). The legacy synchronous methods are
 * kept byte-for-byte so existing stores and callers still compile; the richer cursor-paged list,
 * append-only review command and review history are optional additions a store may adopt. An
 * implementation that does not yet provide them simply leaves the optional method undefined.
 */
export interface CandidateSourceStore {
  putSource(scopeRef: ScopeRef, input: { readonly source: CandidateSource; readonly idempotencyKey: string }, ctx: ToolContext): Promise<CandidateSourceRecord>
  getSource(scopeRef: ScopeRef, sourceId: Uuid, ctx: ToolContext): Promise<CandidateSourceRecord | undefined>
  listSources(scopeRef: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter, ctx: ToolContext): Promise<readonly CandidateSourceRecord[]>
  /** Promote or reject a proposed source; `expectedRevision` is a compare-and-swap fence. */
  reviewSource(scopeRef: ScopeRef, input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string; readonly expectedRevision: string; readonly idempotencyKey: string }, ctx: ToolContext): Promise<CandidateSourceRecord>
  /** Cursor-paged listing that reports completeness instead of silently truncating. */
  listSourcesPage?(scopeRef: ScopeRef, workspaceId: Uuid, page: CandidateSourcePageRequest, ctx: ToolContext): Promise<CandidateSourcePage>
  /** Append an auditable review event and return an idempotent receipt. */
  reviewSourceCommand?(scopeRef: ScopeRef, command: CandidateSourceReviewCommand, ctx: ToolContext): Promise<CandidateSourceReviewReceipt>
  /** Read the append-only review history of one source, bounded and paged. */
  listReviewEvents?(scopeRef: ScopeRef, sourceId: Uuid, page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext): Promise<{ readonly events: readonly CandidateSourceReviewEvent[]; readonly nextCursor?: string }>
}

export const CANDIDATE_SOURCE_KINDS: readonly CandidateSourceKind[] = ['upload', 'web_fetch', 'standard_ref']
export const CANDIDATE_SOURCE_REVIEW_STATES: readonly CandidateSourceReviewState[] = ['proposed', 'approved', 'rejected']
export const SOURCE_TRUST_TIERS: readonly SourceTrustTier[] = ['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic']

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRevision(value: unknown): value is RevisionString {
  return typeof value === 'string' && REVISION_PATTERN.test(value)
}

function assertOptionalCandidateSourceFields(value: Record<string, unknown>): void {
  if (value['title'] !== undefined && (!isNonEmptyString(value['title']) || value['title'].length > 512)) {
    throw new CandidateSourceError('INVALID_SOURCE', 'a candidate source title must be a non-empty string of at most 512 characters')
  }
  if (value['researchRunId'] !== undefined && !isUuid(value['researchRunId'])) {
    throw new CandidateSourceError('INVALID_SOURCE', 'a candidate source researchRunId must be a uuid')
  }
  const reviewRecordRefs = value['reviewRecordRefs']
  if (reviewRecordRefs !== undefined) {
    if (!Array.isArray(reviewRecordRefs) || reviewRecordRefs.length > 64 || !reviewRecordRefs.every(isResourceRef)) {
      throw new CandidateSourceError('INVALID_SOURCE', 'candidate source review record refs must be at most 64 resource references')
    }
    const ids = new Set(reviewRecordRefs.map((ref) => ref.id))
    if (ids.size !== reviewRecordRefs.length) {
      throw new CandidateSourceError('INVALID_SOURCE', 'candidate source review record refs must be distinct')
    }
  }
}

/** Runtime validation at the immutable artifact boundary. */
export function assertCandidateSourceShape(value: unknown): asserts value is CandidateSource {
  if (!isRecord(value) || value.schemaVersion !== 'candidate-source@1'
    || !isUuid(value.sourceId) || !isUuid(value.workspaceId)
    || !CANDIDATE_SOURCE_KINDS.includes(value.kind as CandidateSourceKind)
    || !SOURCE_TRUST_TIERS.includes(value.trustTier as SourceTrustTier)
    || !isRecord(value.origin) || !isResourceRef(value.contentRef)
    || typeof value.contentDigest !== 'string' || !SHA256_PATTERN.test(value.contentDigest)
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(value.reviewState as CandidateSourceReviewState)
    || typeof value.proposedBy !== 'string' || value.proposedBy.length === 0
    || typeof value.recordedAt !== 'string') {
    throw new CandidateSourceError('INVALID_SOURCE', 'invalid candidate source')
  }
  assertOptionalCandidateSourceFields(value)
}

/** Runtime validation of a versioned review command before any audit event is appended. */
export function assertCandidateSourceReviewCommandShape(value: unknown): asserts value is CandidateSourceReviewCommand {
  if (!isRecord(value) || value.schemaVersion !== 'candidate-source-review@1'
    || !isUuid(value.sourceId) || !isUuid(value.workspaceId)
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(value.reviewState as CandidateSourceReviewState)
    || (value.trustTier !== undefined && !SOURCE_TRUST_TIERS.includes(value.trustTier as SourceTrustTier))
    || !isNonEmptyString(value.reviewedBy) || !isNonEmptyString(value.reason) || value.reason.length > 4000
    || !isRevision(value.expectedRevision) || !isNonEmptyString(value.idempotencyKey)
    || !Array.isArray(value.basisRefs) || value.basisRefs.length > 64 || !value.basisRefs.every(isResourceRef)) {
    throw new CandidateSourceError('INVALID_SOURCE', 'invalid candidate source review command')
  }
}
