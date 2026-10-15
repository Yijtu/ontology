import type { RuleConditionState } from '@ontology/contracts'
import type { RuleConditionBranchState } from '@ontology/contracts'

/**
 * The shared finite boolean condition tree and its frozen four-state truth table (SPEC v0.3a
 * execution-evidence EX-4.1). The same plan and evaluation are used by the support checker, the
 * synthetic-case evaluator and the published-rule compiler, so a rule is judged by one compiler
 * instead of a second, looser reading.
 *
 * Truth table (frozen):
 *  - `all`: conflict, else false, else unknown, else true;
 *  - `any`: conflict, else true, else unknown, else false;
 *  - `not` is applied at lowering time to a single observed leaf and only flips true/false.
 */

export type FiniteConditionPlan<Leaf> =
  | { readonly kind: 'leaf'; readonly leaf: Leaf }
  | { readonly kind: 'all'; readonly children: readonly FiniteConditionPlan<Leaf>[] }
  | { readonly kind: 'any'; readonly children: readonly FiniteConditionPlan<Leaf>[] }

function childrenPath(path: string, index: number): string {
  return path.length === 0 ? String(index) : `${path}.${String(index)}`
}

/** Evaluate a finite condition tree; an absent leaf state is treated as `unknown`. */
export function evaluateFiniteCondition<Leaf>(
  plan: FiniteConditionPlan<Leaf>,
  evaluateLeaf: (leaf: Leaf) => RuleConditionState,
): RuleConditionState {
  switch (plan.kind) {
    case 'leaf':
      return evaluateLeaf(plan.leaf)
    case 'all': {
      const states = plan.children.map((child) => evaluateFiniteCondition(child, evaluateLeaf))
      if (states.includes('conflict')) return 'conflict'
      if (states.includes('false')) return 'false'
      if (states.includes('unknown')) return 'unknown'
      return 'true'
    }
    case 'any': {
      const states = plan.children.map((child) => evaluateFiniteCondition(child, evaluateLeaf))
      if (states.includes('conflict')) return 'conflict'
      if (states.includes('true')) return 'true'
      if (states.includes('unknown')) return 'unknown'
      return 'false'
    }
  }
}

/** Flatten a finite condition tree to its leaf states with deterministic dotted paths. */
export function collectConditionBranches<Leaf>(
  plan: FiniteConditionPlan<Leaf>,
  evaluateLeaf: (leaf: Leaf) => RuleConditionState,
  path = '',
): RuleConditionBranchState[] {
  switch (plan.kind) {
    case 'leaf':
      return [{ path, state: evaluateLeaf(plan.leaf) }]
    case 'all':
    case 'any':
      return plan.children.flatMap((child, index) =>
        collectConditionBranches(child, evaluateLeaf, childrenPath(path, index)),
      )
  }
}

/** The conjunction of leaf states, used when a rule declares no explicit condition tree. */
export function andConditionStates(states: readonly RuleConditionState[]): RuleConditionState {
  if (states.includes('conflict')) return 'conflict'
  if (states.includes('false')) return 'false'
  if (states.includes('unknown')) return 'unknown'
  return 'true'
}
