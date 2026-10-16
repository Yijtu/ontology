import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type {
  ToolConnectionAdminView,
  ToolConnectionProbeResult,
  ToolConnectionSelection,
  ToolTargetScope,
} from '../api/tool-connections'
import {
  deleteToolConnection,
  readToolAssignments,
  readToolConnections,
  testStoredToolConnection,
} from '../api/tool-connections'
import { Button, DataTable, Panel, StateFeedback, StatusBadge } from './ui'
import { TOOL_ADAPTER_LABELS, TOOL_CAPABILITY_LABELS, TOOL_CREDENTIAL_LABELS } from './tool-settings-labels'
import { ToolProbeItemView } from './ToolProbeResultView'
import { ToolConnectionEditor } from './ToolConnectionEditor'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'
type View = { readonly kind: 'list' } | { readonly kind: 'editor'; readonly mode: 'create' | 'edit' | 'copy'; readonly connection?: ToolConnectionAdminView }

export interface ToolConnectionsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly scope?: ToolTargetScope
  readonly onViewEffective?: () => void
  readonly onDirtyChange?: (dirty: boolean) => void
}

function scopeNoun(scope: ToolTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return '空间'
    case 'industry_workspace':
      return '工作区'
    case 'project':
      return '项目'
  }
}

function usageOf(selection: ToolConnectionSelection, scope: ToolTargetScope, toolId?: string): string | undefined {
  if (selection.kind !== 'connection') return undefined
  return toolId === undefined ? `${scopeNoun(scope)}默认` : `${scopeNoun(scope)}工具：${toolId}`
}

export function ToolConnectionsPanel({ client, readOnly = false, scope, onViewEffective, onDirtyChange }: ToolConnectionsPanelProps) {
  const live = useRef(true)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [connections, setConnections] = useState<readonly ToolConnectionAdminView[]>([])
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
      const list = await readToolConnections(client, {}, controller.signal)
      if (!live.current || activeController.current !== controller) return
      setConnections(list)
      setPhase('ready')
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      setConnections([])
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
    // Reference labels are a best-effort extra; a viewer without assignment access still sees the
    // catalogue without a fabricated reference count.
    try {
      const scopes: ToolTargetScope[] = [{ kind: 'space' }, ...(scope === undefined || scope.kind === 'space' ? [] : [scope])]
      const found: Record<string, string[]> = {}
      for (const target of scopes) {
        const set = await readToolAssignments(client, target, controller.signal).catch(() => undefined)
        if (set === undefined) continue
        if (set.defaultSelection.kind === 'connection') {
          const id = set.defaultSelection.connectionId
          const label = usageOf(set.defaultSelection, set.scope)
          if (label !== undefined) found[id] = [...(found[id] ?? []), label]
        }
        for (const entry of set.toolSelections) {
          if (entry.selection.kind !== 'connection') continue
          const id = entry.selection.connectionId
          const label = usageOf(entry.selection, set.scope, TOOL_CAPABILITY_LABELS[entry.toolId])
          if (label !== undefined) found[id] = [...(found[id] ?? []), label]
        }
      }
      if (live.current && activeController.current === controller) setUsage(found)
    } catch { /* usage labels are optional */ }
  }, [client, scope])

  useEffect(() => { void load() }, [load])

  const test = async (connection: ToolConnectionAdminView) => {
    if (readOnly || busyId !== undefined) return
    setBusyId(connection.connectionId)
    setNotice(undefined)
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    try {
      const result = await testStoredToolConnection(client, connection.connectionId, controller.signal)
      if (!live.current || activeController.current !== controller) return
      const search = result.search.status === 'passed' ? '通过' : '未通过'
      const archive = result.archive.status === 'passed' ? '通过' : result.archive.status === 'skipped' ? '已跳过' : '未通过'
      setNotice(`连接“${connection.name}”测试完成：搜索测试 ${search}，页面归档测试 ${archive}。两项分开判断，搜索可达不代表页面可归档。`)
      setConnections((previous) => previous.map((entry) => entry.connectionId !== connection.connectionId ? entry : { ...entry, probeSummary: result }))
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      setNotice(error instanceof ApiError && error.status === 403
        ? '当前账户没有测试工具连接的权限。'
        : '工具连接测试未完成；响应正文不会显示。')
    } finally {
      if (live.current) setBusyId(undefined)
    }
  }

  const remove = async (connection: ToolConnectionAdminView) => {
    if (readOnly || busyId !== undefined) return
    setBusyId(connection.connectionId)
    setNotice(undefined)
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    try {
      await deleteToolConnection(client, connection.connectionId, controller.signal)
      if (!live.current || activeController.current !== controller) return
      setConnections((previous) => previous.filter((entry) => entry.connectionId !== connection.connectionId))
      setNotice(`连接“${connection.name}”已删除。`)
    } catch (error) {
      if (!live.current || activeController.current !== controller) return
      if (error instanceof ApiError && error.code === 'TOOL_IN_USE') {
        setNotice(`连接“${connection.name}”仍被分配引用，请先在“默认与分配”中解绑后再删除。`)
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice('当前账户没有删除工具连接的权限。')
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
    return <ToolConnectionEditor
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
    return <Panel title="公共网页搜索" description="空间内的工具连接目录。">
      <StateFeedback title="正在读取工具连接" description="正在从当前 Core 实例读取工具连接目录。" tone="loading" />
    </Panel>
  }

  if (phase === 'forbidden') {
    return <Panel title="公共网页搜索" description="空间内的工具连接目录。">
      <StateFeedback title="无法查看工具连接" description="管理工具连接需要本机平台管理员权限。当前账户看不到连接名称、数量或是否存在。" tone="error"
        action={<Button onClick={() => void load()}>重新读取</Button>} />
    </Panel>
  }

  if (phase === 'error') {
    return <Panel title="公共网页搜索" description="空间内的工具连接目录。">
      <StateFeedback title="暂时无法读取工具连接" description="当前部署可能未接入工具连接目录。请检查本机 Core 服务后重试。" tone="error"
        action={<Button onClick={() => void load()}>重新读取</Button>} />
    </Panel>
  }

  return <Panel title="公共网页搜索" description="公共网页搜索是一项工具能力；连接保存不会自动设为默认；复制不带密钥、默认停用。"
    actions={<>
      {onViewEffective === undefined ? null : <Button variant="quiet" onClick={onViewEffective} data-testid="tool-connections-effective">查看生效详情</Button>}
      {readOnly ? null : <Button variant="primary" onClick={() => setView({ kind: 'editor', mode: 'create' })} data-testid="tool-connection-create">新增连接</Button>}
    </>}>
    {notice === undefined ? null : <p role="status" data-testid="tool-connections-notice">{notice}</p>}
    {connections.length === 0
      ? <StateFeedback title="尚未配置工具连接" description="可以保存一个未完成的停用连接；未配置搜索时仍可整理已有资料。" tone="empty" />
      : <DataTable caption="工具连接目录" data-testid="tool-connections-table">
        <thead><tr>
          <th scope="col">名称</th><th scope="col">适配类型</th><th scope="col">能力</th><th scope="col">启用</th><th scope="col">凭据</th>
          <th scope="col">搜索测试</th><th scope="col">页面归档测试</th><th scope="col">引用情况</th><th scope="col">操作</th>
        </tr></thead>
        <tbody>
          {connections.map((connection) => {
            const references = usage[connection.connectionId] ?? []
            const probe: ToolConnectionProbeResult | undefined = connection.probeSummary
            return <tr key={connection.connectionId} data-testid="tool-connection-row" data-connection-id={connection.connectionId}>
              <td>{connection.name}<br /><small>修订 {connection.revision}</small></td>
              <td>{TOOL_ADAPTER_LABELS[connection.adapterType]}</td>
              <td>{connection.capabilities.map((capability) => TOOL_CAPABILITY_LABELS[capability]).join('、')}</td>
              <td><StatusBadge tone={connection.enabled ? 'success' : 'neutral'}>{connection.enabled ? '已启用' : '已停用'}</StatusBadge></td>
              <td><StatusBadge tone={connection.credentialState === 'present' ? 'success' : 'warning'}>{TOOL_CREDENTIAL_LABELS[connection.credentialState]}</StatusBadge></td>
              <td data-testid="tool-connection-search-test">{probe === undefined ? '未测试' : <ToolProbeItemView label="搜索" item={probe.search} testId={`tool-probe-search-${connection.connectionId}`} />}</td>
              <td data-testid="tool-connection-archive-test">{probe === undefined ? '未测试' : <ToolProbeItemView label="归档" item={probe.archive} testId={`tool-probe-archive-${connection.connectionId}`} />}</td>
              <td>{references.length === 0 ? '未发现引用' : references.join('、')}</td>
              <td className="model-settings__row-actions">
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => setView({ kind: 'editor', mode: 'edit', connection })} data-testid="tool-connection-edit">编辑</Button>
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => setView({ kind: 'editor', mode: 'copy', connection })} data-testid="tool-connection-copy">复制</Button>
                <Button variant="quiet" disabled={readOnly || busyId !== undefined} onClick={() => void test(connection)} data-testid="tool-connection-test">{busyId === connection.connectionId ? '处理中…' : '测试'}</Button>
                <Button variant="danger" disabled={readOnly || busyId !== undefined} onClick={() => void remove(connection)} data-testid="tool-connection-delete">删除</Button>
              </td>
            </tr>
          })}
        </tbody>
      </DataTable>}
  </Panel>
}
