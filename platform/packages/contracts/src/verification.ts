import type {
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  Uuid,
  VersionRef,
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
  /** Legacy bounded numeric drafts may contain a JSON number; new writers use exact decimal strings. */
  readonly value: number | string
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
  /** Pointer to the result column descriptor that owns valuePointer. Required by answer-draft@2. */
  readonly fieldRefPointer?: string
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

/** Evidence pointers for typed non-numeric assertions. */
export interface AssertionEvidenceBinding {
  readonly evidenceRef: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly valuePointer: string
  readonly subjectPointer: string
  readonly timePointer?: string
  /** Pointer to the result column descriptor that owns valuePointer. */
  readonly fieldRefPointer?: string
  readonly documentPointer?: string
  readonly locatorPointer?: string
  readonly textDigestPointer?: string
  readonly quoteDigestPointer?: string
  readonly rulePointer?: string
  readonly computationPointer?: string
  /** Pointer to the exact relation edge/hop object the relation assertion is about. */
  readonly relationPointer?: string
  /** Pointer to the immutable document-version ref a citation was parsed from. */
  readonly documentVersionPointer?: string
}

interface TypedAssertionBase {
  readonly assertionId: Uuid
  readonly subject: string
  readonly predicate: string
  readonly asOf?: Rfc3339UtcTimestamp
  readonly references: readonly AssertionEvidenceBinding[]
}

/** Non-numeric statements shown in the published answer; every statement is result-bound. */
export type VerifiedAssertion =
  | (TypedAssertionBase & { readonly kind: 'string' | 'enum'; readonly value: string })
  | (TypedAssertionBase & { readonly kind: 'boolean'; readonly value: boolean })
  | (TypedAssertionBase & { readonly kind: 'entity_ref'; readonly value: ResourceRef; readonly displayName?: string })
  | (TypedAssertionBase & {
      readonly kind: 'relation_ref'
      readonly value: { readonly type: string; readonly from: ResourceRef; readonly to: ResourceRef }
      /** The pinned relation definition version the edge was published against. */
      readonly definitionRef?: VersionRef
      /** The exact published relation statement the edge came from. */
      readonly statementId?: string
      readonly statementVersion?: string
    })
  | (TypedAssertionBase & {
      readonly kind: 'rule_judgement'
      readonly value: 'true' | 'false' | 'unknown' | 'conflict'
      readonly ruleRef: VersionRef
      readonly premiseRefs: readonly ResourceRef[]
      /**
       * Which rule axis the verdict is about. `applicability` (the default for a legacy
       * assertion) is whether the rule condition holds and no exception fired;
       * `business_proposition` is the explicitly reviewed business conclusion and is only
       * definite when the artifact carries one. A model boolean can never invent either.
       */
      readonly judgementAxis?: 'applicability' | 'business_proposition'
      /** The exact computation digest the archived artifact must carry. */
      readonly computationDigest?: Sha256Digest
    })
  | (TypedAssertionBase & { readonly kind: 'document_quote'; readonly quote: string; readonly documentRef: ResourceRef; readonly locator: { readonly kind: 'page' | 'offset' | 'approximate_locator'; readonly page?: number; readonly startOffset?: number; readonly endOffset?: number; readonly normalizationMapRef?: string }; readonly quoteDigest: Sha256Digest; readonly textDigest: Sha256Digest; readonly precision: 'exact' | 'approximate'; readonly documentVersionRef?: ResourceRef })
  | (TypedAssertionBase & { readonly kind: 'artifact_summary'; readonly artifactRef: ResourceRef; readonly summary: string })

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
  | 'predicate_mismatch'
  | 'time_mismatch'
  | 'source_not_yet_valid'
  | 'stale_source'
  | 'semantic_unsupported'
  | 'semantic_insufficient'
  | 'semantic_unavailable'
  | 'evidence_reference_mismatch'
  | 'visible_statement_unbound'
  | 'assertion_mismatch'
  | 'document_quote_mismatch'
  | 'unverified_limitation'
  | 'rule_judgement_mismatch'
  | 'rule_premise_missing'
  | 'relation_endpoint_mismatch'
  | 'relation_version_mismatch'
  | 'row_binding_mismatch'
  | 'citation_locator_mismatch'

/**
 * A located verification problem. `claimId`/`field`/`evidenceRef`/`pointer` identify exactly
 * what failed; `expected`/`actual` are values computed by the verifier, never model prose.
 */
export interface VerificationFinding {
  readonly code: VerificationFindingCode
  readonly axis: VerificationFindingAxis
  readonly claimId?: Uuid
  readonly assertionId?: Uuid
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
  readonly assertionId?: Uuid
  readonly field?: string
  readonly evidenceRef?: ResourceRef
}

/** Status of the optional semantic decision pass; a deterministic fallback never claims it ran. */
export type SemanticReviewNotRunReason =
  | 'disabled'
  | 'no_claims'
  | 'not_configured'
  | 'provider_fallback'

export type SemanticReviewDisposition =
  | { readonly status: 'completed' }
  | { readonly status: 'not_run'; readonly reason: SemanticReviewNotRunReason }

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
