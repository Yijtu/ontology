import type { ControlReadProjectionRequest, DecimalQuantity, DocumentSpan, ResourceRef, RevisionString, ScopeRef, Sha256Digest, SourceRef, Uuid, ValidityInterval, VersionRef } from './generated/contracts'
import type { SemanticDefinitionVersion } from './semantic-definitions'
import type { PublishedExecutableRule, PublishedStatement } from './semantic-publication'
import type { IdentityPublishedBinding } from './identity-decisions'
import type { ToolContext } from './trusted'
import type { CandidateRecord, StructuredCandidateSourceSpan } from './extraction'
import type { SpanPrecision } from './document-parse'
import type { ExactScalarDecimal } from './materialization'
import type { RuleDependencyReference } from './rule-action-candidates'

/**
 * Bounded rule AST and rule-candidate contracts (SPEC D4.3/D5, US-013/US-015, FR-14/FR-15).
 *
 * The extractor may only represent the rule subset the semantic engine can publish and later
 * evaluate: typed `all`/`any`, explicit attribute comparison, numeric ranges and confirmed
 * relation queries. Every node carries the source spans it was derived from, so an AND/OR
 * operand, a negation, a unit-bearing condition, an applicability scope and an exception can
 * each be traced back to the original text (D4.1/D4.3).
 *
 * An expression outside this subset is never weakened into a looser rule. It is recorded as
 * an explicit unhandled item with a reason (see `RuleUnhandledReason`) and enters review. The
 * shape mirrors `RuleExpression` in `@ontology/semantic-engine`, but lives in `contracts` so
 * the application layer can build a candidate without importing the definition service.
 */

export type RuleComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

/** An explicitly reviewed business conclusion attached to one published rule. */
export interface RuleConclusionBinding {
  /** The exact attribute/predicate declared on the rule's scoped object. */
  readonly predicate: string
  readonly value: DecimalQuantity | ExactScalarDecimal | string | boolean
}

export type RuleApplicabilityState = 'applicable' | 'not_applicable' | 'unknown' | 'conflict'
export type RuleConditionState = 'true' | 'false' | 'unknown' | 'conflict'

export interface RuleComputationFactRef {
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly digest: Sha256Digest
  readonly sourceStatementId?: string
  readonly sourceRefs?: readonly ResourceRef[]
}

/** Exact official observations consumed by a rule, including edge endpoints and tombstones. */
export interface RulePremiseObservation {
  readonly projectId?: string
  readonly assertionId: string
  readonly relation?: { readonly relationId: string; readonly targetEntityId?: string; readonly targetObjectId: string; readonly endpointResolved: boolean }
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly op: 'assert' | 'correct' | 'retract'
  readonly subject: string
  readonly predicate: string
  readonly value?: RuleConclusionBinding['value']
  readonly sourceStatementId?: string
  readonly objectId?: string
  readonly attributeId?: string
  readonly schemaRef?: VersionRef
  readonly validity: ValidityInterval
  readonly sourceRef: SourceRef
  readonly sourceRefs?: readonly ResourceRef[]
  readonly evidenceId?: string
}

/** Saved at materialization, before mutable publication heads can change. No compiled AST. */
export interface RulePremiseReplayInput {
  readonly request: ControlReadProjectionRequest
  readonly definition?: SemanticDefinitionVersion
  readonly declarations: readonly PublishedExecutableRule[]
  readonly attributeStatements: readonly PublishedStatement[]
  readonly relationStatements: readonly PublishedStatement[]
  readonly identityBindings: readonly IdentityPublishedBinding[]
  readonly subjects: readonly { readonly subjectEntityId: string; readonly objectId: string; readonly projectId?: string }[]
  readonly facts: readonly RulePremiseObservation[]
  readonly completeRangeAttributeIds: readonly string[]
  readonly evaluatedRuleIds: readonly string[]
  readonly complete: boolean
}

/** Independent archived-input verification, implemented by the semantic engine, injected by host. */
export interface RulePremiseReplayPort {
  verify(input: { readonly artifact: unknown; readonly payload: unknown }, ctx: ToolContext): Promise<boolean>
}

/** Authorized read of one real original row/cell using its stored mapping/parser pins. */
export interface RuleStructuredPremiseSourcePort {
  read(candidate: CandidateRecord, span: StructuredCandidateSourceSpan, ctx: ToolContext): Promise<{
    readonly documentRef: ResourceRef
    readonly documentVersionRef: ResourceRef
    readonly parserVersion: string
    /** The exact UTF-8 row fingerprint input, containing original raw tokens and cell kinds. */
    readonly rowText: string
  } | undefined>
}

/** The durable typed result of computing one published rule against one entity. */
export interface RuleComputationArtifact {
  readonly premiseInput?: RulePremiseReplayInput
  readonly publishedPackRef?: VersionRef
  readonly dependencyRefs?: readonly RuleDependencyReference[]
  readonly projectId?: string
  readonly schemaVersion: 'rule-computation-artifact@1'
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  readonly ruleRef: VersionRef
  readonly ruleId: string
  readonly ruleVersionId: Uuid
  /** The source store's raw immutable revision (not the serialized SemVer ref). */
  readonly publishedRevision: RevisionString
  readonly instanceKey: string
  readonly objectId: string
  readonly subjectEntityId: string
  readonly predicate: string
  readonly validAt?: string
  readonly asOfRecordedSeq?: RevisionString
  readonly applicability: {
    readonly state: RuleApplicabilityState
    readonly conditionState: RuleConditionState
    readonly exceptionStates: readonly {
      readonly exceptionId: string
      readonly state: RuleConditionState
      readonly factRefs: readonly RuleComputationFactRef[]
    }[]
    readonly positiveSupport: boolean
  }
  readonly factRefs: readonly RuleComputationFactRef[]
  readonly sourceStatementIds: readonly string[]
  /** Present only for a consequence that was explicitly reviewed against this definition. */
  readonly businessConclusion?: RuleConclusionBinding
  readonly inputDigest: Sha256Digest
  readonly computationDigest: Sha256Digest
  readonly sourceSpans: readonly RuleProvenanceSpan[]
  readonly complete: boolean
}

/**
 * The provenance of one AST element. It keeps the parse/chunk identity and the locator the
 * parse stage produced (LOCAL-023) so an element is traceable to the exact source location,
 * and `precision` stays `approximate` for an OCR span.
 */
export interface RuleProvenanceSpan {
  readonly parseId: Uuid
  readonly chunkId: Uuid
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: SpanPrecision
  readonly quoteDigest: Sha256Digest
}

export interface RuleComparisonNode {
  readonly op: 'compare'
  readonly attributeId: string
  readonly operator: RuleComparisonOperator
  readonly value: string | number | boolean
  /** Required when the compared attribute is a quantity, so the unit is not lost. */
  readonly unitCode?: string
  readonly spans: readonly RuleProvenanceSpan[]
}

export interface RuleRangeNode {
  readonly op: 'range'
  readonly attributeId: string
  readonly min?: number
  readonly max?: number
  readonly unitCode?: string
  readonly spans: readonly RuleProvenanceSpan[]
}

export interface RuleRelationNode {
  readonly op: 'relation'
  readonly relationId: string
  /** Reviewed rule-specific condition on the schema-declared target; positive finite subset. */
  readonly targetCondition?: RuleExpressionNode
  readonly spans: readonly RuleProvenanceSpan[]
}

export interface RuleAllNode {
  readonly op: 'all'
  readonly operands: readonly RuleExpressionNode[]
  readonly spans: readonly RuleProvenanceSpan[]
}

export interface RuleAnyNode {
  readonly op: 'any'
  readonly operands: readonly RuleExpressionNode[]
  readonly spans: readonly RuleProvenanceSpan[]
}

/** Explicit negation. It only negates an observed value or a declared complete-range condition. */
export interface RuleNotNode {
  readonly op: 'not'
  readonly operand: RuleExpressionNode
  readonly spans: readonly RuleProvenanceSpan[]
}

export type RuleExpressionNode =
  | RuleComparisonNode
  | RuleRangeNode
  | RuleRelationNode
  | RuleAllNode
  | RuleAnyNode
  | RuleNotNode

/**
 * One exception attached to a rule. An exception stays attached to its rule even when the
 * source text lives in a different chunk or section; the semantic reading is
 * `all(condition, not(exception))`, but the exception is kept as a distinct element so it can
 * never be silently dropped.
 */
export interface RuleExceptionNode {
  readonly exceptionId: string
  readonly condition: RuleExpressionNode
  readonly spans: readonly RuleProvenanceSpan[]
}

/**
 * How much a rule can affect downstream computation. A high-impact rule always needs a human
 * review before it can ever be published; a low-impact rule is only eligible for a configured
 * publication policy. Neither is auto-published by extraction (D4.6).
 */
export type RuleImpact = 'high' | 'low'

export type RuleReviewRequirement = 'required' | 'policy_eligible'

/** A contradictory rule found on the same applicability scope. Surfaced, never auto-picked. */
export interface RuleConflict {
  readonly withRuleId: string
  readonly withCandidateId: Uuid
  readonly attributeId: string
  readonly reason: string
}

/**
 * Why the extractor could not faithfully represent a rule. Each code is an explicit, queryable
 * state; an unhandled rule is never converted into a looser one.
 */
export type RuleUnhandledReason =
  | 'UNSUPPORTED_OPERATOR'
  | 'UNSUPPORTED_QUANTIFIER'
  | 'CYCLIC_EXPRESSION'
  | 'UNRESOLVED_REFERENCE'
  | 'EXCEPTION_UNREPRESENTABLE'
  | 'UNRESOLVED_EXCEPTION_TARGET'
  | 'MALFORMED_EXPRESSION'

/** The draft a generation response carries before it is validated into a bounded AST. */
export interface DraftRuleException {
  readonly targetRuleId: string
  readonly condition: unknown
}

export interface DraftRule {
  readonly ruleId: string
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly impact: RuleImpact
  readonly expression: unknown
  readonly exceptions: readonly unknown[]
  /** Optional proposed consequence; it remains untrusted until schema validation and review. */
  readonly conclusion?: unknown
  readonly ruleDependencies?: readonly string[]
  readonly dependencyRefs?: readonly RuleDependencyReference[]
}
