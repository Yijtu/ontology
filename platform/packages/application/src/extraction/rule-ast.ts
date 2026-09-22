import type {
  DraftRule,
  RuleComparisonOperator,
  RuleExceptionNode,
  RuleExpressionNode,
  RuleProvenanceSpan,
  RuleUnhandledReason,
} from '@ontology/contracts'

/**
 * Deterministic translation of an untrusted rule draft into the bounded rule AST (SPEC D4.3,
 * D5, US-013). It is pure and never weakens an expression: an operator, quantifier or cycle the
 * extractor cannot represent faithfully is returned as an explicit unhandled result with a
 * reason, and the caller records it without publishing a looser rule.
 */

const SUPPORTED_OPS: ReadonlySet<string> = new Set(['all', 'any', 'not', 'compare', 'range', 'relation'])
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])
const AGGREGATE_OPS: ReadonlySet<string> = new Set(['count', 'sum', 'avg', 'min', 'max', 'exists'])
const QUANTIFIER_KEYS = ['quantifier', 'atLeast', 'atMost', 'exactly', 'count'] as const

export interface RuleExceptionDraft {
  readonly exceptionId: string
  readonly condition: unknown
  readonly spans: readonly RuleProvenanceSpan[]
}

export interface RuleAstOk {
  readonly kind: 'ok'
  readonly expression: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
}

export interface RuleAstUnhandled {
  readonly kind: 'unhandled'
  readonly reason: RuleUnhandledReason
  readonly detail: string
}

export type RuleAstResult = RuleAstOk | RuleAstUnhandled

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unhandled(reason: RuleUnhandledReason, detail: string): RuleAstUnhandled {
  return { kind: 'unhandled', reason, detail }
}

/**
 * Collect every rule id an expression references through a `ref` node. Used to build the
 * reference graph before translation, so a cycle gets the precise `CYCLIC_EXPRESSION` reason.
 */
export function collectRuleReferences(expression: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (!isRecord(node)) return
    if (node['op'] === 'ref' && typeof node['ruleId'] === 'string') out.push(node['ruleId'])
    for (const value of Object.values(node)) visit(value)
  }
  visit(expression)
  return out
}

/**
 * Rule ids that participate in a reference cycle (including a self-reference). Recursion is
 * unsupported in the first version, so the whole cycle is reported as unhandled rather than
 * evaluated.
 */
export function detectCyclicRules(drafts: readonly DraftRule[]): ReadonlySet<string> {
  const edges = new Map<string, readonly string[]>()
  for (const draft of drafts) {
    edges.set(draft.ruleId, collectRuleReferences(draft.expression))
  }
  const cyclic = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id)
      for (const entry of stack.slice(start)) cyclic.add(entry)
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) visit(next)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const id of edges.keys()) visit(id)
  return cyclic
}

function translateNode(
  value: unknown,
  spans: readonly RuleProvenanceSpan[],
  cyclicRuleIds: ReadonlySet<string>,
): RuleAstResult {
  if (!isRecord(value)) {
    return unhandled('MALFORMED_EXPRESSION', 'a rule expression node must be an object')
  }
  const op = value['op']
  if (typeof op !== 'string') {
    return unhandled('MALFORMED_EXPRESSION', 'a rule expression node must declare an "op"')
  }
  if (op === 'ref') {
    const ruleId = typeof value['ruleId'] === 'string' ? value['ruleId'] : ''
    if (cyclicRuleIds.has(ruleId)) {
      return unhandled('CYCLIC_EXPRESSION', `rule "${ruleId}" participates in a reference cycle`)
    }
    return unhandled('UNSUPPORTED_OPERATOR', 'rule references are not supported in the first version')
  }
  if (AGGREGATE_OPS.has(op) || QUANTIFIER_KEYS.some((key) => value[key] !== undefined)) {
    return unhandled(
      'UNSUPPORTED_QUANTIFIER',
      `aggregate/quantified expression "${op}" cannot be represented as a bounded rule`,
    )
  }
  if (!SUPPORTED_OPS.has(op)) {
    return unhandled('UNSUPPORTED_OPERATOR', `unsupported rule operator "${op}"`)
  }

  switch (op) {
    case 'all':
    case 'any': {
      const operands = value['operands']
      if (!Array.isArray(operands) || operands.length === 0) {
        return unhandled('MALFORMED_EXPRESSION', `"${op}" needs at least one operand`)
      }
      const translated: RuleExpressionNode[] = []
      for (const operand of operands) {
        const result = translateNode(operand, spans, cyclicRuleIds)
        if (result.kind === 'unhandled') return result
        translated.push(result.expression)
      }
      return { kind: 'ok', expression: { op, operands: translated, spans: [...spans] }, exceptions: [] }
    }
    case 'not': {
      const result = translateNode(value['operand'], spans, cyclicRuleIds)
      if (result.kind === 'unhandled') return result
      return { kind: 'ok', expression: { op: 'not', operand: result.expression, spans: [...spans] }, exceptions: [] }
    }
    case 'compare': {
      const attributeId = value['attributeId']
      if (typeof attributeId !== 'string' || attributeId.length === 0) {
        return unhandled('MALFORMED_EXPRESSION', 'a comparison needs an attribute id')
      }
      const operator = value['operator']
      if (typeof operator !== 'string' || !COMPARISON_OPERATORS.has(operator)) {
        return unhandled('UNSUPPORTED_OPERATOR', `unsupported comparison operator "${String(operator)}"`)
      }
      const compared = value['value']
      if (typeof compared !== 'string' && typeof compared !== 'number' && typeof compared !== 'boolean') {
        return unhandled('MALFORMED_EXPRESSION', 'a comparison needs a scalar value')
      }
      const unitCode = value['unitCode']
      if (unitCode !== undefined && typeof unitCode !== 'string') {
        return unhandled('MALFORMED_EXPRESSION', 'a comparison unitCode must be a string')
      }
      return {
        kind: 'ok',
        expression: {
          op: 'compare',
          attributeId,
          operator: operator as RuleComparisonOperator,
          value: compared,
          ...(unitCode === undefined ? {} : { unitCode }),
          spans: [...spans],
        },
        exceptions: [],
      }
    }
    case 'range': {
      const attributeId = value['attributeId']
      if (typeof attributeId !== 'string' || attributeId.length === 0) {
        return unhandled('MALFORMED_EXPRESSION', 'a range needs an attribute id')
      }
      const min = value['min']
      const max = value['max']
      if (min !== undefined && typeof min !== 'number') {
        return unhandled('MALFORMED_EXPRESSION', 'a range min must be a number')
      }
      if (max !== undefined && typeof max !== 'number') {
        return unhandled('MALFORMED_EXPRESSION', 'a range max must be a number')
      }
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        return unhandled('MALFORMED_EXPRESSION', 'a range min must not exceed max')
      }
      const unitCode = value['unitCode']
      if (unitCode !== undefined && typeof unitCode !== 'string') {
        return unhandled('MALFORMED_EXPRESSION', 'a range unitCode must be a string')
      }
      return {
        kind: 'ok',
        expression: {
          op: 'range',
          attributeId,
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(unitCode === undefined ? {} : { unitCode }),
          spans: [...spans],
        },
        exceptions: [],
      }
    }
    case 'relation': {
      const relationId = value['relationId']
      if (typeof relationId !== 'string' || relationId.length === 0) {
        return unhandled('MALFORMED_EXPRESSION', 'a relation expression needs a relation id')
      }
      return {
        kind: 'ok',
        expression: { op: 'relation', relationId, spans: [...spans] },
        exceptions: [],
      }
    }
    default:
      return unhandled('UNSUPPORTED_OPERATOR', `unsupported rule operator "${op}"`)
  }
}

/**
 * Translate a rule draft and its inline exceptions into the bounded AST. A single
 * unrepresentable exception makes the whole rule unhandled (`EXCEPTION_UNREPRESENTABLE`): the
 * exception is never dropped to keep a looser rule.
 */
export function buildRuleAst(
  draft: DraftRule,
  ruleSpans: readonly RuleProvenanceSpan[],
  exceptions: readonly RuleExceptionDraft[],
  cyclicRuleIds: ReadonlySet<string>,
): RuleAstResult {
  const condition = translateNode(draft.expression, ruleSpans, cyclicRuleIds)
  if (condition.kind === 'unhandled') return condition

  const translatedExceptions: RuleExceptionNode[] = []
  for (const exception of exceptions) {
    const result = translateNode(exception.condition, exception.spans, cyclicRuleIds)
    if (result.kind === 'unhandled') {
      return unhandled(
        'EXCEPTION_UNREPRESENTABLE',
        `exception "${exception.exceptionId}" could not be represented: ${result.detail}`,
      )
    }
    translatedExceptions.push({
      exceptionId: exception.exceptionId,
      condition: result.expression,
      spans: [...exception.spans],
    })
  }
  return { kind: 'ok', expression: condition.expression, exceptions: translatedExceptions }
}

/** Flatten the direct `compare`/`range` nodes of a rule's condition (negations excluded). */
export function flattenComparisons(
  expression: RuleExpressionNode,
): readonly { readonly attributeId: string; readonly operator: RuleComparisonOperator; readonly value: string | number | boolean }[] {
  const out: { attributeId: string; operator: RuleComparisonOperator; value: string | number | boolean }[] = []
  const visit = (node: RuleExpressionNode): void => {
    switch (node.op) {
      case 'compare':
        out.push({ attributeId: node.attributeId, operator: node.operator, value: node.value })
        return
      case 'all':
      case 'any':
        for (const operand of node.operands) visit(operand)
        return
      default:
        return
    }
  }
  visit(expression)
  return out
}
