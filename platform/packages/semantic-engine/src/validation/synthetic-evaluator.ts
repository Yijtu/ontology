import type {
  FiniteRuleConditionEvaluation,
  RuleConditionState,
  RuleSourceConflict,
  SemanticFilter,
  SyntheticCaseEvaluator,
  SyntheticCaseField,
} from '@ontology/contracts'
import { assessRuleSupport } from '@ontology/contracts'
import { canonicalDecimalString } from '@ontology/core'
import { collectConditionBranches, evaluateFiniteCondition } from '../rules/boolean'
import { lowerConditionPlan } from '../rules/support'
import type { LoweredConditionLeaf, LoweredConditionPlan } from '../rules/support'
import { evaluateFilter } from '../rules/values'
import type { RuleAssertionValue } from '../rules/types'

/**
 * The finite-grammar synthetic case evaluator (SPEC v0.3a asset-ui §3.4, issue V03-014 / #186;
 * EX-4.1 different-condition OR, issue V03-026 / #188).
 *
 * It judges one synthetic case against one rule condition with the SAME lowering the support
 * checker uses (`lowerConditionPlan`) and the SAME value/filter semantics the rule evaluator
 * uses (`evaluateFilter`). The frozen finite subset includes genuine different-condition OR, so
 * `operating_hours >= 100 OR alarm = true` is a real OR and each branch keeps its own state.
 *
 * The four axes are reported separately: `applicability`, `propositionState`, `sourceConflicts`
 * and `truncation`. A missing value is `unknown`, never `false`; two disagreeing values for one
 * field are `conflict` and are surfaced as a source conflict, never resolved to a value. The
 * evaluator is pure and deterministic so a validation report is reproducible.
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

function leafConflict(leaf: LoweredConditionLeaf, grouped: ReadonlyMap<string, SyntheticCaseField[]>): RuleSourceConflict | undefined {
  const present = (grouped.get(leaf.attributeId) ?? []).filter((field) => field.value !== null)
  if (present.length <= 1) return undefined
  const distinct = new Set(present.map(valueKey))
  if (distinct.size <= 1) return undefined
  const values: (string | number | boolean)[] = []
  for (const field of present) {
    if (field.value !== null && !values.includes(field.value)) values.push(field.value)
  }
  return {
    fieldRef: leaf.attributeId,
    observedValues: values,
    sourceIds: present.map((field) => field.fieldId),
    reason: 'two or more independent observations of one field disagree',
  }
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

function conflictFromLeaf(
  leaf: LoweredConditionLeaf,
  grouped: ReadonlyMap<string, SyntheticCaseField[]>,
): RuleSourceConflict | undefined {
  return leaf.negative ? undefined : leafConflict(leaf, grouped)
}

export class FiniteGrammarSyntheticEvaluator implements SyntheticCaseEvaluator {
  evaluateRule(input: {
    readonly condition: Parameters<SyntheticCaseEvaluator['evaluateRule']>[0]['condition']
    readonly exceptions: Parameters<SyntheticCaseEvaluator['evaluateRule']>[0]['exceptions']
    readonly fields: readonly SyntheticCaseField[]
    readonly truncated?: boolean
  }): FiniteRuleConditionEvaluation {
    const grouped = groupedFields(input.fields)
    const condition = lowerConditionPlan(input.condition)
    const rawConditionState =
      condition.plan === undefined ? 'unknown' : evaluateFiniteCondition(condition.plan, (leaf) => evaluateLeaf(leaf, grouped))
    // A truncated read may be missing observations, so it can never yield a determinate verdict;
    // an explicit conflict is a definite disagreement and is preserved.
    const truncated = input.truncated === true
    const conditionState: RuleConditionState = truncated && rawConditionState !== 'conflict' ? 'unknown' : rawConditionState
    const branchStates =
      condition.plan === undefined ? [] : collectConditionBranches(condition.plan, (leaf) => evaluateLeaf(leaf, grouped))

    const sourceConflicts: RuleSourceConflict[] = []
    if (condition.plan !== undefined) collectConflicts(condition.plan, grouped, sourceConflicts)

    const findings = [...condition.findings]
    const exceptionStates: { exceptionId: string; state: RuleConditionState }[] = []
    for (const exception of input.exceptions) {
      const lowered = lowerConditionPlan(exception.condition)
      findings.push(...lowered.findings)
      const state =
        lowered.plan === undefined ? 'unknown' : evaluateFiniteCondition(lowered.plan, (leaf) => evaluateLeaf(leaf, grouped))
      exceptionStates.push({ exceptionId: exception.exceptionId, state })
    }

    const assessment = assessRuleSupport(conditionState, exceptionStates)
    return {
      conditionState,
      exceptionStates,
      applicability: assessment.applicability,
      propositionState: assessment.propositionState,
      branchStates,
      sourceConflicts,
      truncation: truncated ? { truncated: true, reason: 'the synthetic sample was cut off' } : { truncated: false },
      findings,
    }
  }
}

function collectConflicts(
  plan: LoweredConditionPlan,
  grouped: ReadonlyMap<string, SyntheticCaseField[]>,
  out: RuleSourceConflict[],
): void {
  if (plan.kind === 'leaf') {
    const conflict = conflictFromLeaf(plan.leaf, grouped)
    if (conflict !== undefined) out.push(conflict)
    return
  }
  for (const child of plan.children) collectConflicts(child, grouped, out)
}
