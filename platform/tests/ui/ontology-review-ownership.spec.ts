// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DefinitionWorkbenchPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { AssetCandidateVersion } from '@ontology/contracts'

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222', B = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444', digest = `sha256:${'a'.repeat(64)}`
const candidate: AssetCandidateVersion = { candidateId: A, workspaceId: W, batchId: D, domain: 'definition', kind: 'object', logicalId: 'device', payload: { kind: 'object', logicalId: 'device', displayName: '设备', businessMeaning: '同一份独立业务含义', suggestedReason: '原始依据', conflicts: [], identityAttributeIds: [] }, inputDraftRef: { workspaceId: W, revision: '1', digest }, sourceRefs: [{ id: D, version: '1.0.0', digest, kind: 'document' }], sourceSpans: [], state: 'produced', pendingConfirmation: false, issues: [], contentDigest: digest, idempotencyKey: digest, recordedAt: '2026-10-09T00:00:00Z' }
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
async function click(container: HTMLElement, text: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text); if (button === undefined) throw new Error(`missing ${text}`); await act(async () => button.click()) }
async function flush() { await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }) }

// Wire-boundary ownership regression; these port fixtures do not claim normal-host PG acceptance.
for (const mode of ['approval_reload', 'late_initial_read'] as const) describe(mode, () => {
  it('does not transfer an old CID approval or revision to a new CID with the same real-producer digest', async () => {
    let rows = [candidate], aReads = 0
    let resolveLate: (response: Response) => void = () => { throw new Error('late read resolver missing') }
    const late = new Promise<Response>((resolve) => { resolveLate = resolve })
    const posts: { id: string; match: string | null }[] = []
    const advance = () => { rows = [{ ...candidate, candidateId: B, replacesCandidateId: A }, candidate] }
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname, method = init?.method ?? 'GET'
      if (path.endsWith('/reviews')) {
        const id = path.split('/').at(-2) ?? ''
        if (method === 'GET') { if (id === A && (++aReads > 1 || mode === 'late_initial_read')) return late; return json({ reviews: [] }) }
        const match = new Headers(init?.headers).get('if-match'); posts.push({ id, match }); expect(match).toBe('0')
        if (id === A) advance()
        return json({ candidateId: id, revision: '1', contentDigest: digest, decision: 'approve', reason: '针对当前候选的独立审核' })
      }
      if (path.endsWith('/rule-action-candidates')) return json({ candidates: [] })
      if (path.endsWith('/drafts')) return json({ drafts: [{ workspaceId: W, revision: '1', digest, documentSetRef: { id: D, version: '1.0.0', digest, kind: 'artifact' }, candidateRefs: [] }] })
      if (path.endsWith('/definition-compatibility')) return json({ report: { workspaceId: W, revision: '1', additions: [], changes: [], breakingChanges: [], requiresRevisionStrategy: false } })
      if (path.endsWith('/generations')) return json({ batches: [] })
      if (path.endsWith('/unsupported-rules')) return json({ rules: [] })
      if (path.endsWith('/candidate-adjudications') || path.endsWith('/definition-adjudications')) return json({ adjudications: [] })
      if (path.endsWith('/candidates')) return json({ candidates: rows })
      return new Response(JSON.stringify({ error: { code: 'CAPABILITY_NOT_CONFIGURED', message: 'unavailable in this boundary test' } }), { status: 503 })
    }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    const reason = async () => { const textarea = container.querySelector<HTMLTextAreaElement>('.ontology-review-bar textarea'); if (textarea === null) throw new Error('review reason missing'); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '新候选需要独立审核'); textarea.dispatchEvent(new Event('input', { bubbles: true })) }) }
    try {
      await act(async () => root.render(createElement(DefinitionWorkbenchPanel, { client: new WorkbenchClient({ baseUrl: 'http://ownership.test', fetchImpl }), workspaceId: W })))
      if (mode === 'approval_reload') { await reason(); await click(container, '批准当前内容') }
      else { advance(); await click(container, '刷新当前版本') }
      await flush()
      expect(container.querySelector('.ontology-candidate-list .is-selected')?.getAttribute('data-candidate-id')).toBe(B)
      await act(async () => resolveLate(json({ reviews: [{ candidateId: A, revision: '7', contentDigest: digest, decision: 'approve', reason: '迟到的旧候选批准' }] })))
      await flush()
      expect(container.textContent).not.toContain('当前内容已人工批准')
      expect(container.textContent).not.toContain('迟到的旧候选批准')
      expect(aReads).toBe(1)
      await reason(); await click(container, '批准当前内容')
      expect(posts.at(-1)).toEqual({ id: B, match: '0' })
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
