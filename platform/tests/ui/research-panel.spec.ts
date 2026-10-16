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
const R2 = '22222222-2222-4222-8222-222222222223'
const J = '33333333-3333-4333-8333-333333333333'
const GEN = '44444444-4444-4444-8444-444444444444'
const digest = `sha256:${'a'.repeat(64)}`

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })
const errorResponse = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'private', retryable: false, reasons: [], missingCapabilities: [] } }), { status, headers: { 'content-type': 'application/json' } })
const ref = (id: string) => ({ id, version: '1.0.0', digest, kind: 'artifact' })

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

function effectiveSearch(state: 'available' | 'blocked' = 'available') {
  return {
    schemaVersion: 'effective-tool-selection@1',
    scope: { kind: 'industry_workspace', workspaceId: W },
    toolId: 'web_search',
    selection: { kind: 'connection', connectionId: GEN },
    resolvedFrom: 'space_default',
    state,
    ...(state === 'available' ? {
      connectionId: GEN,
      connectionSummary: {
        connectionId: GEN, name: '公共搜索', revision: '5', adapterType: 'native_tavily',
        capabilities: ['web_search'], enabled: true, credentialState: 'present', updatedAt: '2026-10-15T00:00:00Z',
      },
    } : { connectionId: GEN, blockedReason: 'TOOL_DISABLED' }),
    assignmentRevision: '1',
    resolvedAt: '2026-10-15T00:00:00Z',
  }
}

const coverage = (overrides: { archivedSnapshots?: number; skippedWithoutSnapshot?: number } = {}) => ({
  queriesPlanned: 2, searchCalls: 3, pagesDiscovered: 8,
  archivedSnapshots: overrides.archivedSnapshots ?? 5,
  skippedWithoutSnapshot: overrides.skippedWithoutSnapshot ?? 3,
  excludedCount: 0, failedCount: 1, truncated: false,
})

interface V2Overrides {
  readonly researchId?: string
  readonly status?: string
  readonly stage?: string
  readonly stopReason?: string
  readonly sourceCount?: number
  readonly candidateCount?: number
  readonly archivedSnapshots?: number
  readonly gapState?: string
  readonly includeGaps?: boolean
  readonly includeReceipts?: boolean
  readonly humanTodos?: boolean
}

function executionV2(overrides: V2Overrides = {}) {
  const status = overrides.status ?? 'running'
  return {
    schemaVersion: 'research-execution@2', researchId: overrides.researchId ?? R, workspaceId: W, runId: J,
    goal: { kind: 'industry_workspace_research', workspaceId: W, draftRevision: '1' },
    status, stage: overrides.stage ?? 'searching',
    briefRef: ref(J), policyRef: { id: 'policy', version: '1.0.0', digest }, budgetRef: { id: 'budget', version: '1.0.0', digest },
    budget: {
      maxTotalCalls: 40, maxSearchCalls: 20, maxModelTokens: 200_000, maxModelTurns: 30, maxSources: 20,
      maxCandidates: 25, maxDownloadBytes: 8_000_000, maxReadBytes: 4_000_000, maxConcurrency: 2, maxRepairAttempts: 3,
      deadline: '2026-10-15T00:30:00Z',
    },
    limits: { sourceLimit: 20, candidateLimit: 25, deadline: '2026-10-15T00:30:00Z' },
    coverage: coverage({ ...(overrides.archivedSnapshots === undefined ? {} : { archivedSnapshots: overrides.archivedSnapshots }) }),
    coverageGaps: overrides.includeGaps === false ? [] : [
      { kind: 'must_cover', name: '停机条件的适用版本', state: overrides.gapState ?? 'unresearched', evidenceCount: 0 },
      { kind: 'must_cover', name: '点检频次的正式依据', state: 'pending_confirmation', evidenceCount: 2 },
    ],
    humanTodos: overrides.humanTodos === true
      ? [{ todoId: J, kind: 'source_review', message: '请审核 AI 调研来源', createdAt: '2026-10-15T00:10:00Z' }]
      : [],
    evidence: [{ sourceRef: ref(GEN), locatorKind: 'web_page', digest, parserVersion: '1.2.0', archived: true }],
    candidateReceipts: overrides.includeReceipts === false ? [] : [
      { candidateId: J, kind: 'definition', state: 'pending_confirmation', pendingConfirmation: true, issueCodes: ['SOURCE_TRUST_BLOCKED'] },
    ],
    sourceCount: overrides.sourceCount ?? 5, candidateCount: overrides.candidateCount ?? 0,
    usage: {
      searchCalls: 3, archivedSnapshots: 5, modelTokens: 12000, modelTurns: 4, candidatesSubmitted: 1,
      bytesDownloaded: 900000, bytesRead: 300000, repairAttempts: 0, usageUnknown: false,
    },
    ...(overrides.stopReason === undefined ? {} : { stopReason: overrides.stopReason }),
    sources: [{ sourceId: GEN, url: 'https://example.com/a' }],
    recordedAt: '2026-10-15T00:10:00Z',
  }
}

function executionV1(overrides: { status?: string; stage?: string; stopReason?: string; sourceCount?: number; archivedSnapshots?: number } = {}) {
  return {
    schemaVersion: 'research-execution@1', researchId: R, workspaceId: W, jobId: J,
    status: overrides.status ?? 'running', stage: overrides.stage ?? 'searching',
    briefRef: ref(J), policyRef: { id: 'policy', version: '1.0.0', digest }, budgetRef: { id: 'budget', version: '1.0.0', digest },
    limits: { sourceLimit: 20, candidateLimit: 25, deadline: '2026-10-15T00:30:00Z' },
    coverage: coverage({ archivedSnapshots: overrides.archivedSnapshots ?? 5 }),
    sourceCount: overrides.sourceCount ?? 5, candidateCount: 0,
    ...(overrides.stopReason === undefined ? {} : { stopReason: overrides.stopReason }),
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

type Responder = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
function client(fetchImpl: Responder) {
  return new WorkbenchClient({ baseUrl: 'http://ui-unit.test', fetchImpl: fetchImpl as typeof fetch })
}
/** The default surface: the tool-connection route is not served yet, so the search service is named honestly. */
function withDefaults(responder: Responder): Responder {
  return async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/effective-tools')) return errorResponse(404, 'NOT_FOUND')
    return responder(input, init)
  }
}

describe('goal-first research entry and activity (R07)', () => {
  it('inherits the workspace goal once and shows a compact task confirmation without a long form', async () => {
    const clientImpl = client(withDefaults(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, {
      workspaceGoal: '整理设备维护规则及其依据',
      mustCover: [{ kind: 'workspace_goal_1', name: '停机条件的适用版本' }],
    })
    try {
      expect(container.querySelector('[data-testid="research-confirm"]')).not.toBeNull()
      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="research-goal"]')?.value).toBe('整理设备维护规则及其依据')
      expect(container.querySelector('[data-testid="research-must-cover-item"]')?.textContent).toContain('停机条件的适用版本')
      expect(container.querySelector('[data-testid="effective-model-name"]')?.textContent).toBe('空间研究模型')
      expect(container.querySelector('[data-testid="research-outbound"]')?.textContent).toContain('不随研究外发')
      expect(container.querySelector('[data-testid="research-search-service"]')?.getAttribute('data-state')).toBe('unavailable')
      expect(container.querySelector('[data-testid="research-search-service"]')?.textContent).toContain('未接入 AI 工具连接目录')
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
      await setText(container, '[data-testid="research-domains"]', 'example.com, standard.example.org')
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(false)
    } finally { await unmount() }
  })

  it('sends only the submitted public brief with the goal and must-cover, never a record or credential', async () => {
    let captured: { body: Record<string, unknown>; key: string | null } | undefined
    const clientImpl = client(withDefaults(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) {
        captured = { body: JSON.parse(String(init.body)) as Record<string, unknown>, key: new Headers(init.headers).get('idempotency-key') }
        return json({ research: executionV2({ status: 'running' }) }, 202)
      }
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, {
      workspaceGoal: '整理设备维护规则及其依据',
      mustCover: [{ kind: 'workspace_goal_1', name: '停机条件的适用版本' }],
    })
    try {
      await setText(container, '[data-testid="research-domains"]', 'example.com')
      await click(container, '[data-testid="research-start"]')
      expect(captured).toBeDefined()
      expect(captured?.body['goal']).toBe('整理设备维护规则及其依据')
      expect(captured?.body['allowedResearchDomains']).toEqual(['example.com'])
      expect(captured?.body['mustCover']).toEqual([{ kind: 'workspace_goal_1', name: '停机条件的适用版本' }])
      expect(captured?.key).not.toBeNull()
      expect(JSON.stringify(captured?.body)).not.toMatch(/project|record|apiKey|credential|history/iu)
    } finally { await unmount() }
  })

  it('shows an explicit unavailable reason when the orchestration surface is not wired', async () => {
    const clientImpl = client(withDefaults(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) return errorResponse(404, 'NOT_FOUND')
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, { workspaceGoal: '整理设备维护规则及其依据' })
    try {
      await setText(container, '[data-testid="research-domains"]', 'example.com')
      await click(container, '[data-testid="research-start"]')
      expect(container.querySelector('[data-testid="research-unavailable"]')?.getAttribute('data-unavailable')).toBe('true')
      expect(container.querySelector('[data-testid="research-unavailable"]')?.textContent).toContain('未接入受控的研究编排服务')
      expect(container.querySelector('[data-testid="research-progress"]')).toBeNull()
    } finally { await unmount() }
  })

  it('renders persisted activity, mustCover gaps, receipts and the three product groups without hidden reasoning', async () => {
    let status = 'running'
    const clientImpl = client(withDefaults(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) return json({ research: executionV2({ status: 'running' }) }, 202)
      if (path.includes('/research-runs/')) {
        return json({ research: status === 'running' ? executionV2({ status: 'running' }) : executionV2({ status: 'awaiting_confirmation', stage: 'awaiting_source_review', humanTodos: true }) })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, { workspaceGoal: '整理设备维护规则及其依据', onOpenGeneration: () => { generated = true } })
    let generated = false
    try {
      await setText(container, '[data-testid="research-domains"]', 'example.com')
      await click(container, '[data-testid="research-start"]')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-version')).toBe('research-execution@2')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe('active')
      expect(container.querySelector('[data-testid="research-activity"]')?.textContent).toContain('已完成检索 3 次')
      expect(container.querySelector('[data-testid="research-no-thinking"]')?.textContent).toContain('不展示模型的隐藏思维过程')
      const gaps = container.querySelectorAll('[data-testid="research-coverage-gap"]')
      expect(Array.from(gaps).map((node) => node.getAttribute('data-state'))).toEqual(['unresearched', 'pending_confirmation'])
      expect(container.querySelector('[data-testid="research-candidate-receipt"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="research-products"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="research-unresolved"]')?.textContent).toContain('停机条件的适用版本')
      expect(container.querySelector('[data-testid="research-evidence-item"]')?.textContent).toContain('已归档')
      expect(container.querySelector('[data-testid="research-usage"]')?.textContent).toContain('12000')
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-generate"]')).toBeNull()
      expect(container.querySelector('[data-testid="research-continue"]')).toBeNull()

      status = 'confirmed'
      await click(container, '[data-testid="research-refresh"]')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe('awaiting_confirmation')
      expect(container.querySelector('[data-testid="research-human-todo"]')?.getAttribute('data-kind')).toBe('source_review')
      const generate = container.querySelector<HTMLButtonElement>('[data-testid="research-generate"]')
      expect(generate?.disabled).toBe(false)
      await act(async () => { generate?.click() })
      expect(generated).toBe(true)
    } finally { await unmount() }
  })

  it('keeps a legacy @1 record readable and honest about the missing groups', async () => {
    const clientImpl = client(withDefaults(async () => json({ research: executionV1({ status: 'completed', stage: 'completed', stopReason: 'no_results', sourceCount: 0, archivedSnapshots: 0 }) })))
    const { container, unmount } = await render(clientImpl, { initialResearchId: R })
    try {
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-version')).toBe('research-execution@1')
      expect(container.querySelector('[data-testid="research-progress"]')?.getAttribute('data-outcome')).toBe('no_results')
      expect(container.querySelector('[data-testid="research-coverage-empty"]')?.textContent).toContain('旧版记录')
      expect(container.querySelector('[data-testid="research-evidence-legacy"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="research-assets-legacy"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="research-no-snapshot"]')?.textContent).toContain('没有任何已归档快照')
    } finally { await unmount() }
  })

  it('offers a grounded continuation only for a non-revivable ending, never for a live run', async () => {
    const posts: string[] = []
    const clientImpl = client(withDefaults(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (init?.method === 'POST' && path.endsWith('/research-runs')) return json({ research: executionV2({ status: 'running' }) }, 202)
      if (init?.method === 'POST' && path.endsWith('/continuations')) {
        posts.push(path)
        return json({ research: executionV2({ researchId: R2, status: 'running' }) }, 202)
      }
      if (path.includes('/research-runs/')) return json({ research: executionV2({ status: 'completed', stage: 'completed', stopReason: 'budget_exhausted', sourceCount: 4 }) })
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, { initialResearchId: R, workspaceGoal: '整理设备维护规则及其依据' })
    try {
      expect(container.querySelector('[data-testid="research-continue"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="research-continue-hint"]')?.textContent).toContain('额度已用尽')
      await click(container, '[data-testid="research-continue"]')
      expect(container.querySelector('[data-testid="research-confirm"]')?.getAttribute('data-mode')).toBe('continuation')
      expect(container.querySelector('[data-testid="research-continuation-of"]')?.textContent).toContain(R)
      await setText(container, '[data-testid="research-domains"]', 'example.com')
      await click(container, '[data-testid="research-start"]')
      expect(posts).toHaveLength(1)
      expect(posts[0]).toContain(`/research-runs/${R}/continuations`)
    } finally { await unmount() }
  })

  it('only shows the stop control while the run is active', async () => {
    const clientImpl = client(withDefaults(async () => json({ research: executionV2({ status: 'cancelled', stopReason: 'cancelled' }) })))
    const { container, unmount } = await render(clientImpl, { initialResearchId: R })
    try {
      expect(container.querySelector('[data-testid="research-cancel"]')).toBeNull()
      expect(container.querySelector('[data-testid="research-ending"]')?.textContent).toContain('已取消')
    } finally { await unmount() }
  })

  it('keeps the start disabled and names the reason when the research model or search service is blocked', async () => {
    const modelBlocked = client(withDefaults(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('blocked')])
      throw new Error(`unexpected ${path}`)
    }))
    const first = await render(modelBlocked)
    try {
      await setText(first.container, '[data-testid="research-domains"]', 'example.com')
      expect(first.container.querySelector('[data-testid="research-blockers"]')?.textContent).toContain('研究模型不可用')
      expect(first.container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
    } finally { await first.unmount() }

    const searchBlocked = client(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      if (path.endsWith('/effective-tools')) return json([effectiveSearch('blocked')])
      throw new Error(`unexpected ${path}`)
    })
    const second = await render(searchBlocked)
    try {
      await setText(second.container, '[data-testid="research-domains"]', 'example.com')
      expect(second.container.querySelector('[data-testid="research-search-service"]')?.getAttribute('data-state')).toBe('blocked')
      expect(second.container.querySelector('[data-testid="research-blockers"]')?.textContent).toContain('公共搜索服务不可用')
      expect(second.container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
    } finally { await second.unmount() }
  })

  it('disables starting for a read-only member', async () => {
    const clientImpl = client(withDefaults(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/effective-models')) return json([effectiveResearch('available')])
      throw new Error(`unexpected ${path}`)
    }))
    const { container, unmount } = await render(clientImpl, { readOnly: true })
    try {
      await setText(container, '[data-testid="research-domains"]', 'example.com')
      expect(container.querySelector('[data-testid="research-readonly"]')).not.toBeNull()
      expect(container.querySelector<HTMLButtonElement>('[data-testid="research-start"]')?.disabled).toBe(true)
    } finally { await unmount() }
  })
})
