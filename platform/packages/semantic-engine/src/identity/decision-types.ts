import type {
  CandidateStore,
  EntityCandidate,
  ErrorCode,
  IdentityDecisionKind,
  IdentityDecisionRecord,
  IdentityDecisionStore,
  IdentityEntityRecord,
  IdentityScoreEvidence,
  IdentityStrongIdentity,
  IndustrySchemaSource,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  Uuid,
} from '@ontology/contracts'

/**
 * Entity adjudication: `match` / `create_pending` / `clarify` / `reject` plus the
 * corrective `split` (SPEC D4.5/D4.6, C6, US-014/US-015, FR-14/16/17).
 *
 * The service never recalls candidates (that is LOCAL-029) and never publishes
 * semantics (that is LOCAL-031). It receives the identity scope from the published
 * definition, applies the merge rules and persists an append-only decision version
 * through the injected `IdentityDecisionStore`.
 */

/** What a reviewer submits for one candidate. */
export interface IdentityDecisionRequest {
  readonly candidateId: Uuid
  readonly kind: IdentityDecisionKind
  /**
   * The decision head revision the reviewer read. `undefined` means the `If-Match`
   * header was absent and the call is rejected with `REVISION_REQUIRED` (428).
   */
  readonly expectedRevision: RevisionString | undefined
  /** Required for `match`/`split`; optional for `reject` (records a cannot-link). */
  readonly targetEntityId?: string
  /** `split` only: the candidate source records to separate. Defaults to the candidate. */
  readonly separatedCandidateIds?: readonly Uuid[]
  readonly evidenceRefs?: readonly ResourceRef[]
  /** A human justification; with a strong identity it authorises a merge. */
  readonly justification?: string
  /** A reviewer-confirmed native id/alias; it must match the candidate and a reviewed target-cluster identity. */
  readonly strongIdentity?: IdentityStrongIdentity
  /** A model/JEV similarity score. Supporting evidence only, never an authority to merge. */
  readonly scoreEvidence?: IdentityScoreEvidence
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

/** The reviewer-facing result of one decision. Carries no raw customer content. */
export interface IdentityDecisionView {
  readonly decisionId: Uuid
  readonly candidateId: Uuid
  readonly kind: IdentityDecisionKind
  readonly revision: RevisionString
  readonly objectId: string
  readonly identityScopeId: string
  readonly targetEntityId?: string
  readonly separatedCandidateIds?: readonly Uuid[]
  readonly supersedesRevision?: RevisionString
  readonly entity?: IdentityEntityRecord
  readonly invalidationOutboxId?: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface IdentityDecisionServiceDependencies {
  /** Append-only decision persistence (production: control PostgreSQL). */
  readonly store: IdentityDecisionStore
  /** The extraction candidates being adjudicated; the candidate is loaded, never trusted from the body. */
  readonly candidates: CandidateStore
  /** Published definitions; the identity scope/type is resolved from here, never from a name. */
  readonly schemaSource: IndustrySchemaSource
  /**
   * The minimum similarity score that may be recorded as *supporting* evidence. A score
   * below it is refused even as support; a score at or above it still never merges on its
   * own. Defaults to 0.8.
   */
  readonly scoreThreshold?: number
  readonly now?: () => string
  readonly newId?: () => string
}

export interface IdentityDecisionListFilter {
  readonly candidateId?: Uuid
  readonly limit?: number
}

export type IdentityDecisionErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'REVISION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'CANDIDATE_NOT_FOUND'
  | 'ENTITY_NOT_FOUND'
  | 'IDENTITY_CONFLICT'
  | 'IDENTITY_SCOPE_MISMATCH'
  | 'IDENTITY_EVIDENCE_REQUIRED'
  | 'IDENTITY_EVIDENCE_INVALID'
  | 'IDENTITY_SCORE_BELOW_THRESHOLD'

const PLATFORM_CODE: Readonly<Record<IdentityDecisionErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  REVISION_REQUIRED: 'INVALID_ARGUMENT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  CANDIDATE_NOT_FOUND: 'INVALID_ARGUMENT',
  ENTITY_NOT_FOUND: 'INVALID_ARGUMENT',
  IDENTITY_CONFLICT: 'DATA_CONFLICT',
  IDENTITY_SCOPE_MISMATCH: 'DATA_CONFLICT',
  IDENTITY_EVIDENCE_REQUIRED: 'INSUFFICIENT_DATA',
  IDENTITY_EVIDENCE_INVALID: 'INSUFFICIENT_DATA',
  IDENTITY_SCORE_BELOW_THRESHOLD: 'INSUFFICIENT_DATA',
}

/**
 * The HTTP status the route renders for each decision failure. Missing `If-Match` is 428
 * and a stale revision is 409 (`VERSION_CONFLICT`), matching C6/§6.
 */
const HTTP_STATUS: Readonly<Record<IdentityDecisionErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  FORBIDDEN: 403,
  INVALID_ARGUMENT: 400,
  REVISION_REQUIRED: 428,
  VERSION_CONFLICT: 409,
  CANDIDATE_NOT_FOUND: 404,
  ENTITY_NOT_FOUND: 404,
  IDENTITY_CONFLICT: 409,
  IDENTITY_SCOPE_MISMATCH: 409,
  IDENTITY_EVIDENCE_REQUIRED: 422,
  IDENTITY_EVIDENCE_INVALID: 422,
  IDENTITY_SCORE_BELOW_THRESHOLD: 422,
}

export class IdentityDecisionError extends Error {
  readonly code: IdentityDecisionErrorCode
  readonly platformCode: ErrorCode
  readonly httpStatus: number

  constructor(code: IdentityDecisionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IdentityDecisionError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
    this.httpStatus = HTTP_STATUS[code]
  }
}

export function isIdentityDecisionError(value: unknown): value is IdentityDecisionError {
  return value instanceof IdentityDecisionError
}

/** The entity type the definition declares for an extracted entity candidate. */
export interface ResolvedIdentityTarget {
  readonly objectId: string
  readonly identityScopeId: string
  readonly identityAttributeIds: readonly string[]
  readonly scopeDimensionIds: readonly string[]
  readonly scopeDimensions: Readonly<Record<string, string>>
  readonly candidate: EntityCandidate
}

export type { IdentityDecisionRecord }
