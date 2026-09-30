import { describe, expect, it } from 'vitest'
import type {
  RuleExceptionNode,
  RuleExpressionNode,
  RuleRelationPremiseDeclaration,
  RuleSupportFindingCode,
  VersionRef,
} from '@ontology/contracts'
import {
  FiniteGrammarRuleSupportValidator,
  FiniteGrammarSyntheticEvaluator,
} from '@ontology/semantic-engine'

/**
 * Independent acceptance samples for the restricted one-hop relation premise (issue V03-027 /
 * #195, A.US-008.AC-01, P.US-006.AC-02, P.FR-9). The expectations come from SPEC v0.3a
 * execution-evidence EX-4.1 `relation_exists`/§5.2: at most one positive one-hop published
 * relation premise is executable; a deeper, cyclic, nested, negated or second relation premise
 * stays `RELATION_PREMISE_UNSUPPORTED` and is never loosened into a field lookup.
 */

const DEFINITION: VersionRef = { id: 'definition.core', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` }

function declaration(overrides: Partial<RuleRelationPremiseDeclaration> = {}): RuleRelationPremiseDeclaration {
  return {
    relationId: 'meter_of',
    fromObjectId: 'site',
    toObjectId: 'meter',
    definitionRef: DEFINITION,
    depth: 1,
    ...overrides,
  }
}

const RELATION: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', spans: [] }

function codes(findings: readonly { readonly code: RuleSupportFindingCode }[]): RuleSupportFindingCode[] {
  return findings.map((finding) => finding.code)
}

describe('one-hop relation premise support validation (V03-027)', () => {
  const validator = new FiniteGrammarRuleSupportValidator()

  it('makes an exactly one-hop declared relation premise executable', () => {
    const report = validator.validate({
      ruleId: 'r.rel',
      condition: RELATION,
      exceptions: [],
      relationPremises: [declaration()],
    })
    expect(report.executable).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.condition).toEqual(RELATION)
  })

  it('keeps an undeclared relation premise not_yet_executable', () => {
    const report = validator.validate({ ruleId: 'r.rel', condition: RELATION, exceptions: [] })
    expect(report.executable).toBe(false)
    expect(codes(report.findings)).toContain('RELATION_PREMISE_UNSUPPORTED')
  })

  it('refuses a deeper, cyclic or nested-target relation premise', () => {
    const deeper = validator.validate({
      ruleId: 'r.deep',
      condition: RELATION,
      exceptions: [],
      relationPremises: [declaration({ depth: 2 })],
    })
    expect(deeper.executable).toBe(false)
    expect(codes(deeper.findings)).toContain('RELATION_PREMISE_UNSUPPORTED')

    const cyclic = validator.validate({
      ruleId: 'r.cycle',
      condition: RELATION,
      exceptions: [],
      relationPremises: [declaration({ cyclic: true })],
    })
    expect(cyclic.executable).toBe(false)

    const nested = validator.validate({
      ruleId: 'r.nested',
      condition: RELATION,
      exceptions: [],
      relationPremises: [declaration({ targetCondition: { op: 'relation', relationId: 'meter_of', spans: [] } })],
    })
    expect(nested.executable).toBe(false)
    expect(codes(nested.findings)).toContain('RELATION_PREMISE_UNSUPPORTED')
  })

  it('refuses a second relation premise and a negated relation', () => {
    const second = validator.validate({
      ruleId: 'r.two',
      condition: {
        op: 'all',
        operands: [RELATION, { op: 'relation', relationId: 'feeds', spans: [] }],
        spans: [],
      },
      exceptions: [],
      relationPremises: [declaration(), declaration({ relationId: 'feeds', fromObjectId: 'site', toObjectId: 'device' })],
    })
    expect(second.executable).toBe(false)
    expect(codes(second.findings)).toContain('RELATION_PREMISE_UNSUPPORTED')

    const negated = validator.validate({
      ruleId: 'r.not',
      condition: { op: 'not', operand: RELATION, spans: [] },
      exceptions: [],
      relationPremises: [declaration()],
    })
    expect(negated.executable).toBe(false)
    expect(codes(negated.findings)).toContain('UNSUPPORTED_NEGATION')
  })

  it('refuses a relation premise attached as an exception', () => {
    const exception: RuleExceptionNode = { exceptionId: 'e1', condition: RELATION, spans: [] }
    const report = validator.validate({
      ruleId: 'r.exc',
      condition: { op: 'compare', attributeId: 'power', operator: 'eq', value: 1, spans: [] },
      exceptions: [exception],
      relationPremises: [declaration()],
    })
    expect(report.executable).toBe(false)
    expect(codes(report.findings)).toContain('UNSUPPORTED_EXCEPTION')
  })
})

describe('one-hop relation premise synthetic evaluation (V03-027)', () => {
  const evaluator = new FiniteGrammarSyntheticEvaluator()

  it('is true when a confirmed, endpoint-resolved published relation exists', () => {
    const result = evaluator.evaluateRule({
      condition: RELATION,
      exceptions: [],
      fields: [],
      relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: true }],
      relationPremises: [declaration()],
    })
    expect(result.findings).toEqual([])
    expect(result.conditionState).toBe('true')
    expect(result.applicability).toBe('applicable')
    expect(result.propositionState).toBe('true')
  })

  it('stays unknown when the relation endpoint is unresolved or the read was not complete', () => {
    const unresolved = evaluator.evaluateRule({
      condition: RELATION,
      exceptions: [],
      fields: [],
      relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: false }],
      relationPremises: [declaration()],
    })
    expect(unresolved.conditionState).toBe('unknown')

    const missing = evaluator.evaluateRule({
      condition: RELATION,
      exceptions: [],
      fields: [],
      relations: [],
      relationPremises: [declaration()],
    })
    expect(missing.conditionState).toBe('unknown')
  })

  it('is an explicit false only when the relation read is attested complete', () => {
    const result = evaluator.evaluateRule({
      condition: RELATION,
      exceptions: [],
      fields: [],
      relations: [],
      relationPremises: [declaration()],
      relationReadComplete: true,
    })
    expect(result.conditionState).toBe('false')
  })

  it('still refuses a relation premise with no executable declaration', () => {
    const result = evaluator.evaluateRule({ condition: RELATION, exceptions: [], fields: [] })
    expect(result.conditionState).toBe('unknown')
    expect(result.findings.some((finding) => finding.code === 'RELATION_PREMISE_UNSUPPORTED')).toBe(true)
  })
})
