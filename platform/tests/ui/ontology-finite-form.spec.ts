// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ConditionEditor, CompetencyQuestionWorkbench } from '@ontology/app-web'
import type { AssetCandidateVersion, DefinitionCandidatePayload, RuleExpressionNode } from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111'; const OTHER = '22222222-2222-4222-8222-222222222222'; const digest = `sha256:${'a'.repeat(64)}`
function attribute(logicalId: string, valueType: 'boolean' | 'quantity' | 'number', unitCode?: string): AssetCandidateVersion {
  const payload: DefinitionCandidatePayload = { kind: 'attribute', logicalId, displayName: logicalId, businessMeaning: logicalId, suggestedReason: '原始声明', conflicts: [], objectLogicalId: 'device', valueType, minCardinality: 0, maxCardinality: 1, ...(unitCode === undefined ? {} : { unitCode }) }
  return { candidateId: logicalId === 'mass' ? W : logicalId === 'count' ? OTHER : '33333333-3333-4333-8333-333333333333', batchId: OTHER, workspaceId: W, logicalId, domain: 'definition', kind: 'attribute', payload, inputDraftRef: { workspaceId: W, revision: '1', digest }, sourceRefs: [], sourceSpans: [], state: 'produced', issues: [], pendingConfirmation: false, contentDigest: digest, idempotencyKey: digest, recordedAt: '2026-10-01T00:00:00Z' }
}
async function setValue(input: HTMLSelectElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }) }
function labelled(container: HTMLElement, name: string): HTMLSelectElement | HTMLTextAreaElement { const label = [...container.querySelectorAll('label')].find((node) => node.textContent === name); const input = label === undefined ? null : container.querySelector(`[id="${label.htmlFor}"]`); if (!(input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) throw new Error(`Missing ${name}`); return input }
describe('finite condition and scope-switch regressions', () => {
  it('clears stale quantity units on explicit attr switches, keeps exact decimals, and submits only explicitly selected booleans', async () => {
    let submitted: RuleExpressionNode = { op: 'compare', attributeId: 'mass', operator: 'eq', value: '0.100000000000000001', unitCode: 'kg', spans: [] }
    function Harness() { const [value, set] = useState(submitted); return createElement(ConditionEditor, { value, definitions: [attribute('mass', 'quantity', 'kg'), attribute('count', 'number'), attribute('active', 'boolean')], objectId: 'device', onChange: (next) => { submitted = next; set(next) } }) }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(Harness)))
      await setValue(labelled(container, '属性'), 'count')
      expect(submitted).toMatchObject({ op: 'compare', attributeId: 'count', value: '0.100000000000000001' }); expect(submitted).not.toHaveProperty('unitCode')
      await setValue(labelled(container, '属性'), 'active')
      expect(submitted).toMatchObject({ op: 'compare', attributeId: 'active', value: '' }); expect(submitted).not.toHaveProperty('unitCode')
      const boolean = labelled(container, '比较值'); expect(boolean.value).toBe(''); expect(container.textContent).toContain('请选择明确的是或否')
      await setValue(boolean, 'false'); expect(submitted).toMatchObject({ op: 'compare', value: false }); expect(boolean.value).toBe('false')
    } finally { await act(async () => root.unmount()); container.remove() }
  })
  it('unlocks a new workspace during a pending CQ read and ignores the canceled old-scope response', async () => {
    let completeOld: ((response: Response) => void) | undefined
    let approved = 0
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: () => new Promise((resolve) => { completeOld = resolve }) })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    const render = (workspaceId: string) => root.render(createElement(CompetencyQuestionWorkbench, { client, workspaceId, readOnly: false, onApprovedRef: (ref) => { if (ref !== undefined) approved++ } }))
    try {
      await act(async () => render(W)); await setValue(labelled(container, '题集版本引用'), JSON.stringify({ id: W, version: '1.0.0', digest }))
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '读取原题集与当前审批')?.click())
      expect(labelled(container, '题集版本引用').disabled).toBe(true)
      await act(async () => render(OTHER))
      expect(labelled(container, '题集版本引用').disabled).toBe(false)
      await setValue(labelled(container, '题集版本引用'), JSON.stringify({ id: OTHER, version: '1.0.0', digest }))
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '读取原题集与当前审批')?.disabled).toBe(false)
      const declaration: unknown = JSON.parse(readFileSync(resolve('tests/fixtures/competency-questions/industrial.cq.json'), 'utf8'))
      await act(async () => completeOld?.(new Response(JSON.stringify({ data: { declaration, approved: true } }), { headers: { 'content-type': 'application/json' } })))
      expect(approved).toBe(0); expect(container.textContent).toContain('尚未读取题集'); expect(labelled(container, '题集版本引用').disabled).toBe(false)
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
