// @vitest-environment jsdom
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DefinitionWorkbenchPanel, canonicalBody, encodeOriginalBytes, parseCompetencyDeclaration, parseGrounding, selectCompetencyQuestions, replaceOriginalRef } from '@ontology/app-web'
import { isDefinitionCandidatePayload } from '@ontology/contracts'
import type { AssetCandidateVersion, DefinitionCandidatePayload } from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const C = '44444444-4444-4444-8444-444444444444'
const D = '55555555-5555-4555-8555-555555555555'
const hash = `sha256:${'a'.repeat(64)}`
const changedHash = `sha256:${'b'.repeat(64)}`
const groundedHash = `sha256:${'c'.repeat(64)}`
const original = { id: D, version: '1.0.0', digest: hash, kind: 'document' as const }
const span = { kind: 'text' as const, parseId: B, chunkId: C, locator: { kind: 'text', startOffset: 0, endOffset: 12 }, spanKind: 'text' as const, precision: 'exact' as const, quoteDigest: hash, textDigest: hash }
function candidate(payload: DefinitionCandidatePayload): AssetCandidateVersion { return { candidateId: A, batchId: B, workspaceId: W, logicalId: payload.logicalId, domain: 'definition', kind: payload.kind, payload, inputDraftRef: { workspaceId: W, revision: '1', digest: hash }, sourceRefs: [original], sourceSpans: [], state: 'produced', issues: [], pendingConfirmation: false, contentDigest: hash, idempotencyKey: hash, recordedAt: '2026-10-01T00:00:00Z' } }
const common = { logicalId: 'device', displayName: '设备', businessMeaning: '独立设备定义', suggestedReason: '原始规定', conflicts: [] }
const object: DefinitionCandidatePayload = { ...common, kind: 'object', identityAttributeIds: [] }
const attribute: DefinitionCandidatePayload = { ...common, logicalId: 'mass', displayName: '质量', kind: 'attribute', objectLogicalId: 'device', valueType: 'quantity', unitCode: 'kg', dimension: 'mass', minCardinality: 0, maxCardinality: 1 }
const relation: DefinitionCandidatePayload = { ...common, logicalId: 'located_in', displayName: '位于', kind: 'relation', fromObjectLogicalId: 'device', toObjectLogicalId: 'device', minCardinality: 0, maxCardinality: 1 }
function json(data: unknown) { return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } }) }
function field(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const node = [...container.querySelectorAll('label')].find((item) => item.textContent === label)
  const input = node === undefined ? null : container.querySelector(`[id="${node.htmlFor}"]`)
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) throw new Error(`Missing field ${label}`)
  return input
}
async function change(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => { const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }) }
async function click(container: HTMLElement, label: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label); if (button === undefined) throw new Error(`Missing button ${label}`); await act(async () => button.click()) }

// These are HTTP-boundary UI proofs. They do not stand in for the normal-host PostgreSQL/E2E proof.
const edits: readonly { readonly name: string; readonly payload: DefinitionCandidatePayload; readonly label: string; readonly value: string; readonly expected: Readonly<Record<string, unknown>> }[] = [
  { name: 'business name', payload: object, label: '业务名称', value: '生产设备', expected: { displayName: '生产设备' } },
  { name: 'value type', payload: attribute, label: '值的类型', value: 'string', expected: { valueType: 'string' } },
  { name: 'unit', payload: attribute, label: '单位', value: 't', expected: { unitCode: 't' } },
  { name: 'dimension', payload: attribute, label: '量纲', value: 'weight', expected: { dimension: 'weight' } },
  { name: 'cardinality', payload: attribute, label: '最少值数量', value: '1', expected: { minCardinality: 1, maxCardinality: 1 } },
  { name: 'business meaning', payload: object, label: '业务含义', value: '项目内独立管理的设备', expected: { businessMeaning: '项目内独立管理的设备' } },
  { name: 'relation endpoint', payload: relation, label: '关系终点', value: 'workshop', expected: { toObjectLogicalId: 'workshop' } },
  { name: 'identity scope', payload: object, label: 'scope', value: 'project', expected: { identityScopeDimensions: ['project'] } },
]
describe('ontology immutable authoring workflow', () => {
  for (const edit of edits) it(`${edit.name}: edit → new candidate → host-fragment selection → another candidate → new content review`, async () => {
    let rows: readonly AssetCandidateVersion[] = [candidate(edit.payload), { ...candidate({ ...object, logicalId: 'workshop', displayName: '车间' }), candidateId: D }]
    let revision = '1'
    const writes: { readonly path: string; readonly body: unknown; readonly match: string | null }[] = []
    const workspace = () => ({ workspaceId: W, namespace: 'test', displayName: '真实接口边界测试', boundary: { goals: ['审核'], included: [], excluded: [], applicability: {} }, headRevision: revision, state: 'draft' })
    const draft = () => ({ workspaceId: W, revision, digest: hash, documentSetRef: { id: W, version: '1.0.0', digest: hash, kind: 'artifact' }, candidateRefs: [] })
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname; const method = init?.method ?? 'GET'
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      if (method === 'POST') writes.push({ path, body, match: new Headers(init?.headers).get('if-match') })
      if (path.endsWith('/edits')) {
        if (typeof body !== 'object' || body === null || !('payload' in body)) throw new Error('Missing edit payload')
        expect(body.payload).toMatchObject(edit.expected)
        if (!isDefinitionCandidatePayload(body.payload)) throw new Error('Invalid posted definition payload')
        const payload = body.payload
        // The independent port returns new immutable versions; it never transfers the old review.
        rows = [{ ...candidate(payload), candidateId: B, contentDigest: changedHash, pendingConfirmation: true, replacesCandidateId: A, sourceRefs: [] }, ...rows]
        revision = '2'
        return json({ created: true, candidates: [{ candidateId: B, workspaceId: W, logicalId: payload.logicalId, kind: payload.kind, state: 'pending_confirmation', payload, contentDigest: changedHash }], adjudication: { adjudicationId: C, kind: 'edit', reason: '人审修改', candidateIds: [A], producedCandidateIds: [B], affected: [], findings: [], compatibility: {} } })
      }
      if (path.endsWith('/source-confirmations')) {
        expect(body).toEqual({ contentDigest: changedHash, sourceRef: original, fragmentIndex: 0, reason: '已核对原文片段' })
        const first = rows[0]; if (first === undefined) throw new Error('Missing edited row')
        rows = [{ ...first, candidateId: C, contentDigest: groundedHash, replacesCandidateId: B, pendingConfirmation: false, sourceRefs: [original], sourceSpans: [] }, ...rows]; revision = '3'
        return json({ batch: {}, candidates: [rows[0]], created: true })
      }
      if (path.endsWith('/reviews')) {
        const id = path.split('/').at(-2)
        if (method === 'GET') return json({ reviews: id === A ? [{ revision: '1', contentDigest: hash, decision: 'approve', reason: '旧内容审批' }] : [] })
        expect(id).toBe(C); expect(new Headers(init?.headers).get('if-match')).toBe('0')
        return json({ revision: '1', contentDigest: groundedHash, decision: 'approve', reason: '独立批准新内容' })
      }
      if (path.endsWith('/source-grounding')) return json({ workspaceRevision: revision, inputDraftRef: { workspaceId: W, revision, digest: hash }, documentSetRef: draft().documentSetRef, coverage: 'complete', usage: { fragments: 1, bytes: 12, inputTokens: 12, pages: 1, readBytes: 12 }, sources: [{ sourceRef: original, trust: 'untrusted_source_data', status: 'complete', reasons: [], contents: [] }], fragments: [{ sourceIndex: 0, fragmentIndex: 0, sourceRef: original, sourceSpan: span, content: { kind: 'text', text: '这是独立原始规定' } }] })
      if (path.endsWith('/sources')) return json({ workspace: workspace(), draft: draft(), sources: [{ sourceRef: original, name: '原始规定', kind: 'document', parseId: B, parserVersion: '1.0.0', status: 'complete', previewCoverage: 'complete', coverage: { status: 'complete', completeness: 'complete', totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] } }] })
      if (path.endsWith('/authoring-context')) return new Response(JSON.stringify({ error: { code: 'CAPABILITY_NOT_CONFIGURED', message: 'not mounted' } }), { status: 503 })
      if (path.endsWith('/rule-action-candidates')) return json({ candidates: [] })
      if (path.endsWith('/drafts')) return json({ drafts: [draft()] })
      if (path.endsWith('/definition-compatibility')) return json({ report: { workspaceId: W, revision, additions: [], changes: [], breakingChanges: [], requiresRevisionStrategy: false } })
      if (path.endsWith('/unsupported-rules')) return json({ rules: [] })
      if (path.endsWith('/generations')) return json({ batches: [] })
      if (path.endsWith('/candidate-adjudications') || path.endsWith('/definition-adjudications')) return json({ adjudications: [] })
      if (path.endsWith('/candidates')) return json({ candidates: rows })
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: path } }), { status: 404 })
    }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(DefinitionWorkbenchPanel, { client: new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl }), workspaceId: W })))
      await click(container, '编辑定义')
      if (edit.label === 'scope') { const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((node) => node.parentElement?.textContent?.includes('限于当前项目')); if (checkbox === undefined) throw new Error('Missing project scope'); await act(async () => checkbox.click()) }
      else await change(field(container, edit.label), edit.value)
      await change(field(container, '本次修改原因'), '人审修改')
      await click(container, '保存为新候选')
      expect(container.querySelector('[data-candidate-id="' + B + '"]')).not.toBeNull()
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '批准当前内容')?.disabled).toBe(true)
      await click(container, '查看原始资料与定位片段')
      const originalChoice = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((node) => node.parentElement?.textContent === '原始规定'); if (originalChoice === undefined) throw new Error('Missing actual original'); await act(async () => originalChoice.click())
      await click(container, '读取所选原文与真实片段')
      const radio = container.querySelector<HTMLInputElement>('dialog input[type=radio]'); if (radio === null) throw new Error('Missing read-back fragment'); await act(async () => radio.click())
      await change(field(container, '来源确认说明'), '已核对原文片段')
      await click(container, '确认依据并生成新候选')
      expect(container.querySelector('[data-candidate-id="' + C + '"]')).not.toBeNull()
      await click(container, '关闭 ×')
      await change(field(container, '审核意见'), '独立批准新内容')
      await click(container, '批准当前内容')
      expect(writes.filter((w) => /\/edits$|\/source-confirmations$|\/reviews$/.test(w.path)).map((w) => [w.path.split('/').at(-2), w.match])).toEqual([[A, '1'], [B, '2'], [C, '0']])
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
describe('ontology source and CQ boundaries', () => {
  it('round trips original binary bytes including non-UTF8 XLSX bytes without text decoding', () => { const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0, 0x80]); expect([...atob(encodeOriginalBytes(bytes))].map((c) => c.charCodeAt(0))).toEqual([80, 75, 3, 4, 255, 0, 128]) })
  it('rejects a fragment whose sourceIndex claims another actual source pin', () => { expect(() => parseGrounding({ workspaceRevision: '1', documentSetRef: { ...original, kind: 'artifact' }, coverage: 'complete', usage: { bytes: 1, readBytes: 1, fragments: 1, pages: 1, inputTokens: 1 }, sources: [{ sourceRef: original, status: 'complete', reasons: [] }], fragments: [{ sourceIndex: 1, fragmentIndex: 0, sourceRef: original, sourceSpan: span, content: { kind: 'text', text: '原文' } }] })).toThrow() })
  it('creates an explicit new compatible subset without altering any independently authored expected result or old body', () => {
    const raw: unknown = JSON.parse(readFileSync(resolve('tests/fixtures/competency-questions/industrial.cq.json'), 'utf8'))
    const originalSet = parseCompetencyDeclaration(raw); const before = canonicalBody(originalSet.body)
    const chosen = originalSet.questions.slice(0, 2).map((q) => q.questionId)
    const next = parseCompetencyDeclaration(selectCompetencyQuestions(originalSet, chosen))
    expect(next.questions.map((q) => q.expected)).toEqual(originalSet.questions.slice(0, 2).map((q) => q.expected))
    expect(next.questions).toHaveLength(2); expect(canonicalBody(originalSet.body)).toBe(before)
    expect(canonicalBody(next.body)).not.toBe(before)
  })
  it('rebinds only declared source references and leaves independent expected data untouched', () => {
    const ref = { id: A, version: '1.0.0', digest: hash }; const actual = { id: B, version: '1.0.0', digest: changedHash }
    const value = { input: { sourceRef: ref }, expected: { sourceRef: ref, value: '0.100000000000000001' } }
    expect(replaceOriginalRef(value, ref, actual)).toEqual({ input: { sourceRef: actual }, expected: value.expected })
    expect(value.input.sourceRef).toEqual(ref)
  })
})
