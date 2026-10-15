import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type {
  EffectiveModelSelection,
  ModelAssignmentSet,
  ModelCapability,
  ModelCapabilitySelection,
  ModelConnectionAdminView,
  ModelConnectionSelection,
  ModelTargetScope,
} from '../api/model-connections'
import {
  MODEL_CAPABILITIES,
  modelAdapterSupportsCapability,
  previewModelChange,
  readModelAssignments,
  readModelConnections,
  saveModelAssignments,
} from '../api/model-connections'
import { EffectiveModelSummary } from './EffectiveModelSummary'
import { Button, Field, Panel, StateFeedback } from './ui'
import { CAPABILITY_LABELS } from './model-settings-labels'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'

interface Draft {
  readonly defaultSelection: ModelConnectionSelection
  readonly capabilities: Readonly<Record<ModelCapability, ModelConnectionSelection>>
}

const INHERIT: ModelConnectionSelection = { kind: 'inherit' }
const DISABLED: ModelConnectionSelection = { kind: 'disabled' }

function encodeSelection(selection: ModelConnectionSelection): string {
  switch (selection.kind) {
    case 'inherit':
      return 'inherit'
    case 'disabled':
      return 'disabled'
    case 'connection':
      return `connection:${selection.connectionId}`
  }
}

function decodeSelection(value: string): ModelConnectionSelection {
  if (value === 'inherit') return INHERIT
  if (value === 'disabled') return DISABLED
  const connectionId = value.startsWith('connection:') ? value.slice('connection:'.length) : ''
  return connectionId.length === 0 ? INHERIT : { kind: 'connection', connectionId }
}

function draftFrom(set: ModelAssignmentSet | undefined): Draft {
  const capabilities = Object.fromEntries(MODEL_CAPABILITIES.map((capability) => {
    const entry = set?.capabilitySelections.find((selection) => selection.capability === capability)
    return [capability, entry?.selection ?? INHERIT]
  })) as Record<ModelCapability, ModelConnectionSelection>
  return { defaultSelection: set?.defaultSelection ?? INHERIT, capabilities }
}

function sameDraft(left: Draft, right: Draft): boolean {
  if (encodeSelection(left.defaultSelection) !== encodeSelection(right.defaultSelection)) return false
  return MODEL_CAPABILITIES.every((capability) => encodeSelection(left.capabilities[capability]) === encodeSelection(right.capabilities[capability]))
}

function scopeKeyOf(scope: ModelTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return 'space'
    case 'industry_workspace':
      return `workspace:${scope.workspaceId}`
    case 'project':
      return `project:${scope.projectId}`
  }
}

export interface ModelAssignmentsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly objectScope?: ModelTargetScope
  readonly onDirtyChange?: (dirty: boolean) => void
}

export function ModelAssignmentsPanel({ client, readOnly = false, objectScope, onDirtyChange }: ModelAssignmentsPanelProps) {
  const [scope, setScope] = useState<ModelTargetScope>({ kind: 'space' })
  const live = useRef(true)
  const token = useRef(0)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [set, setSet] = useState<ModelAssignmentSet | undefined>(undefined)
  const [connections, setConnections] = useState<readonly ModelConnectionAdminView[]>([])
  const [connectionsAvailable, setConnectionsAvailable] = useState(true)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined))
  const [notice, setNotice] = useState<{ readonly kind: 'error' | 'saved' | 'info'; readonly text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState<readonly EffectiveModelSelection[] | undefined>(undefined)

  const load = useCallback(async (target: ModelTargetScope) => {
    const id = ++token.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    setPhase('loading')
    setNotice(undefined)
    setBefore(undefined)
    const current = () => live.current && token.current === id && !controller.signal.aborted
    try {
      const loaded = await readModelAssignments(client, target, controller.signal)
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
      const options = await readModelConnections(client, { enabled: true }, controller.signal)
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

  const optionsFor = (capability: ModelCapability): readonly ModelConnectionAdminView[] =>
    connections.filter((connection) => modelAdapterSupportsCapability(connection.adapterType, capability) && connection.capabilities.includes(capability))

  const selectionControl = (label: string, selection: ModelConnectionSelection, onChange: (next: ModelConnectionSelection) => void, optionFilter: ModelCapability) => {
    const options = optionsFor(optionFilter)
    const currentConnection = selection.kind === 'connection' ? connections.find((entry) => entry.connectionId === selection.connectionId) : undefined
    return <Field label={label} hint={optionFilter === 'generation' ? '生成与研究的默认来源；生成模型不能用作 JEV。' : '仅列出可用且能力匹配的连接。'}>
      {(attributes) => <><select {...attributes} value={encodeSelection(selection)} disabled={readOnly || busy} onChange={(event) => onChange(decodeSelection(event.currentTarget.value))}>
        <option value="inherit">{scope.kind === 'space' ? '未配置（空间无上层）' : '继承（进入下一层）'}</option>
        <option value="disabled">停用（终止解析，不回退）</option>
        {options.map((connection) => <option key={connection.connectionId} value={`connection:${connection.connectionId}`}>{connection.name}</option>)}
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
      const capabilitySelections: ModelCapabilitySelection[] = MODEL_CAPABILITIES
        .filter((capability) => draft.capabilities[capability].kind !== 'inherit')
        .map((capability) => ({ capability, selection: draft.capabilities[capability] }))
      const saved = await saveModelAssignments(client, {
        scope,
        defaultSelection: draft.defaultSelection,
        capabilitySelections,
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

  const preview = async () => {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      const capabilitySelections: ModelCapabilitySelection[] = MODEL_CAPABILITIES
        .filter((capability) => draft.capabilities[capability].kind !== 'inherit')
        .map((capability) => ({ capability, selection: draft.capabilities[capability] }))
      const result = await previewModelChange(client, { scope, defaultSelection: draft.defaultSelection, capabilitySelections })
      setBefore(result.before)
      setNotice({ kind: 'info', text: '以下为该作用域当前的生效来源（仅展示，不改变任何任务）。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof ApiError && error.status === 403 ? '当前账户没有预览该作用域分配的权限。' : '无法预览当前生效来源。' })
    } finally {
      if (live.current) setBusy(false)
    }
  }

  if (phase === 'loading') {
    return <Panel title="默认与分配" description="按作用域与能力指定模型来源。">
      <StateFeedback title="正在读取分配" description="正在读取该作用域的默认与能力分配。" tone="loading" />
    </Panel>
  }
  if (phase === 'forbidden') {
    return <Panel title="默认与分配" description="按作用域与能力指定模型来源。">
      <StateFeedback title="无法查看或修改分配" description="查看与修改分配需要平台管理员或目标对象的 profile-editor 权限。当前账户看不到名称、数量或是否存在。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
    </Panel>
  }
  if (phase === 'error') {
    return <Panel title="默认与分配" description="按作用域与能力指定模型来源。">
      <StateFeedback title="暂时无法读取分配" description="请检查本机 Core 服务后重试。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
    </Panel>
  }

  return <Panel title="默认与分配" description="解析顺序固定：对象能力指定 → 对象默认 → 空间能力指定 → 空间默认；“继承”进入下一层，“停用”终止，不静默改用其他服务商。">
    {objectScope === undefined ? null : <Field label="作用域" hint="对象覆盖只影响该工作对象；恢复继承与停用是不同操作。">
      {(attributes) => <select {...attributes} value={scopeKeyOf(scope)} disabled={busy} onChange={(event) => {
        const value = event.currentTarget.value
        const next: ModelTargetScope = value === 'space' ? { kind: 'space' } : objectScope
        setScope(next)
      }}>
        <option value="space">空间（默认）</option>
        <option value={scopeKeyOf(objectScope)}>当前工作对象覆盖</option>
      </select>}
    </Field>}

    {notice === undefined ? null : <p role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="assignments-notice">{notice.text}</p>}

    <fieldset disabled={readOnly || busy} className="model-settings__fields">
      <legend>默认模型</legend>
      {selectionControl('默认生成模型', draft.defaultSelection, (next) => setDraft((previous) => ({ ...previous, defaultSelection: next })), 'generation')}
    </fieldset>

    <fieldset disabled={readOnly || busy} className="model-settings__fields">
      <legend>按能力指定</legend>
      {MODEL_CAPABILITIES.map((capability) => selectionControl(
        `${CAPABILITY_LABELS[capability]}模型`,
        draft.capabilities[capability],
        (next) => setDraft((previous) => ({ ...previous, capabilities: { ...previous.capabilities, [capability]: next } })),
        capability,
      ))}
    </fieldset>

    <p>默认与能力选择只改变新执行的模型来源，不改变既有执行策略、权限、工具名单或预算。</p>
    {readOnly ? <p role="status">当前为只读访问，不能保存分配。</p> : (
      <div className="model-settings__actions">
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()} data-testid="assignments-save">{busy ? '处理中…' : '保存分配'}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => void preview()} data-testid="assignments-preview">预览当前生效来源</Button>
        {dirty ? <span role="status">有未保存的修改</span> : null}
      </div>
    )}

    {before === undefined ? null : <section className="model-assignments__before" aria-label="当前生效来源">
      <h3>当前生效来源</h3>
      {before.map((selection) => <EffectiveModelSummary key={selection.capability} selection={selection} variant="compact" />)}
    </section>}
  </Panel>
}
