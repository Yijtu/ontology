import { describe, expect, it } from 'vitest'
import { parseRuleActionCandidateOutput, parseRuleExpression } from '@ontology/application'

const compare = { op: 'compare', attributeId: 'status', operator: 'eq', value: 'ready', spans: [] }
const rule = { kind: 'rule', ruleId: 'ready', objectId: 'asset', displayName: 'Ready', businessMeaning: 'ready', suggestedReason: 'source', condition: compare, exceptions: [], sourceSelections: [] }

describe('rule/action parser never weakens undeclared semantic constraints', () => {
  it.each([
    { ...compare, caseInsensitive: true },
    { op: 'range', attributeId: 'hours', min: 10, max: 20, maxExclusive: true },
    { op: 'all', operands: [compare], atLeast: 1 },
    { op: 'relation', relationId: 'located', minCount: 2, targetCondition: compare },
  ])('rejects an extra semantic condition field', (condition) => {
    expect(() => parseRuleExpression(condition, 'condition')).toThrowError(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT', message: expect.stringContaining('unsupported field') }))
  })
  it('rejects exception/response fields and traversal or string overflow without dropping them', () => {
    expect(() => parseRuleActionCandidateOutput(JSON.stringify({ rules: [{ ...rule, exceptions: [{ exceptionId: 'extra', condition: compare, unless: true }] }] }))).toThrow(/exceptions\[0\].*unsupported field unless/)
    expect(() => parseRuleActionCandidateOutput(JSON.stringify({ rules: [rule], constraints: ['must retain this condition'] }))).toThrow(/response.*unsupported field constraints/)
    expect(() => parseRuleActionCandidateOutput(JSON.stringify({ rules: [{ ...rule, businessMeaning: 'x'.repeat(8193) }] }))).toThrow(/businessMeaning/)
    let nested: unknown = compare
    for (let i = 0; i < 34; i += 1) nested = { op: 'not', operand: nested }
    expect(() => parseRuleExpression(nested, 'condition')).toThrow(/32-depth\/512-node/)
    expect(() => parseRuleExpression({ op: 'toString' }, 'condition')).toThrowError(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT' }))
  })
  it('preserves supported family and resource-kind annotations while rejecting schema/ref extras', () => {
    const schema = { id: 'schema', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' }
    const action = { kind: 'action', actionId: 'summary', displayName: 'Summary', businessMeaning: 'summary', suggestedReason: 'source', inputSchemaRef: schema, outputSchemaRef: schema, readOnly: true, sideEffect: 'read_only' }
    const parsed = parseRuleActionCandidateOutput(JSON.stringify({ rules: [rule], actions: [action] }))
    expect(parsed.candidates[0]?.kind).toBe('rule')
    const saved = parsed.candidates[1]; if (saved?.kind !== 'action') throw new Error('missing supported declaration')
    expect(saved.declaration.inputSchemaRef).toEqual(schema)
    expect(() => parseRuleActionCandidateOutput(JSON.stringify({ actions: [{ ...action, inputSchemaRef: { ...schema, customSchema: {} } }] }))).toThrow(/inputSchemaRef.*unsupported field customSchema/)
    expect(() => parseRuleActionCandidateOutput(JSON.stringify({ actions: [{ ...action, suggestedOperationRef: { id: 'summary', version: '1.0.0', namespaceOverride: 'other' } }] }))).toThrow(/suggestedOperationRef.*unsupported field namespaceOverride/)
  })
})
