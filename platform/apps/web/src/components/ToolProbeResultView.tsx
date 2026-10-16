import type { ToolConnectionProbeItem, ToolConnectionProbeResult } from '../api/tool-connections'
import { StatusBadge } from './ui'
import { TOOL_PROBE_REASON_LABELS, TOOL_PROBE_STATUS_LABELS } from './tool-settings-labels'

/**
 * Render the two probe items of a tool-connection test **separately** (design §9). "搜索测试通过"
 * must never imply "页面归档可用": the small real search query and the archive read-back are
 * independent outcomes, each with its own stable reason code. No provider body is shown.
 */
function itemTone(status: ToolConnectionProbeItem['status']): 'success' | 'danger' | 'warning' {
  switch (status) {
    case 'passed':
      return 'success'
    case 'failed':
      return 'danger'
    default:
      return 'warning'
  }
}

function itemLabel(item: ToolConnectionProbeItem): string {
  const base = TOOL_PROBE_STATUS_LABELS[item.status]
  const reason = item.reason === undefined ? '' : ` · ${TOOL_PROBE_REASON_LABELS[item.reason]}`
  const latency = item.latencyMs === undefined ? '' : ` · ${String(item.latencyMs)}ms`
  return `${base}${reason}${latency}`
}

export interface ToolProbeItemViewProps {
  readonly label: string
  readonly item: ToolConnectionProbeItem
  readonly testId: string
}

export function ToolProbeItemView({ label, item, testId }: ToolProbeItemViewProps) {
  return <span className="tool-probe__item" data-testid={testId} data-status={item.status}>
    {label}：<StatusBadge tone={itemTone(item.status)}>{itemLabel(item)}</StatusBadge>
    {item.status === 'skipped' ? <small className="model-settings__hint">未实际执行，不能视为通过。</small> : null}
  </span>
}

export function ToolProbeResultView({ result, testId }: { readonly result: ToolConnectionProbeResult; readonly testId: string }) {
  return <div className="tool-probe" data-testid={testId} data-draft={result.draft}>
    <ToolProbeItemView label="搜索测试" item={result.search} testId={`${testId}-search`} />
    <ToolProbeItemView label="页面归档测试" item={result.archive} testId={`${testId}-archive`} />
    {result.credentialConfigured ? null : <small className="model-settings__hint">未使用凭据。</small>}
  </div>
}
