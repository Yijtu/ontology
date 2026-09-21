import type { SourceBindingRecord, SourceProbeJobRecord } from '@ontology/contracts'

export interface SourcePanelProps {
  readonly sources: readonly SourceBindingRecord[]
  readonly probeJobs: Readonly<Record<string, SourceProbeJobRecord>>
  readonly busy: boolean
  readonly onProbe: (sourceId: string) => void
}

const STATUS_LABEL: Record<SourceBindingRecord['status'], string> = {
  registered: '已登记（未探测）',
  probing: '探测中',
  ready: '就绪',
  failed: '探测失败',
}

/**
 * Source registration and probe status. Only the opaque `secretRef` is shown — never a
 * resolved value — and a probe that failed stays visibly failed instead of silently
 * reading as ready.
 */
export function SourcePanel({ sources, probeJobs, busy, onProbe }: SourcePanelProps) {
  if (sources.length === 0) {
    return (
      <section className="sources" data-testid="sources" data-count="0">
        <h3>数据源</h3>
        <p data-testid="sources-empty">尚未登记数据源。</p>
      </section>
    )
  }
  return (
    <section className="sources" data-testid="sources" data-count={sources.length}>
      <h3>数据源（{sources.length}）</h3>
      <ul>
        {sources.map((source) => {
          const job = probeJobs[source.sourceId]
          return (
            <li key={source.sourceId} data-testid="source" data-status={source.status}>
              <span className="sources__role">{source.role}</span>
              <span className="sources__kind">{source.kind}</span>
              <span className="sources__ref" data-testid="source-secret-ref">
                {source.secretRef}
              </span>
              <span className="sources__status">{STATUS_LABEL[source.status]}</span>
              {job === undefined ? null : (
                <span className="sources__job" data-testid="probe-job" data-status={job.status}>
                  探测任务：{job.status}
                  {job.safeMessage === undefined ? '' : ` — ${job.safeMessage}`}
                </span>
              )}
              <button type="button" disabled={busy} onClick={() => onProbe(source.sourceId)}>
                探测能力
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
