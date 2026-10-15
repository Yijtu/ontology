// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DefinitionWorkbenchPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { UnsupportedDefinitionRule } from '@ontology/contracts'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; environment.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111', D = '22222222-2222-4222-8222-222222222222', digest = `sha256:${'a'.repeat(64)}`
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
async function field(container: HTMLElement, label: string, value: string) {
  const node = [...container.querySelectorAll('label')].find((entry) => entry.textContent === label), input = node === undefined ? null : container.querySelector(`[id="${node.htmlFor}"]`)
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error(`missing ${label}`)
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

// HTTP-boundary UI proof; the existing service/route remains the non-executable authority.
describe('unsupported rule recording entry', () => {
  it.each(['每月任选一项人工核验，无法由有限条件表达。', ' {"op":"custom_quantifier","threshold":"0.100000000000000001"}\n'])('preserves the complete raw input through the real route and rereads the recorded list: %s', async (rawForm) => {
    let records: readonly UnsupportedDefinitionRule[] = [], listReads = 0
    let acknowledge: (response: Response) => void = () => { throw new Error('acknowledgement resolver missing') }
    const delayedAcknowledgement = new Promise<Response>((resolve) => { acknowledge = resolve })
    const writes: { readonly body: unknown; readonly match: string | null; readonly key: string | null }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/unsupported-rules')) {
        if (init?.method === 'POST') {
          const body: unknown = JSON.parse(String(init.body)); writes.push({ body, match: new Headers(init.headers).get('if-match'), key: new Headers(init.headers).get('idempotency-key') })
          const record: UnsupportedDefinitionRule = { ruleId: 'rule.manual_review', workspaceId: W, reason: '需要保留完整业务原文', rawForm, executable: false, idempotencyKey: writes[0]?.key ?? '', actor: 'human-editor', recordedAt: '2026-10-09T00:00:00Z' }
          records = [record]; return delayedAcknowledgement
        }
        listReads++; return json({ rules: records })
      }
      if (path.endsWith('/drafts')) return json({ drafts: [{ workspaceId: W, revision: '7', digest, documentSetRef: { id: D, version: '1.0.0', digest, kind: 'artifact' }, candidateRefs: [] }] })
      if (path.endsWith('/definition-compatibility')) return json({ report: { workspaceId: W, revision: '7', additions: [], changes: [], breakingChanges: [], requiresRevisionStrategy: false } })
      if (path.endsWith('/generations')) return json({ batches: [] })
      if (path.endsWith('/candidate-adjudications') || path.endsWith('/definition-adjudications')) return json({ adjudications: [] })
      if (path.endsWith('/candidates') || path.endsWith('/rule-action-candidates')) return json({ candidates: [] })
      return new Response(JSON.stringify({ error: { code: 'CAPABILITY_NOT_CONFIGURED', message: 'not configured in this wire-boundary proof' } }), { status: 503 })
    }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      const client = new WorkbenchClient({ baseUrl: 'http://unsupported-boundary.test', fetchImpl })
      await act(async () => root.render(createElement(DefinitionWorkbenchPanel, { client, workspaceId: W })))
      const disclosure = [...container.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent === '高级：保留暂时无法表达的规则')
      expect(disclosure?.open).toBe(false)
      await act(async () => disclosure?.querySelector('summary')?.click())
      await field(container, '规则记录标记', 'rule.manual_review'); await field(container, '保留原因', '需要保留完整业务原文'); await field(container, '完整原文（文本或 JSON）', rawForm)
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '记录为不可执行')
      if (button === undefined) throw new Error('missing recording entry')
      await act(async () => button.click())
      expect(disclosure?.querySelector('fieldset')?.disabled).toBe(true)
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '停止等待')?.disabled).toBe(false)
      expect(listReads).toBe(1)
      await act(async () => button.click())
      expect(writes).toHaveLength(1)
      await act(async () => acknowledge(json({ rule: records[0] })))
      expect(writes).toHaveLength(1); expect(writes[0]?.body).toEqual({ ruleId: 'rule.manual_review', reason: '需要保留完整业务原文', rawForm }); expect(writes[0]?.match).toBe('7'); expect(writes[0]?.key).toBeTruthy()
      expect(listReads).toBe(2); expect(records[0]?.executable).toBe(false); expect(container.textContent).toContain('保留的不可执行规则'); expect(container.textContent).toContain('不授予业务审批或执行能力')
      await act(async () => root.render(createElement(DefinitionWorkbenchPanel, { client, workspaceId: W, readOnly: true })))
      expect([...container.querySelectorAll('button')].some((node) => node.textContent === '记录为不可执行')).toBe(false)
      expect(container.textContent).toContain('保留的不可执行规则'); expect(writes).toHaveLength(1)
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
