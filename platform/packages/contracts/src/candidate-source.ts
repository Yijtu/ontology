import type { ResourceRef, Sha256Digest, ScopeRef, Uuid, VersionRef } from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid } from './asset-workspace'
import type { SourceTrustTier } from './source-grounding'

/**
 * A proposed authoring source that is not yet part of an approved workspace corpus. It carries the
 * provenance tier the grounding gate reads (`customer_authoritative` / `public_standard` /
 * `agent_researched` / `synthetic`) plus where it came from and when it was retrieved, so a
 * human can review — promote or reject — it before it may ground a publishable candidate.
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
  readonly recordedAt: string
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

export interface CandidateSourceStore {
  putSource(scopeRef: ScopeRef, input: { readonly source: CandidateSource; readonly idempotencyKey: string }, ctx: ToolContext): Promise<CandidateSource>
  getSource(scopeRef: ScopeRef, sourceId: Uuid, ctx: ToolContext): Promise<CandidateSource | undefined>
  listSources(scopeRef: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter, ctx: ToolContext): Promise<readonly CandidateSource[]>
  /** Promote or reject a proposed source; `expectedRevision` is a compare-and-swap fence. */
  reviewSource(scopeRef: ScopeRef, input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly reviewedBy: string; readonly expectedRevision: string; readonly idempotencyKey: string }, ctx: ToolContext): Promise<CandidateSource>
}

export const CANDIDATE_SOURCE_KINDS: readonly CandidateSourceKind[] = ['upload', 'web_fetch', 'standard_ref']
export const CANDIDATE_SOURCE_REVIEW_STATES: readonly CandidateSourceReviewState[] = ['proposed', 'approved', 'rejected']
export const SOURCE_TRUST_TIERS: readonly SourceTrustTier[] = ['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic']

/** Runtime validation at the immutable artifact boundary. */
export function assertCandidateSourceShape(value: unknown): asserts value is CandidateSource {
  if (!isRecord(value) || value.schemaVersion !== 'candidate-source@1'
    || !isUuid(value.sourceId) || !isUuid(value.workspaceId)
    || !CANDIDATE_SOURCE_KINDS.includes(value.kind as CandidateSourceKind)
    || !SOURCE_TRUST_TIERS.includes(value.trustTier as SourceTrustTier)
    || !isRecord(value.origin) || !isResourceRef(value.contentRef)
    || typeof value.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.contentDigest)
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(value.reviewState as CandidateSourceReviewState)
    || typeof value.proposedBy !== 'string' || value.proposedBy.length === 0
    || typeof value.recordedAt !== 'string') {
    throw new CandidateSourceError('INVALID_SOURCE', 'invalid candidate source')
  }
}
