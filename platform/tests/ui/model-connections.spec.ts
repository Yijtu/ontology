// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchClient } from '../../apps/web/src/api/client'
import {
  deleteModelConnection,
  readEffectiveModels,
  readModelConnections,
} from '../../apps/web/src/api/model-connections'
import type { ModelConnectionAdminView } from '../../apps/web/src/api/model-connections'
import { AiSettingsPanel } from '../../apps/web/src/components/AiSettingsPanel'
import { EffectiveModelsPanel } from '../../apps/web/src/components/EffectiveModelsPanel'
import { ModelAssignmentsPanel } from '../../apps/web/src/components/ModelAssignmentsPanel'
import { ModelConnectionsPanel } from '../../apps/web/src/components/ModelConnectionsPanel'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true

const GEN_ID = '11111111-1111-4111-8111-111111111111'
const JEV_ID = '22222222-2222-4222-8222-222222222222'

const GEN: ModelConnectionAdminView = {
  connectionId: GEN_ID,
  name: '主生成模型',
  revision: '3',
  adapterType: 'company_generation',
  protocol: 'openai_compatible',
  capabilities: ['generation', 'research'],
  enabled: true,
  credentialState: 'present',
  testSummary: { revision: '3', status: 'passed', testedAt: '2026-01-02T00:00:00.000Z' },
  updatedAt: '2026-01-02T00:00:00.000Z',
  platformModelId: 'company-generation',
  providerModelName: 'vendor-chat',
  baseUrl: 'https://gateway.example.com',
  endpoint: '/v1/chat/completions',
}

const JEV: ModelConnectionAdminView = {
  connectionId: JEV_ID,
  name: '决策 JEV',
  revision: '1',
  adapterType: 'jev',
  protocol: 'jev',
  capabilities: ['decision_jev'],
  enabled: true,
  credentialState: 'missing',
  updatedAt: '2026-01-01T00:00:00.000Z',
  platformModelId: 'company-jev',
  providerModelName: 'vendor-jev',
}

const SPACE_SET = {
  schemaVersion: 'model-assignment-set@1',
  scope: { kind: 'space' },
  defaultSelection: { kind: 'connection', connectionId: GEN_ID },
  capabilitySelections: [{ capability: 'decision_jev', selection: { kind: 'connection', connectionId: JEV_ID } }],
  revision: '2',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const EFFECTIVE_AVAILABLE = {
  schemaVersion: 'effective-model-selection@1',
  scope: { kind: 'space' },
  capability: 'generation',
  selection: { kind: 'connection', connectionId: GEN_ID },
  resolvedFrom: 'space_default',
  state: 'available',
  connectionId: GEN_ID,
  connectionSummary: {
    connectionId: GEN_ID, name: '主生成模型', revision: '3', adapterType: 'company_generation',
    protocol: 'openai_compatible', capabilities: ['generation', 'research'], enabled: true,
    credentialState: 'present', updatedAt: '2026-01-02T00:00:00.000Z',
  },
  assignmentRevision: '2',
  resolvedAt: '2026-01-02T00:00:00.000Z',
}

const EFFECTIVE_BLOCKED = {
  schemaVersion: 'effective-model-selection@1',
  scope: { kind: 'space' },
  capability: 'decision_jev',
  selection: { kind: 'connection', connectionId: JEV_ID },
  resolvedFrom: 'space_capability',
  state: 'blocked',
  connectionId: JEV_ID,
  blockedReason: 'CREDENTIAL_MISSING',
  assignmentRevision: '2',
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
    baseUrl: 'http://ai-settings.test',
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

describe('AI model-connections client contract', () => {
  it('reads the catalogue over /api/v1/core/ai and rejects any secret-bearing response', async () => {
    const calls: Call[] = []
    const http = client((call) => {
      calls.push(call)
      return envelope([GEN, JEV])
    })
    const list = await readModelConnections(http)
    expect(list.map((entry) => entry.name)).toEqual(['主生成模型', '决策 JEV'])
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/core/ai/model-connections', search: '' }])

    const secret = client(() => envelope([{ ...GEN, apiKey: 'leaked-secret' }]))
    await expect(readModelConnections(secret)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('deletes with a body-less DELETE and parses effective-models including blocked reasons', async () => {
    const deletes: Call[] = []
    const http = client((call) => {
      if (call.method === 'DELETE') { deletes.push(call); return new Response(null, { status: 204 }) }
      return envelope([EFFECTIVE_AVAILABLE, EFFECTIVE_BLOCKED])
    })
    await deleteModelConnection(http, GEN_ID)
    expect(deletes).toEqual([{ method: 'DELETE', path: `/api/v1/core/ai/model-connections/${GEN_ID}`, search: '' }])

    const selections = await readEffectiveModels(http, { kind: 'space' })
    expect(selections[0]).toMatchObject({ capability: 'generation', state: 'available', resolvedFrom: 'space_default' })
    expect(selections[1]).toMatchObject({ capability: 'decision_jev', state: 'blocked', blockedReason: 'CREDENTIAL_MISSING' })

    const secret = client(() => envelope([{ ...EFFECTIVE_AVAILABLE, apiKey: 'leaked-secret' }]))
    await expect(readEffectiveModels(secret, { kind: 'space' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('ModelConnectionsPanel', () => {
  it('lists connections with adapter, credential, test summary and usage, and never a secret', async () => {
    const http = client((call) => {
      if (call.path.endsWith('/model-connections')) return envelope([GEN, JEV])
      if (call.path.endsWith('/model-assignments')) return envelope(SPACE_SET)
      return envelope({})
    })
    const { container, root } = await render(createElement(ModelConnectionsPanel, { client: http }))
    try {
      const rows = container.querySelectorAll('[data-testid="connection-row"]')
      expect(rows).toHaveLength(2)
      expect(container.textContent).toContain('主生成模型')
      expect(container.textContent).toContain('公司生成适配器')
      expect(container.textContent).toContain('OpenAI 兼容')
      expect(container.textContent).toContain('vendor-chat')
      expect(container.textContent).toContain('凭据已配置')
      expect(container.textContent).toContain('通过')
      expect(container.textContent).toContain('空间默认')
      expect(container.textContent).toContain('空间能力：决策 JEV')
      expect(container.textContent).not.toContain('leaked-secret')
    } finally { await act(async () => root.unmount()) }
  })

  it('shows a permission notice without names when the catalogue is forbidden', async () => {
    const http = client(() => errorResponse(403, 'SCOPE_MISMATCH'))
    const { container, root } = await render(createElement(ModelConnectionsPanel, { client: http }))
    try {
      expect(container.textContent).toContain('管理模型连接需要本机平台管理员权限')
      expect(container.textContent).not.toContain('主生成模型')
      expect(container.querySelector('[data-testid="connection-row"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps the connection and explains how to unbind when a delete is rejected as in-use', async () => {
    const http = client((call) => {
      if (call.method === 'DELETE') return errorResponse(409, 'MODEL_IN_USE')
      if (call.path.endsWith('/model-connections')) return envelope([GEN])
      return envelope(SPACE_SET)
    })
    const { container, root } = await render(createElement(ModelConnectionsPanel, { client: http }))
    try {
      await act(async () => {
        ;(container.querySelector('[data-testid="connection-delete"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.textContent).toContain('请先在“默认与分配”中解绑')
      expect(container.querySelectorAll('[data-testid="connection-row"]')).toHaveLength(1)
    } finally { await act(async () => root.unmount()) }
  })

  it('saves an incomplete disabled connection without a key and clears the key input', async () => {
    const posts: Call[] = []
    let list: readonly ModelConnectionAdminView[] = []
    const http = client((call) => {
      if (call.method === 'POST' && call.path.endsWith('/model-connections')) {
        posts.push(call)
        list = [{ ...GEN, name: '新连接', enabled: false, credentialState: 'missing', capabilities: ['generation'] }]
        return json({ data: list[0] }, 201)
      }
      if (call.path.endsWith('/model-assignments')) return envelope(null)
      return envelope(list)
    })
    const { container, root } = await render(createElement(ModelConnectionsPanel, { client: http }))
    try {
      await act(async () => { (container.querySelector('[data-testid="connection-create"]') as HTMLButtonElement).click() })
      await act(async () => {
        textValue(field(container, '连接名称 *') as HTMLInputElement, '新连接')
        textValue(field(container, 'Core 平台模型 ID *') as HTMLInputElement, 'company-generation')
        textValue(field(container, '服务商模型名称 *') as HTMLInputElement, 'vendor-chat')
        textValue(field(container, '模型服务地址') as HTMLInputElement, 'https://gateway.example.com')
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="connection-editor-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(posts).toHaveLength(1)
      const body = posts[0]?.body as { descriptor: Record<string, unknown>; idempotencyKey: string }
      expect(body.descriptor).toMatchObject({ name: '新连接', enabled: false, capabilities: ['generation'], baseUrl: 'https://gateway.example.com' })
      expect('apiKey' in body).toBe(false)
      expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8)
      await settle()
      expect(container.textContent).toContain('新连接')
      expect(container.querySelector('[data-testid="connection-editor-form"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})

describe('ModelAssignmentsPanel', () => {
  it('offers only capability-matching connections, never a generation model for JEV, and saves with CAS', async () => {
    const puts: Call[] = []
    const http = client((call) => {
      if (call.method === 'PUT') {
        puts.push(call)
        return envelope({ ...SPACE_SET, revision: '3' })
      }
      if (call.path.endsWith('/model-connections')) return envelope([GEN, JEV])
      if (call.path.endsWith('/model-assignments')) return envelope(SPACE_SET)
      return envelope([])
    })
    const { container, root } = await render(createElement(ModelAssignmentsPanel, { client: http }))
    try {
      const jev = field(container, '决策 JEV模型') as HTMLSelectElement
      const jevOptions = [...jev.options].map((option) => option.textContent)
      expect(jevOptions).toContain('决策 JEV')
      expect(jevOptions).not.toContain('主生成模型')

      const defaultSelect = field(container, '默认生成模型') as HTMLSelectElement
      const defaultOptions = [...defaultSelect.options].map((option) => option.textContent)
      expect(defaultOptions).toContain('主生成模型')
      expect(defaultOptions).not.toContain('决策 JEV')

      await act(async () => { selectValue(defaultSelect, 'disabled') })
      await act(async () => {
        ;(container.querySelector('[data-testid="assignments-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(puts).toHaveLength(1)
      const body = puts[0]?.body as { scope: unknown; defaultSelection: unknown; capabilitySelections: readonly unknown[]; expectedRevision: string }
      expect(body.scope).toEqual({ kind: 'space' })
      expect(body.defaultSelection).toEqual({ kind: 'disabled' })
      expect(body.expectedRevision).toBe('2')
      expect(body.capabilitySelections).toEqual([{ capability: 'decision_jev', selection: { kind: 'connection', connectionId: JEV_ID } }])
    } finally { await act(async () => root.unmount()) }
  })

  it('retains the chosen selection and explains a version conflict', async () => {
    const http = client((call) => {
      if (call.method === 'PUT') return errorResponse(409, 'VERSION_CONFLICT')
      if (call.path.endsWith('/model-connections')) return envelope([GEN])
      return envelope(SPACE_SET)
    })
    const { container, root } = await render(createElement(ModelAssignmentsPanel, { client: http }))
    try {
      const defaultSelect = field(container, '默认生成模型') as HTMLSelectElement
      await act(async () => { selectValue(defaultSelect, 'disabled') })
      await act(async () => {
        ;(container.querySelector('[data-testid="assignments-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.textContent).toContain('分配已被其他窗口更新')
      expect((field(container, '默认生成模型') as HTMLSelectElement).value).toBe('disabled')
    } finally { await act(async () => root.unmount()) }
  })
})

describe('EffectiveModelsPanel and AiSettingsPanel', () => {
  it('renders model name, source, state and sanitized blocked reason', async () => {
    const http = client(() => envelope([EFFECTIVE_AVAILABLE, EFFECTIVE_BLOCKED]))
    const { container, root } = await render(createElement(EffectiveModelsPanel, { client: http }))
    try {
      const cards = container.querySelectorAll('[data-testid="effective-model"]')
      expect(cards).toHaveLength(2)
      expect(container.textContent).toContain('主生成模型')
      expect(container.textContent).toContain('空间默认')
      expect(container.textContent).toContain('可用')
      expect(container.textContent).toContain('凭据缺失或已撤销')
      expect(container.textContent).not.toContain('provider-private-body')
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps ?view=models with tabs and exposes the legacy compatibility tab', async () => {
    const http = client((call) => {
      if (call.path.endsWith('/model-connections')) return envelope([])
      if (call.path.endsWith('/model-assignments')) return envelope(null)
      if (call.path.endsWith('/model-settings')) return envelope({ revision: '1', enabled: false, baseUrl: '', endpoint: '/v1/chat/completions', protocol: 'openai-compatible', platformModelId: '', vendorModel: '', hasApiKey: false, activeEnabled: false, restartRequired: false })
      return envelope([])
    })
    const { container, root } = await render(createElement(AiSettingsPanel, { client: http }))
    try {
      expect(container.querySelector('[data-testid="ai-tab-connections"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="ai-tab-assignments"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="ai-tab-effective"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="ai-tab-legacy"]')).not.toBeNull()
      await act(async () => {
        ;(container.querySelector('[data-testid="ai-tab-legacy"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.querySelector('[data-testid="model-settings-form"]')).not.toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})
