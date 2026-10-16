import type { ResearchExecutionView } from '../api/research'
import { RESEARCH_STATUS_LABELS, isResearchActive, researchOutcome } from '../api/research'
import { Button, StatusBadge } from './ui'

/**
 * The research history list (design §2): a compact, reusable view of the runs the current surface
 * knows about, so a run can be reopened by its deep link. It is presentational and never invents a
 * run: the host passes exactly the executions it has read back.
 */
export interface ResearchHistoryViewProps {
  readonly runs: readonly ResearchExecutionView[]
  readonly currentId?: string
  readonly onOpen: (researchId: string) => void
  readonly title?: string
}

function toneOf(run: ResearchExecutionView): 'success' | 'warning' | 'danger' | 'neutral' {
  if (isResearchActive(run)) return 'neutral'
  const outcome = researchOutcome(run)
  if (outcome === 'completed') return 'success'
  if (outcome === 'failed') return 'danger'
  if (outcome === 'cancelled' || outcome === 'no_results') return 'neutral'
  return 'warning'
}

export function ResearchHistoryView({ runs, currentId, onOpen, title = '研究历史' }: ResearchHistoryViewProps) {
  return <section className="research-history" data-testid="research-history" aria-label={title}>
    <h3>{title}</h3>
    {runs.length === 0
      ? <p className="research-hint" data-testid="research-history-empty">本次会话还没有可回看的研究记录。运行记录会保留并可被重新订阅；刷新后请用运行链接继续。</p>
      : <ul className="research-history__list">
        {runs.map((run) => <li key={run.researchId} data-testid="research-history-item" data-current={run.researchId === currentId}>
          <span data-testid="research-history-status"><StatusBadge tone={toneOf(run)}>{RESEARCH_STATUS_LABELS[run.status]}</StatusBadge></span>
          <code>{run.researchId}</code>
          <span className="research-hint">来源 {run.sourceCount} · 候选 {run.candidateCount} · {run.recordedAt}</span>
          <Button variant="quiet" onClick={() => onOpen(run.researchId)} data-testid="research-history-open">打开</Button>
        </li>)}
      </ul>}
  </section>
}
