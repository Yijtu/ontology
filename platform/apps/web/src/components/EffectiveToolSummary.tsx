import { Button, StatusBadge } from './ui'
import type { EffectiveToolSelection } from '../api/tool-connections'
import {
  TOOL_CAPABILITY_LABELS,
  TOOL_CREDENTIAL_LABELS,
  TOOL_EFFECTIVE_STATE_LABELS,
  TOOL_SELECTION_REASON_LABELS,
  TOOL_SELECTION_SOURCE_LABELS,
} from './tool-settings-labels'
import { ToolProbeItemView } from './ToolProbeResultView'

/**
 * A single resolved tool selection (design §9). It names the effective connection, its source, the
 * assignment revision and, when blocked, the stable reason code — never a provider body, address or
 * credential. The search and archive probe outcomes stay separate.
 */
export interface EffectiveToolSummaryProps {
  readonly selection: EffectiveToolSelection
  readonly onConfigure?: () => void
}

function toneOf(state: EffectiveToolSelection['state']): 'success' | 'neutral' | 'warning' | 'danger' {
  switch (state) {
    case 'available':
      return 'success'
    case 'blocked':
      return 'danger'
    case 'disabled':
      return 'warning'
    default:
      return 'neutral'
  }
}

function connectionNameOf(selection: EffectiveToolSelection): string {
  if (selection.connectionSummary !== undefined) return selection.connectionSummary.name
  switch (selection.state) {
    case 'unconfigured':
      return '未配置'
    case 'disabled':
      return '已停用'
    default:
      return '不可用'
  }
}

export function EffectiveToolSummary({ selection, onConfigure }: EffectiveToolSummaryProps) {
  const summary = selection.connectionSummary
  const blockedReason = selection.blockedReason === undefined ? undefined : TOOL_SELECTION_REASON_LABELS[selection.blockedReason]
  return <section
    className="model-effective"
    data-testid="effective-tool"
    data-tool={selection.toolId}
    data-state={selection.state}
    data-source={selection.resolvedFrom}
  >
    <header className="model-effective__head">
      <StatusBadge tone={toneOf(selection.state)}>{TOOL_CAPABILITY_LABELS[selection.toolId]}</StatusBadge>
      <strong data-testid="effective-tool-name">{connectionNameOf(selection)}</strong>
      <span className="model-effective__source" data-testid="effective-tool-source">{TOOL_SELECTION_SOURCE_LABELS[selection.resolvedFrom]}</span>
    </header>
    <dl className="model-effective__details">
      <div><dt>状态</dt><dd data-testid="effective-tool-state">{TOOL_EFFECTIVE_STATE_LABELS[selection.state]}</dd></div>
      {summary === undefined ? null : <div><dt>配置版本</dt><dd>{summary.revision}</dd></div>}
      {summary === undefined ? null : <div><dt>凭据</dt><dd>{TOOL_CREDENTIAL_LABELS[summary.credentialState]}</dd></div>}
      <div><dt>分配版本</dt><dd>{selection.assignmentRevision ?? '—'}</dd></div>
      {blockedReason === undefined ? null : <div><dt>阻断原因</dt><dd data-testid="effective-tool-reason">{blockedReason}</dd></div>}
    </dl>
    {summary?.probeSummary === undefined ? null : <div className="tool-probe" data-testid="effective-tool-probe">
      <ToolProbeItemView label="搜索测试" item={summary.probeSummary.search} testId="effective-tool-probe-search" />
      <ToolProbeItemView label="页面归档测试" item={summary.probeSummary.archive} testId="effective-tool-probe-archive" />
    </div>}
    <p className="model-effective__note">进行中的任务固定其执行时的配置版本与分配版本；此处的更改只影响以后的新任务。选定连接失效不会自动切换。</p>
    {onConfigure === undefined ? null : <Button variant="quiet" onClick={onConfigure} data-testid="effective-tool-configure">前往设置</Button>}
  </section>
}
