import { describe, expect, it } from 'vitest'
import type {
  ControlReadProjectionRequest,
  PublishedRuleVersion,
  PublishedStatement,
  RuleExpressionNode,
  ScopeRef,
  VersionRef,
} from '@ontology/contracts'
import {
  RuleEvaluator,
  compilePublishedRuleInstances,
  projectPublishedAttributeFacts,
  supportRuleFromPublishedRule,
} from '@ontology/semantic-engine'
import type { PublishedRuleSubject, RuleApplicabilityResult, RuleFact } from '@ontology/semantic-engine'

const scopeRef: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}
const definitionRef: VersionRef = {
  id: 'schema-facility',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}
const projectionRef: VersionRef = {
  id: 'projection.semantic',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
}
const evaluator = new RuleEvaluator()

function compare(attributeId: string, value: string | number | boolean, unitCode?: string): RuleExpressionNode {
  return {
    op: 'compare',
    attributeId,
    operator: 'eq',
    value,
    ...(unitCode === undefined ? {} : { unitCode }),
    spans: [],
  }
}

function publishedRule(overrides: Partial<PublishedRuleVersion> = {}): PublishedRuleVersion {
  return {
    ruleVersionId: '00000000-0000-4000-8000-000000000101',
    ruleId: 'rule.facility.maintenance',
    version: '1',
    objectId: 'facility',
    severity: 'soft',
    impact: 'low',
    expression: compare('in_service', true),
    exceptions: [],
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: '00000000-0000-4000-8000-000000000102',
    publicationId: '00000000-0000-4000-8000-000000000103',
    ...overrides,
  }
}

function statement(
  statementId: string,
  subjectEntityId: string,
  attributes: readonly { attributeId: string; value: unknown; unitCode?: string }[],
  overrides: Partial<PublishedStatement> = {},
  objectId = 'facility',
): PublishedStatement {
  return {
    statementId,
    propositionKey: `${subjectEntityId}.attributes`,
    kind: 'entity',
    objectId,
    subjectEntityId,
    predicate: objectId,
    value: { attributes },
    validFrom: '2026-09-20T00:00:00Z',
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: statementId,
    sourceRefs: [],
    publicationId: '00000000-0000-4000-8000-000000000104',
    version: '1',
    status: 'active',
    ...overrides,
  }
}

function projected(statements: readonly PublishedStatement[]): RuleFact[] {
  return [...projectPublishedAttributeFacts(statements, { schemaRef: definitionRef }).facts]
}

function request(asOfRecordedSeq?: string): ControlReadProjectionRequest {
  return {
    scopeRef,
    projectionRef,
    validAt: '2026-09-28T00:00:00Z',
    ...(asOfRecordedSeq === undefined ? {} : { asOfRecordedSeq }),
  }
}

function compileAndEvaluate(args: {
  readonly rules: readonly PublishedRuleVersion[]
  readonly facts: readonly RuleFact[]
  readonly subjects: readonly PublishedRuleSubject[]
  readonly asOfRecordedSeq?: string
  readonly completeRangeAttributeIds?: readonly string[]
}) {
  const compilation = compilePublishedRuleInstances(args.rules, args.facts, {
    scopeRef,
    definitionRef,
    subjects: args.subjects,
    ...(args.completeRangeAttributeIds === undefined ? {} : { completeRangeAttributeIds: args.completeRangeAttributeIds }),
  })
  const result = evaluator.evaluate({
    scopeRef,
    request: request(args.asOfRecordedSeq),
    definitionRef,
    facts: args.facts,
    rules: compilation.instances.map((instance) => instance.supportRule),
  })
  return { compilation, result }
}

function applicability(result: readonly RuleApplicabilityResult[], subjectEntityId: string): RuleApplicabilityResult {
  const found = result.find((entry) => entry.subjectEntityId === subjectEntityId)
  if (found === undefined) throw new Error(`no applicability result for ${subjectEntityId}`)
  return found
}

describe('published rule instances', () => {
  it('binds every condition to one subject and exact object/schema scope', () => {
    const rule = publishedRule({
      expression: {
        op: 'all',
        operands: [compare('inspection_due', true), compare('access_permit', true)],
        spans: [],
      },
    })
    const facts = projected([
      statement('00000000-0000-4000-8000-000000000201', 'facility-T-01', [{ attributeId: 'inspection_due', value: true }]),
      statement('00000000-0000-4000-8000-000000000202', 'facility-T-02', [{ attributeId: 'access_permit', value: true }]),
      statement('00000000-0000-4000-8000-000000000203', 'facility-T-03', [{ attributeId: 'inspection_due', value: true }], {}, 'vehicle'),
    ])
    const { compilation, result } = compileAndEvaluate({
      rules: [rule],
      facts,
      subjects: [
        { subjectEntityId: 'facility-T-01', objectId: 'facility' },
        { subjectEntityId: 'facility-T-02', objectId: 'facility' },
        { subjectEntityId: 'facility-T-03', objectId: 'facility' },
      ],
    })

    expect(compilation.issues).toEqual([])
    expect(compilation.instances).toHaveLength(3)
    expect(result.applicabilities.map((entry) => entry.subjectEntityId).sort()).toEqual([
      'facility-T-01',
      'facility-T-02',
      'facility-T-03',
    ])
    expect(result.applicabilities.map((entry) => entry.state)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(result.applicabilities.every((entry) => entry.positiveSupport === false)).toBe(true)
    expect(result.conclusions.every((entry) => entry.value !== false)).toBe(true)
  })

  it('keeps the published rule version and stable subject-qualified applicability key', () => {
    const rule = publishedRule()
    const facts = projected([statement('00000000-0000-4000-8000-000000000211', 'facility-T-11', [{ attributeId: 'in_service', value: true }])])
    const args = {
      rules: [rule],
      facts,
      subjects: [{ subjectEntityId: 'facility-T-11', objectId: 'facility' }],
    } as const
    const first = compilePublishedRuleInstances(args.rules, args.facts, { scopeRef, definitionRef, subjects: args.subjects })
    const reordered = compilePublishedRuleInstances([...args.rules].reverse(), [...args.facts].reverse(), {
      scopeRef,
      definitionRef,
      subjects: [...args.subjects].reverse(),
    })

    expect(first).toEqual(reordered)
    expect(first.instances[0]?.ruleRef).toEqual({
      id: rule.ruleVersionId,
      version: '1.0.0',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(first.instances[0]?.ruleRef.digest).not.toBe(`sha256:${'0'.repeat(64)}`)
    expect(first.instances[0]?.publishedRevision).toBe('1')
    expect(first.instances[0]?.ruleId).toBe(rule.ruleId)
    expect(first.instances[0]?.propositionKey).toContain('rule-applicability:')
  })

  it('keeps the legacy reference id stable and refuses exceptions or multi-subject facts', () => {
    const plain = publishedRule()
    const oneSubjectFacts = projected([
      statement('00000000-0000-4000-8000-000000000214', 'facility-T-14', [{ attributeId: 'in_service', value: true }]),
    ])
    const legacy = supportRuleFromPublishedRule(plain, oneSubjectFacts)
    expect(legacy.ruleRef).toEqual({
      id: plain.ruleId,
      version: '1.0.0',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(legacy.ruleRef.digest).not.toBe(`sha256:${'0'.repeat(64)}`)

    const withException = publishedRule({
      exceptions: [{ exceptionId: 'closed', condition: compare('closed', true), spans: [] }],
    })
    expect(() => supportRuleFromPublishedRule(withException, oneSubjectFacts)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_NEGATION' }),
    )

    const multiSubjectFacts = projected([
      statement('00000000-0000-4000-8000-000000000215', 'facility-T-15', [{ attributeId: 'in_service', value: true }]),
      statement('00000000-0000-4000-8000-000000000216', 'facility-T-16', [{ attributeId: 'in_service', value: true }]),
    ])
    expect(() => supportRuleFromPublishedRule(plain, multiSubjectFacts)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it('keeps exception applicability separate from proposition support', () => {
    const rule = publishedRule({
      exceptions: [
        {
          exceptionId: 'temporarily_closed',
          condition: compare('temporarily_closed', true),
          spans: [],
        },
      ],
    })
    const subject = { subjectEntityId: 'facility-T-21', objectId: 'facility' }
    const condition = statement('00000000-0000-4000-8000-000000000221', subject.subjectEntityId, [
      { attributeId: 'in_service', value: true },
    ])

    const notExcepted = compileAndEvaluate({
      rules: [rule],
      facts: projected([condition, statement('00000000-0000-4000-8000-000000000222', subject.subjectEntityId, [
        { attributeId: 'temporarily_closed', value: false },
      ])]),
      subjects: [subject],
    })
    const notExceptedResult = applicability(notExcepted.result.applicabilities, subject.subjectEntityId)
    expect(notExceptedResult.state).toBe('applicable')
    expect(notExceptedResult.exceptionStates).toEqual([{ exceptionId: 'temporarily_closed', state: 'false', factRefs: expect.any(Array) }])
    expect(notExceptedResult.positiveSupport).toBe(true)
    expect(notExceptedResult.sourceStatementIds).toHaveLength(2)
    expect(notExcepted.result.conclusions.find((entry) => entry.propositionKey === notExceptedResult.propositionKey)?.value).toBe(true)

    const missingException = compileAndEvaluate({ rules: [rule], facts: projected([condition]), subjects: [subject] })
    const missingResult = applicability(missingException.result.applicabilities, subject.subjectEntityId)
    expect(missingResult.state).toBe('unknown')
    expect(missingResult.positiveSupport).toBe(false)
    expect(missingException.result.conclusions.find((entry) => entry.propositionKey === missingResult.propositionKey)?.domainStatus).toBe('unknown')
    expect(missingException.result.conclusions.find((entry) => entry.propositionKey === missingResult.propositionKey)?.value).toBeUndefined()

    const excepted = compileAndEvaluate({
      rules: [rule],
      facts: projected([condition, statement('00000000-0000-4000-8000-000000000223', subject.subjectEntityId, [
        { attributeId: 'temporarily_closed', value: true },
      ])]),
      subjects: [subject],
    })
    const exceptedResult = applicability(excepted.result.applicabilities, subject.subjectEntityId)
    expect(exceptedResult.state).toBe('not_applicable')
    expect(exceptedResult.positiveSupport).toBe(false)
    expect(excepted.result.conclusions.find((entry) => entry.propositionKey === exceptedResult.propositionKey)?.domainStatus).toBe('unknown')
    expect(excepted.result.conclusions.find((entry) => entry.propositionKey === exceptedResult.propositionKey)?.value).not.toBe(false)

    const conditionFalse = compileAndEvaluate({
      rules: [rule],
      facts: projected([
        statement('00000000-0000-4000-8000-000000000224', subject.subjectEntityId, [
          { attributeId: 'in_service', value: false },
        ]),
        statement('00000000-0000-4000-8000-000000000225', subject.subjectEntityId, [
          { attributeId: 'temporarily_closed', value: false },
        ]),
      ]),
      subjects: [subject],
    })
    const conditionFalseResult = applicability(conditionFalse.result.applicabilities, subject.subjectEntityId)
    expect(conditionFalseResult.conditionState).toBe('false')
    expect(conditionFalseResult.state).toBe('not_applicable')
    expect(conditionFalse.result.conclusions.find((entry) => entry.propositionKey === conditionFalseResult.propositionKey)?.value).toBeUndefined()
  })

  it('keeps unknown and conflicting conditions distinct from rule non-applicability', () => {
    const rule = publishedRule({
      exceptions: [{ exceptionId: 'retired', condition: compare('retired', true), spans: [] }],
    })
    const subject = { subjectEntityId: 'facility-T-26', objectId: 'facility' }
    const exceptionFalse = statement('00000000-0000-4000-8000-000000000226', subject.subjectEntityId, [
      { attributeId: 'retired', value: false },
    ])
    const unknownCondition = compileAndEvaluate({ rules: [rule], facts: projected([exceptionFalse]), subjects: [subject] })
    expect(applicability(unknownCondition.result.applicabilities, subject.subjectEntityId).conditionState).toBe('unknown')
    expect(applicability(unknownCondition.result.applicabilities, subject.subjectEntityId).state).toBe('unknown')

    const conflictCondition = compileAndEvaluate({
      rules: [rule],
      subjects: [subject],
      facts: projected([
        statement('00000000-0000-4000-8000-000000000227', subject.subjectEntityId, [{ attributeId: 'in_service', value: true }]),
        statement('00000000-0000-4000-8000-000000000228', subject.subjectEntityId, [{ attributeId: 'in_service', value: false }]),
        exceptionFalse,
      ]),
    })
    expect(applicability(conflictCondition.result.applicabilities, subject.subjectEntityId).conditionState).toBe('conflict')
    expect(applicability(conflictCondition.result.applicabilities, subject.subjectEntityId).state).toBe('conflict')
  })

  it('recomputes exception false → retracted/missing → true while preserving parent references', () => {
    const rule = publishedRule({
      exceptions: [{ exceptionId: 'retired', condition: compare('retired', true), spans: [] }],
    })
    const subject = { subjectEntityId: 'facility-T-31', objectId: 'facility' }
    const current = statement('00000000-0000-4000-8000-000000000231', subject.subjectEntityId, [
      { attributeId: 'in_service', value: true },
    ])
    const falseException = statement('00000000-0000-4000-8000-000000000232', subject.subjectEntityId, [
      { attributeId: 'retired', value: false },
    ])
    const missingException = statement(
      falseException.statementId,
      subject.subjectEntityId,
      [{ attributeId: 'retired', value: false }],
      { version: '2', status: 'retracted' },
    )
    const trueException = statement(
      falseException.statementId,
      subject.subjectEntityId,
      [{ attributeId: 'retired', value: true }],
      { version: '3' },
    )
    const facts = projected([current, falseException, missingException, trueException])
    const evaluateAt = (seq: string) =>
      compileAndEvaluate({ rules: [rule], facts, subjects: [subject], asOfRecordedSeq: seq })

    const before = applicability(evaluateAt('1').result.applicabilities, subject.subjectEntityId)
    const middle = applicability(evaluateAt('2').result.applicabilities, subject.subjectEntityId)
    const after = applicability(evaluateAt('3').result.applicabilities, subject.subjectEntityId)
    expect(before.state).toBe('applicable')
    expect(middle.state).toBe('unknown')
    expect(middle.sourceStatementIds).toContain(falseException.statementId)
    expect(after.state).toBe('not_applicable')
    expect(after.sourceStatementIds).toContain(falseException.statementId)
    expect(after.factRefs.some((ref) => ref.logicalAssertionId === `${falseException.statementId}#retired`)).toBe(true)
  })

  it('surfaces premise conflicts and never chooses one disagreeing source as OR support', () => {
    const rule = publishedRule({
      exceptions: [{ exceptionId: 'retired', condition: compare('retired', true), spans: [] }],
    })
    const subject = { subjectEntityId: 'facility-T-41', objectId: 'facility' }
    const { compilation, result } = compileAndEvaluate({
      rules: [rule],
      subjects: [subject],
      facts: projected([
        statement('00000000-0000-4000-8000-000000000241', subject.subjectEntityId, [{ attributeId: 'in_service', value: true }]),
        statement('00000000-0000-4000-8000-000000000242', subject.subjectEntityId, [{ attributeId: 'retired', value: false }]),
        statement('00000000-0000-4000-8000-000000000243', subject.subjectEntityId, [{ attributeId: 'retired', value: true }]),
      ]),
    })
    expect(compilation.issues).toEqual([])
    const produced = applicability(result.applicabilities, subject.subjectEntityId)
    expect(produced.state).toBe('conflict')
    expect(produced.positiveSupport).toBe(false)
    expect(result.conflicts.some((conflict) => conflict.propositionKey === 'retired')).toBe(true)
  })

  it('compares exact decimal quantities with unit boundaries and keeps invalid values unknown', () => {
    const rule = publishedRule({
      expression: {
        op: 'range',
        attributeId: 'rated_capacity',
        min: 0.3,
        max: 0.3,
        unitCode: 'kW',
        spans: [],
      },
    })
    const subject = { subjectEntityId: 'facility-T-51', objectId: 'facility' }
    const exact = compileAndEvaluate({
      rules: [rule],
      subjects: [subject],
      facts: projected([statement('00000000-0000-4000-8000-000000000251', subject.subjectEntityId, [
        { attributeId: 'rated_capacity', value: 0.300, unitCode: 'kW' },
      ])]),
    })
    expect(applicability(exact.result.applicabilities, subject.subjectEntityId).state).toBe('applicable')

    const wrongUnit = compileAndEvaluate({
      rules: [rule],
      subjects: [subject],
      facts: projected([statement('00000000-0000-4000-8000-000000000252', subject.subjectEntityId, [
        { attributeId: 'rated_capacity', value: 0.3, unitCode: 'MW' },
      ])]),
    })
    expect(applicability(wrongUnit.result.applicabilities, subject.subjectEntityId).state).toBe('unknown')

    const invalid = projectPublishedAttributeFacts(
      [statement('00000000-0000-4000-8000-000000000253', subject.subjectEntityId, [
        { attributeId: 'rated_capacity', value: 'not-a-number', unitCode: 'kW' },
      ])],
      { schemaRef: definitionRef },
    )
    const invalidEvaluation = compileAndEvaluate({ rules: [rule], subjects: [subject], facts: [...invalid.facts] })
    expect(invalid.issues.map((issue) => issue.code)).toEqual(['INVALID_VALUE'])
    expect(applicability(invalidEvaluation.result.applicabilities, subject.subjectEntityId).state).toBe('unknown')
  })

  it('supports same-condition any and finite observed not, and reports mixed OR as unsupported', () => {
    const subject = { subjectEntityId: 'facility-T-56', objectId: 'facility' }
    const sameCondition = publishedRule({
      expression: {
        op: 'any',
        operands: [compare('in_service', true), compare('in_service', true)],
        spans: [],
      },
    })
    const sameConditionResult = compileAndEvaluate({
      rules: [sameCondition],
      subjects: [subject],
      facts: projected([statement('00000000-0000-4000-8000-000000000256', subject.subjectEntityId, [
        { attributeId: 'in_service', value: true },
      ])]),
    })
    expect(sameConditionResult.compilation.issues).toEqual([])
    expect(applicability(sameConditionResult.result.applicabilities, subject.subjectEntityId).state).toBe('applicable')

    const finiteNot = publishedRule({
      expression: {
        op: 'not',
        operand: compare('operating_mode', 'automatic'),
        spans: [],
      },
    })
    const finiteNotResult = compileAndEvaluate({
      rules: [finiteNot],
      subjects: [subject],
      facts: projected([statement('00000000-0000-4000-8000-000000000257', subject.subjectEntityId, [
        { attributeId: 'operating_mode', value: 'manual' },
      ])]),
    })
    expect(applicability(finiteNotResult.result.applicabilities, subject.subjectEntityId).state).toBe('applicable')

    const completeRangeNot = compileAndEvaluate({
      rules: [finiteNot],
      subjects: [subject],
      facts: [],
      completeRangeAttributeIds: ['operating_mode'],
    })
    expect(applicability(completeRangeNot.result.applicabilities, subject.subjectEntityId).state).toBe('applicable')

    const mixedAny = publishedRule({
      expression: {
        op: 'any',
        operands: [compare('in_service', true), compare('in_service', false)],
        spans: [],
      },
    })
    const mixed = compileAndEvaluate({ rules: [mixedAny], subjects: [subject], facts: [] })
    expect(mixed.compilation.instances).toHaveLength(0)
    expect(mixed.compilation.issues[0]?.code).toBe('UNSUPPORTED_FILTER')
  })

  it('reports unsupported rules per rule and keeps valid same-scope instances', () => {
    const unsupported = publishedRule({
      ruleId: 'rule.facility.relation',
      ruleVersionId: '00000000-0000-4000-8000-000000000261',
      expression: { op: 'relation', relationId: 'connected_to', spans: [] },
    })
    const supported = publishedRule({
      ruleId: 'rule.facility.in-service',
      ruleVersionId: '00000000-0000-4000-8000-000000000262',
    })
    const subject = { subjectEntityId: 'facility-T-61', objectId: 'facility' }
    const compilation = compilePublishedRuleInstances([unsupported, supported], [], {
      scopeRef,
      definitionRef,
      subjects: [subject],
    })
    expect(compilation.instances).toHaveLength(1)
    expect(compilation.issues).toHaveLength(1)
    expect(compilation.issues[0]?.ruleId).toBe(unsupported.ruleId)
    expect(compilation.issues[0]?.code).toBe('UNSUPPORTED_FILTER')
  })

  it('reports noncanonical raw revisions instead of emitting an invalid VersionRef', () => {
    const noncanonical = publishedRule({ version: '01' })
    const compilation = compilePublishedRuleInstances([noncanonical], [], {
      scopeRef,
      definitionRef,
      subjects: [{ subjectEntityId: 'facility-T-65', objectId: 'facility' }],
    })
    expect(compilation.instances).toHaveLength(0)
    expect(compilation.issues[0]).toMatchObject({
      ruleId: noncanonical.ruleId,
      ruleVersionId: noncanonical.ruleVersionId,
      publishedRevision: '01',
      code: 'INVALID_RULE',
    })
    expect(compilation.issues[0]?.ruleRef).toBeUndefined()
  })

  it('does not treat a rule mismatch or exception as a negative business fact when another rule supports', () => {
    const applicable = publishedRule({
      ruleId: 'rule.facility.primary',
      ruleVersionId: '00000000-0000-4000-8000-000000000271',
    })
    const excepted = publishedRule({
      ruleId: 'rule.facility.exceptional',
      ruleVersionId: '00000000-0000-4000-8000-000000000272',
      exceptions: [{ exceptionId: 'closed', condition: compare('closed', true), spans: [] }],
    })
    const subject = { subjectEntityId: 'facility-T-71', objectId: 'facility' }
    const { result } = compileAndEvaluate({
      rules: [applicable, excepted],
      subjects: [subject],
      facts: projected([
        statement('00000000-0000-4000-8000-000000000273', subject.subjectEntityId, [
          { attributeId: 'in_service', value: true },
          { attributeId: 'closed', value: true },
        ]),
      ]),
    })
    expect(result.applicabilities.map((entry) => entry.state).sort()).toEqual(['applicable', 'not_applicable'])
    expect(result.applicabilities.some((entry) => entry.positiveSupport)).toBe(true)
    expect(result.conclusions.every((entry) => entry.value !== false)).toBe(true)
  })
})
