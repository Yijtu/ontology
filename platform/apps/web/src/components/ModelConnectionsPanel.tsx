import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type { ModelConnectionAdminView, ModelConnectionSelection, ModelTargetScope } from '../api/model-connections'
import {
  deleteModelConnection,
  readModelAssignments,
  readModelConnections,
  testStoredConnection,
} from '../api/model-connections'
import { Button, DataTable, Panel, StateFeedback, StatusBadge } from './ui'
import { ADAPTER_LABELS, CAPABILITY_LABELS, CREDENTIAL_LABELS, PROTOCOL_LABELS, TEST_REASON_LABELS } from './model-settings-labels'
import { ModelConnectionEditor } from './ModelConnectionEditor'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'
type View = { readonly kind: 'list' } | { readonly kind: 'editor'; readonly mode: 'create' | 'edit' | 'copy'; readonly connection?: ModelConnectionAdminView }

export interface ModelConnectionsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly scope?: ModelTargetScope
  readonly onDirtyChange?: (dirty: boolean) => void
}

function scopeNoun(scope: ModelTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return '空间'
    case 'industry_workspace':
      return '工作区'
    case 'project':
      return '项目'
  }
}

/** Derive a best-effort reference label for each connection from the assignment sets we can read. */
function usageOf(selection: ModelConnectionSelection, scope: ModelTargetScope, capability?: string): string | undefined {
  if (selection.kind !== 'connection') return undefined
  return capability === undefined ? `${scopeNoun(scope)}默认` : `${scopeNoun(scope)}能力：${capability}`
}

export function ModelConnectionsPanel({ client, readOnly = false, scope, onDirtyChange }: ModelConnectionsPanelProps) {
  const live = useRef(true)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [connections, setConnections] = useState<readonly ModelConnectionAdminView[]>([])
  const [usage, setUsage] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [view, setView] = useState<View>({ kind: 'list' })
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)

  useEffect(() => () => { live.current = false; activeController.current?.abort() }, [])

  const load = useCallback(async () => {
    setPhase('loading')
    setNotice(undefined)
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    try {
      const list = await readModelConnections(client, {}, controller.signal)
      if (!live.current || activeController.current !== controller) return
      setConnections(list)
      setPhase('ready')
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      setConnections([])
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
    // Reference labels are a best-effort extra; a viewer without read access to assignments still
    // sees the catalogue without a fabricated reference count.
    try {
      const scopes: ModelTargetScope[] = [{ kind: 'space' }, ...(scope === undefined || scope.kind === 'space' ? [] : [scope])]
      const found: Record<string, string[]> = {}
      for (const target of scopes) {
        const set = await readModelAssignments(client, target, controller.signal).catch(() => undefined)
        if (set === undefined) continue
        const defaultLabel = usageOf(set.defaultSelection, set.scope)
        if (defaultLabel !== undefined && set.defaultSelection.kind === 'connection') {
          const id = set.defaultSelection.connectionId
          found[id] = [...(found[id] ?? []), defaultLabel]
        }
        for (const entry of set.capabilitySelections) {
          const label = usageOf(entry.selection, set.scope, CAPABILITY_LABELS[entry.capability])
          if (label !== undefined && entry.selection.kind === 'connection') {
            const id = entry.selection.connectionId
            found[id] = [...(found[id] ?? []), label]
          }
        }
      }
      if (live.current && activeController.current === controller) setUsage(found)
    } catch { /* usage labels are optional */ }
  }, [client, scope])

  useEffect(() => { void load() }, [load])

  const test = async (connection: ModelConnectionAdminView) => {
    if (readOnly || busyId !== undefined) return
    setBusyId(connection.connectionId)
    setNotice(undefined)
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    try {
      const result = await testStoredConnection(client, connection.connectionId, controller.signal)
      if (!live.current || activeController.current !== controller) return
      setNotice(result.status === 'passed'
        ? `连接“${connection.name}”测试通过${result.latencyMs === undefined ? '' : ` · ${result.latencyMs}ms`}；此结果只表示通信可达。`
        : `连接“${connection.name}”测试未通过${result.reason === undefined ? '' : `：${TEST_REASON_LABELS[result.reason]}`}。`)
      setConnections((previous) => previous.map((entry) => entry.connectionId !== connection.connectionId ? entry : {
        ...entry,
        testSummary: { revision: connection.revision, status: result.status, testedAt: result.testedAt, ...(result.reason === undefined ? {} : { reason: result.reason }) },
      }))
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      setNotice(error instanceof ApiError && error.status === 403 ? '当前账户没有测试模型的权限。' : '连接测试未完成；响应正文不会显示。')
    } finally {
      if (live.current) setBusyId(undefined)
    }
  }

  const remove = async (connection: ModelConnectionAdminView) => {
    if (readOnly || busyId !== undefined) return
    setBusyId(connection.connectionId)
    setNotice(undefined)
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    try {
      await deleteModelConnection(client, connection.connectionId, controller.signal)
      if (!live.current || activeController.current !== controller) return
      setConnections((previous) => previous.filter((entry) => entry.connectionId !== connection.connectionId))
      setNotice(`连接“${connection.name}”已删除。`)
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      if (error instanceof ApiError && error.code === 'MODEL_IN_USE') {
        setNotice(`连接“${connection.name}”仍被分配引用，请先在“默认与分配”中解绑后再删除。`)
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice('当前账户没有删除模型连接的权限。')
      } else {
        setNotice('删除未完成；请检查 Core 服务后重试。')
      }
    } finally {
      if (live.current) setBusyId(undefined)
    }
  }

  const editorKey = useMemo(() => view.kind === 'editor'
    ? `${view.mode}:${view.connection?.connectionId ?? 'new'}@${view.connection?.revision ?? ''}`
    : 'list', [view])

  if (view.kind === 'editor') {
    return <ModelConnectionEditor
      key={editorKey}
      client={client}
      mode={view.mode}
      {...(view.connection === undefined ? {} : { connection: view.connection })}
      readOnly={readOnly}
      {...(onDirtyChange === undefined ? {} : { onDirtyChange })}
      onCancel={() => { setView({ kind: 'list' }); void load() }}
      onSaved={(saved) => { setView({ kind: 'list' }); setNotice(`连接“${saved.name}”已保存。`); void load() }}
    />
  }

  if (phase === 'loading') {
    return <Panel title="模型连接" description="空间内的模型连接目录。">
      <StateFeedback title="正在读取模型连接" description="正在从当前 Core 实例读取连接目录。" tone="loading" />
    </Panel>
  }

  if (phase === 'forbidden') {
    return <Panel title="模型连接" description="空间内的模型连接目录。">
      <StateFeedback title="无法查看模型连接" description="管理模型连接需要本机平台管理员权限。当前账户看不到连接名称、数量或是否存在。" tone="error"
        action={<Button onClick={() => void load()}>重新读取</Button>} />
    </Panel>
  }

  if (phase === 'error') {
    return <Panel title="模型连接" description="空间内的模型连接目录。">
      <StateFeedback title="暂时无法读取模型连接" description="请检查本机 Core 服务后重试。" tone="error"
        action={<Button onClick={() => void load()}>重新读取</Button>} />
    </Panel>
  }

  return <Panel title="模型连接" description="空间内的模型连接目录。连接保存不会自动设为默认；复制不带密钥、默认停用。"
    actions={readOnly ? undefined : <Button variant="primary" onClick={() => setView({ kind: 'editor', mode: 'create' })} data-testid="connection-create">新增连接</Button>}>
    {notice === undefined ? null : <p role="status" data-testid="connections-notice">{notice}</p>}
    {connections.length === 0
      ? <StateFeedback title="尚未配置模型连接" description="可以保存一个未完成的停用连接；未配置模型时非模型路径仍可用。" tone="empty" />
      : <DataTable caption="模型连接目录">
        <thead><tr><th scope="col">名称</th><th scope="col">适配类型 / 协议</th><th scope="col">服务商模型名</th><th scope="col">能力</th><th scope="col">启用</th><th scope="col">凭据</th><th scope="col">最近测试</th><th scope="col">引用情况</th><th scope="col">操作</th></tr></thead>
        <tbody>
          {connections.map((connection) => {
            const references = usage[connection.connectionId] ?? []
            const testSummary = connection.testSummary
            return <tr key={connection.connectionId} data-testid="connection-row" data-connection-id={connection.connectionId}>
              <td>{connection.name}<br /><small>修订 {connection.revision}</small></td>
              <td>{ADAPTER_LABELS[connection.adapterType]}<br /><small>{PROTOCOL_LABELS[connection.protocol]}</small></td>
              <td>{connection.providerModelName}</td>
              <td>{connection.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join('、')}</td>
              <td><StatusBadge tone={connection.enabled ? 'success' : 'neutral'}>{connection.enabled ? '已启用' : '已停用'}</StatusBadge></td>
              <td><StatusBadge tone={connection.credentialState === 'present' ? 'success' : 'warning'}>{CREDENTIAL_LABELS[connection.credentialState]}</StatusBadge></td>
              <td>{testSummary === undefined ? '未测试' : <>{testSummary.status === 'passed' ? '通过' : '未通过'}<br /><small>{testSummary.testedAt} · 修订 {testSummary.revision}{testSummary.reason === undefined ? '' : ` · ${TEST_REASON_LABELS[testSummary.reason]}`}</small></>}</td>
              <td>{references.length === 0 ? '未发现引用' : references.join('、')}</td>
              <td className="model-settings__row-actions">
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => setView({ kind: 'editor', mode: 'edit', connection })} data-testid="connection-edit">编辑</Button>
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => setView({ kind: 'editor', mode: 'copy', connection })} data-testid="connection-copy">复制</Button>
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => void test(connection)} data-testid="connection-test">{busyId === connection.connectionId ? '处理中…' : '测试'}</Button>
                <Button variant="danger" disabled={readOnly || busyId !== undefined} onClick={() => void remove(connection)} data-testid="connection-delete">删除</Button>
              </td>
            </tr>
          })}
        </tbody>
      </DataTable>}
  </Panel>
}
