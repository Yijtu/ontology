import type {
  RuleExpressionNode,
  RuleRelationPremiseDeclaration,
  RuleSupportFinding,
  RuleSupportReport,
  RuleSupportValidationInput,
  RuleSupportValidator,
} from '@ontology/contracts'
import type { FiniteConditionPlan } from './boolean'

/**
 * Deterministic finite-grammar support checker (SPEC v0.3a execution-evidence §4.1, §5.2,
 * issue V03-010 / #184; EX-4.1 different-condition OR, issue V03-026 / #188).
 *
 * It consumes the FROZEN `RuleExpressionNode` grammar and reports whether a proposed
 * condition/exception set is representable by the executable subset the publish stage and the
 * evaluator already enforce (`rules/compile.ts`, `rules/boolean.ts`). It never edits, drops or
 * weakens a node: an out-of-subset form is recorded verbatim as a `not_yet_executable` finding
 * so the candidate can be saved and reviewed, but it can never be enabled.
 *
 * The subset mirrors the evaluator exactly:
 *  - `compare` / `range` over one declared attribute;
 *  - finite `all` (AND);
 *  - finite `any` (a genuine different-condition OR, e.g. `operating_hours >= 100 h OR
 *    alarm = true`); every branch keeps its own AST, state and sources and is never lowered
 *    into a same-filter source group;
 *  - `not` over one observed comparison/range leaf;
 *  - at most one POSITIVE, ONE-HOP `relation` premise whose relation is declared in the pinned
 *    definition (`RuleRelationPremiseDeclaration`). A relation with no executable declaration,
 *    a deeper/cyclic relation, a relation inside `not` or a second relation premise stays
 *    `RELATION_PREMISE_UNSUPPORTED` and is never loosened into a field lookup.
 * Declared rule dependencies must be acyclic and at most three levels deep.
 */

const MAX_DEPENDENCY_DEPTH = 3
const MAX_CONDITION_DEPTH = 8
const MAX_OR_BRANCHES = 16
const MAX_EXCEPTIONS = 4

export interface LoweredConditionLeaf {
  readonly attributeId: string
  readonly operator: string
  readonly values: readonly (string | number | boolean)[]
  readonly unitCode?: string
  readonly negative: boolean
  /**
   * Set when this leaf is a one-hop relation premise rather than an attribute observation.
   * `attributeId` carries the relation id and `operator` is `exists`; the evaluator resolves
   * it through confirmed published relations, never through a field value.
   */
  readonly relationId?: string
}

/**
 * Mutable state threaded through one lowering pass: the declared one-hop relation premises of
 * the pinned definition plus the relation nodes actually seen. It is what enforces the
 * "at most one relation premise" rule after the whole condition and its exceptions are walked.
 */
interface RelationLoweringState {
  readonly declarations: ReadonlyMap<string, RuleRelationPremiseDeclaration>
  relationCount: number
}

function containsRelationNode(node: RuleExpressionNode): boolean {
  switch (node.op) {
    case 'relation':
      return true
    case 'all':
    case 'any':
      return node.operands.some(containsRelationNode)
    case 'not':
      return containsRelationNode(node.operand)
    default:
      return false
  }
}

function relationPremiseIsOneHop(declaration: RuleRelationPremiseDeclaration): boolean {
  if (declaration.cyclic === true) return false
  if (declaration.depth !== 1) return false
  if (declaration.targetCondition !== undefined && containsRelationNode(declaration.targetCondition)) return false
  return true
}

function rangeLeaf(
  node: Extract<RuleExpressionNode, { op: 'range' }>,
  path: string,
  findings: RuleSupportFinding[],
): LoweredConditionLeaf | undefined {
  if (node.min === undefined && node.max === undefined) {
    findings.push({
      code: 'UNSUPPORTED_RANGE',
      message: `range of ${node.attributeId} declares neither a minimum nor a maximum`,
      path,
      rawForm: node,
    })
    return undefined
  }
  const unit = node.unitCode === undefined ? {} : { unitCode: node.unitCode }
  if (node.min !== undefined && node.max !== undefined) {
    return { attributeId: node.attributeId, operator: 'between', values: [node.min, node.max], ...unit, negative: false }
  }
  if (node.min !== undefined) {
    return { attributeId: node.attributeId, operator: 'gte', values: [node.min], ...unit, negative: false }
  }
  if (node.max === undefined) return undefined
  return { attributeId: node.attributeId, operator: 'lte', values: [node.max], ...unit, negative: false }
}

function lowerPlan(
  node: RuleExpressionNode,
  path: string,
  findings: RuleSupportFinding[],
  depth: number,
  relations: RelationLoweringState,
): FiniteConditionPlan<LoweredConditionLeaf> | undefined {
  if (depth > MAX_CONDITION_DEPTH) {
    findings.push({
      code: 'UNSUPPORTED_QUANTIFIER',
      message: `the condition nests deeper than the supported maximum of ${String(MAX_CONDITION_DEPTH)}`,
      path,
      rawForm: node,
    })
    return undefined
  }
  switch (node.op) {
    case 'compare': {
      if (node.attributeId.length === 0) {
        findings.push({
          code: 'UNRESOLVED_REFERENCE',
          message: 'a comparison names no attribute',
          path,
          rawForm: node,
        })
        return undefined
      }
      return {
        kind: 'leaf',
        leaf: {
          attributeId: node.attributeId,
          operator: node.operator,
          values: [node.value],
          ...(node.unitCode === undefined ? {} : { unitCode: node.unitCode }),
          negative: false,
        },
      }
    }
    case 'range': {
      const leaf = rangeLeaf(node, path, findings)
      return leaf === undefined ? undefined : { kind: 'leaf', leaf }
    }
    case 'all': {
      if (node.operands.length === 0) {
        findings.push({ code: 'MALFORMED_EXPRESSION', message: 'an AND has no operand', path, rawForm: node })
        return undefined
      }
      const children: FiniteConditionPlan<LoweredConditionLeaf>[] = []
      for (const [index, operand] of node.operands.entries()) {
        const child = lowerPlan(operand, `${path}.operands[${String(index)}]`, findings, depth + 1, relations)
        if (child === undefined) return undefined
        children.push(child)
      }
      return { kind: 'all', children }
    }
    case 'any': {
      if (node.operands.length === 0) {
        findings.push({ code: 'MALFORMED_EXPRESSION', message: 'an OR has no branch', path, rawForm: node })
        return undefined
      }
      if (node.operands.length > MAX_OR_BRANCHES) {
        findings.push({
          code: 'UNSUPPORTED_QUANTIFIER',
          message: `an OR has ${String(node.operands.length)} branches, more than the supported maximum of ${String(MAX_OR_BRANCHES)}`,
          path,
          rawForm: node,
        })
        return undefined
      }
      const children: FiniteConditionPlan<LoweredConditionLeaf>[] = []
      for (const [index, operand] of node.operands.entries()) {
        const child = lowerPlan(operand, `${path}.operands[${String(index)}]`, findings, depth + 1, relations)
        if (child === undefined) return undefined
        children.push(child)
      }
      return { kind: 'any', children }
    }
    case 'not': {
      const operand = lowerPlan(node.operand, `${path}.operand`, findings, depth + 1, relations)
      if (operand === undefined) return undefined
      if (operand.kind !== 'leaf' || operand.leaf.negative || operand.leaf.relationId !== undefined) {
        findings.push({
          code: 'UNSUPPORTED_NEGATION',
          message: 'negation must cover exactly one observed comparison or range leaf',
          path,
          rawForm: node,
        })
        return undefined
      }
      return { kind: 'leaf', leaf: { ...operand.leaf, negative: true } }
    }
    case 'relation': {
      const declaration = relations.declarations.get(node.relationId)
      if (declaration === undefined) {
        findings.push({
          code: 'RELATION_PREMISE_UNSUPPORTED',
          message: `relation premise ${node.relationId} has no executable one-hop declaration in the pinned definition`,
          path,
          rawForm: node,
        })
        return undefined
      }
      if (!relationPremiseIsOneHop(declaration)) {
        findings.push({
          code: 'RELATION_PREMISE_UNSUPPORTED',
          message: `relation premise ${node.relationId} is not an acyclic one-hop relation and cannot be executed`,
          path,
          rawForm: node,
        })
        return undefined
      }
      relations.relationCount += 1
      return {
        kind: 'leaf',
        leaf: {
          attributeId: node.relationId,
          operator: 'exists',
          values: [],
          negative: false,
          relationId: node.relationId,
        },
      }
    }
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
    const relations: RelationLoweringState = {
      declarations: new Map((input.relationPremises ?? []).map((declaration) => [declaration.relationId, declaration])),
      relationCount: 0,
    }
    lowerPlan(input.condition, 'condition', findings, 0, relations)
    if (input.exceptions.length > MAX_EXCEPTIONS) {
      findings.push({
        code: 'UNSUPPORTED_EXCEPTION',
        message: `a rule attaches ${String(input.exceptions.length)} exceptions, more than the supported maximum of ${String(MAX_EXCEPTIONS)}`,
        path: 'exceptions',
        rawForm: input.exceptions,
      })
    }
    for (const [index, exception] of input.exceptions.entries()) {
      const plan = lowerPlan(exception.condition, `exceptions[${String(index)}].condition`, findings, 0, relations)
      if (plan === undefined) continue
      // An exception is a negated condition; a relation premise may never be negated (SPEC §5.2).
      if (plan.kind === 'leaf' && (plan.leaf.negative || plan.leaf.relationId !== undefined)) {
        findings.push({
          code: 'UNSUPPORTED_EXCEPTION',
          message: `exception ${exception.exceptionId} must be one explicit comparison, range, same-condition or different-condition any`,
          path: `exceptions[${String(index)}]`,
          rawForm: exception,
        })
      }
    }
    if (relations.relationCount > 1) {
      findings.push({
        code: 'RELATION_PREMISE_UNSUPPORTED',
        message: `a rule declares ${String(relations.relationCount)} relation premises; at most one one-hop relation premise is executable`,
        path: 'condition',
        rawForm: input.condition,
      })
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
 * The lowered finite condition: either a single leaf or a finite `all`/`any` tree. The support
 * checker, the synthetic evaluator and the published compiler all consume this lowering.
 */
export type LoweredConditionPlan = FiniteConditionPlan<LoweredConditionLeaf>

export interface LoweredCondition {
  readonly leaves: readonly LoweredConditionLeaf[]
  readonly findings: readonly RuleSupportFinding[]
}

/**
 * Lower a frozen `RuleExpressionNode` into the supported finite condition tree. The optional
 * declared one-hop relation premises mirror the support validator, so the evaluator and the
 * validator agree on exactly which relation node is executable.
 */
export function lowerConditionPlan(
  condition: RuleExpressionNode,
  relationPremises: readonly RuleRelationPremiseDeclaration[] = [],
): {
  readonly plan: LoweredConditionPlan | undefined
  readonly findings: readonly RuleSupportFinding[]
} {
  const findings: RuleSupportFinding[] = []
  const relations: RelationLoweringState = {
    declarations: new Map(relationPremises.map((declaration) => [declaration.relationId, declaration])),
    relationCount: 0,
  }
  const plan = lowerPlan(condition, 'condition', findings, 0, relations)
  return { plan, findings }
}

function flattenConjunction(plan: LoweredConditionPlan): LoweredConditionLeaf[] | undefined {
  if (plan.kind === 'leaf') return [plan.leaf]
  if (plan.kind !== 'all') return undefined
  const leaves: LoweredConditionLeaf[] = []
  for (const child of plan.children) {
    const flattened = flattenConjunction(child)
    if (flattened === undefined) return undefined
    leaves.push(...flattened)
  }
  return leaves
}

/**
 * Legacy flat lowering: the conjunction of leaves, with an `any` collapsed only when it is a
 * same-condition equivalent-source group. A genuine different-condition OR cannot be expressed
 * as a flat conjunction and yields a `DIFFERENT_CONDITION_OR` finding; callers that must honour
 * the full finite boolean subset use `lowerConditionPlan` instead.
 */
export function lowerConditionLeaves(condition: RuleExpressionNode): LoweredCondition {
  const findings: RuleSupportFinding[] = []
  const relations: RelationLoweringState = { declarations: new Map(), relationCount: 0 }
  const plan = lowerPlan(condition, 'condition', findings, 0, relations)
  if (plan === undefined) return { leaves: [], findings }
  const leaves = flattenConjunction(plan)
  if (leaves === undefined) {
    findings.push({
      code: 'DIFFERENT_CONDITION_OR',
      message: 'a different-condition OR cannot be flattened into a conjunction of observed leaves',
      path: 'condition',
      rawForm: condition,
    })
    return { leaves: [], findings }
  }
  return { leaves, findings }
}
