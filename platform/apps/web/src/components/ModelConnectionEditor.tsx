import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type {
  ModelAdapterType,
  ModelCapability,
  ModelConnectionAdminView,
  ModelConnectionDescriptor,
  ModelConnectionTestResult,
  ModelProtocol,
} from '../api/model-connections'
import {
  copyModelConnection,
  createModelConnection,
  modelAdapterSupportsCapability,
  testDraftConnection,
  testStoredConnection,
  updateModelConnection,
} from '../api/model-connections'
import { Button, Field, Panel, StateFeedback } from './ui'
import { ADAPTER_LABELS, CAPABILITY_LABELS, PROTOCOL_LABELS, TEST_REASON_LABELS } from './model-settings-labels'

export type ModelConnectionEditorMode = 'create' | 'edit' | 'copy'

interface Draft {
  readonly name: string
  readonly adapterType: ModelAdapterType
  readonly protocol: ModelProtocol
  readonly capabilities: readonly ModelCapability[]
  readonly enabled: boolean
  readonly baseUrl: string
  readonly endpoint: string
  readonly platformModelId: string
  readonly providerModelName: string
}

type Phase = 'idle' | 'saving' | 'testing'

export interface ModelConnectionEditorProps {
  readonly client: WorkbenchClient
  readonly mode: ModelConnectionEditorMode
  readonly connection?: ModelConnectionAdminView
  readonly onSaved: (view: ModelConnectionAdminView) => void
  readonly onCancel: () => void
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly readOnly?: boolean
}

function defaultDraft(): Draft {
  return {
    name: '',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation'],
    enabled: false,
    baseUrl: '',
    endpoint: '',
    platformModelId: '',
    providerModelName: '',
  }
}

function draftFromConnection(view: ModelConnectionAdminView, mode: ModelConnectionEditorMode): Draft {
  return {
    name: mode === 'copy' ? `${view.name} 副本` : view.name,
    adapterType: view.adapterType,
    protocol: view.protocol,
    capabilities: [...view.capabilities],
    enabled: mode === 'edit' ? view.enabled : false,
    baseUrl: view.baseUrl ?? '',
    endpoint: view.endpoint ?? '',
    platformModelId: view.platformModelId,
    providerModelName: view.providerModelName,
  }
}

function sameDraft(left: Draft, right: Draft): boolean {
  return left.name === right.name && left.adapterType === right.adapterType && left.protocol === right.protocol &&
    left.enabled === right.enabled && left.baseUrl === right.baseUrl && left.endpoint === right.endpoint &&
    left.platformModelId === right.platformModelId && left.providerModelName === right.providerModelName &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability) => right.capabilities.includes(capability))
}

function sameServiceOrigin(left: string, right: string): boolean {
  try {
    return new URL(left.trim()).origin === new URL(right.trim()).origin
  } catch {
    return false
  }
}

function applyAdapterConstraint(draft: Draft, adapterType: ModelAdapterType): Draft {
  if (adapterType === 'jev') {
    return { ...draft, adapterType, protocol: 'jev', capabilities: ['decision_jev'] }
  }
  const allowed: readonly ModelProtocol[] = ['openai_compatible', 'private']
  const capabilities = draft.capabilities.filter((capability) => capability !== 'decision_jev')
  return {
    ...draft,
    adapterType,
    protocol: allowed.includes(draft.protocol) ? draft.protocol : 'openai_compatible',
    capabilities: capabilities.length === 0 ? ['generation'] : capabilities,
  }
}

function descriptorOf(draft: Draft): ModelConnectionDescriptor {
  return {
    name: draft.name.trim(),
    adapterType: draft.adapterType,
    protocol: draft.protocol,
    capabilities: [...draft.capabilities],
    enabled: draft.enabled,
    platformModelId: draft.platformModelId.trim(),
    providerModelName: draft.providerModelName.trim(),
    ...(draft.baseUrl.trim().length === 0 ? {} : { baseUrl: draft.baseUrl.trim() }),
    ...(draft.endpoint.trim().length === 0 ? {} : { endpoint: draft.endpoint.trim() }),
  }
}

function validate(draft: Draft, options: {
  readonly mode: ModelConnectionEditorMode
  readonly hasCredential: boolean
  readonly apiKey: string
  readonly clearCredential: boolean
  readonly savedBaseUrl: string
  readonly requireKey: boolean
}): string | undefined {
  if (draft.name.trim().length === 0) return '请填写连接名称。'
  if (draft.capabilities.length === 0) return '请至少为该连接指定一项能力。'
  if (!draft.capabilities.every((capability) => modelAdapterSupportsCapability(draft.adapterType, capability))) {
    return '所选的适配类型不支持其中的能力，请调整能力或适配类型。'
  }
  if (draft.platformModelId.trim().length === 0) return '请填写 Core 平台模型 ID。'
  if (draft.providerModelName.trim().length === 0) return '请填写服务商模型名称。'
  if (draft.adapterType === 'company_generation') {
    if (draft.baseUrl.trim().length > 0) {
      try {
        const url = new URL(draft.baseUrl.trim())
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '模型服务地址须使用 HTTP 或 HTTPS。'
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '服务地址只填写域名和端口；路径请填写到 API 端点中。'
      } catch {
        return '请填写完整的模型服务地址，例如 https://gateway.example.com。'
      }
    }
    if (draft.endpoint.trim().length > 0 && (!draft.endpoint.startsWith('/') || draft.endpoint.startsWith('//') || /[?#\\]/u.test(draft.endpoint))) {
      return 'API 端点须以单个 / 开头，且不能包含查询参数或片段。'
    }
    if (draft.enabled && draft.baseUrl.trim().length === 0) return '启用模型前，请填写模型服务地址。'
    if (draft.enabled && draft.endpoint.trim().length === 0) return '启用模型前，请填写 API 端点。'
  }
  if (!draft.enabled && !options.requireKey) return undefined

  const keyProvided = options.apiKey.length > 0
  const keepStored = options.hasCredential && !options.clearCredential && sameServiceOrigin(options.savedBaseUrl, draft.baseUrl)
  if (options.clearCredential && draft.enabled) {
    return '启用中的连接不能清除凭据；请先停用，或改为填写新凭据。'
  }
  if (!keyProvided && !keepStored) {
    return '启用模型并测试连接需要 API Key；请填写服务商提供的密钥，或明确清除旧密钥。'
  }
  return undefined
}

function failureText(error: unknown, timedOut: boolean): string {
  if (timedOut) return '连接测试超过等待时间，未收到可用结果。请检查地址和端点后重试。'
  if (error instanceof ApiError) {
    if (error.status === 403) return '当前账户没有管理模型连接的权限。'
    if (error.code === 'MODEL_IN_USE') return '该连接仍被分配引用，请先在“默认与分配”中解绑后再删除。'
    if (error.code === 'MODEL_CAPABILITY_MISMATCH') return error.message
    if (error.code === 'VERSION_CONFLICT' || error.status === 409) return '连接已被其他窗口更新。请返回目录重新读取后再编辑，当前非密钥输入仍保留。'
    if (error.code === 'MALFORMED_RESPONSE') return 'Core 返回的连接数据无法识别。当前输入仍保留。'
    if (error.status === 400) return error.message
  }
  return '操作未完成。请检查 Core 服务后重试；服务端响应正文不会显示。'
}

export function ModelConnectionEditor({ client, mode, connection, onSaved, onCancel, onDirtyChange, readOnly = false }: ModelConnectionEditorProps) {
  const live = useRef(true)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [draft, setDraft] = useState<Draft>(() => (mode === 'create' || connection === undefined ? defaultDraft() : draftFromConnection(connection, mode)))
  const [apiKey, setApiKey] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<{ readonly kind: 'error' | 'saved'; readonly text: string } | undefined>(undefined)
  const [testResult, setTestResult] = useState<ModelConnectionTestResult | undefined>(undefined)
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
    return <Panel title="模型连接" description="编辑模型连接。">
      <StateFeedback title="连接不可用" description="未选择要编辑的连接。请返回连接目录后重试。" tone="error" action={<Button onClick={onCancel}>返回连接目录</Button>} />
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
        const saved = await copyModelConnection(client, connection?.connectionId ?? '', { name: draft.name.trim(), idempotencyKey: client.newRequestKey() }, request.controller.signal)
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
      mode,
      hasCredential: connection?.credentialState === 'present',
      apiKey,
      clearCredential,
      savedBaseUrl: connection?.baseUrl ?? '',
      requireKey: false,
    })
    if (validation !== undefined) { setNotice({ kind: 'error', text: validation }); return }
    const descriptor = descriptorOf(draft)
    const request = begin()
    try {
      const saved = mode === 'edit' && connection !== undefined
        ? await updateModelConnection(client, connection.connectionId, {
            descriptor,
            expectedRevision: connection.revision,
            ...(apiKey.length === 0 ? {} : { apiKey }),
            ...(clearCredential ? { clearCredential: true } : {}),
            idempotencyKey: client.newRequestKey(),
          }, request.controller.signal)
        : await createModelConnection(client, {
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
    const storedPossible = mode === 'edit' && connection !== undefined && connection.credentialState === 'present' &&
      apiKey.length === 0 && !clearCredential && savedDraft !== undefined && sameDraft(draft, savedDraft)
    const validation = validate(draft, {
      mode,
      hasCredential: connection?.credentialState === 'present',
      apiKey,
      clearCredential,
      savedBaseUrl: connection?.baseUrl ?? '',
      requireKey: !storedPossible,
    })
    if (validation !== undefined) { setNotice({ kind: 'error', text: validation }); return }
    const request = begin('testing')
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; request.controller.abort() }, 10_000)
    try {
      const result = storedPossible && connection !== undefined
        ? await testStoredConnection(client, connection.connectionId, request.controller.signal)
        : await testDraftConnection(client, { descriptor, ...(apiKey.length === 0 ? {} : { apiKey }) }, request.controller.signal)
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

  const title = mode === 'create' ? '新增模型连接' : mode === 'copy' ? '复制模型连接' : '编辑模型连接'
  const description = mode === 'copy'
    ? '只复制非敏感字段：新 ID、默认停用、不复制凭据、范围或分配。'
    : '适配类型与协议分开；能力由适配类型决定。保存不会自动设为默认。'

  if (mode === 'copy') {
    return <Panel title={title} description={description} actions={<Button variant="quiet" onClick={onCancel} data-testid="connection-editor-cancel">取消</Button>}>
      <form onSubmit={(event) => void save(event)} data-testid="connection-copy-form">
        {notice === undefined ? null : <p role="alert" data-testid="connection-editor-notice">{notice.text}</p>}
        <Field label="副本名称 *">{() => <input type="text" value={draft.name} disabled={readOnly || busy} onChange={(event) => { setDraft((previous) => ({ ...previous, name: event.currentTarget.value })); setNotice(undefined) }} />}</Field>
        <p>源连接：{connection?.name}（{ADAPTER_LABELS[connection?.adapterType ?? 'company_generation']} · {PROTOCOL_LABELS[connection?.protocol ?? 'openai_compatible']}）。副本默认停用，不含密钥。</p>
        <div className="model-settings__actions">
          <Button type="submit" variant="primary" disabled={readOnly || busy} data-testid="connection-copy-submit">{busy ? '正在复制…' : '创建副本'}</Button>
          <Button type="button" variant="quiet" onClick={onCancel}>取消</Button>
        </div>
      </form>
    </Panel>
  }

  const capabilityOptions: readonly ModelCapability[] = draft.adapterType === 'jev' ? ['decision_jev'] : ['generation', 'research']
  return <Panel title={title} description={description} actions={<Button variant="quiet" onClick={onCancel} data-testid="connection-editor-cancel">取消</Button>}>
    {notice === undefined ? null : <p role="alert" data-testid="connection-editor-notice">{notice.text}</p>}
    {testResult === undefined ? null : <p role="status" data-testid="connection-editor-test-result" data-status={testResult.status} data-draft={testResult.draft}>
      {testResult.status === 'passed'
        ? `连接测试通过${testResult.draft ? '（未保存草稿）' : ''}${testResult.latencyMs === undefined ? '' : ` · ${testResult.latencyMs}ms`}；此结果只表示通信可达。`
        : `连接测试未通过${testResult.reason === undefined ? '' : `：${TEST_REASON_LABELS[testResult.reason]}`}。`}
      {testResult.credentialConfigured ? '' : ' 未使用凭据。'}
    </p>}

    <form onSubmit={(event) => void save(event)} data-testid="connection-editor-form">
      <fieldset disabled={readOnly || busy} className="model-settings__fields">
        <legend>连接与模型</legend>
        <Field label="连接名称 *" hint="用于在其他模型中区分此连接。">
          {(attributes) => <input {...attributes} type="text" value={draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} />}
        </Field>
        <Field label="适配类型" hint="由部署注册的适配器决定；生成与研究共用生成适配器，决策 JEV 使用独立适配器。">
          {(attributes) => <select {...attributes} value={draft.adapterType} onChange={(event) => {
            const adapterType = event.currentTarget.value
            if (adapterType === 'company_generation' || adapterType === 'jev') patch(applyAdapterConstraint(draft, adapterType))
          }}>
            <option value="company_generation">公司生成适配器</option>
            <option value="jev">JEV 适配器</option>
          </select>}
        </Field>
        <Field label="协议" hint="与适配类型分开；生成适配器可用 OpenAI 兼容或私有协议，JEV 使用其自身协议。">
          {(attributes) => <select {...attributes} value={draft.protocol} disabled={draft.adapterType === 'jev'} onChange={(event) => {
            const protocol = event.currentTarget.value
            if (protocol === 'openai_compatible' || protocol === 'private') patch({ protocol })
          }}>
            {draft.adapterType === 'jev'
              ? <option value="jev">JEV 协议</option>
              : <><option value="openai_compatible">OpenAI 兼容</option><option value="private">私有协议</option></>}
          </select>}
        </Field>
        <fieldset className="model-settings__group"><legend>能力 *</legend>
          <span className="model-settings__checks">{capabilityOptions.map((capability) =>
            <label key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={draft.adapterType === 'jev'}
              onChange={(event) => {
                const next = event.currentTarget.checked
                  ? [...draft.capabilities, capability]
                  : draft.capabilities.filter((entry) => entry !== capability)
                patch({ capabilities: next })
              }} />{CAPABILITY_LABELS[capability]}</label>)}</span>
          <p className="model-settings__hint">由适配类型决定，不能任意勾选；JEV 适配器只服务决策能力。</p>
        </fieldset>
        <Field label="启用" hint="新建默认停用。启用表示可用于分配与执行。">
          {(attributes) => <input {...attributes} type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />}
        </Field>
        {draft.adapterType !== 'company_generation' ? null : <>
          <Field label="模型服务地址" hint="只填域名和端口，例如 https://gateway.example.com；不要把 /v1 放在这里。">
            {(attributes) => <input {...attributes} type="url" autoComplete="url" value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.currentTarget.value })} />}
          </Field>
          <Field label="API 端点" hint="相对服务地址的路径；OpenAI 兼容服务通常使用 /v1/chat/completions。">
            {(attributes) => <input {...attributes} type="text" value={draft.endpoint} onChange={(event) => patch({ endpoint: event.currentTarget.value })} />}
          </Field>
        </>}
        <Field label="Core 平台模型 ID *" hint="Core 内的稳定标识，用于区分不同配置。">
          {(attributes) => <input {...attributes} type="text" value={draft.platformModelId} onChange={(event) => patch({ platformModelId: event.currentTarget.value })} />}
        </Field>
        <Field label="服务商模型名称 *" hint="服务商侧要求的模型名称；与 Core 平台模型 ID 是不同标识。">
          {(attributes) => <input {...attributes} type="text" value={draft.providerModelName} onChange={(event) => patch({ providerModelName: event.currentTarget.value })} />}
        </Field>
        <Field label="API Key" hint={connection?.credentialState === 'present'
          ? '留空保留现有密钥；更换服务地址时必须重新填写。保存后输入框会清空，读取不会返回密钥。'
          : '新增连接时填写；保存后输入框会清空，读取不会返回密钥。'}>
          {(attributes) => <input {...attributes} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.currentTarget.value); setClearCredential(false); setNotice(undefined) }} />}
        </Field>
        {mode === 'edit' && connection?.credentialState === 'present' ? <Field label="清除凭据" hint="清除后后续调用被阻断；启用中的连接不能直接清除，请先停用。">
          {(attributes) => <input {...attributes} type="checkbox" checked={clearCredential} onChange={(event) => {
            const next = event.currentTarget.checked
            setClearCredential(next)
            setApiKey(next ? '' : apiKey)
            setNotice(undefined)
          }} />}
        </Field> : null}
      </fieldset>

      <p>“测试连接”会发送少量真实协议请求，可能计费；草稿可测试并标注为未保存草稿。页面不显示 API Key 或服务端响应正文。</p>
      {readOnly ? <p role="status">当前为只读访问，不能保存连接或发送连接测试。</p> : (
        <div className="model-settings__actions">
          <Button type="submit" variant="primary" disabled={busy} data-testid="connection-editor-save">{phase === 'saving' ? '正在保存…' : '保存连接'}</Button>
          <Button type="button" disabled={busy} onClick={() => void test()} data-testid="connection-editor-test">{phase === 'testing' ? '正在测试…' : '测试连接'}</Button>
          <Button type="button" variant="quiet" onClick={onCancel}>取消</Button>
          {dirty ? <span role="status">有未保存的修改</span> : null}
        </div>
      )}
    </form>
  </Panel>
}
