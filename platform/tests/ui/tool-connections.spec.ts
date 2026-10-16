// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchClient } from '../../apps/web/src/api/client'
import {
  deleteToolConnection,
  readToolConnections,
  testStoredToolConnection,
} from '../../apps/web/src/api/tool-connections'
import type { ToolConnectionAdminView, ToolConnectionProbeResult } from '../../apps/web/src/api/tool-connections'
import { AiSettingsPanel } from '../../apps/web/src/components/AiSettingsPanel'
import { EffectiveToolsPanel } from '../../apps/web/src/components/EffectiveToolsPanel'
import { ToolAssignmentsPanel } from '../../apps/web/src/components/ToolAssignmentsPanel'
import { ToolConnectionEditor } from '../../apps/web/src/components/ToolConnectionEditor'
import { ToolConnectionsPanel } from '../../apps/web/src/components/ToolConnectionsPanel'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true

const SEARCH_ID = '33333333-3333-4333-8333-333333333333'

const PROBE: ToolConnectionProbeResult = {
  schemaVersion: 'tool-connection-test-result@1',
  connectionId: SEARCH_ID,
  connectionRevision: '3',
  testedAt: '2026-01-02T00:00:00.000Z',
  draft: false,
  credentialConfigured: true,
  search: { status: 'passed', latencyMs: 120 },
  archive: { status: 'failed', reason: 'page_not_readable' },
}

const SEARCH: ToolConnectionAdminView = {
  connectionId: SEARCH_ID,
  name: '公共搜索 Tavily',
  revision: '3',
  adapterType: 'native_tavily',
  capabilities: ['web_search'],
  enabled: true,
  credentialState: 'present',
  probeSummary: PROBE,
  updatedAt: '2026-01-02T00:00:00.000Z',
  endpoint: 'https://api.tavily.com/search',
}

const SPACE_SET = {
  schemaVersion: 'tool-assignment-set@1',
  scope: { kind: 'space' },
  defaultSelection: { kind: 'connection', connectionId: SEARCH_ID },
  toolSelections: [],
  revision: '2',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const EFFECTIVE_AVAILABLE = {
  schemaVersion: 'effective-tool-selection@1',
  scope: { kind: 'space' },
  toolId: 'web_search',
  selection: { kind: 'connection', connectionId: SEARCH_ID },
  resolvedFrom: 'space_default',
  state: 'available',
  connectionId: SEARCH_ID,
  connectionSummary: {
    connectionId: SEARCH_ID, name: '公共搜索 Tavily', revision: '3', adapterType: 'native_tavily',
    capabilities: ['web_search'], enabled: true, credentialState: 'present',
    probeSummary: PROBE, updatedAt: '2026-01-02T00:00:00.000Z',
  },
  assignmentRevision: '2',
  resolvedAt: '2026-01-02T00:00:00.000Z',
}

const EFFECTIVE_BLOCKED = {
  schemaVersion: 'effective-tool-selection@1',
  scope: { kind: 'space' },
  toolId: 'web_search',
  selection: { kind: 'disabled' },
  resolvedFrom: 'space_tool',
  state: 'blocked',
  blockedReason: 'TOOL_DISABLED',
  resolvedAt: '2026-01-02T00:00:00.000Z',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function envelope(data: unknown): Response { return json({ data }) }
function errorResponse(status: number, code: string): Response {
  return json({ error: { code, message: 'provider-private-body-should-not-render', retryable: false, reasons: [], missingCapabilities: [] } }, status)
}

type Call = { readonly method: string; readonly path: string; readonly search: string; readonly body?: unknown }
function client(handler: (call: Call) => Response | Promise<Response>): WorkbenchClient {
  return new WorkbenchClient({
    baseUrl: 'http://tool-settings.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
      return handler({ method, path: url.pathname, search: url.search, ...(body === undefined ? {} : { body }) })
    },
  })
}

async function render(node: ReturnType<typeof createElement>): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { container, root }
}
async function settle(): Promise<void> { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

function field(container: HTMLElement, labelText: string): HTMLInputElement | HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find((entry) => entry.textContent?.trim() === labelText)
  const control = label === undefined ? undefined : container.ownerDocument.getElementById(label.htmlFor)
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
    throw new Error(`field ${labelText} is not rendered`)
  }
  return control
}
function textValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
function selectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

afterEach(() => { document.body.innerHTML = '' })

describe('AI tool-connections client contract', () => {
  it('reads the catalogue over /api/v1/core/ai and rejects any secret-bearing response', async () => {
    const calls: Call[] = []
    const http = client((call) => {
      calls.push(call)
      return envelope([SEARCH])
    })
    const list = await readToolConnections(http)
    expect(list.map((entry) => entry.name)).toEqual(['公共搜索 Tavily'])
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/core/ai/tool-connections', search: '' }])

    const secret = client(() => envelope([{ ...SEARCH, apiKey: 'leaked-secret' }]))
    await expect(readToolConnections(secret)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('reads a probe with the search and archive items kept separate, and deletes body-less', async () => {
    const deletes: Call[] = []
    const http = client((call) => {
      if (call.method === 'DELETE') { deletes.push(call); return new Response(null, { status: 204 }) }
      return envelope(PROBE)
    })
    const result = await testStoredToolConnection(http, SEARCH_ID)
    expect(result.search).toMatchObject({ status: 'passed', latencyMs: 120 })
    expect(result.archive).toMatchObject({ status: 'failed', reason: 'page_not_readable' })

    await deleteToolConnection(http, SEARCH_ID)
    expect(deletes).toEqual([{ method: 'DELETE', path: `/api/v1/core/ai/tool-connections/${SEARCH_ID}`, search: '' }])

    const secret = client(() => envelope({ ...PROBE, secret: 'leaked-secret' }))
    await expect(testStoredToolConnection(secret, SEARCH_ID)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('ToolConnectionsPanel', () => {
  it('lists connections with adapter, credential, reference and separate search/archive probes', async () => {
    const http = client((call) => {
      if (call.path.endsWith('/tool-connections')) return envelope([SEARCH])
      if (call.path.endsWith('/tool-assignments')) return envelope(SPACE_SET)
      return envelope({})
    })
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      const rows = container.querySelectorAll('[data-testid="tool-connection-row"]')
      expect(rows).toHaveLength(1)
      expect(container.textContent).toContain('公共搜索 Tavily')
      expect(container.textContent).toContain('原生 Tavily 搜索')
      expect(container.textContent).toContain('公共网页搜索')
      expect(container.textContent).toContain('凭据已配置')
      expect(container.textContent).toContain('空间默认')
      expect(container.querySelector('[data-testid="tool-probe-search-' + SEARCH_ID + '"]')?.getAttribute('data-status')).toBe('passed')
      expect(container.querySelector('[data-testid="tool-probe-archive-' + SEARCH_ID + '"]')?.getAttribute('data-status')).toBe('failed')
      expect(container.textContent).not.toContain('leaked-secret')
    } finally { await act(async () => root.unmount()) }
  })

  it('shows a permission notice without names when the catalogue is forbidden', async () => {
    const http = client(() => errorResponse(403, 'SCOPE_MISMATCH'))
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      expect(container.textContent).toContain('管理工具连接需要本机平台管理员权限')
      expect(container.textContent).not.toContain('公共搜索 Tavily')
      expect(container.querySelector('[data-testid="tool-connection-row"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps the connection and explains how to unbind when a delete is rejected as in-use', async () => {
    const http = client((call) => {
      if (call.method === 'DELETE') return errorResponse(409, 'TOOL_IN_USE')
      if (call.path.endsWith('/tool-connections')) return envelope([SEARCH])
      return envelope(SPACE_SET)
    })
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-connection-delete"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.textContent).toContain('请先在“默认与分配”中解绑')
      expect(container.querySelectorAll('[data-testid="tool-connection-row"]')).toHaveLength(1)
    } finally { await act(async () => root.unmount()) }
  })

  it('saves a disabled connection without a key and clears the key input', async () => {
    const posts: Call[] = []
    let list: readonly ToolConnectionAdminView[] = []
    const http = client((call) => {
      if (call.method === 'POST' && call.path.endsWith('/tool-connections')) {
        posts.push(call)
        list = [{ connectionId: SEARCH_ID, name: '新搜索连接', revision: '1', adapterType: 'native_tavily', capabilities: ['web_search'], enabled: false, credentialState: 'missing', updatedAt: '2026-01-02T00:00:00.000Z' }]
        return json({ data: list[0] }, 201)
      }
      return envelope(list)
    })
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      await act(async () => { (container.querySelector('[data-testid="tool-connection-create"]') as HTMLButtonElement).click() })
      await act(async () => { textValue(field(container, '连接名称 *') as HTMLInputElement, '新搜索连接') })
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-connection-editor-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(posts).toHaveLength(1)
      const body = posts[0]?.body as { descriptor: Record<string, unknown>; idempotencyKey: string }
      expect(body.descriptor).toMatchObject({ name: '新搜索连接', adapterType: 'native_tavily', capabilities: ['web_search'], enabled: false })
      expect('apiKey' in body).toBe(false)
      expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8)
      await settle()
      expect(container.textContent).toContain('新搜索连接')
      expect(container.querySelector('[data-testid="tool-connection-editor-form"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('refuses to enable a native Tavily connection without a key', async () => {
    const posts: Call[] = []
    const http = client((call) => {
      if (call.method === 'POST') posts.push(call)
      return envelope([])
    })
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      await act(async () => { (container.querySelector('[data-testid="tool-connection-create"]') as HTMLButtonElement).click() })
      await act(async () => {
        textValue(field(container, '连接名称 *') as HTMLInputElement, '缺少密钥')
        ;(field(container, '启用') as HTMLInputElement).click()
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-connection-editor-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(posts).toHaveLength(0)
      expect(container.textContent).toContain('原生 Tavily 服务需要 API Key')
    } finally { await act(async () => root.unmount()) }
  })

  it('copies a connection with a name only, never a key', async () => {
    const posts: Call[] = []
    const http = client((call) => {
      if (call.method === 'POST' && call.path.endsWith('/copy')) {
        posts.push(call)
        return json({ data: { ...SEARCH, name: '公共搜索 Tavily 副本', enabled: false } }, 201)
      }
      if (call.path.endsWith('/tool-connections')) return envelope([SEARCH])
      return envelope(SPACE_SET)
    })
    const { container, root } = await render(createElement(ToolConnectionsPanel, { client: http }))
    try {
      await act(async () => { (container.querySelector('[data-testid="tool-connection-copy"]') as HTMLButtonElement).click() })
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-connection-copy-submit"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(posts).toHaveLength(1)
      const body = posts[0]?.body as Record<string, unknown>
      expect(body['name']).toBe('公共搜索 Tavily 副本')
      expect('apiKey' in body).toBe(false)
      expect(posts[0]?.path).toBe(`/api/v1/core/ai/tool-connections/${SEARCH_ID}/copy`)
    } finally { await act(async () => root.unmount()) }
  })
})

describe('ToolConnectionEditor', () => {
  it('shows the stored search and archive outcomes separately', async () => {
    const http = client((call) => {
      if (call.path.endsWith('/test')) return envelope(PROBE)
      return envelope(SEARCH)
    })
    const { container, root } = await render(createElement(ToolConnectionEditor, {
      client: http, mode: 'edit', connection: SEARCH, onSaved: () => undefined, onCancel: () => undefined,
    }))
    try {
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-connection-editor-test"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const result = container.querySelector('[data-testid="tool-connection-editor-test-result"]')
      expect(result).not.toBeNull()
      expect(result?.getAttribute('data-draft')).toBe('false')
      expect(container.querySelector('[data-testid="tool-connection-editor-test-result-search"]')?.getAttribute('data-status')).toBe('passed')
      expect(container.querySelector('[data-testid="tool-connection-editor-test-result-archive"]')?.getAttribute('data-status')).toBe('failed')
      expect(container.textContent).toContain('页面不可读')

      // Changing the credential invalidates the previous probe result (design §9).
      await act(async () => { textValue(field(container, 'API Key') as HTMLInputElement, 'new-key') })
      expect(container.querySelector('[data-testid="tool-connection-editor-test-result"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})

describe('ToolAssignmentsPanel', () => {
  it('offers only web-search connections and saves with CAS expected revision', async () => {
    const puts: Call[] = []
    const http = client((call) => {
      if (call.method === 'PUT') { puts.push(call); return envelope({ ...SPACE_SET, revision: '3' }) }
      if (call.path.endsWith('/tool-connections')) return envelope([SEARCH])
      if (call.path.endsWith('/tool-assignments')) return envelope(SPACE_SET)
      return envelope([])
    })
    const { container, root } = await render(createElement(ToolAssignmentsPanel, { client: http }))
    try {
      const defaultSelect = field(container, '默认连接') as HTMLSelectElement
      const options = [...defaultSelect.options].map((option) => option.textContent)
      expect(options).toContain('公共搜索 Tavily')
      await act(async () => { selectValue(defaultSelect, 'disabled') })
      await act(async () => {
        ;(container.querySelector('[data-testid="tool-assignments-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(puts).toHaveLength(1)
      const body = puts[0]?.body as { scope: unknown; defaultSelection: unknown; toolSelections: readonly unknown[]; expectedRevision: string }
      expect(body.scope).toEqual({ kind: 'space' })
      expect(body.defaultSelection).toEqual({ kind: 'disabled' })
      expect(body.toolSelections).toEqual([])
      expect(body.expectedRevision).toBe('2')
    } finally { await act(async () => root.unmount()) }
  })

  it('shows a permission notice without names when assignments are forbidden', async () => {
    const http = client(() => errorResponse(403, 'SCOPE_MISMATCH'))
    const { container, root } = await render(createElement(ToolAssignmentsPanel, { client: http }))
    try {
      expect(container.textContent).toContain('查看与修改分配需要平台管理员或目标对象的 profile-editor 权限')
      expect(container.textContent).not.toContain('公共搜索 Tavily')
    } finally { await act(async () => root.unmount()) }
  })
})

describe('EffectiveToolsPanel and AiSettingsPanel', () => {
  it('renders the effective connection, source, state, blocked reason and split probes', async () => {
    const http = client(() => envelope([EFFECTIVE_AVAILABLE, EFFECTIVE_BLOCKED]))
    const { container, root } = await render(createElement(EffectiveToolsPanel, { client: http }))
    try {
      const cards = container.querySelectorAll('[data-testid="effective-tool"]')
      expect(cards).toHaveLength(2)
      expect(container.textContent).toContain('公共搜索 Tavily')
      expect(container.textContent).toContain('空间默认')
      expect(container.textContent).toContain('可用')
      expect(container.textContent).toContain('所选搜索连接已被停用')
      expect(container.querySelector('[data-testid="effective-tool-probe-search"]')?.getAttribute('data-status')).toBe('passed')
      expect(container.querySelector('[data-testid="effective-tool-probe-archive"]')?.getAttribute('data-status')).toBe('failed')
      expect(container.textContent).not.toContain('provider-private-body')
    } finally { await act(async () => root.unmount()) }
  })

  it('exposes the「能力与工具」tab distinct from model connections', async () => {
    const http = client((call) => {
      if (call.path.endsWith('/model-connections')) return envelope([])
      if (call.path.endsWith('/model-assignments')) return envelope(null)
      if (call.path.endsWith('/tool-connections')) return envelope([SEARCH])
      if (call.path.endsWith('/tool-assignments')) return envelope(SPACE_SET)
      return envelope([])
    })
    const { container, root } = await render(createElement(AiSettingsPanel, { client: http }))
    try {
      expect(container.querySelector('[data-testid="ai-tab-tools"]')).not.toBeNull()
      await act(async () => {
        ;(container.querySelector('[data-testid="ai-tab-tools"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="tool-settings"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="tool-subtab-connections"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="tool-connection-row"]')).not.toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})
