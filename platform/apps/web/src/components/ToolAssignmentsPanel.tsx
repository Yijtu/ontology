import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type {
  ToolAssignmentSet,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolTargetScope,
} from '../api/tool-connections'
import {
  readToolAssignments,
  readToolConnections,
  saveToolAssignments,
} from '../api/tool-connections'
import { Button, Field, Panel, StateFeedback } from './ui'
import { TOOL_CAPABILITY_LABELS } from './tool-settings-labels'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'

interface Draft {
  readonly defaultSelection: ToolConnectionSelection
  readonly webSearch: ToolConnectionSelection
}

const INHERIT: ToolConnectionSelection = { kind: 'inherit' }
const DISABLED: ToolConnectionSelection = { kind: 'disabled' }

function encodeSelection(selection: ToolConnectionSelection): string {
  switch (selection.kind) {
    case 'inherit':
      return 'inherit'
    case 'disabled':
      return 'disabled'
    case 'connection':
      return `connection:${selection.connectionId}`
  }
}

function decodeSelection(value: string): ToolConnectionSelection {
  if (value === 'inherit') return INHERIT
  if (value === 'disabled') return DISABLED
  const connectionId = value.startsWith('connection:') ? value.slice('connection:'.length) : ''
  return connectionId.length === 0 ? INHERIT : { kind: 'connection', connectionId }
}

function webSearchSelection(set: ToolAssignmentSet | undefined): ToolConnectionSelection {
  return set?.toolSelections.find((entry) => entry.toolId === 'web_search')?.selection ?? INHERIT
}

function draftFrom(set: ToolAssignmentSet | undefined): Draft {
  return { defaultSelection: set?.defaultSelection ?? INHERIT, webSearch: webSearchSelection(set) }
}

function sameDraft(left: Draft, right: Draft): boolean {
  return encodeSelection(left.defaultSelection) === encodeSelection(right.defaultSelection) &&
    encodeSelection(left.webSearch) === encodeSelection(right.webSearch)
}

function scopeKeyOf(scope: ToolTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return 'space'
    case 'industry_workspace':
      return `workspace:${scope.workspaceId}`
    case 'project':
      return `project:${scope.projectId}`
  }
}

export interface ToolAssignmentsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly objectScope?: ToolTargetScope
  readonly onDirtyChange?: (dirty: boolean) => void
}

export function ToolAssignmentsPanel({ client, readOnly = false, objectScope, onDirtyChange }: ToolAssignmentsPanelProps) {
  const [scope, setScope] = useState<ToolTargetScope>({ kind: 'space' })
  const live = useRef(true)
  const token = useRef(0)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [set, setSet] = useState<ToolAssignmentSet | undefined>(undefined)
  const [connections, setConnections] = useState<readonly ToolConnectionAdminView[]>([])
  const [connectionsAvailable, setConnectionsAvailable] = useState(true)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined))
  const [notice, setNotice] = useState<{ readonly kind: 'error' | 'saved'; readonly text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (target: ToolTargetScope) => {
    const id = ++token.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    setPhase('loading')
    setNotice(undefined)
    const current = () => live.current && token.current === id && !controller.signal.aborted
    try {
      const loaded = await readToolAssignments(client, target, controller.signal)
      if (!current()) return
      setSet(loaded)
      setDraft(draftFrom(loaded))
      setPhase('ready')
    } catch (error) {
      if (!current()) return
      setSet(undefined)
      setDraft(draftFrom(undefined))
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
    try {
      const options = await readToolConnections(client, { capability: 'web_search', enabled: true }, controller.signal)
      if (!current()) return
      setConnections(options)
      setConnectionsAvailable(true)
    } catch {
      if (!current()) return
      setConnections([])
      setConnectionsAvailable(false)
    }
  }, [client])

  useEffect(() => { void load(scope) }, [load, scope])
  useEffect(() => () => { live.current = false; activeController.current?.abort() }, [])

  const loaded = set
  const dirty = !sameDraft(draft, draftFrom(loaded))

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const selectionControl = (label: string, hint: string, selection: ToolConnectionSelection, onChange: (next: ToolConnectionSelection) => void) => {
    const currentConnection = selection.kind === 'connection' ? connections.find((entry) => entry.connectionId === selection.connectionId) : undefined
    return <Field label={label} hint={hint}>
      {(attributes) => <><select {...attributes} value={encodeSelection(selection)} disabled={readOnly || busy} onChange={(event) => onChange(decodeSelection(event.currentTarget.value))}>
        <option value="inherit">{scope.kind === 'space' ? '未配置（空间无上层）' : '继承（进入下一层）'}</option>
        <option value="disabled">停用（终止解析，不回退）</option>
        {connections.map((connection) => <option key={connection.connectionId} value={`connection:${connection.connectionId}`}>{connection.name}</option>)}
        {selection.kind === 'connection' && currentConnection === undefined
          ? <option value={`connection:${selection.connectionId}`}>已选连接（当前不可见）</option>
          : null}
      </select>
      {!connectionsAvailable ? <p className="model-settings__hint" role="status">无法列出可用连接（需要平台管理员权限）。仍可设置继承/停用，或保留已有选择。</p> : null}</>}
    </Field>
  }

  const save = async () => {
    if (readOnly || busy) return
    setBusy(true)
    setNotice(undefined)
    const id = ++token.current
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    const current = () => live.current && token.current === id && !controller.signal.aborted
    try {
      const toolSelections: ToolConnectionSelectionEntry[] = draft.webSearch.kind === 'inherit'
        ? []
        : [{ toolId: 'web_search' as ToolConnectionCapability, selection: draft.webSearch }]
      const saved = await saveToolAssignments(client, {
        scope,
        defaultSelection: draft.defaultSelection,
        toolSelections,
        ...(loaded === undefined ? {} : { expectedRevision: loaded.revision }),
      }, controller.signal)
      if (!current()) return
      setSet(saved)
      setDraft(draftFrom(saved))
      setNotice({ kind: 'saved', text: '分配已保存；新任务将使用新选择，进行中的任务保持原绑定。' })
    } catch (error) {
      if (!current()) return
      if (error instanceof ApiError && error.status === 403) setNotice({ kind: 'error', text: '当前账户没有修改该作用域分配的权限。' })
      else if (error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.status === 409)) setNotice({ kind: 'error', text: '分配已被其他窗口更新。请重新读取后再保存，当前选择仍保留。' })
      else if (error instanceof ApiError && error.code === 'MALFORMED_RESPONSE') setNotice({ kind: 'error', text: 'Core 返回的分配数据无法识别；当前选择仍保留。' })
      else setNotice({ kind: 'error', text: '分配没有保存；请检查 Core 服务后重试。' })
    } finally {
      if (live.current) setBusy(false)
    }
  }

  if (phase === 'loading') {
    return <Panel title="默认与分配" description="按作用域为公共搜索工具指定连接来源。">
      <StateFeedback title="正在读取分配" description="正在读取该作用域的默认与工具分配。" tone="loading" />
    </Panel>
  }
  if (phase === 'forbidden') {
    return <Panel title="默认与分配" description="按作用域为公共搜索工具指定连接来源。">
      <StateFeedback title="无法查看或修改分配" description="查看与修改分配需要平台管理员或目标对象的 profile-editor 权限。当前账户看不到名称、数量或是否存在。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
    </Panel>
  }
  if (phase === 'error') {
    return <Panel title="默认与分配" description="按作用域为公共搜索工具指定连接来源。">
      <StateFeedback title="暂时无法读取分配" description="请检查本机 Core 服务后重试。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
    </Panel>
  }

  return <Panel title="默认与分配" description="解析顺序固定：对象工具指定 → 对象默认 → 空间工具指定 → 空间默认；“继承”进入下一层，“停用”终止，不静默改用其他服务商。">
    {objectScope === undefined ? null : <Field label="作用域" hint="对象覆盖只影响该工作对象；恢复继承与停用是不同操作。">
      {(attributes) => <select {...attributes} value={scopeKeyOf(scope)} disabled={busy} onChange={(event) => {
        const value = event.currentTarget.value
        setScope(value === 'space' ? { kind: 'space' } : objectScope)
      }}>
        <option value="space">空间（默认）</option>
        <option value={scopeKeyOf(objectScope)}>当前工作对象覆盖</option>
      </select>}
    </Field>}

    {notice === undefined ? null : <p role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="tool-assignments-notice">{notice.text}</p>}

    <fieldset disabled={readOnly || busy} className="model-settings__fields">
      <legend>默认搜索连接</legend>
      {selectionControl('默认连接', '未单独指定工具的默认来源；只列出提供网页搜索能力且已启用的连接。', draft.defaultSelection, (next) => setDraft((previous) => ({ ...previous, defaultSelection: next })))}
    </fieldset>

    <fieldset disabled={readOnly || busy} className="model-settings__fields">
      <legend>按工具指定</legend>
      {selectionControl(`${TOOL_CAPABILITY_LABELS.web_search}连接`, '覆盖默认；只允许选择已授权且能力匹配的连接。', draft.webSearch, (next) => setDraft((previous) => ({ ...previous, webSearch: next })))}
    </fieldset>

    <p>分配只改变新执行的搜索来源，不改变既有执行策略、权限、搜索域名或预算；连接使用权不等于可扩大范围。</p>
    {readOnly ? <p role="status">当前为只读访问，不能保存分配。</p> : (
      <div className="model-settings__actions">
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()} data-testid="tool-assignments-save">{busy ? '处理中…' : '保存分配'}</Button>
        {dirty ? <span role="status">有未保存的修改</span> : null}
      </div>
    )}
  </Panel>
}
