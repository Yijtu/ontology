import type {
  RuleExpressionNode,
  RuleSupportFinding,
  RuleSupportReport,
  RuleSupportValidationInput,
  RuleSupportValidator,
} from '@ontology/contracts'

/**
 * Deterministic finite-grammar support checker (SPEC v0.3a execution-evidence §4.1, §5.2,
 * issue V03-010 / #184).
 *
 * It consumes the FROZEN `RuleExpressionNode` grammar and reports whether a proposed
 * condition/exception set is representable by the executable subset the publish stage and the
 * evaluator already enforce (`rules/compile.ts`). It never edits, drops or weakens a node: an
 * out-of-subset form is recorded verbatim as a `not_yet_executable` finding so the candidate
 * can be saved and reviewed, but it can never be enabled. The rule, SQL, compute and writer
 * stages all consume the same `rule-expression@1` grammar.
 *
 * The subset mirrors the evaluator exactly:
 *  - `compare` / `range` over one declared attribute;
 *  - finite `all` (AND);
 *  - `any` only when every branch is the SAME observed condition (an equivalent-source OR);
 *    genuinely different conditions are `DIFFERENT_CONDITION_OR`;
 *  - `not` over one observed comparison/range;
 *  - no `relation` premise yet (one-hop relation navigation is a later capability).
 * Declared rule dependencies must be acyclic and at most three levels deep.
 */

const MAX_DEPENDENCY_DEPTH = 3

interface LeafGroup {
  readonly attributeId: string
  readonly operator: string
  readonly values: readonly (string | number | boolean)[]
  readonly unitCode?: string
  readonly negative: boolean
}

function signature(group: LeafGroup): string {
  return JSON.stringify({
    attributeId: group.attributeId,
    operator: group.operator,
    values: group.values,
    unitCode: group.unitCode ?? null,
  })
}

function rangeGroup(node: Extract<RuleExpressionNode, { op: 'range' }>, path: string, findings: RuleSupportFinding[]): LeafGroup[] | undefined {
  if (node.min === undefined && node.max === undefined) {
    findings.push({
      code: 'UNSUPPORTED_RANGE',
      message: `range of ${node.attributeId} declares neither a minimum nor a maximum`,
      path,
      rawForm: node,
    })
    return undefined
  }
  if (node.min !== undefined && node.max !== undefined) {
    return [
      {
        attributeId: node.attributeId,
        operator: 'between',
        values: [node.min, node.max],
        ...(node.unitCode === undefined ? {} : { unitCode: node.unitCode }),
        negative: false,
      },
    ]
  }
  if (node.min !== undefined) {
    return [
      {
        attributeId: node.attributeId,
        operator: 'gte',
        values: [node.min],
        ...(node.unitCode === undefined ? {} : { unitCode: node.unitCode }),
        negative: false,
      },
    ]
  }
  if (node.max === undefined) return undefined
  return [
    {
      attributeId: node.attributeId,
      operator: 'lte',
      values: [node.max],
      ...(node.unitCode === undefined ? {} : { unitCode: node.unitCode }),
      negative: false,
    },
  ]
}

function lower(
  node: RuleExpressionNode,
  path: string,
  findings: RuleSupportFinding[],
): LeafGroup[] | undefined {
  switch (node.op) {
    case 'compare':
      if (node.attributeId.length === 0) {
        findings.push({
          code: 'UNRESOLVED_REFERENCE',
          message: 'a comparison names no attribute',
          path,
          rawForm: node,
        })
        return undefined
      }
      return [
        {
          attributeId: node.attributeId,
          operator: node.operator,
          values: [node.value],
          ...(node.unitCode === undefined ? {} : { unitCode: node.unitCode }),
          negative: false,
        },
      ]
    case 'range':
      return rangeGroup(node, path, findings)
    case 'all': {
      const groups: LeafGroup[] = []
      for (const [index, operand] of node.operands.entries()) {
        const lowered = lower(operand, `${path}.operands[${String(index)}]`, findings)
        if (lowered === undefined) return undefined
        groups.push(...lowered)
      }
      return groups
    }
    case 'any': {
      const branches: LeafGroup[] = []
      for (const [index, operand] of node.operands.entries()) {
        const lowered = lower(operand, `${path}.operands[${String(index)}]`, findings)
        if (lowered === undefined) return undefined
        const first = lowered[0]
        if (lowered.length !== 1 || first === undefined || first.negative) {
          findings.push({
            code: 'DIFFERENT_CONDITION_OR',
            message: 'a branch of OR is not one observed condition and cannot form an equivalent-source group',
            path: `${path}.operands[${String(index)}]`,
            rawForm: operand,
          })
          return undefined
        }
        branches.push(first)
      }
      const head = branches[0]
      if (head === undefined) {
        findings.push({ code: 'MALFORMED_EXPRESSION', message: 'an OR has no branch', path, rawForm: node })
        return undefined
      }
      const expected = signature(head)
      for (const [index, branch] of branches.entries()) {
        if (signature(branch) !== expected) {
          findings.push({
            code: 'DIFFERENT_CONDITION_OR',
            message: 'branches of OR express different conditions; the finite subset cannot merge them',
            path: `${path}.operands[${String(index)}]`,
            rawForm: node,
          })
          return undefined
        }
      }
      return [head]
    }
    case 'not': {
      const lowered = lower(node.operand, `${path}.operand`, findings)
      if (lowered === undefined) return undefined
      const single = lowered[0]
      if (lowered.length !== 1 || single === undefined || single.negative) {
        findings.push({
          code: 'UNSUPPORTED_NEGATION',
          message: 'negation must cover exactly one observed comparison or range',
          path,
          rawForm: node,
        })
        return undefined
      }
      return [{ ...single, negative: true }]
    }
    case 'relation':
      findings.push({
        code: 'RELATION_PREMISE_UNSUPPORTED',
        message: `relation premise ${node.relationId} is not part of the first executable subset`,
        path,
        rawForm: node,
      })
      return undefined
    default:
      findings.push({
        code: 'MALFORMED_EXPRESSION',
        message: 'the expression uses an unknown node',
        path,
        rawForm: node,
      })
      return undefined
  }
}

function checkDependencies(input: RuleSupportValidationInput, findings: RuleSupportFinding[]): number {
  const dependencies = input.ruleDependencies ?? []
  const lookup = input.dependencyLookup
  let maxDepth = 0
  for (const dependency of dependencies) {
    const stack: { readonly ruleId: string; readonly depth: number; readonly trail: readonly string[] }[] = [
      { ruleId: dependency, depth: 1, trail: [input.ruleId] },
    ]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) continue
      if (current.trail.includes(current.ruleId)) {
        findings.push({
          code: 'RULE_DEPENDENCY_CYCLE',
          message: `rule dependency ${current.ruleId} forms a cycle`,
          path: 'ruleDependencies',
          rawForm: current.trail,
        })
        continue
      }
      maxDepth = Math.max(maxDepth, current.depth)
      if (current.depth > MAX_DEPENDENCY_DEPTH) {
        findings.push({
          code: 'RULE_DEPENDENCY_DEPTH',
          message: `rule dependency depth ${String(current.depth)} exceeds the supported maximum of ${String(MAX_DEPENDENCY_DEPTH)}`,
          path: 'ruleDependencies',
          rawForm: current.trail,
        })
        continue
      }
      const next = lookup?.get(current.ruleId) ?? []
      for (const child of next) {
        stack.push({ ruleId: child, depth: current.depth + 1, trail: [...current.trail, current.ruleId] })
      }
    }
  }
  return maxDepth
}

/**
 * The finite-grammar support validator. It is stateless and deterministic; the same candidate
 * always produces the same report, so candidate, preflight, publish and evaluation agree.
 */
export class FiniteGrammarRuleSupportValidator implements RuleSupportValidator {
  validate(input: RuleSupportValidationInput): RuleSupportReport {
    const findings: RuleSupportFinding[] = []
    lower(input.condition, 'condition', findings)
    for (const [index, exception] of input.exceptions.entries()) {
      const lowered = lower(exception.condition, `exceptions[${String(index)}].condition`, findings)
      if (lowered === undefined) continue
      const single = lowered[0]
      if (lowered.length !== 1 || single === undefined || single.negative) {
        findings.push({
          code: 'UNSUPPORTED_EXCEPTION',
          message: `exception ${exception.exceptionId} must be one explicit comparison, range or same-condition OR`,
          path: `exceptions[${String(index)}]`,
          rawForm: exception,
        })
      }
    }
    const dependencyDepth = checkDependencies(input, findings)
    const executable = findings.length === 0
    return {
      ruleId: input.ruleId,
      supportState: executable ? 'executable' : 'not_yet_executable',
      executable,
      findings,
      condition: input.condition,
      exceptions: input.exceptions,
      dependencyDepth,
    }
  }
}

/** Convenience wrapper for callers that do not need the port instance. */
export function validateRuleSupport(input: RuleSupportValidationInput): RuleSupportReport {
  return new FiniteGrammarRuleSupportValidator().validate(input)
}

/**
 * One lowered leaf of the finite subset: the conjunction of leaves is the rule's `all`
 * condition, with `any` already collapsed to its equivalent-source representative. Exported so
 * the synthetic validation evaluator judges cases with the SAME lowering the support checker
 * and the evaluator use, instead of a second, looser reading.
 */
export interface LoweredConditionLeaf {
  readonly attributeId: string
  readonly operator: string
  readonly values: readonly (string | number | boolean)[]
  readonly unitCode?: string
  readonly negative: boolean
}

export interface LoweredCondition {
  readonly leaves: readonly LoweredConditionLeaf[]
  readonly findings: readonly RuleSupportFinding[]
}

/**
 * Lower a frozen `RuleExpressionNode` into the flat conjunction the finite subset represents.
 * A form outside the subset yields findings and the leaves collected so far; the node is never
 * edited into a looser one.
 */
export function lowerConditionLeaves(condition: RuleExpressionNode): LoweredCondition {
  const findings: RuleSupportFinding[] = []
  const lowered = lower(condition, 'condition', findings)
  return { leaves: lowered ?? [], findings }
}
