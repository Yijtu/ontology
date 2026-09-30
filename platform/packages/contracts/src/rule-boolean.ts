import type { RuleApplicabilityState, RuleConditionState } from './rule-extraction'
import type { RuleSupportFinding } from './rule-action-candidates'

/**
 * Finite boolean rule-condition contracts (SPEC v0.3a execution-evidence EX-4.1/EX-4.2,
 * issue V03-026 / #188).
 *
 * The executable subset is the frozen `RuleExpressionNode` grammar restricted to:
 *  - `compare` / `range` over one declared attribute;
 *  - finite `all` (AND) with at least one operand;
 *  - finite `any` that is a genuine different-condition OR (each branch is its own condition and
 *    keeps its own AST, state and sources; it is never lowered into a same-filter source group);
 *  - `not` over exactly one observed comparison/range leaf.
 * One-hop `relation` premises stay outside the first subset and are refused explicitly.
 *
 * The four axes below are separate and are never collapsed:
 *  - `applicability` — whether the rule's condition holds and no exception is triggered;
 *  - `propositionState` — the business proposition the rule may support;
 *  - `sourceConflicts` — disagreeing observations for one field;
 *  - `truncation` — whether the read that produced the inputs was cut off.
 * A missing observation is `unknown`; it is never defaulted to `false`.
 */

export type RuleBusinessPropositionState = 'true' | 'false' | 'unknown' | 'conflict'

/** The state of one branch of the finite condition tree, keyed by its dotted path. */
export interface RuleConditionBranchState {
  readonly path: string
  readonly state: RuleConditionState
}

/** Two or more disagreeing observations of one field, kept apart from a rule verdict. */
export interface RuleSourceConflict {
  readonly fieldRef: string
  readonly observedValues: readonly (string | number | boolean)[]
  readonly sourceIds: readonly string[]
  readonly reason: string
}

/** Whether the inputs were cut off; a truncated read can only yield `unknown`, never `false`. */
export interface RuleEvaluationTruncation {
  readonly truncated: boolean
  readonly reason?: string
}

/**
 * The four-state evaluation of one finite rule condition plus its explicit exceptions. It is the
 * value the synthetic-case evaluator returns and the shape a hard verifier can recompute.
 */
export interface FiniteRuleConditionEvaluation {
  readonly conditionState: RuleConditionState
  readonly exceptionStates: readonly { readonly exceptionId: string; readonly state: RuleConditionState }[]
  readonly applicability: RuleApplicabilityState
  readonly propositionState: RuleBusinessPropositionState
  readonly branchStates: readonly RuleConditionBranchState[]
  readonly sourceConflicts: readonly RuleSourceConflict[]
  readonly truncation: RuleEvaluationTruncation
  /** Non-empty iff the condition/exception is outside the supported subset; then it is refused. */
  readonly findings: readonly RuleSupportFinding[]
}
