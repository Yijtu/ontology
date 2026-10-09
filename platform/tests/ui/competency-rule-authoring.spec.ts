// @vitest-environment jsdom
import { randomUUID, webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { contentDigestOf } from '@ontology/application'
import { CompetencyQuestionWorkbench, canonicalBody } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import { isRecord as isObject, isVersionRef } from '@ontology/contracts'
import type { VersionRef } from '@ontology/contracts'
import { CQ_WORKSPACE, cqDigest, currentPreview } from './competency-authoring-fixtures'

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
function field(container: HTMLElement, name: string) { const label = [...container.querySelectorAll('label')].find((row) => row.textContent === name), node = label === undefined ? null : container.querySelector(`[id="${label.htmlFor}"]`); if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) throw new Error(`missing field ${name}`); return node }
async function change(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { await act(async () => { const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }) }
async function click(container: HTMLElement, name: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === name); if (button === undefined) throw new Error(`missing button ${name}`); expect(button.disabled, container.textContent ?? name).toBe(false); await act(async () => button.click()) }
async function waitUntil(predicate: () => boolean, diagnostic?: () => string) { for (let i = 0; i < 30 && !predicate(); i++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)) }); expect(predicate(), diagnostic?.()).toBe(true) }

describe('ordinary independent CQ authoring at the HTTP boundary', () => {
  it('uploads literal CSV, retains edited independent expectations on append, reads the new BODY back and separately reviews its new CID without JSON input', async () => {
    const cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    const preview = currentPreview(), originals: string[] = [], order: string[] = [], callbacks: (VersionRef | undefined)[] = []
    let saved: { ref: VersionRef; body: Record<string, unknown> } | undefined, approved = false
    let finishSecond: (() => void) | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname, method = init?.method ?? 'GET'
      if (path.endsWith('/competency-question-sources')) {
        expect(new Headers(init?.headers).get('x-source-media-type')).toBe('text/csv')
        if (!(init?.body instanceof Blob)) throw new Error('original CSV byte blob missing')
        const blob = init.body
        const bytes = await new Promise<Uint8Array>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result)); else reject(new Error('original byte read failed')) }; reader.onerror = () => reject(new Error('original byte read failed')); reader.readAsArrayBuffer(blob) })
        originals.push(new TextDecoder().decode(bytes)); order.push('original')
        const response = json({ sourceRef: { id: randomUUID(), version: '1.0.0', digest: cqDigest(bytes) } })
        if (originals.length === 2) return new Promise<Response>((resolve) => { finishSecond = () => resolve(response) })
        return response
      }
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      if (path.endsWith('/competency-question-sets')) {
        if (!isObject(body) || !isVersionRef(body['ref']) || !isObject(body['body'])) throw new Error('new declaration body missing')
        expect(body['ref'].digest).toBe(contentDigestOf(body['body'])); saved = { ref: body['ref'], body: body['body'] }; order.push('save'); approved = false
        return json({ declaration: saved, candidateId: saved.ref.id, approvalRequired: true })
      }
      if (path.endsWith('/competency-question-sets/read')) { order.push('readback'); return json({ declaration: saved, approved }) }
      if (path.endsWith('/reviews') && method === 'GET') return json({ reviews: [] })
      if (path.endsWith('/reviews') && method === 'POST') { expect(saved).toBeDefined(); expect(path.split('/').at(-2)).toBe(saved?.ref.id); expect(new Headers(init?.headers).get('if-match')).toBe('0'); order.push('human-review'); approved = true; return json({ candidateId: saved?.ref.id, contentDigest: saved?.ref.digest, revision: '1', decision: 'approve', reason: '独立人工审核' }) }
      return new Response('', { status: 404 })
    }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(CompetencyQuestionWorkbench, { client: new WorkbenchClient({ baseUrl: 'http://authoring.test', fetchImpl }), workspaceId: CQ_WORKSPACE, preview, readOnly: false, onApprovedRef: (ref) => callbacks.push(ref) })))
      await change(field(container, '要验证的业务规则'), 'maintenance')
      await change(field(container, '设备编号（必填）'), '机组-01'); await change(field(container, '运行时长（必填）'), '9.000000000000000001')
      await change(field(container, '业务问题'), '这台设备是否适用维护要求？'); await change(field(container, '期望条件'), 'false'); await change(field(container, '期望适用性'), 'not_applicable'); await change(field(container, '独立期望的依据'), '独立核对原始规范，期望不来自当前运行结果。')
      await click(container, '上传原始行并加入新题集'); await waitUntil(() => container.textContent?.includes('合成原始行已真实存档') === true, () => `${JSON.stringify({ originals, order })} ${container.textContent ?? ''}`)
      expect(originals[0]).toBe('machine_id,hours\n机组-01,9.000000000000000001\n')
      expect(container.textContent).not.toContain('当前题集已人工批准')
      const firstCard = container.querySelector<HTMLElement>('.ontology-question-list li')
      if (firstCard === null) throw new Error('first independent question editor missing')
      await act(async () => firstCard.querySelector<HTMLElement>('details summary')?.click())
      await change(field(firstCard, '条件状态'), 'conflict')
      await change(field(container, '运行时长（必填）'), '6.500000000000000001'); await change(field(container, '业务问题'), '第二个独立问题'); await change(field(container, '期望条件'), 'true'); await change(field(container, '期望适用性'), 'applicable')
      await click(container, '上传原始行并加入新题集'); await waitUntil(() => finishSecond !== undefined)
      expect(container.querySelector<HTMLInputElement>('.ontology-question-list input[type=checkbox]')?.disabled).toBe(true)
      expect(field(container, '完整题集内容').disabled).toBe(true)
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '停止等待（保留输入）')?.disabled).toBe(false)
      await act(async () => finishSecond?.())
      await waitUntil(() => originals.length === 2 && container.textContent?.includes('2 个问题在当前待保存题集') === true)
      await click(container, '保存为全新题集'); await waitUntil(() => saved !== undefined && order.includes('readback'))
      if (saved === undefined || !Array.isArray(saved.body['questions'])) throw new Error('actual readback declaration missing')
      expect(saved.body['questions']).toHaveLength(2)
      const first: unknown = saved.body['questions'][0], second: unknown = saved.body['questions'][1]
      if (!isObject(first) || !isObject(second) || !isObject(first['input']) || !isObject(second['input'])) throw new Error('independent input records missing')
      expect(first['expected']).toEqual({ kind: 'rule', conditionState: 'conflict', applicability: 'not_applicable', propositionState: 'unknown' })
      expect(second['expected']).toEqual({ kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'unknown' })
      expect(first['input']['projectId']).toBe(second['input']['projectId']); expect(first['input']['projectId']).not.toBe(CQ_WORKSPACE)
      expect(order).toEqual(['original','original','save','readback'])
      expect(callbacks.at(-1)).toBeUndefined()
      await change(field(container, '新题集人工审核意见'), '逐条独立核对输入与期望'); await click(container, '人工批准当前新题集'); await waitUntil(() => callbacks.at(-1)?.id === saved?.ref.id)
      expect(order.slice(-2)).toEqual(['human-review','readback'])
      expect(canonicalBody(saved.body)).toContain('9.000000000000000001')
    } finally { await act(async () => root.unmount()); container.remove(); if (cryptoBefore !== undefined) Object.defineProperty(globalThis, 'crypto', cryptoBefore) }
  })
  it('unlocks the same workspace when its preview is invalidated during a source upload and ignores the late original acknowledgment', async () => {
    const preview = currentPreview()
    let finish: (response: Response) => void = () => { throw new Error('source request missing') }, sourceRequested = false, bodyWrites = 0
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    const fetchImpl: typeof fetch = async (input) => { if (String(input).endsWith('/competency-question-sources')) { sourceRequested = true; return pending }; bodyWrites++; return new Response('', { status: 404 }) }
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container), client = new WorkbenchClient({ baseUrl: 'http://authoring.test', fetchImpl })
    const approvals: (VersionRef | undefined)[] = [], onApprovedRef = (ref: VersionRef | undefined) => approvals.push(ref)
    try {
      await act(async () => root.render(createElement(CompetencyQuestionWorkbench, { client, workspaceId: CQ_WORKSPACE, preview, readOnly: false, onApprovedRef })))
      await change(field(container, '要验证的业务规则'), 'maintenance'); await change(field(container, '设备编号（必填）'), 'M-2'); await change(field(container, '运行时长（必填）'), '8')
      await change(field(container, '业务问题'), '仍待上传的问题'); await change(field(container, '期望条件'), 'true'); await change(field(container, '期望适用性'), 'applicable'); await change(field(container, '独立期望的依据'), '独立填写')
      await click(container, '上传原始行并加入新题集'); expect(sourceRequested).toBe(true)
      await act(async () => root.render(createElement(CompetencyQuestionWorkbench, { client, workspaceId: CQ_WORKSPACE, readOnly: false, onApprovedRef })))
      await change(field(container, '题集版本引用'), JSON.stringify({ id: randomUUID(), version: '1.0.0', digest: cqDigest('independently authored declaration reference') }))
      const read = [...container.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === '读取原题集与当前审批')
      expect(read?.disabled).toBe(false)
      await act(async () => finish(json({ sourceRef: { id: randomUUID(), version: '1.0.0', digest: cqDigest('machine_id,hours\nM-2,8\n') } })))
      expect(bodyWrites).toBe(0); expect(approvals.filter((ref) => ref !== undefined)).toEqual([])
      expect(container.querySelector('.ontology-question-list')).toBeNull(); expect(container.textContent).toContain('尚未编写当前题集')
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
