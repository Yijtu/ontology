import type {
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'

/**
 * Structured answer-draft claims and the combined verification verdict (SPEC D7.4, C2,
 * US-021, FR-27/FR-28/FR-29, INV-09).
 *
 * A draft is not free prose: every numeric/unit/subject/time statement is a `DraftClaim`
 * bound to the exact evidence result it came from. That binding is what lets the verifier
 * locate an injected, unsupported conclusion to the specific claim, field and evidence
 * instead of returning a generic "verification failed".
 *
 * The types here are data only. The `DraftVerificationService` that consumes them lives in
 * `@ontology/application`; the JEV decision port stays a separate contract (ADR-09) and is
 * never allowed to author the explanation text.
 */

/** Whether a claim asserts an observed fact, a forecast, a computed value or a rule derivation. */
export type DraftClaimKind = 'observation' | 'prediction' | 'computation' | 'rule_derivation'

/**
 * A numeric value with its unit. Both are mandatory: D7.4 requires the unit to be bound to
 * the result, so a claim can never present a bare number the model transcribed by hand.
 */
export interface BoundQuantity {
  readonly value: number
  readonly unit: string
}

/** The business-time binding of a claim (D7.4: time is bound to the result). */
export interface ClaimTimeBinding {
  readonly asOf?: Rfc3339UtcTimestamp
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

/**
 * One evidence result a claim is bound to, plus the JSON Pointers that locate the bound
 * value, unit, subject and time inside that result payload. The verifier re-reads the
 * archived payload and checks each pointer, so a value that was never in the result is a
 * located failure rather than a trusted transcription.
 */
export interface ClaimResultBinding {
  readonly evidenceRef: ResourceRef
  /** The digest of the result the draft author believed it read. */
  readonly resultDigest: Sha256Digest
  readonly valuePointer: string
  readonly unitPointer: string
  readonly subjectPointer: string
  readonly timePointer?: string
}

/** One structured, result-bound claim of an answer draft. */
export interface DraftClaim {
  readonly claimId: Uuid
  /** The entity/subject the claim is about; must equal the bound result's subject. */
  readonly subject: string
  readonly predicate: string
  readonly value: BoundQuantity
  readonly time: ClaimTimeBinding
  readonly kind: DraftClaimKind
  /** At least one binding is required for a claim to be supportable. */
  readonly references: readonly ClaimResultBinding[]
}

/** Which check produced a finding. Hard findings are programmatic and outrank any score. */
export type VerificationFindingAxis = 'hard' | 'semantic' | 'policy'

export type VerificationFindingCode =
  | 'draft_hash_mismatch'
  | 'evidence_manifest_mismatch'
  | 'missing_claims'
  | 'claim_limit_exceeded'
  | 'unbound_claim'
  | 'evidence_not_found'
  | 'result_digest_mismatch'
  | 'result_unreadable'
  | 'number_mismatch'
  | 'unit_mismatch'
  | 'subject_mismatch'
  | 'time_mismatch'
  | 'stale_source'
  | 'semantic_unsupported'
  | 'semantic_insufficient'
  | 'semantic_unavailable'
  | 'visible_statement_unbound'

/**
 * A located verification problem. `claimId`/`field`/`evidenceRef`/`pointer` identify exactly
 * what failed; `expected`/`actual` are values computed by the verifier, never model prose.
 */
export interface VerificationFinding {
  readonly code: VerificationFindingCode
  readonly axis: VerificationFindingAxis
  readonly claimId?: Uuid
  readonly field?: string
  readonly evidenceRef?: ResourceRef
  readonly pointer?: string
  readonly expected?: string
  readonly actual?: string
}

/**
 * The human-readable explanation of one finding. `message` is always produced by the
 * restricted template registry from `code` and typed parameters; no JEV/decision text ever
 * reaches this field (D7.4, ADR-09).
 */
export interface ClaimExplanation {
  readonly code: VerificationFindingCode
  readonly templateId: NonEmptyString
  readonly message: string
  readonly claimId?: Uuid
  readonly field?: string
  readonly evidenceRef?: ResourceRef
}

/** Whether the policy requires, permits or forbids the JEV semantic review. */
export type SemanticReviewMode = 'required' | 'optional' | 'disabled'

/**
 * What to do when JEV is unavailable. `deterministic` keeps the hard checks and marks the
 * semantic axis as not run; `clarify` records `semantic_unavailable` so the controller can
 * ask for clarification. Neither fabricates a calibrated result (C2).
 */
export type JevUnavailableBehaviour = 'deterministic' | 'clarify'

/** The versioned policy a verdict binds. A model or request can never loosen it. */
export interface VerificationPolicy {
  readonly policyVersion: NonEmptyString
  /** The explanation-template registry version the verdict's explanations came from. */
  readonly templateVersion: NonEmptyString
  readonly semanticReview: SemanticReviewMode
  readonly onJevUnavailable: JevUnavailableBehaviour
  /** The definition version stamped on the fixed JEV decision questions. */
  readonly decisionDefinitionVersion: Semver
  /** Upper bound on structured claims the verifier will process. */
  readonly maxClaims: number
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  policyVersion: 'combined-verification-policy@1',
  templateVersion: 'restricted-explanation-templates@1',
  semanticReview: 'required',
  onJevUnavailable: 'deterministic',
  decisionDefinitionVersion: '1.0.0',
  maxClaims: 128,
}
