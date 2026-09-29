import type {
  RuleConditionState,
  SemanticFilter,
  SyntheticCaseEvaluator,
  SyntheticCaseField,
  SyntheticRuleEvaluation,
} from '@ontology/contracts'
import { canonicalDecimalString } from '@ontology/core'
import { lowerConditionLeaves } from '../rules/support'
import type { LoweredConditionLeaf } from '../rules/support'
import { evaluateFilter } from '../rules/values'
import type { RuleAssertionValue } from '../rules/types'

/**
 * The finite-grammar synthetic case evaluator (SPEC v0.3a asset-ui §3.4, issue V03-014 / #186).
 *
 * It judges one synthetic case against one rule condition with the SAME lowering the support
 * checker uses (`lowerConditionLeaves`) and the SAME value/filter semantics the rule evaluator
 * uses (`evaluateFilter`). A missing value is `unknown`, never `false`; two disagreeing values
 * for one field are `conflict`. The evaluator is pure and deterministic so a validation report
 * is reproducible.
 */

const FILTER_OP: Readonly<Record<string, SemanticFilter['op']>> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  between: 'between',
  in: 'in',
}

function negate(state: RuleConditionState): RuleConditionState {
  if (state === 'true') return 'false'
  if (state === 'false') return 'true'
  return state
}

function andStates(states: readonly RuleConditionState[]): RuleConditionState {
  if (states.some((state) => state === 'conflict')) return 'conflict'
  if (states.some((state) => state === 'false')) return 'false'
  if (states.some((state) => state === 'unknown')) return 'unknown'
  return 'true'
}

function assertionValueOf(field: SyntheticCaseField): RuleAssertionValue {
  if (typeof field.value === 'number') {
    return { amount: canonicalDecimalString(String(field.value)) ?? String(field.value), unit: field.unitCode ?? '' }
  }
  if (typeof field.value === 'boolean') return field.value
  if (field.unitCode !== undefined) {
    const text = typeof field.value === 'string' ? field.value : String(field.value)
    return { amount: canonicalDecimalString(text) ?? text, unit: field.unitCode }
  }
  return typeof field.value === 'string' ? field.value : ''
}

function groupedFields(fields: readonly SyntheticCaseField[]): Map<string, SyntheticCaseField[]> {
  const grouped = new Map<string, SyntheticCaseField[]>()
  for (const field of fields) {
    const bucket = grouped.get(field.fieldId)
    if (bucket === undefined) grouped.set(field.fieldId, [field])
    else bucket.push(field)
  }
  return grouped
}

function valueKey(field: SyntheticCaseField): string {
  return JSON.stringify({ value: field.value, unitCode: field.unitCode ?? null })
}

function evaluateLeaf(leaf: LoweredConditionLeaf, grouped: ReadonlyMap<string, SyntheticCaseField[]>): RuleConditionState {
  const candidates = grouped.get(leaf.attributeId) ?? []
  const present = candidates.filter((field) => field.value !== null)
  if (present.length === 0) return 'unknown'
  if (present.length > 1) {
    const distinct = new Set(present.map(valueKey))
    if (distinct.size > 1) return 'conflict'
  }
  const field = present[0]
  if (field === undefined) return 'unknown'
  if (leaf.unitCode !== undefined && field.unitCode !== leaf.unitCode) return 'unknown'
  const filter: SemanticFilter = {
    fieldRef: leaf.attributeId,
    op: FILTER_OP[leaf.operator] ?? 'eq',
    values: [...leaf.values],
  }
  const matched = evaluateFilter(filter, assertionValueOf(field))
  const state: RuleConditionState = matched === undefined ? 'unknown' : matched ? 'true' : 'false'
  return leaf.negative ? negate(state) : state
}

function evaluateCondition(
  condition: Parameters<SyntheticCaseEvaluator['evaluateRule']>[0]['condition'],
  grouped: ReadonlyMap<string, SyntheticCaseField[]>,
): RuleConditionState {
  const lowered = lowerConditionLeaves(condition)
  if (lowered.findings.length > 0) return 'unknown'
  return andStates(lowered.leaves.map((leaf) => evaluateLeaf(leaf, grouped)))
}

export class FiniteGrammarSyntheticEvaluator implements SyntheticCaseEvaluator {
  evaluateRule(input: {
    readonly condition: Parameters<SyntheticCaseEvaluator['evaluateRule']>[0]['condition']
    readonly exceptions: Parameters<SyntheticCaseEvaluator['evaluateRule']>[0]['exceptions']
    readonly fields: readonly SyntheticCaseField[]
  }): SyntheticRuleEvaluation {
    const grouped = groupedFields(input.fields)
    const rawCondition = evaluateCondition(input.condition, grouped)
    const exceptionStates = input.exceptions.map((exception) => ({
      exceptionId: exception.exceptionId,
      state: evaluateCondition(exception.condition, grouped),
    }))
    // The rule applies as `all(condition, not(exception))`; the effective condition state folds
    // each exception in so an expectation is judged against the rule the platform will execute.
    const conditionState = andStates([rawCondition, ...exceptionStates.map((entry) => negate(entry.state))])
    return { conditionState, exceptionStates }
  }
}
