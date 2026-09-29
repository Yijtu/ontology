import { describe, expect, it } from 'vitest'
import type { RuleExceptionNode, RuleExpressionNode, RuleSupportFindingCode, ScopeRef, VersionRef } from '@ontology/contracts'
import {
  FiniteGrammarRuleSupportValidator,
  FiniteGrammarSyntheticEvaluator,
  RuleEvaluator,
} from '@ontology/semantic-engine'
import type { RuleFact, SupportRule } from '@ontology/semantic-engine'

/**
 * Independent acceptance samples for the finite different-condition OR, AND and exception
 * contracts (issue V03-026 / #188). The expectations are derived from the frozen truth table
 * (SPEC v0.3a execution-evidence EX-4.1) and are not copied from the implementation.
 */

const SCOPE: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
}

function compare(attributeId: string, value: string | number | boolean, operator: 'eq' | 'gte' = 'eq', unitCode?: string): RuleExpressionNode {
  return {
    op: 'compare',
    attributeId,
    operator,
    value,
    ...(unitCode === undefined ? {} : { unitCode }),
    spans: [],
  }
}

function range(attributeId: string, min: number, unitCode?: string): RuleExpressionNode {
  return { op: 'range', attributeId, min, ...(unitCode === undefined ? {} : { unitCode }), spans: [] }
}

const DIFFERENT_OR: RuleExpressionNode = {
  op: 'any',
  operands: [compare('operating_hours', 100, 'gte', 'h'), compare('alarm', true)],
  spans: [],
}

const AND: RuleExpressionNode = {
  op: 'all',
  operands: [compare('operating_hours', 100, 'gte', 'h'), compare('alarm', true)],
  spans: [],
}

function codes(findings: readonly { readonly code: RuleSupportFindingCode }[]): RuleSupportFindingCode[] {
  return findings.map((finding) => finding.code)
}

describe('finite grammar support validator (V03-026)', () => {
  const validator = new FiniteGrammarRuleSupportValidator()

  it('accepts comparison, range, finite AND, genuine different-condition OR and a single-leaf not', () => {
    const condition: RuleExpressionNode = {
      op: 'all',
      operands: [DIFFERENT_OR, range('power', 10, 'kW'), { op: 'not', operand: compare('mode', 'manual'), spans: [] }],
      spans: [],
    }
    const report = validator.validate({ ruleId: 'r.finite', condition, exceptions: [] })
    expect(report.executable).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.condition).toEqual(condition)
  })

  it('keeps each genuine OR branch: it is not lowered into one same-filter source group', () => {
    const report = validator.validate({ ruleId: 'r.or', condition: DIFFERENT_OR, exceptions: [] })
    expect(report.executable).toBe(true)
    // The condition is echoed verbatim, proving no branch was merged or dropped.
    expect(report.condition).toEqual(DIFFERENT_OR)
  })

  it('refuses a relation premise, a compound negation and a non-finite OR', () => {
    const relation = validator.validate({ ruleId: 'r.rel', condition: { op: 'relation', relationId: 'meter_of', spans: [] }, exceptions: [] })
    expect(relation.executable).toBe(false)
    expect(codes(relation.findings)).toContain('RELATION_PREMISE_UNSUPPORTED')

    const compoundNot: RuleExpressionNode = { op: 'not', operand: AND, spans: [] }
    const notReport = validator.validate({ ruleId: 'r.not', condition: compoundNot, exceptions: [] })
    expect(notReport.executable).toBe(false)
    expect(codes(notReport.findings)).toContain('UNSUPPORTED_NEGATION')

    const manyBranches: RuleExpressionNode = {
      op: 'any',
      operands: Array.from({ length: 17 }, (_, index) => compare(`field_${String(index)}`, true)),
      spans: [],
    }
    const wide = validator.validate({ ruleId: 'r.wide', condition: manyBranches, exceptions: [] })
    expect(wide.executable).toBe(false)
    expect(codes(wide.findings)).toContain('UNSUPPORTED_QUANTIFIER')
  })

  it('refuses an explicit negative exception and an over-deep rule dependency chain', () => {
    const negativeException: RuleExceptionNode = {
      exceptionId: 'e1',
      condition: { op: 'not', operand: compare('closed', true), spans: [] },
      spans: [],
    }
    const report = validator.validate({ ruleId: 'r.exc', condition: range('power', 10), exceptions: [negativeException] })
    expect(report.executable).toBe(false)
    expect(codes(report.findings)).toContain('UNSUPPORTED_EXCEPTION')

    const lookup = new Map<string, readonly string[]>([
      ['r1', ['r2']],
      ['r2', ['r3']],
      ['r3', ['r4']],
    ])
    const deep = validator.validate({ ruleId: 'root', condition: range('power', 10), exceptions: [], ruleDependencies: ['r1'], dependencyLookup: lookup })
    expect(deep.findings.some((finding) => finding.code === 'RULE_DEPENDENCY_DEPTH')).toBe(true)
  })
})

describe('finite synthetic case evaluator (V03-026)', () => {
  const evaluator = new FiniteGrammarSyntheticEvaluator()

  it('evaluates a genuine different-condition OR branch-by-branch', () => {
    const trueByFirst = evaluator.evaluateRule({
      condition: DIFFERENT_OR,
      exceptions: [],
      fields: [{ fieldId: 'operating_hours', value: 120, unitCode: 'h' }],
    })
    expect(trueByFirst.conditionState).toBe('true')
    expect(trueByFirst.applicability).toBe('applicable')
    expect(trueByFirst.propositionState).toBe('true')
    expect(trueByFirst.branchStates.map((branch) => branch.state)).toEqual(['true', 'unknown'])

    const trueBySecond = evaluator.evaluateRule({ condition: DIFFERENT_OR, exceptions: [], fields: [{ fieldId: 'alarm', value: true }] })
    expect(trueBySecond.conditionState).toBe('true')
  })

  it('never defaults a missing branch to false', () => {
    const missing = evaluator.evaluateRule({ condition: DIFFERENT_OR, exceptions: [], fields: [] })
    expect(missing.conditionState).toBe('unknown')
    expect(missing.applicability).toBe('unknown')
    expect(missing.propositionState).toBe('unknown')

    const oneMissing = evaluator.evaluateRule({ condition: DIFFERENT_OR, exceptions: [], fields: [{ fieldId: 'alarm', value: false }] })
    // alarm=false refutes one branch, but the other branch is missing, so the OR is unknown.
    expect(oneMissing.conditionState).toBe('unknown')
  })

  it('is false only when every branch is explicitly refuted', () => {
    const bothFalse = evaluator.evaluateRule({
      condition: DIFFERENT_OR,
      exceptions: [],
      fields: [
        { fieldId: 'operating_hours', value: 50, unitCode: 'h' },
        { fieldId: 'alarm', value: false },
      ],
    })
    expect(bothFalse.conditionState).toBe('false')
    expect(bothFalse.applicability).toBe('not_applicable')
    expect(bothFalse.propositionState).toBe('unknown')
  })

  it('evaluates finite AND with the frozen truth table', () => {
    const bothTrue = evaluator.evaluateRule({
      condition: AND,
      exceptions: [],
      fields: [
        { fieldId: 'operating_hours', value: 120, unitCode: 'h' },
        { fieldId: 'alarm', value: true },
      ],
    })
    expect(bothTrue.conditionState).toBe('true')

    const oneFalse = evaluator.evaluateRule({
      condition: AND,
      exceptions: [],
      fields: [
        { fieldId: 'operating_hours', value: 50, unitCode: 'h' },
        { fieldId: 'alarm', value: true },
      ],
    })
    expect(oneFalse.conditionState).toBe('false')

    const oneMissing = evaluator.evaluateRule({ condition: AND, exceptions: [], fields: [{ fieldId: 'alarm', value: true }] })
    expect(oneMissing.conditionState).toBe('unknown')
  })

  it('keeps source conflicts, applicability, proposition and truncation separate', () => {
    const conflicting = evaluator.evaluateRule({
      condition: DIFFERENT_OR,
      exceptions: [],
      fields: [
        { fieldId: 'operating_hours', value: 120, unitCode: 'h' },
        { fieldId: 'operating_hours', value: 50, unitCode: 'h' },
      ],
    })
    expect(conflicting.conditionState).toBe('conflict')
    expect(conflicting.sourceConflicts).toHaveLength(1)
    expect(conflicting.sourceConflicts[0]?.fieldRef).toBe('operating_hours')
    expect(conflicting.sourceConflicts[0]?.observedValues).toEqual([120, 50])

    const truncated = evaluator.evaluateRule({ condition: range('power', 10, 'kW'), exceptions: [], fields: [{ fieldId: 'power', value: 20, unitCode: 'kW' }], truncated: true })
    expect(truncated.truncation).toEqual({ truncated: true, reason: 'the synthetic sample was cut off' })
    expect(truncated.conditionState).toBe('unknown')
    expect(truncated.propositionState).toBe('unknown')
  })

  it('keeps a true exception separate from a missing one and does not make the proposition false', () => {
    const exception: RuleExceptionNode = { exceptionId: 'closed', condition: compare('closed', true), spans: [] }
    const excepted = evaluator.evaluateRule({
      condition: range('power', 10, 'kW'),
      exceptions: [exception],
      fields: [
        { fieldId: 'power', value: 20, unitCode: 'kW' },
        { fieldId: 'closed', value: true },
      ],
    })
    expect(excepted.conditionState).toBe('true')
    expect(excepted.exceptionStates).toEqual([{ exceptionId: 'closed', state: 'true' }])
    expect(excepted.applicability).toBe('not_applicable')
    expect(excepted.propositionState).toBe('unknown')

    const missingException = evaluator.evaluateRule({
      condition: range('power', 10, 'kW'),
      exceptions: [exception],
      fields: [{ fieldId: 'power', value: 20, unitCode: 'kW' }],
    })
    expect(missingException.exceptionStates).toEqual([{ exceptionId: 'closed', state: 'unknown' }])
    expect(missingException.applicability).toBe('unknown')
    expect(missingException.propositionState).toBe('unknown')
  })

  it('explicitly refuses an out-of-subset condition', () => {
    const relation: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', spans: [] }
    const refused = evaluator.evaluateRule({ condition: relation, exceptions: [], fields: [] })
    expect(refused.conditionState).toBe('unknown')
    expect(refused.findings.some((finding) => finding.code === 'RELATION_PREMISE_UNSUPPORTED')).toBe(true)
  })
})

describe('published-rule evaluator with an explicit condition tree (V03-026)', () => {
  const evaluator = new RuleEvaluator()

  function fact(overrides: Partial<RuleFact> & { readonly assertionId: string }): RuleFact {
    return {
      logicalAssertionId: overrides.assertionId,
      recordedSeq: '1',
      op: 'assert',
      subject: 'site.home-1',
      predicate: 'p',
      validity: { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' },
      sourceRef: { namespace: 'ha-anker', sourceId: overrides.assertionId },
      ...overrides,
    }
  }

  function orRule(): SupportRule {
    return {
      ruleRef: versionRef('rule.attention'),
      ruleId: 'rule.attention',
      premiseGroups: [
        {
          groupId: 'g-hours',
          filter: { fieldRef: 'hours', op: 'gte', values: [100] },
          alternatives: [{ alternativeId: 'a-hours', assertionId: 'f-hours' }],
          unitCode: 'h',
        },
        {
          groupId: 'g-alarm',
          filter: { fieldRef: 'alarm', op: 'eq', values: [true] },
          alternatives: [{ alternativeId: 'a-alarm', assertionId: 'f-alarm' }],
        },
      ],
      condition: { kind: 'any', children: [{ kind: 'leaf', leaf: 'g-hours' }, { kind: 'leaf', leaf: 'g-alarm' }] },
      conclusion: { propositionKey: 'device.attention', predicate: 'device.attention', value: true },
    }
  }

  const hoursFact = (amount: string) =>
    fact({ assertionId: 'f-hours', logicalAssertionId: 'la-hours', predicate: 'hours', value: { amount, unit: 'h' } })
  const alarmFact = (value: boolean) =>
    fact({ assertionId: 'f-alarm', logicalAssertionId: 'la-alarm', predicate: 'alarm', value })

  function evaluate(facts: readonly RuleFact[]) {
    return evaluator.evaluate({
      scopeRef: SCOPE,
      request: { scopeRef: SCOPE, projectionRef: versionRef('projection.semantic') },
      facts,
      rules: [orRule()],
    })
  }

  it('derives support when any genuinely different branch holds', () => {
    const result = evaluate([hoursFact('120')])
    expect(result.conclusions[0]?.domainStatus).toBe('known')
    expect(result.conclusions[0]?.value).toBe(true)
    expect(result.conclusions[0]?.satisfiedBy).toEqual([{ groupId: 'g-hours', alternativeIds: ['a-hours'] }])
  })

  it('is unknown, never false, when the only present branch is unknown', () => {
    const result = evaluate([])
    expect(result.conclusions[0]?.domainStatus).toBe('unknown')
    expect(result.conclusions[0]?.value).toBeUndefined()
    expect(result.gaps.length).toBeGreaterThan(0)
  })

  it('is a determinate false only when every branch is refuted', () => {
    const result = evaluate([hoursFact('50'), alarmFact(false)])
    expect(result.conclusions[0]?.domainStatus).toBe('known')
    expect(result.conclusions[0]?.value).toBe(false)
  })

  it('surfaces a source conflict as a separate axis, not as one branch winning', () => {
    const result = evaluate([
      fact({ assertionId: 'f-alarm', logicalAssertionId: 'la-alarm', predicate: 'alarm', value: true }),
      fact({ assertionId: 'f-alarm-2', logicalAssertionId: 'la-alarm', predicate: 'alarm', value: false, recordedSeq: '2' }),
    ])
    expect(result.conclusions[0]?.domainStatus).toBe('conflict')
    expect(result.conflicts.some((conflict) => conflict.propositionKey === 'alarm')).toBe(true)
    expect(result.conclusions[0]?.value).not.toBe(true)
  })

  it('rejects a condition tree that references an unknown premise group', () => {
    const broken: SupportRule = { ...orRule(), condition: { kind: 'leaf', leaf: 'g-missing' } }
    expect(() =>
      evaluator.evaluate({
        scopeRef: SCOPE,
        request: { scopeRef: SCOPE, projectionRef: versionRef('projection.semantic') },
        facts: [],
        rules: [broken],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RULE' }))
  })
})
