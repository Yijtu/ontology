import type {
  DecimalQuantity,
  ControlReadProjectionRequest,
  DomainResultStatus,
  RevisionString,
  RuleProvenanceSpan,
  ScopeRef,
  SemanticFilter,
  Sha256Digest,
  ResourceRef,
  SourceRef,
  ValidityInterval,
  VersionRef,
} from '@ontology/contracts'
import type { FiniteConditionPlan } from './boolean'
import type { RuleEvaluationErrorCode } from './errors'

/**
 * Declarative rule evaluation and compact support DAG (SPEC D5/D5.1, C3/C4, US-016, FR-18).
 *
 * The evaluator is a pure, deterministic function of versioned inputs: explicit facts, support
 * rules and a bitemporal read request. It never reads a store, clock or random source, so the
 * same inputs always produce the same output and the application layer decides whether to
 * persist the result (LOCAL-033) or just answer a question on demand (D5.1).
 *
 * Two support semantics are kept distinct:
 *  - **AND premises of one derivation.** A rule justification needs every premise group.
 *  - **OR alternative supports.** A premise group holds several equivalent valid sources; one
 *    surviving source keeps the group satisfied (D5/INV-06).
 *
 * A support expression is stored as a compact DAG: the same fact, group, rule or conclusion is
 * one shared node, so evaluation is linear in the number of alternatives instead of enumerating
 * the Cartesian product of all source combinations (D5).
 */

/** An exact decimal quantity, categorical string or boolean assertion value. */
export type RuleDecimalValue = DecimalQuantity

export type RuleAssertionValue = DecimalQuantity | string | boolean

/** One version of a logical assertion as published into the append-only event stream (D3.1). */
export interface RuleFact {
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly op: 'assert' | 'correct' | 'retract'
  readonly subject: string
  readonly predicate: string
  readonly value?: RuleAssertionValue
  /** Parent immutable statement for attribute projections; outbox dependencies key the parent. */
  readonly sourceStatementId?: string
  /** Original published entity type and attribute identity, retained for scoped rule compilation. */
  readonly objectId?: string
  readonly attributeId?: string
  /** Schema pin supplied by the publication reader that loaded this statement page. */
  readonly schemaRef?: VersionRef
  readonly validity: ValidityInterval
  readonly sourceRef: SourceRef
  readonly sourceRefs?: readonly ResourceRef[]
  readonly evidenceId?: string
}

/**
 * One equivalent source inside a premise group. It resolves either to an explicit fact
 * (`assertionId`) or to another rule's derived conclusion (`propositionKey`). Exactly one is
 * present; a rule that references a derived proposition becomes a dependency edge and takes
 * part in cycle detection.
 */
export interface RulePremiseAlternative {
  readonly alternativeId: string
  readonly assertionId?: string
  readonly propositionKey?: string
}

/**
 * Whether a group is required to hold (`positive`) or is an explicit negation (`negative`).
 * D5 allows negation only on an explicit observed value or a condition that declares a complete
 * range. A negative group without `completeRange` is rejected instead of being weakened.
 */
export type RuleGroupPolarity = 'positive' | 'negative'

/** Premises in one group are OR alternatives; different groups are AND prerequisites (D5). */
export interface RulePremiseGroup {
  readonly groupId: string
  readonly filter: SemanticFilter
  readonly alternatives: readonly RulePremiseAlternative[]
  readonly polarity?: RuleGroupPolarity
  readonly completeRange?: boolean
  /** A negative group over present, explicitly published observations is sound without range closure. */
  readonly explicitObservation?: boolean
  /** Expected quantity unit; incompatible observations remain unknown instead of comparing amounts. */
  readonly unitCode?: string
}

/**
 * The rule's boolean condition as a finite tree over premise-group ids. When absent, the rule is
 * the AND of every premise group (backward compatible). An `any` node is a genuine
 * different-condition OR: each branch is its own condition and its own group, never a same-filter
 * alternative set (SPEC v0.3a EX-4.1/EX-4.2).
 */
export type RuleConditionPlan = FiniteConditionPlan<string>

/** The proposition a rule derives. The predicate defaults to the proposition key. */
export interface RuleConclusionSpec {
  readonly propositionKey: string
  readonly predicate?: string
  readonly value?: RuleAssertionValue
}

/** One declarative support rule: AND of OR premise groups plus a conclusion. */
export interface SupportRule {
  readonly ruleRef: VersionRef
  readonly ruleId: string
  readonly premiseGroups: readonly RulePremiseGroup[]
  /** Finite boolean tree over group ids; absent means the AND of all premise groups. */
  readonly condition?: RuleConditionPlan
  readonly conclusion: RuleConclusionSpec
  /** Published instances contribute positive support only; a refuted condition is not proposition=false. */
  readonly publishedInstance?: PublishedRuleInstanceMetadata
}

export interface PublishedRuleInstanceMetadata {
  readonly ruleId: string
  readonly ruleVersionId: string
  readonly publishedRevision: RevisionString
  readonly ruleRef: VersionRef
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  readonly instanceKey: string
  readonly objectId: string
  readonly subjectEntityId: string
  readonly propositionKey: string
  readonly predicate: string
  /** Set false for reviewed business-consequence clones; the applicability rule still runs. */
  readonly emitApplicabilityArtifact?: boolean
  readonly conditionGroupIds: readonly string[]
  readonly exceptions: readonly {
    readonly exceptionId: string
    readonly groupIds: readonly string[]
  }[]
  readonly sourceSpans: readonly RuleProvenanceSpan[]
}

export type RuleApplicabilityState = 'applicable' | 'not_applicable' | 'unknown' | 'conflict'
export type RuleConditionState = 'true' | 'false' | 'unknown' | 'conflict'

export interface RuleExceptionState {
  readonly exceptionId: string
  readonly state: RuleConditionState
  readonly factRefs: readonly RuleFactRef[]
}

/** One published rule × subject result. It deliberately describes support, not business negation. */
export interface RuleApplicabilityResult {
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  readonly ruleRef: VersionRef
  readonly ruleId: string
  readonly ruleVersionId: string
  readonly publishedRevision: RevisionString
  readonly instanceKey: string
  readonly objectId: string
  readonly subjectEntityId: string
  readonly propositionKey: string
  readonly predicate: string
  readonly validAt?: string
  readonly asOfRecordedSeq?: RevisionString
  readonly state: RuleApplicabilityState
  readonly conditionState: RuleConditionState
  readonly exceptionStates: readonly RuleExceptionState[]
  readonly positiveSupport: boolean
  readonly factRefs: readonly RuleFactRef[]
  readonly sourceStatementIds: readonly string[]
  readonly inputDigest: Sha256Digest
  readonly computationDigest: Sha256Digest
  readonly sourceSpans: readonly RuleProvenanceSpan[]
  readonly complete: boolean
}

export interface RuleCapabilityIssue {
  readonly ruleId: string
  readonly ruleVersionId: string
  readonly publishedRevision: RevisionString
  readonly ruleRef?: VersionRef
  readonly objectId: string
  readonly subjectEntityId?: string
  readonly code: RuleEvaluationErrorCode
  readonly message: string
  readonly sourceSpans: readonly RuleProvenanceSpan[]
}

export interface PublishedRuleSubject {
  readonly subjectEntityId: string
  readonly objectId: string
}

export interface CompiledPublishedRuleInstance {
  readonly supportRule: SupportRule
  readonly ruleRef: VersionRef
  readonly ruleId: string
  readonly ruleVersionId: string
  readonly publishedRevision: RevisionString
  readonly instanceKey: string
  readonly objectId: string
  readonly subjectEntityId: string
  readonly propositionKey: string
  readonly predicate: string
}

export interface PublishedRuleCompilation {
  readonly instances: readonly CompiledPublishedRuleInstance[]
  readonly issues: readonly RuleCapabilityIssue[]
}

export interface AttributeProjectionIssue {
  readonly statementId: string
  readonly attributeId?: string
  readonly code: 'MALFORMED_ATTRIBUTES' | 'MALFORMED_ATTRIBUTE' | 'INVALID_VALUE' | 'DUPLICATE_ATTRIBUTE_ID'
  readonly message: string
}

export interface PublishedAttributeProjection {
  readonly facts: readonly RuleFact[]
  readonly issues: readonly AttributeProjectionIssue[]
}

/** A pinned reference to the exact fact version that supported a conclusion. */
export interface RuleFactRef {
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly digest: Sha256Digest
  readonly sourceStatementId?: string
  readonly sourceRefs?: readonly ResourceRef[]
}

export type SupportNodeState = 'satisfied' | 'refuted' | 'unknown' | 'conflict'

/** A shared leaf: one fact version, or one derived proposition, referenced by alternatives. */
export interface SupportLeafNode {
  readonly kind: 'fact'
  readonly nodeId: string
  /** `assertionId` for an explicit fact, `propositionKey` for a derived one. */
  readonly label: string
  readonly state: SupportNodeState
  readonly value?: RuleAssertionValue
}

/** One premise group node. `alternativeNodeIds` are shared leaf ids, never a combination. */
export interface SupportGroupNode {
  readonly kind: 'group'
  readonly nodeId: string
  readonly groupId: string
  readonly state: SupportNodeState
  readonly alternativeNodeIds: readonly string[]
}

/** One rule node: the AND of its group nodes. */
export interface SupportRuleNode {
  readonly kind: 'rule'
  readonly nodeId: string
  readonly ruleId: string
  readonly ruleRef: VersionRef
  readonly state: SupportNodeState
  readonly groupNodeIds: readonly string[]
}

/** One conclusion node: the OR of every rule path that derives the same proposition. */
export interface SupportConclusionNode {
  readonly kind: 'conclusion'
  readonly nodeId: string
  readonly propositionKey: string
  readonly state: SupportNodeState
  readonly ruleNodeIds: readonly string[]
}

export type SupportNode = SupportLeafNode | SupportGroupNode | SupportRuleNode | SupportConclusionNode

/** The compact support DAG. `nodes` is sorted by `nodeId` for deterministic comparison. */
export interface SupportGraph {
  readonly nodes: readonly SupportNode[]
  readonly conclusionNodeIds: readonly string[]
}

/** Which alternatives of a premise group a conclusion rests on. */
export interface RuleSatisfiedBy {
  readonly groupId: string
  readonly alternativeIds: readonly string[]
}

export interface RuleConclusionResult {
  /** The declared proposition label, matching the rule's `conclusion.propositionKey`. */
  readonly propositionKey: string
  /** Canonical identity including subject/unit/time/scope qualifiers (D5). */
  readonly qualifiedPropositionKey: Sha256Digest
  readonly predicate: string
  readonly domainStatus: DomainResultStatus
  readonly value?: RuleAssertionValue
  readonly satisfiedBy: readonly RuleSatisfiedBy[]
  readonly ruleRefs: readonly VersionRef[]
  readonly factRefs: readonly RuleFactRef[]
  readonly supportNodeId: string
}

export interface RuleConflictResult {
  readonly propositionKey: string
  readonly qualifiedPropositionKey: Sha256Digest
  readonly assertionIds: readonly string[]
  readonly values: readonly RuleAssertionValue[]
}

export interface RuleEvaluationInput {
  readonly scopeRef: ScopeRef
  readonly request: ControlReadProjectionRequest
  readonly facts: readonly RuleFact[]
  readonly rules: readonly SupportRule[]
  /** The pinned definition version the facts and rules were published against. */
  readonly definitionRef?: VersionRef
  /** False when an upstream page/cap stopped before the complete scope was loaded. */
  readonly complete?: boolean
}

export interface RuleEvaluationResult {
  readonly scopeRef: ScopeRef
  readonly request: ControlReadProjectionRequest
  readonly definitionRef?: VersionRef
  readonly conclusions: readonly RuleConclusionResult[]
  readonly applicabilities: readonly RuleApplicabilityResult[]
  readonly gaps: readonly string[]
  readonly conflicts: readonly RuleConflictResult[]
  readonly supports: SupportGraph
  /** Digest of the canonical input, so two evaluations of the same version compare equal. */
  readonly inputDigest: Sha256Digest
}
