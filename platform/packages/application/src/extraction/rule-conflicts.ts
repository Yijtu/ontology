import type { IndustrySchema, RuleCandidate, RuleConflict, Uuid } from '@ontology/contracts'
import { flattenComparisons } from './rule-ast'

/**
 * Deterministic conflict detection for rule candidates on the same applicability scope
 * (SPEC D5, US-015). Two rules that cannot both hold are surfaced as an explicit conflict on
 * both candidates; the pipeline never picks one and silently drops the other.
 *
 * It is pure: it reads the candidates and the published schema projection and returns a map
 * from candidate id to the conflicts found. Only single-valued attributes can host an `eq`
 * contradiction, so a legitimately multi-valued attribute is never flagged.
 */

function isSingleValued(schema: IndustrySchema, objectId: string, attributeId: string): boolean {
  const object = schema.objects.find((entry) => entry.objectId === objectId)
  const attribute = object?.attributes.find((entry) => entry.attributeId === attributeId)
  return attribute?.maxCardinality === 1
}

interface Range {
  readonly min: number
  readonly max: number
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.min <= right.max && right.min <= left.max
}

function rangeOf(expression: RuleCandidate['expression']): Range | undefined {
  if (expression.op !== 'range') return undefined
  const min = expression.min ?? Number.NEGATIVE_INFINITY
  const max = expression.max ?? Number.POSITIVE_INFINITY
  return { min, max }
}

function comparePair(
  left: RuleCandidate,
  right: RuleCandidate,
  schema: IndustrySchema,
): RuleConflict | undefined {
  const leftComparisons = flattenComparisons(left.expression)
  const rightComparisons = flattenComparisons(right.expression)
  for (const a of leftComparisons) {
    for (const b of rightComparisons) {
      if (a.attributeId !== b.attributeId) continue
      if (a.operator === 'eq' && b.operator === 'ne' && a.value === b.value) {
        return conflictOf(right, a.attributeId, `eq ${String(a.value)} contradicts ne ${String(b.value)}`)
      }
      if (a.operator === 'ne' && b.operator === 'eq' && a.value === b.value) {
        return conflictOf(right, a.attributeId, `ne ${String(a.value)} contradicts eq ${String(b.value)}`)
      }
      if (
        a.operator === 'eq' &&
        b.operator === 'eq' &&
        a.value !== b.value &&
        isSingleValued(schema, left.objectId, a.attributeId)
      ) {
        return conflictOf(
          right,
          a.attributeId,
          `two different required values ${String(a.value)} / ${String(b.value)} for a single-valued attribute`,
        )
      }
    }
  }
  const leftRange = rangeOf(left.expression)
  const rightRange = rangeOf(right.expression)
  if (
    leftRange !== undefined &&
    rightRange !== undefined &&
    !rangesOverlap(leftRange, rightRange)
  ) {
    const attributeId = left.expression.op === 'range' ? left.expression.attributeId : ''
    return conflictOf(right, attributeId, 'two non-overlapping numeric ranges')
  }
  return undefined
}

function conflictOf(withRule: RuleCandidate, attributeId: string, reason: string): RuleConflict {
  return {
    withRuleId: withRule.ruleId,
    withCandidateId: withRule.candidateId,
    attributeId,
    reason,
  }
}

export function detectRuleConflicts(
  rules: readonly RuleCandidate[],
  schema: IndustrySchema,
): Map<Uuid, RuleConflict[]> {
  const out = new Map<Uuid, RuleConflict[]>()
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const left = rules[i]
      const right = rules[j]
      if (left === undefined || right === undefined) continue
      if (left.objectId !== right.objectId) continue
      const forward = comparePair(left, right, schema)
      if (forward !== undefined) {
        out.set(left.candidateId, [...(out.get(left.candidateId) ?? []), forward])
      }
      const backward = comparePair(right, left, schema)
      if (backward !== undefined) {
        out.set(right.candidateId, [...(out.get(right.candidateId) ?? []), backward])
      }
    }
  }
  return out
}
