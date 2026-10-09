import type {
  ResourceRef,
  RuleComputationArtifact,
  RuleProvenanceSpan,
  Semver,
  CandidateSourceSpan,
  ParseCoverage,
} from '@ontology/contracts'

/**
 * Immutable materialized-rule support payload (V03-029, SPEC v0.3 A §5.2/§3.2).
 *
 * The wrapper preserves the exact `RuleComputationArtifact` the reader compares against its
 * append-only projection slice, and records the real parse/span conversions the producer
 * performed. Fact-premise spans and the reviewed rule's specification text are located on two
 * separate mappings so a complete fact graph is never mistaken for verified policy text.
 */

/** One authorized conversion from a raw published fact resource to an archived evidence envelope. */
export interface RuleDerivationSourceEvidenceMapping {
  readonly sourceCoverage?: ParseCoverage
  readonly premiseGroup: string
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly sourceStatementId: string
  readonly sourceRef: ResourceRef
  /** Logical document-version pin from the extraction candidate. */
  readonly documentVersionRef: ResourceRef
  /** Actual immutable parse original passed to DocumentSpanReader; its id can differ. */
  readonly documentRef: ResourceRef
  readonly parserVersion: Semver
  readonly sourceSpan: CandidateSourceSpan
  readonly evidenceRef: ResourceRef
}

/** Immutable attestation archived by a fact-premise document-span evidence envelope. */
export interface RuleSourceSpanArchiveBinding {
  readonly sourceCoverage?: ParseCoverage
  readonly schemaVersion: 'rule-source-span-binding@1'
  readonly premiseGroup: string
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly sourceStatementId: string
  readonly sourceRef: ResourceRef
  readonly documentVersionRef: ResourceRef
  /** Physical immutable original ref returned by the scoped parse record. */
  readonly documentRef: ResourceRef
  readonly parserVersion: Semver
  readonly sourceSpan: CandidateSourceSpan
  readonly textArtifactRef: ResourceRef
}

/**
 * One converted specification (policy) span of the reviewed rule text. The span is the exact
 * `RuleProvenanceSpan` carried on the published rule AST node, so its parse/chunk identity,
 * locator, span kind, precision and quote digest are unchanged; the additional refs record
 * where the immutable text and the `document_span` evidence were archived.
 */
export interface RulePolicySourceEvidenceMapping {
  readonly sourceCoverage?: ParseCoverage
  readonly span: RuleProvenanceSpan
  readonly documentVersionRef: ResourceRef
  /** Physical immutable original ref returned by the scoped parse record. */
  readonly documentRef: ResourceRef
  readonly parserVersion: Semver
  readonly textArtifactRef: ResourceRef
  readonly evidenceRef: ResourceRef
}

/** Immutable attestation archived by a specification-span document-span evidence envelope. */
export interface RulePolicySpanArchiveBinding {
  readonly sourceCoverage?: ParseCoverage
  readonly schemaVersion: 'rule-policy-span-binding@1'
  readonly span: RuleProvenanceSpan
  readonly documentVersionRef: ResourceRef
  /** Physical immutable original ref returned by the scoped parse record. */
  readonly documentRef: ResourceRef
  readonly parserVersion: Semver
  readonly textArtifactRef: ResourceRef
}

/** Wrapper used only when raw source resources were converted to evidence envelopes. */
export interface RuleDerivationSupportPayload {
  readonly schemaVersion: 'rule-derivation-support-payload@1'
  readonly artifact: RuleComputationArtifact
  readonly sourceEvidenceMappings: readonly RuleDerivationSourceEvidenceMapping[]
  readonly policySourceEvidenceMappings: readonly RulePolicySourceEvidenceMapping[]
  readonly premiseRefs?: readonly ResourceRef[]
}
