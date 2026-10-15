// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { WorkbenchClient } from '../../apps/web/src/api/client'
import { ResearchPanel } from '../../apps/web/src/components/ResearchPanel'

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
env.IS_REACT_ACT_ENVIRONMENT = true

const W = '11111111-1111-4111-8111-111111111111'
const R = '22222222-2222-4222-8222-222222222222'
const J = '33333333-3333-4333-8333-333333333333'
const GEN = '44444444-4444-4444-8444-444444444444'
const digest = `sha256:${'a'.repeat(64)}`

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })
const errorResponse = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'private', retryable: false, reasons: [], missingCapabilities: [] } }), { status, headers: { 'content-type': 'application/json' } })

function effectiveResearch(state: 'available' | 'blocked' | 'unconfigured' = 'available') {
  return {
    schemaVersion: 'effective-model-selection@1',
    scope: { kind: 'industry_workspace', workspaceId: W },
    capability: 'research',
    selection: { kind: 'connection', connectionId: GEN },
    resolvedFrom: 'space_default',
    state,
    ...(state === 'available' ? {
      connectionId: GEN,
      connectionSummary: {
        connectionId: GEN, name: '空间研究模型', revision: '3', adapterType: 'company_generation',
        protocol: 'openai_compatible', capabilities: ['generation', 'research'], enabled: true,
        credentialState: 'present', updatedAt: '2026-10-15T00:00:00Z',
      },
    } : {}),
    ...(state === 'blocked' ? { connectionId: GEN, blockedReason: 'CREDENTIAL_MISSING' } : {}),
    assignmentRevision: '2',
    resolvedAt: '2026-10-15T00:00:00Z',
  }
}

interface ExecutionOverrides {
  readonly status?: string
  readonly stage?: string
  readonly stopReason?: string
  readonly sourceCount?: number
  readonly candidateCount?: number
  readonly archivedSnapshots?: number
  readonly skippedWithoutSnapshot?: number
  readonly noResults?: boolean
}

function execution(overrides: ExecutionOverrides = {}) {
  const stopReason = overrides.stopReason ?? (overrides.noResults === true ? 'no_results' : undefined)
  return {
    schemaVersion: 'research-execution@1', researchId: R, workspaceId: W, jobId: J,
    status: overrides.status ?? 'running', stage: overrides.stage ?? 'searching',
    briefRef: { id: J, version: '1.0.0', digest, kind: 'artifact' },
    policyRef: { id: 'policy', version: '1.0.0', digest },
    budgetRef: { id: 'budget', version: '1.0.0', digest },
    limits: { sourceLimit: 20, candidateLimit: 25, deadline: '2026-10-15T00:30:00Z' },
    coverage: {
      queriesPlanned: 2, searchCalls: 3, pagesDiscovered: 8,
      archivedSnapshots: overrides.archivedSnapshots ?? 5,
      skippedWithoutSnapshot: overrides.skippedWithoutSnapshot ?? 3,
      excludedCount: 0, failedCount: 1, truncated: false,
    },
    sourceCount: overrides.sourceCount ?? 5, candidateCount: overrides.candidateCount ?? 0,
    ...(stopReason === undefined ? {} : { stopReason }),
    recordedAt: '2026-10-15T00:10:00Z',
  }
}

async function render(client: WorkbenchClient, props: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(ResearchPanel, { client, workspaceId: W, ...props })))
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove() } }
}
async function click(container: HTMLElement, selector: string) {
  const node = container.querySelector<HTMLElement>(selector); if (node === null) throw new Error(`Missing ${selector}`)
  await act(async () => { node.click() })
}
async function setText(container: HTMLElement, selector: string, value: string) {
  const node = container.querySelector<HTMLElement>(selector); if (node === null) throw new Error(`Missing ${selector}`)
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function fillValid(container: HTMLElement) {
  await setText(container, '[data-testid="research-goal"]', '整理设备维护规则及其依据')
  await setText(container, '[data-testid="research-domains"]', 'example.com, standard.example.org')
}

function client(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: fetchImpl as typeof fetch })
}

describe('research authorization and progress (N11)', () => {
  it('states the outbound scope, caps and the actual model receiver before starting', async () => {
    const clientImpl = client(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl)
    try {
      expect(container.querySelector('[data-testid="research-scope-notice"]')?.textContent).toContain('不会随研究一并外发')
      expect(container.querySelector('[data-testid="research-domain-notice"]')?.textContent).toContain('不构成授权')
      expect(container.querySelector('[data-testid="research-candidate-notice"]')?.textContent).toContain('需人工确认')
      expect(container.querySelector('[data-testid="effective-model-name"]')?.textContent).toBe('空间研究模型')
      expect(container.querySelector('[data-testid="research-cap-receiver"]')?.textContent).toContain('空间研究模型')
      expect(container.querySelector('[data-testid="research-cost"]')?.textContent).toContain('当前无法估算')
      expect(container.querySelector('[data-testid="research-progress"]')).toBeNull()
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
      await fillValid(container)
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(false)
    } finally { await unmount() }
  })

  it('sends only the submitted public brief, never a project record or credential', async () => {
    let captured: { body: Record<string, unknown>; key: string | null } | undefined
    const clientImpl = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) {
        captured = { body: JSON.parse(String(init.body)) as Record<string, unknown>, key: new Headers(init.headers).get('idempotency-key') }
        return json({ research: execution({ status: 'running' }) }, 202)
      }
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl)
    try {
      await fillValid(container)
      await click(container, '[data-testid="research-start"]')
      expect(captured).toBeDefined()
      expect(Object.keys(captured?.body ?? {}).sort()).toEqual(['allowedDomains', 'brief', 'limits'])
      expect(captured?.key).not.toBeNull()
      const brief = (captured?.body ?? {})['brief'] as Record<string, unknown>
      expect(brief['schemaVersion']).toBe('modeling-brief@1')
      expect(brief['workspaceId']).toBe(W)
      expect(brief['goal']).toBe('整理设备维护规则及其依据')
      expect(brief['allowedResearchDomains']).toEqual(['example.com', 'standard.example.org'])
      expect(brief['targetKinds']).toEqual(['object'])
      const limits = (captured?.body ?? {})['limits'] as Record<string, unknown>
      expect(limits['sourceLimit']).toBe(20)
      expect(limits['candidateLimit']).toBe(25)
      expect(typeof limits['deadline']).toBe('string')
      expect(JSON.stringify(captured?.body)).not.toMatch(/project|record|apiKey|credential|history/iu)
    } finally { await unmount() }
  })

  it('shows an explicit unavailable reason when the orchestration surface is not wired', async () => {
    const clientImpl = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) return errorResponse(404, 'NOT_FOUND')
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl)
    try {
      await fillValid(container)
      await click(container, '[data-testid="research-start"]')
      expect(container.querySelector('[data-testid="research-unavailable"]')?.getAttribute('data-unavailable')).toBe('true')
      expect(container.querySelector('[data-testid="research-unavailable"]')?.textContent).toContain('未接入受控的研究编排服务')
      expect(container.querySelector('[data-testid="research-progress"]')).toBeNull()
    } finally { await unmount() }
  })

  it('renders real progress, refreshes by re-reading, and guides to generation after confirmation', async () => {
    let status = 'running'
    const clientImpl = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) return json({ research: execution({ status: 'running' }) }, 202)
      if (path.includes('/research-runs/')) {
        return json({ research: status === 'running' ? execution({ status: 'running' }) : execution({ status: 'awaiting_confirmation', stage: 'awaiting_source_review', sourceCount: 5 }) })
      }
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl, { onOpenGeneration: () => { generated = true } })
    let generated = false
    try {
      await fillValid(container)
      await click(container, '[data-testid="research-start"]')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe('active')
      expect(container.querySelector('[data-testid="research-source-count"]')?.textContent).toBe('5')
      expect(container.querySelector('[data-testid="research-candidate-count"]')?.textContent).toBe('0')
      expect(container.querySelector('[data-testid="research-skipped-without-snapshot"]')?.textContent).toBe('3')
      expect(container.querySelector('[data-testid="research-links-only"]')?.textContent).toContain('仅发现链接')
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-generate"]')).toBeNull()

      status = 'confirmed'
      await click(container, '[data-testid="research-refresh"]')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe('awaiting_confirmation')
      expect(container.querySelector('[data-testid="research-ending"]')?.textContent).toContain('等待人工确认来源')
      const generate = container.querySelector<HTMLButtonElement>('[data-testid="research-generate"]')
      expect(generate?.disabled).toBe(false)
      await act(async () => { generate?.click() })
      expect(generated).toBe(true)
    } finally { await unmount() }
  })

  it('distinguishes cancelled, no-results, partial and failed endings, and flags no archived snapshot', async () => {
    const cases: readonly { readonly overrides: ExecutionOverrides; readonly outcome: string; readonly text: string }[] = [
      { overrides: { status: 'cancelled', stopReason: 'cancelled' }, outcome: 'cancelled', text: '已取消' },
      { overrides: { status: 'completed', stage: 'completed', stopReason: 'no_results', sourceCount: 0, archivedSnapshots: 0, skippedWithoutSnapshot: 4 }, outcome: 'no_results', text: '无结果' },
      { overrides: { status: 'completed', stage: 'completed', stopReason: 'partial_results', sourceCount: 3 }, outcome: 'partial', text: '部分结果' },
      { overrides: { status: 'failed', stopReason: 'provider_failed' }, outcome: 'failed', text: '失败' },
    ]
    for (const testCase of cases) {
      const clientImpl = client(async (input) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
        return json({ research: execution(testCase.overrides) })
      })
      const { container, unmount } = await render(clientImpl, { initialResearchId: R })
      try {
        expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe(testCase.outcome)
        expect(container.querySelector('[data-testid="research-ending"]')?.textContent).toContain(testCase.text)
        if (testCase.outcome === 'no_results') {
          expect(container.querySelector('[data-testid="research-no-snapshot"]')?.textContent).toContain('没有任何已归档快照')
        }
      } finally { await unmount() }
    }
  })

  it('keeps the start disabled and names the reason when the research model is blocked', async () => {
    const clientImpl = client(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('blocked')])
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl)
    try {
      await fillValid(container)
      expect(container.querySelector('[data-testid="effective-model"]')?.getAttribute('data-state')).toBe('blocked')
      expect(container.querySelector('[data-testid="research-model-blocked"]')?.textContent).toContain('研究模型不可用')
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
    } finally { await unmount() }
  })

  it('disables starting for a read-only member', async () => {
    const clientImpl = client(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      throw new Error(`unexpected ${path}`)
    })
    const { container, unmount } = await render(clientImpl, { readOnly: true })
    try {
      await fillValid(container)
      expect(container.querySelector('[data-testid="research-readonly"]')).not.toBeNull()
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
    } finally { await unmount() }
  })
})
