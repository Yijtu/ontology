// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { WorkspaceSourcesPanel } from '@ontology/app-web'
import type { IndustryWorkspace } from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111'; const S = '22222222-2222-4222-8222-222222222222'; const P = '33333333-3333-4333-8333-333333333333'
const digest = `sha256:${'a'.repeat(64)}`
const workspace = (revision = '1'): IndustryWorkspace => ({ workspaceId: W, namespace: 'test', displayName: '资料工作区', boundary: { goals: ['资料验证'], included: [], excluded: [], applicability: {} }, state: 'draft', headRevision: revision })
const draft = (revision: string) => ({ workspaceId: W, revision, digest, documentSetRef: { id: P, version: '1.0.0', digest, kind: 'artifact' }, candidateRefs: [] })
const source = { sourceRef: { id: S, version: '1.0.0', digest, kind: 'document' }, name: '原始台账', kind: 'table', parseId: P, parserVersion: '1.0.0', status: 'complete', previewCoverage: 'complete', coverage: { status: 'complete', completeness: 'complete', totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] }, tables: [{ tableId: 'table-1', sheetName: '运营台账', headerRow: 3, columns: [{ columnIndex: 0, header: '数量', headerDigest: digest }], rows: [{ sourceRowKey: 'row-4', cells: [{ columnIndex: 0, raw: '0.100000000000000001' }] }] }] }
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
const identity = { newId: () => W, sha256: () => Promise.resolve(digest) }
function baseline(path: string, revision: string, generationEnabled = true): Response {
  if (path.endsWith('/authoring-context')) return json({ scopeRef: { tenantId: W, spaceId: P }, workspace: workspace(revision), draft: draft(revision), generationPolicyRef: { id: 'actual-policy', version: '1.0.0', digest }, models: { generationEnabled, decisionEnabled: false }, operations: [], generationLimits: { maxOutputTokens: 16384, maxCandidatesPerCall: 25, maxSources: 64, sourceContextBytes: 65536, sourceReadBytes: 33554432, sourceFragments: 32 } })
  return json({ workspace: workspace(revision), draft: draft(revision), sources: [source] })
}
async function text(container: HTMLElement, label: string, value: string) { const l = [...container.querySelectorAll('label')].find((n) => n.textContent === label); const input = l === undefined ? null : container.querySelector(`[id="${l.htmlFor}"]`); if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${label}`); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function button(container: HTMLElement, label: string) { const b = [...container.querySelectorAll<HTMLButtonElement>('button')].find((n) => n.textContent === label); if (b === undefined) throw new Error(`Missing ${label}`); await act(async () => b.click()) }
async function chooseFile(container: HTMLElement) {
  const bytes = new Uint8Array([80, 75, 3, 4, 255, 0, 128]); const file = new File([bytes], '原始台账.xlsx')
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  const input = container.querySelector<HTMLInputElement>('input[type=file]'); if (input === null) throw new Error('Missing file input')
  await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
describe('workspace source UI boundary', () => {
  it('uploads untouched binary bytes and actual header/sheet options, then adopts only the host corpus revision', async () => {
    let revision = '1'; let uploaded: unknown; let changes = 0
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input, init) => { const path = new URL(String(input)).pathname; if (init?.method === 'POST') { uploaded = JSON.parse(String(init.body)); expect(new Headers(init.headers).get('if-match')).toBe('1'); expect(new Headers(init.headers).get('idempotency-key')).toBeTruthy(); revision = '2'; return json({ workspace: workspace(revision), draft: draft(revision), source }) } return baseline(path, revision) } })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    const render = () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(revision), identity, onWorkspaceChanged: (actual, actualDraft) => { changes++; expect(actual.headRevision).toBe('2'); expect(actualDraft.documentSetRef.id).toBe(P); render() } }))
    try {
      await act(async () => render()); await chooseFile(container); await text(container, '实际表头所在行', '3'); await text(container, '实际数据起始行', '4'); await text(container, '工作表名称（多表时填写）', '运营台账'); await button(container, '上传并读取真实资料')
      expect(uploaded).toEqual({ name: '原始台账.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentEncoding: 'base64', content: 'UEsDBP8AgA==', options: { headerRow: 3, dataStartRow: 4, sheetName: '运营台账' } })
      expect(changes).toBe(1); expect(container.textContent).toContain('0.100000000000000001')
      expect([...container.querySelectorAll('button')].some((b) => b.textContent === '停止等待并保留当前输入')).toBe(false)
    } finally { await act(async () => root.unmount()); container.remove() }
  })
  it('model-off and read-only state keep original previews but prohibit writes and generation', async () => {
    let writes = 0
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input, init) => { if (init?.method === 'POST') writes++; return baseline(new URL(String(input)).pathname, '1', false) } })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity })))
      expect(container.textContent).toContain('生成模型未配置')
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '从所选真实资料生成候选')?.disabled).toBe(true)
      await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity, readOnly: true })))
      expect(container.querySelector('input[type=file]')).toBeNull(); expect(container.textContent).toContain('查看真实原文与片段'); expect(writes).toBe(0)
    } finally { await act(async () => root.unmount()); container.remove() }
  })
  it('summarizes the actual generation batch and keeps its complete JSON folded', async () => {
    const batch = { batchId: P, workspaceId: W, domain: 'definition', inputDraftRef: { workspaceId: W, revision: '1', digest }, modelRef: { providerId: 'controlled', modelId: 'controlled' }, responseSchemaRef: { id: 'schema', version: '1.0.0', digest }, documentSetRef: draft('1').documentSetRef, generationPolicyRef: { id: 'actual-policy', version: '1.0.0', digest }, state: 'pending_confirmation', counts: { total: 1, produced: 0, pendingConfirmation: 1, pendingReview: 0, failed: 0 }, idempotencyKey: 'fixture-generation-key', requestDigest: digest, createdBy: 'test', recordedAt: '2026-10-01T00:00:00Z' }
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input, init) => { if (init?.method === 'POST') { const request: unknown = JSON.parse(String(init.body)); expect(request).toMatchObject({ candidateLimit: 25, sourceRefs: [source.sourceRef] }); return json({ batch, candidates: [{}], created: true }) }; return baseline(new URL(String(input)).pathname, '1') } })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try { await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity }))); await button(container, '从所选真实资料生成候选'); expect(container.textContent).toContain('实际候选 1 项'); expect(container.textContent).toContain('来源待确认 1 项'); const disclosure = [...container.querySelectorAll('details')].find((node) => node.querySelector('summary')?.textContent === '高级：服务端记录的完整生成批次'); expect(disclosure).toBeDefined(); expect(disclosure?.open).toBe(false) }
    finally { await act(async () => root.unmount()); container.remove() }
  })
  it('displays native XLSX boolean, empty, null and missing cells without React hiding them', async () => {
    const preview = { ...source, format: 'xlsx', tables: [{ ...source.tables[0], columns: [0,1,2,3,4].map((columnIndex) => ({ columnIndex, header: `列${columnIndex + 1}`, headerDigest: digest })), rows: [{ sourceRowKey: 'row-4', cells: [{ columnIndex: 0, raw: true }, { columnIndex: 1, raw: false }, { columnIndex: 2, raw: '' }, { columnIndex: 3, raw: null }] }] }] }
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => String(input).endsWith('/authoring-context') ? baseline('/authoring-context', '1') : json({ workspace: workspace(), draft: draft('1'), sources: [preview] }) })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try { await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity }))); expect([...container.querySelectorAll('tbody td')].map((cell) => cell.textContent)).toEqual(['true','false','（原文为空字符串）','（原文为 null）','（缺少此格）']) }
    finally { await act(async () => root.unmount()); container.remove() }
  })
  it('a stopped upload retains human inputs and shows an unknown outcome without late success', async () => {
    let changes = 0
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: (input, init) => { if (init?.method === 'POST') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })); return Promise.resolve(baseline(new URL(String(input)).pathname, '1')) } })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity, onWorkspaceChanged: () => { changes++ } })))
      await chooseFile(container)
      const upload = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '上传并读取真实资料'); if (upload === undefined) throw new Error('Missing upload')
      await act(async () => { upload.click(); await Promise.resolve() })
      await button(container, '停止等待并保留当前输入')
      expect(changes).toBe(0); expect(container.textContent).toContain('上传写入结果待核对'); expect(container.querySelector<HTMLInputElement>('input[required]')?.value).toBe('原始台账.xlsx'); expect(container.textContent).not.toContain('原始字节已存储并解析')
    } finally { await act(async () => root.unmount()); container.remove() }
  })

  it('distinguishes a complete original parse from a bounded eight-row partial preview', async () => {
    const preview = { ...source, previewCoverage: 'partial', coverage: { ...source.coverage, totalUnits: 10, parsedUnits: 10 }, tables: [{ ...source.tables[0], rows: Array.from({ length: 8 }, (_, index) => ({ sourceRowKey: `row-${index + 4}`, cells: [{ columnIndex: 0, raw: String(index) }] })) }] }
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => String(input).endsWith('/authoring-context') ? baseline('/authoring-context', '1') : json({ workspace: workspace(), draft: draft('1'), sources: [preview] }) })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity })))
      expect(container.textContent).toContain('原始解析覆盖：10/10'); expect(container.textContent).toContain('原始解析完整。')
      expect(container.textContent).toContain('预览有限 · 解析完成')
      expect(container.textContent).toContain('当前预览有范围限制，不能当作全部原文。'); expect(container.textContent).not.toContain('当前预览完整。')
      expect(container.querySelectorAll('tbody tr')).toHaveLength(8)
    } finally { await act(async () => root.unmount()); container.remove() }
  })

  it('locks the exact submitted name/header/data-row/sheet until a delayed acknowledgement completes', async () => {
    let revision = '1', changes = 0
    let resolveUpload: (response: Response) => void = () => { throw new Error('upload resolver missing') }
    const delayed = new Promise<Response>((resolve) => { resolveUpload = resolve })
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: (input, init) => init?.method === 'POST' ? delayed : Promise.resolve(baseline(new URL(String(input)).pathname, revision)) })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    const inputFor = (label: string) => { const node = [...container.querySelectorAll('label')].find((value) => value.textContent === label); const input = node === undefined ? null : container.querySelector<HTMLInputElement>(`[id="${node.htmlFor}"]`); if (input === null) throw new Error(`Missing ${label}`); return input }
    try {
      await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity, onWorkspaceChanged: () => { changes++ } })))
      await chooseFile(container); await text(container, '资料名称', '本次已提交台账'); await text(container, '实际表头所在行', '3'); await text(container, '实际数据起始行', '4'); await text(container, '工作表名称（多表时填写）', '运营台账')
      await button(container, '上传并读取真实资料')
      for (const label of ['资料名称', '实际表头所在行', '实际数据起始行', '工作表名称（多表时填写）']) expect(inputFor(label).disabled).toBe(true)
      expect(inputFor('资料名称').value).toBe('本次已提交台账'); expect(inputFor('实际表头所在行').value).toBe('3'); expect(inputFor('实际数据起始行').value).toBe('4'); expect(inputFor('工作表名称（多表时填写）').value).toBe('运营台账')
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '停止等待并保留当前输入')?.disabled).toBe(false)
      revision = '2'; await act(async () => resolveUpload(json({ workspace: workspace('2'), draft: draft('2'), source })))
      expect(changes).toBe(1); expect(inputFor('资料名称').disabled).toBe(false)
      await text(container, '资料名称', '下一份资料的新名称')
      expect(inputFor('资料名称').value).toBe('下一份资料的新名称')
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
