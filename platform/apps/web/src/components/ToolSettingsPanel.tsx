import { useState } from 'react'
import type { WorkbenchClient } from '../api/client'
import type { ToolTargetScope } from '../api/tool-connections'
import { ToolConnectionsPanel } from './ToolConnectionsPanel'
import { ToolAssignmentsPanel } from './ToolAssignmentsPanel'
import { EffectiveToolsPanel } from './EffectiveToolsPanel'

type ToolTab = 'connections' | 'assignments' | 'effective'

const SUBTABS: readonly { readonly id: ToolTab; readonly label: string }[] = [
  { id: 'connections', label: '工具连接' },
  { id: 'assignments', label: '默认与分配' },
  { id: 'effective', label: '生效详情' },
]

export interface ToolSettingsPanelProps {
  readonly client: WorkbenchClient
  readonly readOnly?: boolean
  readonly objectScope?: ToolTargetScope
  readonly onDirtyChange?: (dirty: boolean) => void
}

/**
 * The「能力与工具」surface (design §9). A tool connection (public web search) is a **different
 * entity** from a model connection, so it lives on its own sub-surface with its own catalogue,
 * assignment and effect details. It reuses the model-settings interaction and version semantics but
 * never registers a search service as a generation model.
 */
export function ToolSettingsPanel({ client, readOnly = false, objectScope, onDirtyChange }: ToolSettingsPanelProps) {
  const [tab, setTab] = useState<ToolTab>('connections')

  return <div className="tool-settings" data-testid="tool-settings" data-tab={tab}>
    <nav className="ai-settings__tabs" aria-label="能力与工具">
      {SUBTABS.map((entry) => <button key={entry.id} type="button" className="ai-settings__tab" data-testid={`tool-subtab-${entry.id}`}
        data-active={entry.id === tab} aria-current={entry.id === tab ? 'page' : undefined} onClick={() => setTab(entry.id)}>{entry.label}</button>)}
    </nav>

    {tab === 'connections' ? <ToolConnectionsPanel client={client} readOnly={readOnly}
      {...(objectScope === undefined ? {} : { scope: objectScope })}
      onViewEffective={() => setTab('effective')}
      {...(onDirtyChange === undefined ? {} : { onDirtyChange })} /> : null}
    {tab === 'assignments' ? <ToolAssignmentsPanel client={client} readOnly={readOnly}
      {...(objectScope === undefined ? {} : { objectScope })}
      {...(onDirtyChange === undefined ? {} : { onDirtyChange })} /> : null}
    {tab === 'effective' ? <EffectiveToolsPanel client={client}
      {...(objectScope === undefined ? {} : { objectScope })}
      onOpenSettings={() => setTab('assignments')} /> : null}
  </div>
}
