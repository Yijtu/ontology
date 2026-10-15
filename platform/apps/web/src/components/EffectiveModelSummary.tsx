import { Button, StatusBadge } from './ui'
import type { EffectiveModelSelection } from '../api/model-connections'
import {
  CAPABILITY_LABELS,
  CREDENTIAL_LABELS,
  EFFECTIVE_STATE_LABELS,
  SELECTION_REASON_LABELS,
  SELECTION_SOURCE_LABELS,
  TEST_REASON_LABELS,
} from './model-settings-labels'

/**
 * A single resolved model selection (design §5.2/§5.3). Reused by the effect-details page and
 * available for the first-screen capability strip. It names the model, its source and, when a
 * selection is blocked, the stable reason code — never a provider body, address or credential.
 */
export interface EffectiveModelSummaryProps {
  readonly selection: EffectiveModelSelection
  readonly variant?: 'full' | 'compact'
  readonly onConfigure?: () => void
}

function toneOf(state: EffectiveModelSelection['state']): 'success' | 'neutral' | 'warning' | 'danger' {
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

/** The model name to show; an available selection always has a connection summary. */
export function modelNameOf(selection: EffectiveModelSelection): string {
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

export function EffectiveModelSummary({ selection, variant = 'full', onConfigure }: EffectiveModelSummaryProps) {
  const summary = selection.connectionSummary
  const modelName = modelNameOf(selection)
  const blockedReason = selection.blockedReason === undefined ? undefined : SELECTION_REASON_LABELS[selection.blockedReason]
  return <section
    className={`model-effective model-effective--${variant}`}
    data-testid="effective-model"
    data-capability={selection.capability}
    data-state={selection.state}
    data-source={selection.resolvedFrom}
  >
    <header className="model-effective__head">
      <StatusBadge tone={toneOf(selection.state)}>{CAPABILITY_LABELS[selection.capability]}</StatusBadge>
      <strong data-testid="effective-model-name">{modelName}</strong>
      <span className="model-effective__source" data-testid="effective-model-source">{SELECTION_SOURCE_LABELS[selection.resolvedFrom]}</span>
    </header>
    {variant === 'compact' ? null : <dl className="model-effective__details">
      <div><dt>状态</dt><dd data-testid="effective-model-state">{EFFECTIVE_STATE_LABELS[selection.state]}</dd></div>
      {summary === undefined ? null : <div><dt>配置版本</dt><dd>{summary.revision}</dd></div>}
      {summary === undefined ? null : <div><dt>凭据</dt><dd>{CREDENTIAL_LABELS[summary.credentialState]}</dd></div>}
      <div><dt>分配版本</dt><dd>{selection.assignmentRevision ?? '—'}</dd></div>
      {blockedReason === undefined ? null : <div><dt>阻断原因</dt><dd data-testid="effective-model-reason">{blockedReason}</dd></div>}
      {summary?.testSummary === undefined ? null : <div><dt>最近测试</dt><dd>
        {summary.testSummary.status === 'passed' ? '通过' : '未通过'}
        {` · ${summary.testSummary.testedAt}`}
        {summary.testSummary.reason === undefined ? '' : ` · ${TEST_REASON_LABELS[summary.testSummary.reason]}`}
        {` · 修订 ${summary.testSummary.revision}`}
      </dd></div>}
    </dl>}
    {variant === 'compact' ? null : <p className="model-effective__note">
      进行中的任务固定其执行时的配置版本与分配版本；此处的更改只影响以后的新任务。
    </p>}
    {onConfigure === undefined ? null : <Button variant="quiet" onClick={onConfigure} data-testid="effective-model-configure">前往设置</Button>}
  </section>
}
