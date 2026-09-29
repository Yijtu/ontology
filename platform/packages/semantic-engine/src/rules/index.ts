/**
 * Declarative rule evaluation and compact support DAG (SPEC D5/D5.1, C3/C4, US-016, FR-18).
 *
 * The module is a pure, deterministic evaluator over versioned facts and support rules. It keeps
 * AND premise groups and OR alternative supports distinct, shares support structure in a compact
 * DAG instead of enumerating every source combination, never coerces unknown or conflict to
 * `true`, and rejects cycles and unsupported negation with a typed error. It does not
 * materialise a projection (LOCAL-033) or expose a provenance/history API (LOCAL-034).
 */
export { RuleEvaluator } from './evaluate'
export { RuleEvaluationError, isRuleEvaluationError } from './errors'
export type { RuleEvaluationErrorCode } from './errors'
export { compilePublishedRuleInstances, supportRuleFromPublishedRule } from './compile'
export type { PublishedRuleCompilerOptions } from './compile'
export { projectPublishedAttributeFacts, ruleFactsFromStatements } from './from-published'
export type { PublishedAttributeProjectionOptions } from './from-published'
export { conclusionQualifiedKey, factQualifiedKey, qualifiedPropositionKey } from './proposition'
export type { PropositionQualifiers } from './proposition'
export {
  assertSupportedFilter,
  canonicalDecimalString,
  compareDecimal,
  evaluateFilter,
  filterMatches,
  isDecimalQuantity,
  isRuleDecimalValue,
} from './values'
export type {
  AttributeProjectionIssue,
  CompiledPublishedRuleInstance,
  PublishedAttributeProjection,
  PublishedRuleCompilation,
  PublishedRuleSubject,
  RuleApplicabilityResult,
  RuleApplicabilityState,
  RuleAssertionValue,
  RuleConclusionResult,
  RuleConclusionSpec,
  RuleConflictResult,
  RuleEvaluationInput,
  RuleEvaluationResult,
  RuleFact,
  RuleFactRef,
  RuleCapabilityIssue,
  RuleConditionState,
  RuleDecimalValue,
  RuleExceptionState,
  RuleGroupPolarity,
  RulePremiseAlternative,
  RulePremiseGroup,
  PublishedRuleInstanceMetadata,
  RuleSatisfiedBy,
  SupportConclusionNode,
  SupportGraph,
  SupportGroupNode,
  SupportLeafNode,
  SupportNode,
  SupportNodeState,
  SupportRule,
  SupportRuleNode,
} from './types'
