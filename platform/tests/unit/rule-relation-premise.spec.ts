import { relationPremisesFromDefinition } from '@ontology/contracts'
import type { RuleFact } from '@ontology/semantic-engine'
import { relationDefinition, relationCondition, targetCondition, invalidRelationTargets } from './rule-relation-fixtures'
import { SCOPE_A } from './verification-fixtures'
import { describe, expect, it } from 'vitest'
import type {
  RuleExceptionNode,
  RuleExpressionNode,
  RuleRelationPremiseDeclaration,
  RuleSupportFindingCode,
  VersionRef,
  PublishedRuleVersion,
} from '@ontology/contracts'
import {
  FiniteGrammarRuleSupportValidator,
  FiniteGrammarSyntheticEvaluator,
  compilePublishedRuleInstances,
  RuleEvaluator,
  MaterializationDependencyIndex,
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

describe('published and synthetic target-condition parity (#253)', () => {
  const definition = relationDefinition(SCOPE_A)
  const rule: PublishedRuleVersion = {
    ruleVersionId: '11111111-1111-4111-8111-111111111111', ruleId: 'site_ready', version: '1', objectId: 'site', severity: 'soft', impact: 'low',
    expression: relationCondition, exceptions: [], recordedAt: '2026-10-01T00:00:00Z', sourceCandidateId: '22222222-2222-4222-8222-222222222222', publicationId: '33333333-3333-4333-8333-333333333333',
  }
  const base = { recordedSeq: '1', op: 'assert' as const, schemaRef: definition.ref, validity: { validFrom: '2026-10-01T00:00:00Z', validTo: '2026-10-03T00:00:00Z' }, sourceRef: { namespace: 'test', sourceId: 'original' } }
  function fact(id: string, predicate: string, value: NonNullable<RuleFact['value']>): RuleFact {
    return { ...base, assertionId: id, logicalAssertionId: id, subject: 'meter-1', objectId: 'meter', predicate, value, sourceStatementId: id }
  }
  function edge(id = 'edge-1'): RuleFact {
    return { ...base, assertionId: id, logicalAssertionId: id, subject: 'site-1', objectId: 'site', predicate: 'meter_of', value: true, sourceStatementId: id, relation: { relationId: 'meter_of', targetEntityId: 'meter-1', targetObjectId: 'meter', endpointResolved: true } }
  }
  function evaluate(facts: readonly RuleFact[], complete = false, request: { validAt?: string; asOfRecordedSeq?: string } = {}) {
    const compiled = compilePublishedRuleInstances([rule], facts, { scopeRef: SCOPE_A, definitionRef: definition.ref, definition, subjects: [{ objectId: 'site', subjectEntityId: 'site-1' }], relationCompleteness: complete ? [{ scopeRef: SCOPE_A, definitionRef: definition.ref, subjectEntityId: 'site-1', relationId: 'meter_of', validAt: '2026-10-02T00:00:00Z', asOfRecordedSeq: '2' }] : [] })
    expect(compiled.issues).toEqual([])
    const result = new RuleEvaluator().evaluate({ scopeRef: SCOPE_A, definitionRef: definition.ref, facts, rules: compiled.instances.map((instance) => instance.supportRule), request: { scopeRef: SCOPE_A, projectionRef: definition.ref, validAt: '2026-10-02T00:00:00Z', asOfRecordedSeq: '2', ...request } })
    return { compiled, result, applicability: result.applicabilities[0] }
  }

  it.each([
    { fields: [{ fieldId: 'active', value: true }, { fieldId: 'power', value: 12, unitCode: 'kW' }], state: 'true' },
    { fields: [{ fieldId: 'active', value: false }, { fieldId: 'power', value: 12, unitCode: 'kW' }], state: 'false' },
    { fields: [{ fieldId: 'power', value: 12, unitCode: 'kW' }], state: 'unknown' },
    { fields: [{ fieldId: 'active', value: true }, { fieldId: 'active', value: false }, { fieldId: 'power', value: 12, unitCode: 'kW' }], state: 'conflict' },
    { fields: [{ fieldId: 'active', value: true }, { fieldId: 'power', value: 30, unitCode: 'kW' }, { fieldId: 'alarm', value: true }], state: 'true' },
  ])('evaluates target fields as $state through the same finite subset', ({ fields, state }) => {
    const synthetic = new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition: relationCondition, exceptions: [], fields: [{ fieldId: 'active', value: true }], relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: true, targetFields: fields }], relationPremises: relationPremisesFromDefinition(definition) })
    const facts = fields.map((field, index) => fact(`${field.fieldId}-${String(index)}`, field.fieldId, typeof field.value === 'number' ? { amount: String(field.value), unit: field.unitCode ?? '' } : field.value))
    expect(synthetic.conditionState).toBe(state)
    const runtime = evaluate([edge(), ...facts])
    expect(runtime.applicability?.conditionState).toBe(state)
    const group = runtime.result.supports.nodes.find((node) => node.kind === 'group' && node.relationBranches !== undefined)
    expect(group?.kind === 'group' ? group.relationBranches?.[0]?.targetGroupNodeIds.length : undefined).toBeGreaterThan(0)
    if (state === 'true') expect(runtime.result.conclusions[0]?.factRefs.map((ref) => ref.sourceStatementId)).toContain('active-0')
    if (state === 'conflict') expect(synthetic.sourceConflicts[0]?.fieldRef).toBe('active')
  })

  it('treats equivalent exact-decimal target observations as the same value', () => {
    const synthetic = new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition: relationCondition, exceptions: [], fields: [], relationPremises: relationPremisesFromDefinition(definition, relationCondition), relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: true, targetFields: [{ fieldId: 'active', value: true }, { fieldId: 'power', value: 12, unitCode: 'kW' }, { fieldId: 'power', value: '12.00', unitCode: 'kW' }] }] })
    expect(synthetic.conditionState).toBe('true')
    expect(synthetic.sourceConflicts).toEqual([])
    expect(evaluate([edge(), fact('active', 'active', true), fact('power-a', 'power', { amount: '12', unit: 'kW' }), fact('power-b', 'power', { amount: '12', unit: 'kW' })]).applicability?.conditionState).toBe('true')
  })

  it('shares target groups and observations across equivalent edge support without a Cartesian expansion', () => {
    const facts = [
      ...Array.from({ length: 100 }, (_, index) => edge(`edge-${String(index)}`)),
      ...Array.from({ length: 100 }, (_, index) => fact(`active-${String(index)}`, 'active', true)),
      ...Array.from({ length: 100 }, (_, index) => fact(`power-${String(index)}`, 'power', { amount: '12', unit: 'kW' })),
    ]
    const { compiled, result, applicability } = evaluate(facts)
    const group = compiled.instances[0]?.supportRule.premiseGroups[0]
    expect(group?.relation?.branches).toHaveLength(100)
    expect(group?.relation?.targetGroups).toHaveLength(3)
    expect(group?.relation?.targetConditions).toHaveLength(1)
    expect(group?.alternatives).toHaveLength(301)
    expect(applicability?.conditionState).toBe('true')
    expect(result.conclusions[0]?.factRefs).toHaveLength(300)
    expect(result.supports.nodes.length).toBeLessThan(400)
    expect(JSON.stringify(compiled.instances[0]?.supportRule).length).toBeLessThan(100_000)
  })

  it('keeps missing edges unknown without closure; unresolved, wrong-schema and expired facts never establish a premise', () => {
    const targets = [fact('active', 'active', true), fact('power', 'power', { amount: '12', unit: 'kW' })]
    expect(evaluate(targets).applicability?.conditionState).toBe('unknown')
    const disguised = { ...fact('fake-relation-field', 'meter_of', true), subject: 'site-1', objectId: 'site', attributeId: 'meter_of' }
    expect(evaluate([disguised, ...targets]).applicability?.conditionState).toBe('unknown')
    expect(evaluate(targets, true).applicability?.conditionState).toBe('false')
    expect(evaluate(targets, true, { asOfRecordedSeq: '1' }).applicability?.conditionState).toBe('unknown')
    expect(evaluate(targets, true, { validAt: '2026-10-04T00:00:00Z' }).applicability?.conditionState).toBe('unknown')
    expect(evaluate([{ ...edge(), relation: { relationId: 'meter_of', targetObjectId: 'meter', endpointResolved: false } }, ...targets], true).applicability?.conditionState).toBe('unknown')
    expect(evaluate([edge(), ...targets.map((target) => ({ ...target, schemaRef: DEFINITION }))]).applicability?.conditionState).toBe('unknown')
    expect(evaluate([edge(), ...targets], false, { validAt: '2026-10-04T00:00:00Z' }).applicability?.conditionState).toBe('unknown')
    expect(evaluate([edge(), ...targets], false, { asOfRecordedSeq: '0' }).applicability?.conditionState).toBe('unknown')
  })

  it('retracts one support without losing the independent edge or recorded history', () => {
    const facts = [edge(), edge('edge-2'), fact('active', 'active', true), fact('power', 'power', { amount: '12', unit: 'kW' })]
    const withdrawn = [...facts, { ...edge(), assertionId: 'edge-1@2', recordedSeq: '2', op: 'retract' as const }]
    const current = evaluate(withdrawn)
    expect(current.applicability?.conditionState).toBe('true')
    expect(current.applicability?.sourceStatementIds).toContain('edge-2')
    const historical = evaluate(withdrawn, false, { asOfRecordedSeq: '1' })
    expect(historical.applicability?.conditionState).toBe('true')
    const noTarget = [...withdrawn, { ...fact('active', 'active', true), assertionId: 'active@2', recordedSeq: '2', op: 'retract' as const }]
    expect(evaluate(noTarget).applicability?.conditionState).toBe('unknown')
    expect(evaluate(noTarget, false, { asOfRecordedSeq: '1' }).applicability?.conditionState).toBe('true')
    const index = MaterializationDependencyIndex.build({ facts: withdrawn, rules: current.compiled.instances.map((instance) => instance.supportRule) })
    expect(index.affectedRuleIds({ kind: 'identity_changed', changeId: 'target-split', scopeRef: SCOPE_A, recordedSeq: '2', recordedAt: '2026-10-02T00:00:00Z', entityId: 'meter-1', objectId: 'meter', separatedCandidateIds: [], reason: 'target source split' })).toEqual(current.compiled.instances.map((instance) => instance.supportRule.ruleId))
    expect(index.affectedRuleIds({ kind: 'assertion_retracted', changeId: 'change-1', scopeRef: SCOPE_A, recordedSeq: '2', recordedAt: '2026-10-02T00:00:00Z', validity: base.validity, logicalAssertionId: 'active', predicate: 'active', subjectEntityId: 'meter-1' })).toEqual(current.compiled.instances.map((instance) => instance.supportRule.ruleId))
  })

  it('never reuses the former target after an edge endpoint correction, including historical reads', () => {
    const original = edge()
    const corrected: RuleFact = { ...original, assertionId: 'edge-1@2', recordedSeq: '2', op: 'correct', relation: { relationId: 'meter_of', targetEntityId: 'meter-2', targetObjectId: 'meter', endpointResolved: true } }
    const observations = [fact('active', 'active', true), fact('power', 'power', { amount: '12', unit: 'kW' }),
      { ...fact('active-2', 'active', false), subject: 'meter-2' }, { ...fact('power-2', 'power', { amount: '12', unit: 'kW' }), subject: 'meter-2' }]
    expect(evaluate([original, corrected, ...observations]).applicability?.conditionState).toBe('false')
    expect(evaluate([original, corrected, ...observations], false, { asOfRecordedSeq: '1' }).applicability?.conditionState).toBe('true')
    expect(evaluate([{ ...original, op: 'retract' }, ...observations.map((fact) => ({ ...fact, value: false }))]).applicability?.conditionState).toBe('unknown')
  })

  it.each(invalidRelationTargets)('rejects the pinned target domain: $name across support, synthetic and compilation', ({ targetCondition }) => {
    const condition: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', targetCondition, spans: [] }
    const premises = relationPremisesFromDefinition(definition, condition)
    expect(premises).toEqual([])
    const support = new FiniteGrammarRuleSupportValidator().validate({ ruleId: 'typed-target', condition, exceptions: [], relationPremises: premises })
    expect(support.executable).toBe(false)
    expect(support.findings.map((finding) => finding.code)).toContain('RELATION_PREMISE_UNSUPPORTED')
    const synthetic = new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition, exceptions: [], fields: [], relationPremises: premises, relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: true, targetFields: [{ fieldId: 'active', value: true }, { fieldId: 'meter_id', value: 'same-name' }, { fieldId: 'power', value: 12, unitCode: 'kW' }] }] })
    expect(synthetic.conditionState).toBe('unknown')
    expect(synthetic.findings.map((finding) => finding.code)).toContain('RELATION_PREMISE_UNSUPPORTED')
    const compiled = compilePublishedRuleInstances([{ ...rule, expression: condition }], [edge(), fact('active', 'active', true), fact('power', 'power', { amount: '12', unit: 'kW' })], { scopeRef: SCOPE_A, definitionRef: definition.ref, definition, subjects: [{ objectId: 'site', subjectEntityId: 'site-1' }] })
    expect(compiled.instances).toEqual([])
    expect(compiled.issues).toHaveLength(1)
  })

  it.each([
    { name: 'typed boolean ne', targetCondition: { op: 'compare', attributeId: 'active', operator: 'ne', value: false, spans: [] } },
    { name: 'exact quantity eq', targetCondition: { op: 'compare', attributeId: 'power', operator: 'eq', value: '12.00', unitCode: 'kW', spans: [] } },
    { name: 'numeric range with unit', targetCondition: { op: 'range', attributeId: 'power', min: 10, max: 20, unitCode: 'kW', spans: [] } },
  ] satisfies readonly { readonly name: string; readonly targetCondition: RuleExpressionNode }[])('preserves valid pinned target parity: $name', ({ targetCondition }) => {
    const condition: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', targetCondition, spans: [] }
    const premises = relationPremisesFromDefinition(definition, condition)
    expect(new FiniteGrammarRuleSupportValidator().validate({ ruleId: 'typed-target', condition, exceptions: [], relationPremises: premises }).executable).toBe(true)
    const synthetic = new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition, exceptions: [], fields: [], relationPremises: premises, relations: [{ relationId: 'meter_of', targetObjectRef: 'meter', endpointResolved: true, targetFields: [{ fieldId: 'active', value: true }, { fieldId: 'power', value: 12, unitCode: 'kW' }] }] })
    expect(synthetic.conditionState).toBe('true')
    const facts = [edge(), fact('active', 'active', true), fact('power', 'power', { amount: '12', unit: 'kW' })]
    const compiled = compilePublishedRuleInstances([{ ...rule, expression: condition }], facts, { scopeRef: SCOPE_A, definitionRef: definition.ref, definition, subjects: [{ objectId: 'site', subjectEntityId: 'site-1' }] })
    expect(compiled.issues).toEqual([])
    const evaluated = new RuleEvaluator().evaluate({ scopeRef: SCOPE_A, definitionRef: definition.ref, facts, rules: compiled.instances.map((instance) => instance.supportRule), request: { scopeRef: SCOPE_A, projectionRef: definition.ref } })
    expect(evaluated.applicabilities[0]?.conditionState).toBe('true')
  })

  it('validates rule-scoped target attribute ownership and the exact definition pin', () => {
    const wrongTarget: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', targetCondition: { op: 'compare', attributeId: 'site_id', operator: 'eq', value: 'same-name', spans: [] }, spans: [] }
    const options = { scopeRef: SCOPE_A, definitionRef: definition.ref, definition, subjects: [{ objectId: 'site', subjectEntityId: 'site-1' }] }
    expect(compilePublishedRuleInstances([{ ...rule, expression: wrongTarget }], [], options).issues).toHaveLength(1)
    expect(compilePublishedRuleInstances([rule], [], { ...options, definitionRef: DEFINITION }).issues).toHaveLength(1)
    expect(compilePublishedRuleInstances([rule], [], { ...options, subjects: [] }).issues).toEqual([])
  })

  it('refuses unsupported target negation, second relation and relation exceptions in every path', () => {
    const declarations = [declaration({ targetCondition: { op: 'not', operand: { op: 'compare', attributeId: 'active', operator: 'eq', value: true, spans: [] }, spans: [] } })]
    expect(new FiniteGrammarRuleSupportValidator().validate({ ruleId: 'r', condition: RELATION, exceptions: [], relationPremises: declarations }).executable).toBe(false)
    const condition: RuleExpressionNode = { op: 'all', operands: [RELATION, RELATION], spans: [] }
    expect(new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition, fields: [], exceptions: [], relationPremises: [declaration()] }).findings).not.toEqual([])
    expect(compilePublishedRuleInstances([{ ...rule, expression: condition }], [], { scopeRef: SCOPE_A, definitionRef: definition.ref, definition, subjects: [] }).issues).toHaveLength(1)
    const relationException = { exceptionId: 'e-rel', condition: RELATION, spans: [] }
    expect(new FiniteGrammarSyntheticEvaluator().evaluateRule({ condition: targetCondition, exceptions: [relationException], fields: [], relationPremises: [declaration()] }).findings.map((finding) => finding.code)).toContain('UNSUPPORTED_EXCEPTION')
    expect(new FiniteGrammarRuleSupportValidator().validate({ ruleId: 'r', condition: targetCondition, exceptions: [{ exceptionId: 'e', condition: { op: 'any', operands: [RELATION, { op: 'compare', attributeId: 'alarm', operator: 'eq', value: true, spans: [] }], spans: [] }, spans: [] }], relationPremises: [declaration()] }).executable).toBe(false)
  })
})
