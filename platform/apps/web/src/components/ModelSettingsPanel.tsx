import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WorkbenchClient } from '../api/client'
import {
  readModelSettings,
  saveModelSettings,
  testModelSettings,
} from '../api/model-settings'
import type {
  ModelSettingsConnectionTest,
  ModelSettingsDraft,
  ModelSettingsView,
  SaveModelSettingsRequest,
  TestModelSettingsRequest,
} from '../api/model-settings'
import { ApiError } from '../api/errors'
import { Button, Field, Panel, StateFeedback, StatusBadge } from './ui'

type Action = 'load' | 'save' | 'test'
type Notice = { readonly kind: 'error' | 'saved'; readonly text: string }
type PanelState = {
  readonly owner: object
  readonly phase: 'loading' | 'load-error' | 'ready' | 'saving' | 'testing'
  readonly view?: ModelSettingsView
  readonly draft?: ModelSettingsDraft
  readonly apiKey: string
  readonly clearApiKey: boolean
  readonly notice?: Notice
  readonly testResult?: Pick<ModelSettingsConnectionTest, 'reachable'>
}

function clearFeedback(state: PanelState): PanelState {
  const next = { ...state }
  delete next.notice
  delete next.testResult
  return next
}

export interface ModelSettingsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly onDirtyChange?: (dirty: boolean) => void
}

function draftFrom(view: ModelSettingsView): ModelSettingsDraft {
  return {
    enabled: view.enabled,
    baseUrl: view.baseUrl,
    endpoint: view.endpoint,
    protocol: view.protocol,
    platformModelId: view.platformModelId,
    vendorModel: view.vendorModel,
  }
}

function sameDraft(left: ModelSettingsDraft, right: ModelSettingsDraft): boolean {
  return left.enabled === right.enabled && left.baseUrl === right.baseUrl &&
    left.endpoint === right.endpoint && left.protocol === right.protocol &&
    left.platformModelId === right.platformModelId && left.vendorModel === right.vendorModel
}

function validateDraft(
  draft: ModelSettingsDraft,
  options: { readonly hasApiKey: boolean; readonly apiKey: string; readonly clearApiKey: boolean; readonly savedBaseUrl: string },
): string | undefined {
  if (!draft.enabled) return undefined
  if (draft.baseUrl.trim().length === 0) return '启用模型前，请填写模型服务地址。'
  try {
    const url = new URL(draft.baseUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '模型服务地址须使用 HTTP 或 HTTPS。'
  } catch {
    return '请填写完整的模型服务地址，例如 https://gateway.example.com。'
  }
  if (draft.endpoint.trim().length === 0) return '启用模型前，请填写 API 端点。'
  if (draft.platformModelId.trim().length === 0) return '启用模型前，请填写 Core 平台模型 ID。'
  if (draft.vendorModel.trim().length === 0) return '启用模型前，请填写服务商模型名称。'
  if (options.apiKey.length === 0 && (options.clearApiKey || !options.hasApiKey)) {
    return '启用模型并测试连接需要 API Key。请先填写服务商提供的密钥。'
  }
  if (options.apiKey.length === 0 && !sameServiceOrigin(options.savedBaseUrl, draft.baseUrl)) {
    return '服务地址已更换，请重新填写对应的 API Key。'
  }
  return undefined
}

function sameServiceOrigin(left: string, right: string): boolean {
  try {
    return new URL(left.trim()).origin === new URL(right.trim()).origin
  } catch {
    return false
  }
}

function failureText(action: Action, error: unknown, timedOut = false): string {
  if (timedOut) return '连接测试超过等待时间，未收到可用结果。请检查地址和端点后重试。'
  if (error instanceof ApiError) {
    if (error.status === 403) return '当前账户没有读取或修改模型配置的权限。'
    if (error.status === 409) return '配置已被其他窗口更新。请重新读取后再保存，当前输入仍保留。'
    if (error.code === 'MALFORMED_RESPONSE') return 'Core 返回的配置数据无法识别。当前输入仍保留。'
  }
  if (action === 'load') return '暂时无法读取 Core 模型配置。请检查本机服务后重试。'
  if (action === 'test') return '连接测试未完成。请检查网络、地址和端点后重试；服务端响应内容不会显示。'
  return '配置没有保存。请检查 Core 服务后重试，当前输入仍保留。'
}

function settingsRequest(draft: ModelSettingsDraft, apiKey: string, clearApiKey: boolean): Omit<TestModelSettingsRequest, 'revision'> {
  return {
    ...draft,
    ...(apiKey.length === 0 ? {} : { apiKey }),
    ...(clearApiKey ? { clearApiKey: true } : {}),
  }
}

export function ModelSettingsPanel({ client, readOnly = false, onDirtyChange }: ModelSettingsPanelProps) {
  const owner = useMemo(() => ({ client }), [client])
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const requestId = useRef(0)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [loaded, setLoaded] = useState<PanelState>({
    owner,
    phase: 'loading',
    apiKey: '',
    clearApiKey: false,
  })
  const state = loaded.owner === owner ? loaded : undefined
  const busy = state?.phase === 'loading' || state?.phase === 'saving' || state?.phase === 'testing'
  const draft = state?.draft
  const view = state?.view
  const dirty = state !== undefined && view !== undefined && draft !== undefined &&
    (!sameDraft(draft, draftFrom(view)) || state.apiKey.length > 0 || state.clearApiKey)

  useEffect(() => {
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    const id = ++requestId.current
    const current = () => ownerRef.current === owner && requestId.current === id && !controller.signal.aborted
    setLoaded({ owner, phase: 'loading', apiKey: '', clearApiKey: false })
    void readModelSettings(client, controller.signal).then((actual) => {
      if (!current()) return
      setLoaded({
        owner,
        phase: 'ready',
        view: actual,
        draft: draftFrom(actual),
        apiKey: '',
        clearApiKey: false,
      })
    }).catch((error: unknown) => {
      if (!current()) return
      setLoaded({
        owner,
        phase: 'load-error',
        apiKey: '',
        clearApiKey: false,
        notice: { kind: 'error', text: failureText('load', error) },
      })
    })
    return () => {
      controller.abort()
      if (activeController.current === controller) activeController.current = undefined
      if (requestId.current === id) requestId.current += 1
    }
  }, [client, owner])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [client, onDirtyChange])

  const beginAction = (phase: 'saving' | 'testing') => {
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    const id = ++requestId.current
    setLoaded((previous) => previous.owner !== owner ? previous : {
      ...clearFeedback(previous),
      phase,
    })
    return {
      controller,
      current: () => ownerRef.current === owner && requestId.current === id && !controller.signal.aborted,
      currentEvenIfAborted: () => ownerRef.current === owner && requestId.current === id,
    }
  }

  const reload = () => {
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    const id = ++requestId.current
    setLoaded({ owner, phase: 'loading', apiKey: '', clearApiKey: false })
    void readModelSettings(client, controller.signal).then((actual) => {
      if (ownerRef.current !== owner || requestId.current !== id || controller.signal.aborted) return
      setLoaded({ owner, phase: 'ready', view: actual, draft: draftFrom(actual), apiKey: '', clearApiKey: false })
    }).catch((error: unknown) => {
      if (ownerRef.current !== owner || requestId.current !== id || controller.signal.aborted) return
      setLoaded({ owner, phase: 'load-error', apiKey: '', clearApiKey: false, notice: { kind: 'error', text: failureText('load', error) } })
    })
  }

  const updateDraft = (change: Partial<ModelSettingsDraft>) => {
    setLoaded((previous) => previous.owner !== owner || previous.draft === undefined ? previous : {
      ...clearFeedback(previous),
      draft: { ...previous.draft, ...change },
    })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (readOnly || busy || state?.view === undefined || draft === undefined) return
    const validation = validateDraft(draft, {
      hasApiKey: state.view.hasApiKey,
      apiKey: state.apiKey,
      clearApiKey: state.clearApiKey,
      savedBaseUrl: state.view.baseUrl,
    })
    if (validation !== undefined) {
      setLoaded((previous) => previous.owner !== owner ? previous : { ...previous, notice: { kind: 'error', text: validation } })
      return
    }
    const actualView = state.view
    const input: SaveModelSettingsRequest = {
      ...settingsRequest(draft, state.apiKey, state.clearApiKey),
      revision: actualView.revision,
    }
    const request = beginAction('saving')
    try {
      const actual = await saveModelSettings(client, input, request.controller.signal)
      if (!request.current()) return
      setLoaded({
        owner,
        phase: 'ready',
        view: actual,
        draft: draftFrom(actual),
        apiKey: '',
        clearApiKey: false,
        notice: { kind: 'saved', text: actual.restartRequired
          ? '配置已保存；当前进程尚未切换到新设置。重启 Core 后生效。'
          : '配置已保存；当前进程已使用这组设置。' },
      })
    } catch (error) {
      if (!request.current()) return
      setLoaded((previous) => previous.owner !== owner ? previous : {
        ...previous,
        phase: 'ready',
        notice: { kind: 'error', text: failureText('save', error) },
      })
    } finally {
      if (activeController.current === request.controller) activeController.current = undefined
    }
  }

  const testConnection = async () => {
    if (readOnly || busy || draft === undefined) return
    const validation = validateDraft({ ...draft, enabled: true }, {
      hasApiKey: state?.view?.hasApiKey ?? false,
      apiKey: state?.apiKey ?? '',
      clearApiKey: state?.clearApiKey ?? false,
      savedBaseUrl: state?.view?.baseUrl ?? '',
    })
    if (validation !== undefined) {
      setLoaded((previous) => previous.owner !== owner ? previous : { ...previous, notice: { kind: 'error', text: validation } })
      return
    }
    const input: TestModelSettingsRequest = settingsRequest({ ...draft, enabled: true }, state?.apiKey ?? '', state?.clearApiKey ?? false)
    const request = beginAction('testing')
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      request.controller.abort()
    }, 10_000)
    try {
      const result: ModelSettingsConnectionTest = await testModelSettings(client, input, request.controller.signal)
      if (!request.current()) return
      setLoaded((previous) => previous.owner !== owner ? previous : {
        ...clearFeedback(previous),
        phase: 'ready',
        testResult: { reachable: result.reachable },
      })
    } catch (error) {
      if (!request.currentEvenIfAborted()) return
      setLoaded((previous) => previous.owner !== owner ? previous : {
        ...previous,
        phase: 'ready',
        testResult: { reachable: false },
        notice: { kind: 'error', text: failureText('test', error, timedOut) },
      })
    } finally {
      window.clearTimeout(timeout)
      if (activeController.current === request.controller) activeController.current = undefined
    }
  }

  if (state === undefined || state.phase === 'loading') {
    return <Panel title="模型配置" description="配置供此 Core 实例使用的生成模型。">
      <StateFeedback title="正在读取模型配置" description="正在从当前 Core 实例读取已保存设置。" tone="loading" />
    </Panel>
  }

  if (state.phase === 'load-error' || view === undefined || draft === undefined) {
    return <Panel title="模型配置" description="配置供此 Core 实例使用的生成模型。">
      <StateFeedback title="暂时无法读取配置" description={state.notice?.text ?? '请检查本机 Core 服务后重试。'} tone="error"
        action={<Button onClick={reload}>重新读取配置</Button>} />
    </Panel>
  }

  return <Panel title="模型配置" description="配置供此 Core 实例使用的生成模型。">
    <p>结构化资料导入和人工审核不需要模型。保存只更新配置，不会自动重启；当前进程在重启前继续使用原配置。</p>

    <section className="model-settings__status" aria-label="模型配置生效状态" data-restart-required={view.restartRequired}>
      <StatusBadge tone={view.enabled ? 'success' : 'neutral'}>
        {view.enabled ? '已保存配置：模型启用' : '已保存配置：模型关闭'}
      </StatusBadge>
      <StatusBadge tone={view.activeEnabled ? 'success' : 'neutral'}>
        {view.activeEnabled ? '当前进程：模型已启用' : '当前进程：模型未启用'}
      </StatusBadge>
      {view.restartRequired
        ? <p role="status">需要重启 Core 才能让保存的配置生效。本面板不会自动重启服务。</p>
        : <p role="status">保存的启用状态与当前进程一致。</p>}
      {view.hasApiKey ? <p>已保存 API Key。密钥不会回显；留空会保留现有密钥。</p> : <p>尚未保存 API Key。</p>}
    </section>

    {state.notice === undefined ? null : <p role={state.notice.kind === 'error' ? 'alert' : 'status'} data-testid="model-settings-notice">{state.notice.text}</p>}
    {state.testResult === undefined ? null : (
      <p role="status" data-testid="model-settings-test-result" data-reachable={state.testResult.reachable}>
        {state.testResult.reachable
          ? '连接测试通过：Core 能与此配置通信。此结果不代表模型回答或业务质量已验证。'
          : '连接测试未通过：请检查地址、端点和模型标识。'}
      </p>
    )}

    <form onSubmit={(event) => void save(event)} data-testid="model-settings-form">
      <fieldset disabled={readOnly || busy} className="model-settings__fields">
        <legend>服务与模型</legend>
        <Field label="启用生成模型" hint="启用后供配置为生成能力的功能使用；不会自动启用决策模型。">
          {(attributes) => <input {...attributes} type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })} />}
        </Field>
        <Field label="模型服务地址" hint="填写服务提供方或公司网关的基础 URL，例如 https://gateway.example.com。">
          {(attributes) => <input {...attributes} type="url" autoComplete="url" placeholder="https://gateway.example.com" value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.currentTarget.value })} />}
        </Field>
        <Field label="API 端点" hint="相对于服务地址的请求路径；OpenAI 兼容服务通常使用 /v1/chat/completions。">
          {(attributes) => <input {...attributes} type="text" placeholder="/v1/chat/completions" value={draft.endpoint} onChange={(event) => updateDraft({ endpoint: event.currentTarget.value })} />}
        </Field>
        <Field label="协议" hint="按服务实际支持的接口格式选择。">
          {(attributes) => <select {...attributes} value={draft.protocol} onChange={(event) => {
            const protocol = event.currentTarget.value
            if (protocol === 'private' || protocol === 'openai-compatible') updateDraft({ protocol })
          }}>
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="private">私有协议</option>
          </select>}
        </Field>
        <Field label="Core 平台模型 ID" hint="Core 内部能力标识，例如 company-generation。">
          {(attributes) => <input {...attributes} type="text" placeholder="company-generation" value={draft.platformModelId} onChange={(event) => updateDraft({ platformModelId: event.currentTarget.value })} />}
        </Field>
        <Field label="服务商模型名称 *" hint="必填。填写服务商侧要求的模型名称；它与 Core 平台模型 ID 是不同标识。">
          {(attributes) => <input {...attributes} type="text" placeholder="留空或填写服务商模型名" value={draft.vendorModel} onChange={(event) => updateDraft({ vendorModel: event.currentTarget.value })} />}
        </Field>
        <Field label="API Key" hint="新增或更换密钥时填写。同一服务地址留空会保留现有密钥；更换服务地址时必须重新填写。保存后输入框会清空，读取配置不会返回密钥。">
          {(attributes) => <input {...attributes} type="password" autoComplete="new-password" value={state.apiKey} onChange={(event) => {
            const apiKey = event.currentTarget.value
            setLoaded((previous) => previous.owner !== owner ? previous : { ...clearFeedback(previous), apiKey, clearApiKey: false })
          }} />}
        </Field>
        {view.hasApiKey ? <Field label="清除已保存的 API Key" hint="只有勾选此项并保存，才会删除已保存密钥。">
          {(attributes) => <input {...attributes} type="checkbox" checked={state.clearApiKey} onChange={(event) => {
            const clearApiKey = event.currentTarget.checked
            setLoaded((previous) => previous.owner !== owner ? previous : { ...clearFeedback(previous), clearApiKey, apiKey: clearApiKey ? '' : previous.apiKey })
          }} />}
        </Field> : null}
      </fieldset>

      <p>“测试连接”会向当前配置的地址发送少量真实协议请求，可能联系已填写的服务。Core 将在 8 秒内结束测试；页面不显示 API Key 或服务端响应正文。通过只表示通信可达，不证明回答质量。</p>
      {readOnly ? <p role="status">当前为只读访问，不能保存配置或发送连接测试。</p> : (
        <div className="model-settings__actions">
          <Button type="submit" variant="primary" disabled={busy} data-testid="model-settings-save">
            {state.phase === 'saving' ? '正在保存…' : '保存配置（重启生效）'}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void testConnection()} data-testid="model-settings-test">
            {state.phase === 'testing' ? '正在测试…' : '测试连接'}
          </Button>
          {dirty ? <span role="status">有未保存的修改</span> : null}
        </div>
      )}
    </form>
  </Panel>
}
