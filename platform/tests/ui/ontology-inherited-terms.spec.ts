// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ConditionEditor, parseExecutionPreview, parseTermLabels, prepareHumanRuleInput, buildHumanRuleQuestion, humanQuestionSet, appendHumanQuestion } from '@ontology/app-web'
import type { RuleExpressionNode } from '@ontology/contracts'
import { cqDigest, currentPreview, previewWire } from './competency-authoring-fixtures'
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
describe('actual inherited formal terms and independent CQ boundaries', () => {
  it('uses named inherited attributes with no fabricated candidate ID and preserves an exact decimal on explicit unitless selection', async () => {
    const preview = currentPreview(), container = document.createElement('div'), root = createRoot(container)
    let changed: RuleExpressionNode | undefined
    try {
      await act(async () => root.render(createElement(ConditionEditor, { value: { op: 'compare', attributeId: 'hours', operator: 'gte', value: '0.100000000000000001', unitCode: 'h', spans: [] }, onChange: (value) => { changed = value }, definitions: [], inheritedDefinition: preview.definitions, ...(preview.termLabels === undefined ? {} : { termLabels: preview.termLabels }), objectId: 'machine' })))
      const options = [...container.querySelectorAll('option')].map((node) => node.textContent)
      expect(options).toContain('运行时长'); expect(options).toContain('设备编号')
      const select = [...container.querySelectorAll<HTMLSelectElement>('select')].find((node) => node.value === 'hours')
      if (select === undefined) throw new Error('actual inherited attribute selector missing')
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'machine_id'); select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(changed).toMatchObject({ attributeId: 'machine_id', value: '0.100000000000000001' }); expect(changed).not.toHaveProperty('unitCode')
    } finally { await act(async () => root.unmount()) }
  })
  it('refuses labels and rule choices belonging to another actual formal identity', () => {
    const preview = currentPreview()
    expect(() => parseTermLabels({ attributes: [{ objectId: 'foreign', attributeId: 'hours', displayName: '同名属性' }], relations: [] }, preview.definitions)).toThrow()
    const wire = previewWire()
    expect(() => parseExecutionPreview({ ...wire, ruleChoices: wire.ruleChoices.map((rule) => ({ ...rule, ref: wire.definitionRef })) })).toThrow()
    expect(() => parseExecutionPreview({ ...wire, sources: wire.sources.map((source) => ({ ...source, wholeSourceLocation: { ...source.wholeSourceLocation, endOffset: source.byteSize + 1 } })) })).toThrow()
  })
  it('preserves exact input strings and independent edited expected literals when adding questions', () => {
    const preview = currentPreview(), rule = preview.ruleChoices[0]
    if (rule === undefined) throw new Error('actual rule choice missing')
    const input = prepareHumanRuleInput(preview, rule, { machine_id: 'M-1', hours: '9.000000000000000001' }), original = { id: '77777777-7777-4777-8777-777777777777', version: '1.0.0', digest: cqDigest(input.bytes) }
    const question = buildHumanRuleQuestion(preview, rule, input, original, { projectAlias: '88888888-8888-4888-8888-888888888888', questionId: 'independent-one', question: '独立问题', derivation: '独立原文推导', validAt: '2026-10-09T00:00:00Z', expected: { kind: 'rule', conditionState: 'false', applicability: 'not_applicable', propositionState: 'unknown' } })
    const body = humanQuestionSet(preview, [question]), edited = { ...body, questions: [{ ...question, expected: { ...question.expected, conditionState: 'conflict' } }] }
    const appended = appendHumanQuestion(preview, edited, { ...question, questionId: 'independent-two' })
    expect(appended['questions']).toEqual([...edited.questions, { ...question, questionId: 'independent-two' }])
    expect(new TextDecoder().decode(input.bytes)).toContain('9.000000000000000001')
    expect(question.expected).toEqual({ kind: 'rule', conditionState: 'false', applicability: 'not_applicable', propositionState: 'unknown' })
    expect(() => prepareHumanRuleInput(preview, rule, { machine_id: 'M-1', hours: '9e2' })).toThrow()
  })
})
