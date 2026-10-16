// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { WorkspaceSourcesPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { IndustryWorkspace } from '@ontology/contracts'

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; env.IS_REACT_ACT_ENVIRONMENT = true
const W = '11111111-1111-4111-8111-111111111111'
const S = '22222222-2222-4222-8222-222222222222'
const T = '33333333-3333-4333-8333-333333333333'
const U = '55555555-5555-4555-8555-555555555555'
const P = '66666666-6666-4666-8666-666666666666'
const digest = `sha256:${'a'.repeat(64)}`
const workspace = (revision = '1'): IndustryWorkspace => ({ workspaceId: W, namespace: 'test', displayName: '资料工作区', boundary: { goals: ['资料验证'], included: [], excluded: [], applicability: {} }, state: 'draft', headRevision: revision })
const draft = (revision: string) => ({ workspaceId: W, revision, digest, documentSetRef: { id: P, version: '1.0.0', digest, kind: 'artifact' }, candidateRefs: [] })
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message, retryable: false, reasons: [] } }), { status, headers: { 'content-type': 'application/json' } })
const identity = { newId: () => W, sha256: () => Promise.resolve(digest) }

const corpusSource = (id: string, name: string, status = 'complete') => ({
  sourceRef: { id, version: '1.0.0', digest, kind: 'document' }, name, kind: 'document', parseId: P, parserVersion: '1.0.0',
  status, previewCoverage: status === 'complete' ? 'complete' : 'partial',
  coverage: { status: status === 'complete' ? 'complete' : 'partial', completeness: status === 'complete' ? 'complete' : 'partial', totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] },
})

interface CandidateOverrides { readonly contentRefId: string; readonly title: string; readonly trustTier: string; readonly reviewState: string; readonly kind: string; readonly revision?: string }
const candidateSource = (sourceId: string, overrides: CandidateOverrides) => ({
  schemaVersion: 'candidate-source@1', sourceId, workspaceId: W, kind: overrides.kind, trustTier: overrides.trustTier,
  origin: { url: `https://example.test/${sourceId}`, publisher: '示例发布方' },
  contentRef: { id: overrides.contentRefId, version: '1.0.0', digest, kind: 'document' }, contentDigest: digest,
  reviewState: overrides.reviewState, proposedBy: 'researcher', title: overrides.title,
  recordedAt: '2026-10-01T00:00:00Z', revision: overrides.revision ?? '1',
})

function authoring(revision: string) {
  return json({ scopeRef: { tenantId: W, spaceId: P }, workspace: workspace(revision), draft: draft(revision), generationPolicyRef: { id: 'policy', version: '1.0.0', digest }, models: { generationEnabled: true, decisionEnabled: false }, operations: [], generationLimits: { maxOutputTokens: 16384, maxCandidatesPerCall: 25, maxSources: 64, sourceContextBytes: 65536, sourceReadBytes: 33554432, sourceFragments: 32 } })
}

async function render(client: WorkbenchClient, props: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
  await act(async () => root.render(createElement(WorkspaceSourcesPanel, { client, workspace: workspace(), identity, ...props })))
  return { container, root, unmount: async () => { await act(async () => root.unmount()); container.remove() } }
}
async function click(container: HTMLElement, selector: string) {
  const node = container.querySelector<HTMLButtonElement>(selector); if (node === null) throw new Error(`Missing ${selector}`)
  await act(async () => { node.click() })
}
async function setSelect(container: HTMLElement, selector: string, value: string) {
  const node = container.querySelector<HTMLSelectElement>(selector); if (node === null) throw new Error(`Missing ${selector}`)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(node, value); node.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function clickRadio(container: HTMLElement, selector: string) {
  const node = container.querySelector<HTMLInputElement>(selector); if (node === null) throw new Error(`Missing ${selector}`)
  await act(async () => { node.click() })
}
function entry(container: HTMLElement, title: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('[data-testid="source-library-entry"]')].find((node) => node.querySelector('strong')?.textContent === title)
  if (card === undefined) throw new Error(`Missing library entry ${title}`)
  return card
}

describe('workspace source library and intake (N06)', () => {
  it('gathers the three intake entries, showing each real reason instead of a fake enabled control', async () => {
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [] })
    } })
    const { container, unmount } = await render(client)
    try {
      expect(container.querySelector('[data-testid="intake-ai_research"]')?.getAttribute('data-available')).toBe('false')
      expect(container.querySelector('[data-testid="intake-upload"]')?.getAttribute('data-available')).toBe('true')
      expect(container.querySelector('[data-testid="intake-structured_file"]')?.getAttribute('data-available')).toBe('false')
      expect(container.querySelector('[data-testid="intake-ai_research"]')?.textContent).toContain('未接入受控的公共搜索与归档服务')
      await click(container, '[data-testid="intake-ai_research-button"]')
      expect(container.querySelector('[data-testid="intake-guidance"]')?.textContent).toContain('恢复入口')
    } finally { await unmount() }
  })

  it('lists each source with the four separate axes and never collapses a reviewed source into an authority claim', async () => {
    const matched = candidateSource('44444444-4444-4444-8444-444444444444', { contentRefId: S, title: '设备维护标准（网页归档）', trustTier: 'agent_researched', reviewState: 'proposed', kind: 'web_fetch' })
    const unmatched = candidateSource('77777777-7777-4777-8777-777777777777', { contentRefId: T, title: '国家标准 GB/T 示例', trustTier: 'public_standard', reviewState: 'approved', kind: 'standard_ref' })
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [matched, unmatched] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [corpusSource(S, '原始台账'), corpusSource(U, '上传的旧资料')] })
    } })
    const { container, unmount } = await render(client)
    try {
      const matchedCard = entry(container, '设备维护标准（网页归档）')
      expect(matchedCard.querySelector('[data-testid="entry-trust"]')?.textContent).toBe('AI 调研，待确认')
      expect(matchedCard.querySelector('[data-testid="entry-review"]')?.textContent).toBe('待审核')
      expect(matchedCard.querySelector('[data-testid="entry-parse"]')?.textContent).toBe('解析完成')
      expect(matchedCard.querySelector('[data-testid="entry-admission"]')?.textContent).toBe('已纳入建模')

      const unmatchedCard = entry(container, '国家标准 GB/T 示例')
      expect(unmatchedCard.querySelector('[data-testid="entry-trust"]')?.textContent).toBe('已确认公共标准/规范')
      expect(unmatchedCard.querySelector('[data-testid="entry-parse"]')?.textContent).toBe('尚未归档可读原文')
      expect(unmatchedCard.querySelector('[data-testid="entry-admission"]')?.textContent).toBe('已审核，尚未纳入建模')

      const uploadCard = entry(container, '上传的旧资料')
      expect(uploadCard.querySelector('[data-testid="entry-trust"]')?.textContent).toBe('上传（未记录来源类别）')
      expect(uploadCard.querySelector('[data-testid="entry-admission"]')?.textContent).toBe('已纳入当前草稿语料')
    } finally { await unmount() }
  })

  it('keeps source review and tier promotion separate: review never carries a tier, promotion is its own control', async () => {
    let revision = '1'
    const reviewCaptured: { body: unknown; ifMatch: string | null }[] = []
    const promotionCaptured: { body: unknown; ifMatch: string | null }[] = []
    const base = candidateSource('44444444-4444-4444-8444-444444444444', { contentRefId: S, title: '设备维护标准（网页归档）', trustTier: 'agent_researched', reviewState: 'proposed', kind: 'web_fetch' })
    const approved = { ...base, revision: '2', reviewState: 'approved' }
    const promoted = { ...base, revision: '3', reviewState: 'approved', trustTier: 'public_standard' }
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method === 'POST' && path.endsWith('/tier-promotions')) {
        promotionCaptured.push({ body: JSON.parse(String(init.body)), ifMatch: new Headers(init.headers).get('if-match') })
        revision = '3'
        return json({ promotion: { sourceId: base.sourceId, revision, reviewState: 'approved', trustTier: 'public_standard', replayed: false } }, 201)
      }
      if (init?.method === 'POST' && path.endsWith('/reviews')) {
        reviewCaptured.push({ body: JSON.parse(String(init.body)), ifMatch: new Headers(init.headers).get('if-match') })
        revision = '2'
        return json({ source: approved, receipt: { replayed: false } }, 201)
      }
      if (path.endsWith('/review-handoff')) return json({ schemaVersion: 'review-handoff@1', workspaceId: W, candidates: [], asOf: '2026-10-01T00:00:00Z' })
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [revision === '3' ? promoted : revision === '2' ? approved : base] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [corpusSource(S, '原始台账')] })
    } })
    const { container, unmount } = await render(client)
    try {
      const sid = '44444444-4444-4444-8444-444444444444'
      await clickRadio(container, `input[name="review-state-${sid}"][value="approved"]`)
      const reason = container.querySelector<HTMLInputElement>(`[data-testid="source-review-${sid}"] input:not([type="radio"]):not([type="checkbox"])`)
      if (reason === null) throw new Error('Missing review reason input')
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(reason, '已对照原文确认'); reason.dispatchEvent(new Event('input', { bubbles: true })) })
      await click(container, `[data-testid="source-review-submit-${sid}"]`)
      expect(reviewCaptured[0]?.ifMatch).toBe('1')
      expect(reviewCaptured[0]?.body).toEqual({ reviewState: 'approved', reason: '已对照原文确认', basisRefs: [] })
      expect(container.querySelector('[data-testid="source-review-notice"]')?.textContent).toContain('来源审核已记录')
      // Let the refresh after the review settle so the promotion control is enabled again.
      for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

      // The promotion is a distinct control, and its request names the new tier explicitly.
      await setSelect(container, `[data-testid="source-promotion-${sid}"] select`, 'public_standard')
      const promotionReason = container.querySelector<HTMLInputElement>(`[data-testid="source-promotion-${sid}"] input:not([type])`)
      if (promotionReason === null) throw new Error('Missing promotion reason input')
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(promotionReason, '原文为公开规范'); promotionReason.dispatchEvent(new Event('input', { bubbles: true })) })
      await click(container, `[data-testid="source-promotion-submit-${sid}"]`)
      expect(promotionCaptured[0]?.body).toEqual({ nextTrustTier: 'public_standard', reason: '原文为公开规范', basisRefs: [] })
      expect(container.querySelector('[data-testid="source-promotion-notice"]')?.textContent).toContain('来源类别已提升')
    } finally { await unmount() }
  })

  it('shows each pending product with each cited source kept separate and the blocking reason explicit', async () => {
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/review-handoff')) return json({
        schemaVersion: 'review-handoff@1', workspaceId: W, asOf: '2026-10-01T00:00:00Z',
        candidates: [{ candidateId: U, candidateKind: 'definition', state: 'pending_confirmation', blocked: true, blockCodes: ['SOURCE_TRUST_BLOCKED'],
          pendingConfirmation: true, readiness: 'pending_sources', allSourcesConfirmed: false,
          links: [
            { index: 0, sourceRef: { id: S, version: '1.0.0', digest, kind: 'document' }, reviewState: 'approved', trustTier: 'public_standard', admitted: true, groundsPublication: true, pendingConfirmation: false },
            { index: 1, sourceRef: { id: T, version: '1.0.0', digest, kind: 'document' }, reviewState: 'proposed', trustTier: 'agent_researched', admitted: false, groundsPublication: false, pendingConfirmation: true, blockReason: 'SOURCE_TRUST_BLOCKED' },
          ] }],
      })
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [] })
    } })
    const { container, unmount } = await render(client)
    try {
      const section = container.querySelector('[data-testid="review-handoff"]')
      expect(section?.getAttribute('data-availability')).toBe('ready')
      const card = container.querySelector('[data-testid="review-handoff-candidate"]')
      expect(card?.getAttribute('data-blocked')).toBe('true')
      expect(card?.getAttribute('data-readiness')).toBe('pending_sources')
      const links = container.querySelectorAll('[data-testid="review-handoff-link"]')
      expect(links).toHaveLength(2)
      expect(container.querySelector('[data-testid="review-handoff-readiness"]')?.textContent).toContain('仍有来源未确认')
      expect(section?.textContent).toContain('AI 调研，待确认')
      expect(section?.textContent).toContain('已接受')
    } finally { await unmount() }
  })

  it('keeps the reviewer input on a version conflict instead of overwriting it', async () => {
    const base = candidateSource('44444444-4444-4444-8444-444444444444', { contentRefId: S, title: '设备维护标准（网页归档）', trustTier: 'agent_researched', reviewState: 'proposed', kind: 'web_fetch' })
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method === 'POST' && path.endsWith('/reviews')) return failure(409, 'VERSION_CONFLICT', 'stale')
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [base] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [corpusSource(S, '原始台账')] })
    } })
    const { container, unmount } = await render(client)
    try {
      const sid = '44444444-4444-4444-8444-444444444444'
      const reason = container.querySelector<HTMLInputElement>(`[data-testid="source-review-${sid}"] input:not([type="radio"]):not([type="checkbox"])`)
      if (reason === null) throw new Error('Missing reason input')
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(reason, '待保留的审核理由'); reason.dispatchEvent(new Event('input', { bubbles: true })) })
      await click(container, `[data-testid="source-review-submit-${sid}"]`)
      expect(container.querySelector('[data-testid="source-review-failure"]')?.getAttribute('data-family')).toBe('conflict')
      expect(container.querySelector<HTMLInputElement>(`[data-testid="source-review-${sid}"] input:not([type="radio"]):not([type="checkbox"])`)?.value).toBe('待保留的审核理由')
    } finally { await unmount() }
  })

  it('routes upload by purpose and states that upload never grants an authority tier', async () => {
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [] })
    } })
    const { container, unmount } = await render(client)
    try {
      const upload = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '上传并读取真实资料')
      expect(upload()?.disabled).toBe(true)
      await clickRadio(container, 'input[name="source-purpose"][value="project_record"]')
      expect(container.querySelector('[data-testid="source-purpose-project"]')?.textContent).toContain('项目记录在项目工作台的数据与资料页接入')
      await clickRadio(container, 'input[name="source-purpose"][value="industry_basis"]')
      expect(container.textContent).toContain('上传只登记原料，不会自动获得权威来源类别')
    } finally { await unmount() }
  })

  it('shows an empty state with reason and next step when the workspace has no source yet', async () => {
    const client = new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/authoring-context')) return authoring('1')
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path.includes('/industry-workspaces/')) return json({ sources: [] })
      return json({ workspace: workspace(), draft: draft('1'), sources: [] })
    } })
    const { container, unmount } = await render(client)
    try {
      expect(container.querySelector('[data-testid="source-library-empty"]')?.textContent).toContain('还没有来源记录')
    } finally { await unmount() }
  })
})
