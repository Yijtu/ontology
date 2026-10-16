import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type {
  ToolAdapterType,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionDescriptor,
  ToolConnectionProbeResult,
} from '../api/tool-connections'
import {
  copyToolConnection,
  createToolConnection,
  testDraftToolConnection,
  testStoredToolConnection,
  updateToolConnection,
} from '../api/tool-connections'
import { Button, Field, Panel, StateFeedback } from './ui'
import { ToolProbeResultView } from './ToolProbeResultView'
import { TOOL_CAPABILITY_LABELS } from './tool-settings-labels'

export type ToolConnectionEditorMode = 'create' | 'edit' | 'copy'

interface Draft {
  readonly name: string
  readonly adapterType: ToolAdapterType
  readonly capabilities: readonly ToolConnectionCapability[]
  readonly enabled: boolean
  readonly endpoint: string
}

type Phase = 'idle' | 'saving' | 'testing'

/** First phase: both adapter families serve the web-search tool only (design §9). */
const ADAPTER_CAPABILITIES: Readonly<Record<ToolAdapterType, readonly ToolConnectionCapability[]>> = {
  native_tavily: ['web_search'],
  http_compat: ['web_search'],
}

/** The native Tavily service authenticates every call; the keyless compat gateway does not. */
function adapterRequiresCredential(adapterType: ToolAdapterType): boolean {
  return adapterType === 'native_tavily'
}

export interface ToolConnectionEditorProps {
  readonly client: WorkbenchClient
  readonly mode: ToolConnectionEditorMode
  readonly connection?: ToolConnectionAdminView
  readonly onSaved: (view: ToolConnectionAdminView) => void
  readonly onCancel: () => void
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly readOnly?: boolean
}

function defaultDraft(): Draft {
  return { name: '', adapterType: 'native_tavily', capabilities: ['web_search'], enabled: false, endpoint: '' }
}

function draftFromConnection(view: ToolConnectionAdminView, mode: ToolConnectionEditorMode): Draft {
  return {
    name: mode === 'copy' ? `${view.name} 副本` : view.name,
    adapterType: view.adapterType,
    capabilities: [...view.capabilities],
    enabled: mode === 'edit' ? view.enabled : false,
    endpoint: view.endpoint ?? '',
  }
}

function sameDraft(left: Draft, right: Draft): boolean {
  return left.name === right.name && left.adapterType === right.adapterType && left.enabled === right.enabled &&
    left.endpoint === right.endpoint && left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability) => right.capabilities.includes(capability))
}

function descriptorOf(draft: Draft): ToolConnectionDescriptor {
  return {
    name: draft.name.trim(),
    adapterType: draft.adapterType,
    capabilities: [...draft.capabilities],
    enabled: draft.enabled,
    ...(draft.endpoint.trim().length === 0 ? {} : { endpoint: draft.endpoint.trim() }),
  }
}

function validateEndpoint(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '服务地址须使用 HTTP 或 HTTPS。'
    if (url.username || url.password || url.search || url.hash) return '服务地址只填写域名、端口和路径，不能包含账号、查询参数或片段。'
    return undefined
  } catch {
    return '请填写完整的服务地址，例如 https://api.example.com/search。'
  }
}

function validate(draft: Draft, options: {
  readonly hasCredential: boolean
  readonly apiKey: string
  readonly clearCredential: boolean
  readonly endpointChanged: boolean
  readonly requireKey: boolean
}): string | undefined {
  if (draft.name.trim().length === 0) return '请填写连接名称。'
  if (draft.capabilities.length === 0) return '请至少为该连接指定一项能力。'
  const supported = ADAPTER_CAPABILITIES[draft.adapterType]
  if (!draft.capabilities.every((capability) => supported.includes(capability))) {
    return '所选的适配类型不支持其中的能力，搜索服务只能提供公共网页搜索能力。'
  }
  const endpointError = validateEndpoint(draft.endpoint)
  if (endpointError !== undefined) return endpointError
  if (draft.enabled && draft.adapterType === 'http_compat' && draft.endpoint.trim().length === 0) {
    return '启用兼容网关前，请填写服务地址。'
  }
  if (options.clearCredential && draft.enabled) {
    return '启用中的连接不能清除凭据；请先停用，或改为填写新凭据。'
  }
  if (draft.enabled && options.endpointChanged && options.apiKey.length === 0 && options.hasCredential && !options.clearCredential) {
    return '更换服务地址时必须重新填写密钥，旧密钥不会发送到新地址。'
  }
  const keyProvided = options.apiKey.length > 0
  const keepStored = options.hasCredential && !options.clearCredential && !options.endpointChanged
  if (options.requireKey && !keyProvided && !keepStored) {
    return '原生 Tavily 服务需要 API Key；请填写服务商提供的密钥，或明确清除旧密钥。'
  }
  return undefined
}

function failureText(error: unknown, timedOut: boolean): string {
  if (timedOut) return '连接测试超过等待时间，未收到可用结果。请检查服务地址后重试。'
  if (error instanceof ApiError) {
    if (error.status === 403) return '当前账户没有管理工具连接的权限（需要本机平台管理员）。'
    if (error.code === 'TOOL_IN_USE') return '该连接仍被分配引用，请先在“默认与分配”中解绑后再删除。'
    if (error.code === 'TOOL_CAPABILITY_MISMATCH') return error.message
    if (error.code === 'NOT_FOUND') return '该工具连接不存在或不在当前空间内。'
    if (error.code === 'VERSION_CONFLICT' || error.status === 409) return '连接已被其他窗口更新。请返回目录重新读取后再编辑，当前非密钥输入仍保留。'
    if (error.code === 'MALFORMED_RESPONSE') return 'Core 返回的工具连接数据无法识别。当前输入仍保留。'
    if (error.status === 400) return error.message
  }
  return '操作未完成。请检查 Core 服务后重试；服务端响应正文不会显示。'
}

export function ToolConnectionEditor({ client, mode, connection, onSaved, onCancel, onDirtyChange, readOnly = false }: ToolConnectionEditorProps) {
  const live = useRef(true)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [draft, setDraft] = useState<Draft>(() => (mode === 'create' || connection === undefined ? defaultDraft() : draftFromConnection(connection, mode)))
  const [apiKey, setApiKey] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<{ readonly kind: 'error' | 'saved'; readonly text: string } | undefined>(undefined)
  const [testResult, setTestResult] = useState<ToolConnectionProbeResult | undefined>(undefined)
  const busy = phase === 'saving' || phase === 'testing'

  const savedDraft = connection === undefined ? undefined : draftFromConnection(connection, mode)
  const dirty = mode === 'copy'
    ? draft.name !== `${connection?.name ?? ''} 副本`
    : savedDraft === undefined
      ? !sameDraft(draft, defaultDraft()) || apiKey.length > 0
      : !sameDraft(draft, savedDraft) || apiKey.length > 0 || clearCredential

  useEffect(() => () => {
    live.current = false
    activeController.current?.abort()
    onDirtyChange?.(false)
  }, [onDirtyChange])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  if (connection === undefined && mode !== 'create') {
    return <Panel title="工具连接" description="编辑工具连接。">
      <StateFeedback title="连接不可用" description="未选择要编辑的工具连接。请返回连接目录后重试。" tone="error" action={<Button onClick={onCancel}>返回连接目录</Button>} />
    </Panel>
  }

  const patch = (change: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...change }))
    setNotice(undefined)
    setTestResult(undefined)
  }

  const begin = (next: 'saving' | 'testing' = 'saving') => {
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    setPhase(next)
    setNotice(undefined)
    return {
      controller,
      current: () => live.current && activeController.current === controller && !controller.signal.aborted,
      currentEvenIfAborted: () => live.current && activeController.current === controller,
      clear: () => { if (activeController.current === controller) activeController.current = undefined },
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (readOnly || busy) return
    if (mode === 'copy') {
      if (draft.name.trim().length === 0) { setNotice({ kind: 'error', text: '请填写副本名称。' }); return }
      const request = begin()
      try {
        const saved = await copyToolConnection(client, connection?.connectionId ?? '', { name: draft.name.trim(), idempotencyKey: client.newRequestKey() }, request.controller.signal)
        if (!request.current()) return
        setPhase('idle')
        onSaved(saved)
      } catch (error) {
        if (!request.current()) return
        setPhase('idle')
        setNotice({ kind: 'error', text: failureText(error, false) })
        request.clear()
      }
      return
    }
    const validation = validate(draft, {
      hasCredential: connection?.credentialState === 'present',
      apiKey,
      clearCredential,
      endpointChanged: savedDraft !== undefined && savedDraft.endpoint !== draft.endpoint,
      requireKey: adapterRequiresCredential(draft.adapterType) && draft.enabled && connection?.credentialState !== 'present',
    })
    if (validation !== undefined) { setNotice({ kind: 'error', text: validation }); return }
    const descriptor = descriptorOf(draft)
    const request = begin()
    try {
      const saved = mode === 'edit' && connection !== undefined
        ? await updateToolConnection(client, connection.connectionId, {
            descriptor,
            expectedRevision: connection.revision,
            ...(apiKey.length === 0 ? {} : { apiKey }),
            ...(clearCredential ? { clearCredential: true } : {}),
            idempotencyKey: client.newRequestKey(),
          }, request.controller.signal)
        : await createToolConnection(client, {
            descriptor,
            ...(apiKey.length === 0 ? {} : { apiKey }),
            idempotencyKey: client.newRequestKey(),
          }, request.controller.signal)
      if (!request.current()) return
      setPhase('idle')
      onSaved(saved)
    } catch (error) {
      if (!request.current()) return
      setPhase('idle')
      setNotice({ kind: 'error', text: failureText(error, false) })
      request.clear()
    }
  }

  const test = async () => {
    if (readOnly || busy || mode === 'copy') return
    const descriptor = descriptorOf(draft)
    const storedPossible = mode === 'edit' && connection !== undefined && apiKey.length === 0 && !clearCredential &&
      savedDraft !== undefined && sameDraft(draft, savedDraft)
    const validation = validate(draft, {
      hasCredential: connection?.credentialState === 'present',
      apiKey,
      clearCredential,
      endpointChanged: savedDraft !== undefined && savedDraft.endpoint !== draft.endpoint,
      requireKey: adapterRequiresCredential(draft.adapterType) && !storedPossible,
    })
    if (validation !== undefined) { setNotice({ kind: 'error', text: validation }); return }
    const request = begin('testing')
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; request.controller.abort() }, 15_000)
    try {
      const result = storedPossible && connection !== undefined
        ? await testStoredToolConnection(client, connection.connectionId, request.controller.signal)
        : await testDraftToolConnection(client, { descriptor, ...(apiKey.length === 0 ? {} : { apiKey }) }, request.controller.signal)
      if (!request.current()) return
      setPhase('idle')
      setTestResult(result)
    } catch (error) {
      if (!request.currentEvenIfAborted()) return
      setPhase('idle')
      setTestResult(undefined)
      setNotice({ kind: 'error', text: failureText(error, timedOut) })
    } finally {
      window.clearTimeout(timeout)
      request.clear()
    }
  }

  const title = mode === 'create' ? '新增工具连接' : mode === 'copy' ? '复制工具连接' : '编辑工具连接'
  const description = mode === 'copy'
    ? '只复制非敏感字段：新 ID、默认停用、不复制凭据、范围或分配。'
    : '工具连接与模型连接是不同实体；搜索服务只能提供公共网页搜索能力。保存不会自动设为默认。'

  if (mode === 'copy') {
    return <Panel title={title} description={description} actions={<Button variant="quiet" onClick={onCancel} data-testid="tool-connection-editor-cancel">取消</Button>}>
      <form onSubmit={(event) => void save(event)} data-testid="tool-connection-copy-form">
        {notice === undefined ? null : <p role="alert" data-testid="tool-connection-editor-notice">{notice.text}</p>}
        <Field label="副本名称 *">{() => <input type="text" value={draft.name} disabled={readOnly || busy} onChange={(event) => { setDraft((previous) => ({ ...previous, name: event.currentTarget.value })); setNotice(undefined) }} />}</Field>
        <p>源连接：{connection?.name}。副本默认停用，不含密钥，也不继承任何分配。</p>
        <div className="model-settings__actions">
          <Button type="submit" variant="primary" disabled={readOnly || busy} data-testid="tool-connection-copy-submit">{busy ? '正在复制…' : '创建副本'}</Button>
          <Button type="button" variant="quiet" onClick={onCancel}>取消</Button>
        </div>
      </form>
    </Panel>
  }

  return <Panel title={title} description={description} actions={<Button variant="quiet" onClick={onCancel} data-testid="tool-connection-editor-cancel">取消</Button>}>
    {notice === undefined ? null : <p role="alert" data-testid="tool-connection-editor-notice">{notice.text}</p>}
    {testResult === undefined ? null : <ToolProbeResultView result={testResult} testId="tool-connection-editor-test-result" />}

    <form onSubmit={(event) => void save(event)} data-testid="tool-connection-editor-form">
      <fieldset disabled={readOnly || busy} className="model-settings__fields">
        <legend>连接与能力</legend>
        <Field label="连接名称 *" hint="用于在分配与生效详情中区分此连接。">
          {(attributes) => <input {...attributes} type="text" value={draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} />}
        </Field>
        <Field label="适配类型" hint="原生 Tavily 可直接用；兼容网关用于保留旧部署。">
          {(attributes) => <select {...attributes} value={draft.adapterType} onChange={(event) => {
            const adapterType = event.currentTarget.value
            if (adapterType === 'native_tavily' || adapterType === 'http_compat') {
              patch({ adapterType, capabilities: ['web_search'] })
            }
          }}>
            <option value="native_tavily">原生 Tavily 搜索</option>
            <option value="http_compat">兼容 HTTP 网关</option>
          </select>}
        </Field>
        <fieldset className="model-settings__group"><legend>能力 *</legend>
          <span className="model-settings__checks"><label>
            <input type="checkbox" checked={draft.capabilities.includes('web_search')} disabled
              onChange={() => undefined} />{TOOL_CAPABILITY_LABELS.web_search}
          </label></span>
          <p className="model-settings__hint">首期两个适配器都只提供公共网页搜索能力；它属于工具能力，不是生成模型能力。</p>
        </fieldset>
        <Field label="启用" hint="新建默认停用。启用表示可用于分配与执行。">
          {(attributes) => <input {...attributes} type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />}
        </Field>
        <Field label="服务地址" hint="兼容网关必填；可含路径，例如 https://gateway.example.com/search。">
          {(attributes) => <input {...attributes} type="url" autoComplete="url" value={draft.endpoint} onChange={(event) => patch({ endpoint: event.currentTarget.value })} />}
        </Field>
        <Field label="API Key" hint={connection?.credentialState === 'present'
          ? '留空保留现有密钥；更换服务地址时必须重新填写。保存后输入框会清空，读取不会返回密钥。'
          : '原生 Tavily 需要；兼容网关可留空。保存后输入框会清空，读取不会返回密钥。'}>
          {(attributes) => <input {...attributes} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.currentTarget.value); setClearCredential(false); setNotice(undefined); setTestResult(undefined) }} />}
        </Field>
        {mode === 'edit' && connection?.credentialState === 'present' ? <Field label="清除凭据" hint="清除后后续调用被阻断；启用中的连接不能直接清除，请先停用。">
          {(attributes) => <input {...attributes} type="checkbox" checked={clearCredential} onChange={(event) => {
            const next = event.currentTarget.checked
            setClearCredential(next)
            setApiKey(next ? '' : apiKey)
            setNotice(undefined)
            setTestResult(undefined)
          }} />}
        </Field> : null}
      </fieldset>

      <p>“测试连接”会分别发送一次小额真实搜索查询和一次获准测试页的归档读取，可能计费；草稿可测试并标注为未保存草稿。页面不显示 API Key 或服务端响应正文。</p>
      {readOnly ? <p role="status">当前为只读访问，不能保存连接或发送工具测试。</p> : (
        <div className="model-settings__actions">
          <Button type="submit" variant="primary" disabled={busy} data-testid="tool-connection-editor-save">{phase === 'saving' ? '正在保存…' : '保存连接'}</Button>
          <Button type="button" disabled={busy} onClick={() => void test()} data-testid="tool-connection-editor-test">{phase === 'testing' ? '正在测试…' : '测试连接'}</Button>
          <Button type="button" variant="quiet" onClick={onCancel}>取消</Button>
          {dirty ? <span role="status">有未保存的修改</span> : null}
        </div>
      )}
    </form>
  </Panel>
}
