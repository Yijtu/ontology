// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelSettingsView } from '../../apps/web/src/api/model-settings'
import { isModelSettingsView, readModelSettings, saveModelSettings, testModelSettings } from '../../apps/web/src/api/model-settings'
import { ModelSettingsPanel } from '../../apps/web/src/components/ModelSettingsPanel'
import { WorkbenchClient } from '../../apps/web/src/api/client'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS: ModelSettingsView = {
  revision: '7',
  enabled: false,
  baseUrl: '',
  endpoint: '/v1/chat/completions',
  protocol: 'openai-compatible',
  platformModelId: '',
  vendorModel: '',
  hasApiKey: false,
  activeEnabled: false,
  restartRequired: false,
}

const SAVED: ModelSettingsView = {
  ...SETTINGS,
  revision: '8',
  enabled: true,
  baseUrl: 'https://gateway.example.com',
  platformModelId: 'company-generation',
  vendorModel: 'vendor-chat-small',
  hasApiKey: true,
  activeEnabled: false,
  restartRequired: true,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: typeof fetch): WorkbenchClient {
  return new WorkbenchClient({ baseUrl: 'http://model-config.test', fetchImpl })
}

function envelope(data: unknown): Response {
  return json({ data })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function render(settingsClient: WorkbenchClient, props: { readonly readOnly?: boolean; readonly onDirtyChange?: (dirty: boolean) => void } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(ModelSettingsPanel, { client: settingsClient, ...props }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { container, root }
}

function field(container: HTMLElement, labelText: string): HTMLInputElement | HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find((entry) => entry.textContent?.trim() === labelText)
  if (label?.htmlFor === '') throw new Error(`field label ${labelText} has no input id`)
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

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

afterEach(() => { document.body.innerHTML = '' })

describe('Core model settings client contract', () => {
  it('uses the frozen GET, PUT and connection-test contracts and rejects secret-bearing reads', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const http = client(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
      calls.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return envelope(SETTINGS)
      if (method === 'PUT') return envelope(SAVED)
      return envelope({ reachable: true, message: 'Provider returned opaque test detail.' })
    })

    expect(isModelSettingsView(SETTINGS)).toBe(true)
    expect(isModelSettingsView({ ...SETTINGS, apiKey: 'must-not-be-read-back' })).toBe(false)
    expect(await readModelSettings(http)).toEqual(SETTINGS)
    const request = {
      revision: SETTINGS.revision,
      enabled: SAVED.enabled,
      baseUrl: SAVED.baseUrl,
      endpoint: SAVED.endpoint,
      protocol: SAVED.protocol,
      platformModelId: SAVED.platformModelId,
      vendorModel: SAVED.vendorModel,
      apiKey: 'one-time-secret',
    }
    expect(await saveModelSettings(http, request)).toEqual(SAVED)
    expect(await testModelSettings(http, {
      enabled: request.enabled, baseUrl: request.baseUrl, endpoint: request.endpoint,
      protocol: request.protocol, platformModelId: request.platformModelId,
      vendorModel: request.vendorModel, apiKey: request.apiKey,
    })).toEqual({ reachable: true, message: 'Provider returned opaque test detail.' })
    expect(calls).toEqual([
      { method: 'GET', path: '/api/v1/core/model-settings' },
      { method: 'PUT', path: '/api/v1/core/model-settings', body: request },
      { method: 'POST', path: '/api/v1/core/model-settings/test', body: {
        enabled: request.enabled, baseUrl: request.baseUrl, endpoint: request.endpoint,
        protocol: request.protocol, platformModelId: request.platformModelId,
        vendorModel: request.vendorModel, apiKey: request.apiKey,
      } },
    ])

    const secretResponse = client(async () => envelope({ ...SETTINGS, apiKey: 'unexpected-secret' }))
    await expect(readModelSettings(secretResponse)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})

describe('ModelSettingsPanel', () => {
  it('clears the one-time key after save, explains restart and does not render provider response text', async () => {
    let submitted: unknown
    const paths: string[] = []
    const http = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      paths.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.endsWith('/test')) {
        return envelope({ reachable: true, message: 'provider-private-body-never-render-this' })
      }
      if (init?.method === 'PUT') {
        submitted = JSON.parse(String(init.body)) as unknown
        return envelope(SAVED)
      }
      return envelope(SETTINGS)
    })
    const dirtyCalls: boolean[] = []
    const { container, root } = await render(http, { onDirtyChange: (dirty) => dirtyCalls.push(dirty) })
    try {
      expect(paths).toContain('GET /api/v1/core/model-settings')
      expect(container.textContent).toContain('尚未保存 API Key')
      const enabled = field(container, '启用生成模型') as HTMLInputElement
      const baseUrl = field(container, '模型服务地址') as HTMLInputElement
      const platformModelId = field(container, 'Core 平台模型 ID') as HTMLInputElement
      const vendorModel = field(container, '服务商模型名称 *') as HTMLInputElement
      const key = field(container, 'API Key') as HTMLInputElement
      expect(key.type).toBe('password')

      await act(async () => {
        enabled.click()
        textValue(baseUrl, 'https://gateway.example.com')
        textValue(platformModelId, 'company-generation')
        textValue(vendorModel, 'vendor-chat-small')
        textValue(key, 'one-time-secret-never-echo')
      })
      await settle()
      expect(dirtyCalls.at(-1)).toBe(true)

      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(submitted).toEqual({
        revision: '7', enabled: true, baseUrl: 'https://gateway.example.com', endpoint: '/v1/chat/completions',
        protocol: 'openai-compatible', platformModelId: 'company-generation', vendorModel: 'vendor-chat-small',
        apiKey: 'one-time-secret-never-echo',
      })
      expect((field(container, 'API Key') as HTMLInputElement).value).toBe('')
      expect(container.textContent).toContain('需要重启 Core')
      expect(container.textContent).toContain('已保存配置：模型启用')
      expect(container.textContent).toContain('当前进程：模型未启用')
      expect(container.textContent).not.toContain('one-time-secret-never-echo')
      expect(dirtyCalls.at(-1)).toBe(false)

      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-test"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.textContent).toContain('Core 能与此配置通信')
      expect(container.textContent).toContain('不代表模型回答或业务质量已验证')
      expect(container.textContent).not.toContain('provider-private-body-never-render-this')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('retains non-secret inputs after a conflict and never renders server/provider details', async () => {
    const http = client(async (_input, init) => {
      if (init?.method === 'PUT') {
        return json({ error: { code: 'VERSION_CONFLICT', message: 'provider-private-body-and-key-should-not-appear' } }, 409)
      }
      return envelope(SETTINGS)
    })
    const { container, root } = await render(http)
    try {
      await act(async () => {
        (field(container, '启用生成模型') as HTMLInputElement).click()
        textValue(field(container, '模型服务地址') as HTMLInputElement, 'https://keep-this-address.example')
        textValue(field(container, 'Core 平台模型 ID') as HTMLInputElement, 'keep-this-model-id')
        textValue(field(container, '服务商模型名称 *') as HTMLInputElement, 'vendor-chat-small')
        textValue(field(container, 'API Key') as HTMLInputElement, 'typed-secret-value')
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-save"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(container.textContent).toContain('配置已被其他窗口更新')
      expect((field(container, '模型服务地址') as HTMLInputElement).value).toBe('https://keep-this-address.example')
      expect((field(container, 'Core 平台模型 ID') as HTMLInputElement).value).toBe('keep-this-model-id')
      expect((field(container, 'API Key') as HTMLInputElement).type).toBe('password')
      expect(container.textContent).not.toContain('typed-secret-value')
      expect(container.textContent).not.toContain('provider-private-body-and-key-should-not-appear')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('requires a vendor model and a new key before sending enabled saves or connection tests', async () => {
    const methods: string[] = []
    const http = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      const method = init?.method ?? 'GET'
      methods.push(`${method} ${path}`)
      if (path.endsWith('/test')) return envelope({ reachable: true, message: 'sanitized' })
      return envelope(SETTINGS)
    })
    const { container, root } = await render(http)
    try {
      await act(async () => {
        ;(field(container, '启用生成模型') as HTMLInputElement).click()
        textValue(field(container, '模型服务地址') as HTMLInputElement, 'https://gateway.example.com')
        textValue(field(container, 'Core 平台模型 ID') as HTMLInputElement, 'company-generation')
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-save"]') as HTMLButtonElement).click()
      })
      expect(container.textContent).toContain('服务商模型名称')
      expect(container.textContent).toContain('填写服务商模型名称')
      expect(methods).toEqual(['GET /api/v1/core/model-settings'])

      await act(async () => { textValue(field(container, '服务商模型名称 *') as HTMLInputElement, 'vendor-chat-small') })
      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-save"]') as HTMLButtonElement).click()
      })
      expect(container.textContent).toContain('启用模型并测试连接需要 API Key')
      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-test"]') as HTMLButtonElement).click()
      })
      expect(methods).toEqual(['GET /api/v1/core/model-settings'])

      await act(async () => { textValue(field(container, 'API Key') as HTMLInputElement, 'new-test-key') })
      await act(async () => {
        ;(container.querySelector('[data-testid="model-settings-test"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(methods).toEqual(['GET /api/v1/core/model-settings', 'POST /api/v1/core/model-settings/test'])
      expect(container.textContent).toContain('Core 能与此配置通信')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('requires a replacement key when the saved key would be sent to a different service origin', async () => {
    const methods: string[] = []
    const http = client(async (input, init) => {
      const path = new URL(String(input)).pathname
      methods.push(`${init?.method ?? 'GET'} ${path}`)
      return envelope(SAVED)
    })
    const { container, root } = await render(http)
    try {
      await act(async () => {
        textValue(field(container, '模型服务地址') as HTMLInputElement, 'https://other-gateway.example')
        ;(container.querySelector('[data-testid="model-settings-test"]') as HTMLButtonElement).click()
      })
      expect(container.textContent).toContain('服务地址已更换，请重新填写对应的 API Key')
      expect(methods).toEqual(['GET /api/v1/core/model-settings'])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('does not let a delayed response from the previous client replace the new scope', async () => {
    const late = deferred<Response>()
    const oldClient = client(async () => late.promise)
    const newClient = client(async () => envelope({ ...SETTINGS, baseUrl: 'https://new-scope.example' }))
    const { container, root } = await render(oldClient)
    try {
      await act(async () => {
        root.render(createElement(ModelSettingsPanel, { client: newClient }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect((field(container, '模型服务地址') as HTMLInputElement).value).toBe('https://new-scope.example')
      await act(async () => {
        late.resolve(envelope({ ...SETTINGS, baseUrl: 'https://old-scope.example' }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect((field(container, '模型服务地址') as HTMLInputElement).value).toBe('https://new-scope.example')
    } finally {
      await act(async () => root.unmount())
    }
  })
})
