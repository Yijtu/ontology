import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type { EffectiveModelSelection, ModelTargetScope } from '../api/model-connections'
import { readEffectiveModels } from '../api/model-connections'
import { EffectiveModelSummary } from './EffectiveModelSummary'
import { Button, Field, Panel, StateFeedback } from './ui'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'

export interface EffectiveModelsPanelProps {
  readonly client: WorkbenchClient
  readonly objectScope?: ModelTargetScope
  readonly onOpenSettings?: () => void
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

function describeScope(scope: ModelTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return '空间作用域'
    case 'industry_workspace':
      return '当前工作区'
    case 'project':
      return '当前项目'
  }
}

export function EffectiveModelsPanel({ client, objectScope, onOpenSettings }: EffectiveModelsPanelProps) {
  const [scope, setScope] = useState<ModelTargetScope>({ kind: 'space' })
  const live = useRef(true)
  const token = useRef(0)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [selections, setSelections] = useState<readonly EffectiveModelSelection[]>([])

  const load = useCallback(async (target: ModelTargetScope) => {
    const id = ++token.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    setPhase('loading')
    try {
      const result = await readEffectiveModels(client, target, undefined, controller.signal)
      if (!live.current || token.current !== id || controller.signal.aborted) return
      setSelections(result)
      setPhase('ready')
    } catch (error) {
      if (!live.current || token.current !== id || controller.signal.aborted) return
      setSelections([])
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [client])

  useEffect(() => { void load(scope) }, [load, scope])
  useEffect(() => () => { live.current = false; activeController.current?.abort() }, [])

  return <Panel title="生效详情" description="说明每个能力在当前工作对象上的最终模型、来源与阻断原因；不显示密钥或连接地址。"
    actions={onOpenSettings === undefined ? undefined : <Button variant="quiet" onClick={onOpenSettings} data-testid="effective-open-settings">前往设置</Button>}>
    {objectScope === undefined ? null : <Field label="作用域" hint="查看空间默认或当前工作对象覆盖后的实际生效模型。">
      {(attributes) => <select {...attributes} value={scopeKeyOf(scope)} onChange={(event) => {
        const value = event.currentTarget.value
        setScope(value === 'space' ? { kind: 'space' } : objectScope)
      }}>
        <option value="space">空间（默认）</option>
        <option value={scopeKeyOf(objectScope)}>当前工作对象</option>
      </select>}
    </Field>}

    {phase === 'loading' ? <StateFeedback title="正在解析生效模型" description="正在按固定顺序解析该作用域的模型来源。" tone="loading" />
      : phase === 'forbidden' ? <StateFeedback title="无法查看生效模型" description="查看生效模型需要平台管理员或 profile-editor 权限。当前账户看不到模型名称、数量或是否存在。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
      : phase === 'error' ? <StateFeedback title="暂时无法解析生效模型" description="请检查本机 Core 服务后重试。" tone="error"
        action={<Button onClick={() => void load(scope)}>重新读取</Button>} />
      : <>
        <p className="model-settings__hint">当前工作对象：{describeScope(scope)}。以下为解析后的最终模型。</p>
        <div className="model-effective__list">
          {selections.map((selection) => <EffectiveModelSummary key={selection.capability} selection={selection} {...(onOpenSettings === undefined ? {} : { onConfigure: onOpenSettings })} />)}
        </div>
      </>}
  </Panel>
}
