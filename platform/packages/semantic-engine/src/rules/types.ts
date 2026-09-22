import type {
  ControlReadProjectionRequest,
  DecimalQuantity,
  DomainResultStatus,
  RevisionString,
  ScopeRef,
  SemanticFilter,
  Sha256Digest,
  SourceRef,
  ValidityInterval,
  VersionRef,
} from '@ontology/contracts'

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

/** An exact decimal, categorical string or boolean assertion value. Floats are never exact. */
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
  readonly validity: ValidityInterval
  readonly sourceRef: SourceRef
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
}

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
  readonly conclusion: RuleConclusionSpec
}

/** A pinned reference to the exact fact version that supported a conclusion. */
export interface RuleFactRef {
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly digest: Sha256Digest
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
}

export interface RuleEvaluationResult {
  readonly scopeRef: ScopeRef
  readonly request: ControlReadProjectionRequest
  readonly definitionRef?: VersionRef
  readonly conclusions: readonly RuleConclusionResult[]
  readonly gaps: readonly string[]
  readonly conflicts: readonly RuleConflictResult[]
  readonly supports: SupportGraph
  /** Digest of the canonical input, so two evaluations of the same version compare equal. */
  readonly inputDigest: Sha256Digest
}
