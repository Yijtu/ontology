import { useEffect, useMemo, useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import type { ModelTargetScope } from '../api/model-connections'
import { EffectiveModelsPanel } from './EffectiveModelsPanel'
import { ModelAssignmentsPanel } from './ModelAssignmentsPanel'
import { ModelConnectionsPanel } from './ModelConnectionsPanel'
import { ModelSettingsPanel } from './ModelSettingsPanel'
import { ToolSettingsPanel } from './ToolSettingsPanel'

export type AiSettingsTab = 'connections' | 'tools' | 'assignments' | 'effective' | 'legacy'

const TABS: readonly { readonly id: AiSettingsTab; readonly label: string }[] = [
  { id: 'connections', label: '模型连接' },
  { id: 'tools', label: '能力与工具' },
  { id: 'assignments', label: '默认与分配' },
  { id: 'effective', label: '生效详情' },
  { id: 'legacy', label: '单实例兼容配置' },
]

function isTab(value: string | null): value is AiSettingsTab {
  return value !== null && TABS.some((tab) => tab.id === value)
}

function readTab(): AiSettingsTab {
  if (typeof window === 'undefined') return 'connections'
  const value = new URLSearchParams(window.location.search).get('aiTab')
  return isTab(value) ? value : 'connections'
}

/** Keep the AI-settings sub-tab on the URL so `?view=models&aiTab=...` is a stable deep link. */
function writeTab(tab: AiSettingsTab): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (tab === 'connections') url.searchParams.delete('aiTab')
  else url.searchParams.set('aiTab', tab)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export interface AiSettingsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly workspaceId?: string
  readonly projectId?: string
  readonly onDirtyChange?: (dirty: boolean) => void
}

/**
 * The AI-settings surface behind `?view=models` (design §5.2/§5.3). It exposes the connection
 * catalogue, the default/capability/object assignments and the resolved effect details, and keeps
 * the legacy single-instance configuration as an explicit compatibility tab. Connection details
 * and credentials are only ever fetched by the administrator endpoints; a viewer without access
 * sees a permission notice, never a name or a count.
 */
export function AiSettingsPanel({ client, readOnly = false, workspaceId, projectId, onDirtyChange }: AiSettingsPanelProps) {
  const [tab, setTab] = useState<AiSettingsTab>(readTab)

  const objectScope: ModelTargetScope | undefined = useMemo(() => {
    if (projectId !== undefined) return { kind: 'project', projectId }
    if (workspaceId !== undefined) return { kind: 'industry_workspace', workspaceId }
    return undefined
  }, [workspaceId, projectId])

  useEffect(() => { writeTab(tab) }, [tab])

  const select = (next: AiSettingsTab) => setTab(next)

  return <div className="ai-settings" data-testid="ai-settings" data-tab={tab}>
    <nav className="ai-settings__tabs" aria-label="AI 设置">
      {TABS.map((entry) => <button key={entry.id} type="button" className="ai-settings__tab" data-testid={`ai-tab-${entry.id}`}
        data-active={entry.id === tab} aria-current={entry.id === tab ? 'page' : undefined} onClick={() => select(entry.id)}>{entry.label}</button>)}
    </nav>

    {tab === 'connections' ? <ModelConnectionsPanel client={client} readOnly={readOnly} {...(objectScope === undefined ? {} : { scope: objectScope })} {...(onDirtyChange === undefined ? {} : { onDirtyChange })} /> : null}
    {tab === 'tools' ? <ToolSettingsPanel client={client} readOnly={readOnly} {...(objectScope === undefined ? {} : { objectScope })} {...(onDirtyChange === undefined ? {} : { onDirtyChange })} /> : null}
    {tab === 'assignments' ? <ModelAssignmentsPanel client={client} readOnly={readOnly} {...(objectScope === undefined ? {} : { objectScope })} {...(onDirtyChange === undefined ? {} : { onDirtyChange })} /> : null}
    {tab === 'effective' ? <EffectiveModelsPanel client={client} {...(objectScope === undefined ? {} : { objectScope })} onOpenSettings={() => select('assignments')} /> : null}
    {tab === 'legacy' ? <div className="ai-settings__legacy">
      <p className="model-settings__hint">兼容旧的整实例“生成模型”配置，供尚未迁移到连接目录的部署使用。</p>
      <ModelSettingsPanel client={client} readOnly={readOnly} {...(onDirtyChange === undefined ? {} : { onDirtyChange })} />
    </div> : null}
  </div>
}
