import type { PublishedRuleVersion, RuleExpressionNode, SemanticFilter } from '@ontology/contracts'
import { RuleEvaluationError } from './errors'
import type { RuleFact, RulePremiseAlternative, RulePremiseGroup, SupportRule } from './types'

/**
 * Compile a published rule AST into the bounded support-rule model the evaluator consumes
 * (SPEC D5, ADR-11). Only the declarative subset is accepted:
 *
 *  - `all` -> several AND premise groups.
 *  - `any` -> one OR premise group; every operand must lower to the same filter so the merged
 *    alternatives stay equivalent sources of one condition.
 *  - `compare`/`range` -> one premise group whose alternatives are the facts matching the
 *    predicate.
 *  - `not` -> rejected as unsupported negation.
 *  - `relation` -> rejected as an unsupported premise form.
 *
 * A rule outside the subset is refused instead of being weakened into a looser rule.
 */
export function supportRuleFromPublishedRule(
  rule: PublishedRuleVersion,
  facts: readonly RuleFact[],
): SupportRule {
  const groups = compileNode(rule.expression, facts, rule.ruleId)
  return {
    ruleRef: {
      id: rule.ruleId,
      version: rule.version,
      digest: `sha256:${'0'.repeat(64)}`,
    },
    ruleId: rule.ruleId,
    premiseGroups: groups,
    conclusion: { propositionKey: rule.objectId, predicate: rule.objectId, value: true },
  }
}

function alternativesFor(attributeId: string, facts: readonly RuleFact[]): RulePremiseAlternative[] {
  const alternatives = facts
    .filter((fact) => fact.predicate === attributeId)
    .map((fact) => ({ alternativeId: fact.assertionId, assertionId: fact.assertionId }))
  if (alternatives.length > 0) return alternatives
  // No published fact matches the predicate yet: keep the premise unknown rather than dropping
  // it. A synthetic id that resolves to no active fact yields `unknown`, never `false`.
  const placeholder = `unmatched:${attributeId}`
  return [{ alternativeId: placeholder, assertionId: placeholder }]
}

function leafGroup(attributeId: string, filter: SemanticFilter, facts: readonly RuleFact[], groupId: string): RulePremiseGroup {
  return { groupId, filter, alternatives: alternativesFor(attributeId, facts) }
}

function compileNode(
  node: RuleExpressionNode,
  facts: readonly RuleFact[],
  prefix: string,
): RulePremiseGroup[] {
  switch (node.op) {
    case 'compare':
      return [
        leafGroup(
          node.attributeId,
          { fieldRef: node.attributeId, op: node.operator, values: [node.value] },
          facts,
          `${prefix}:${node.attributeId}`,
        ),
      ]
    case 'range': {
      const fieldRef = node.attributeId
      let filter: SemanticFilter
      if (node.min !== undefined && node.max !== undefined) {
        filter = { fieldRef, op: 'between', values: [node.min, node.max] }
      } else if (node.min !== undefined) {
        filter = { fieldRef, op: 'gte', values: [node.min] }
      } else if (node.max !== undefined) {
        filter = { fieldRef, op: 'lte', values: [node.max] }
      } else {
        throw new RuleEvaluationError(
          'UNSUPPORTED_FILTER',
          `range of ${fieldRef} declares neither a minimum nor a maximum`,
        )
      }
      return [leafGroup(fieldRef, filter, facts, `${prefix}:${fieldRef}`)]
    }
    case 'all':
      return node.operands.flatMap((operand, index) => compileNode(operand, facts, `${prefix}.${String(index)}`))
    case 'any': {
      const lowered = node.operands.map((operand, index) =>
        compileNode(operand, facts, `${prefix}.${String(index)}`),
      )
      const single = lowered.map((groups) => {
        const first = groups[0]
        if (first === undefined || groups.length !== 1) {
          throw new RuleEvaluationError(
            'UNSUPPORTED_FILTER',
            `any operand of ${prefix} is not a single comparison and cannot be merged into one OR group`,
          )
        }
        return first
      })
      const [head, ...rest] = single
      if (head === undefined) {
        throw new RuleEvaluationError('UNSUPPORTED_FILTER', `any of ${prefix} has no operand`)
      }
      const signature = JSON.stringify(head.filter)
      for (const group of rest) {
        if (JSON.stringify(group.filter) !== signature) {
          throw new RuleEvaluationError(
            'UNSUPPORTED_FILTER',
            `any of ${prefix} mixes different filters that one OR group cannot express`,
          )
        }
      }
      const alternatives = new Map<string, RulePremiseAlternative>()
      for (const group of single) {
        for (const alternative of group.alternatives) alternatives.set(alternative.alternativeId, alternative)
      }
      return [
        {
          groupId: `${prefix}:any`,
          filter: head.filter,
          alternatives: [...alternatives.values()].sort((left, right) =>
            left.alternativeId.localeCompare(right.alternativeId),
          ),
        },
      ]
    }
    case 'not':
      throw new RuleEvaluationError(
        'UNSUPPORTED_NEGATION',
        `rule ${prefix} uses an explicit negation the declarative subset cannot represent`,
      )
    case 'relation':
      throw new RuleEvaluationError(
        'UNSUPPORTED_FILTER',
        `rule ${prefix} uses a relation premise the declarative subset cannot represent`,
      )
    default:
      throw new RuleEvaluationError('UNSUPPORTED_FILTER', `rule ${prefix} uses an unknown expression node`)
  }
}
