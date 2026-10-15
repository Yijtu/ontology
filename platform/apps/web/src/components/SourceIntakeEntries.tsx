import type { SourceEntryPoint } from '@ontology/contracts'
import './ontology/ontology.css'

/**
 * The three intake entry points (design §1.3 / §2.5): AI 搜寻公共资料 / 上传或粘贴资料 /
 * 接入结构化数据, gathered on the source page. An entry that this deployment cannot serve is shown
 * with its concrete reason and recovery instead of a bare disabled control, so a user never starts a
 * flow that silently cannot run. Selecting an entry only reveals guidance here; the actual research,
 * upload and file-mapping experiences live in their own surfaces.
 */
export interface SourceIntakeEntryView {
  readonly entry: SourceEntryPoint
  readonly title: string
  readonly subtitle: string
  readonly available: boolean
  readonly reason?: string
  readonly recovery?: string
}

export interface SourceIntakeEntriesProps {
  readonly entries: readonly SourceIntakeEntryView[]
  readonly active: SourceEntryPoint | undefined
  readonly onSelect: (entry: SourceEntryPoint) => void
}

export function SourceIntakeEntries({ entries, active, onSelect }: SourceIntakeEntriesProps) {
  const selected = entries.find((entry) => entry.entry === active)
  return (
    <section className="ontology-intake" aria-label="知识从哪里来" data-testid="source-intake">
      <h3>知识从哪里来？</h3>
      <p className="ontology-hint">三种料源在此汇聚。入口是否可用由当前部署能力决定；不可用的入口会写出原因与恢复方式，不会伪装成可用。</p>
      <ul className="ontology-intake__list">
        {entries.map((entry) => (
          <li key={entry.entry} data-testid={`intake-${entry.entry}`} data-available={entry.available}>
            <button type="button" data-testid={`intake-${entry.entry}-button`} aria-current={active === entry.entry ? 'true' : undefined}
              onClick={() => onSelect(entry.entry)}>
              <strong>{entry.title}</strong>
              <span>{entry.subtitle}</span>
              <small>{entry.available ? '可用' : entry.reason ?? '当前不可用'}</small>
            </button>
          </li>
        ))}
      </ul>
      {selected === undefined ? null : (
        <p role="status" className="ontology-notice" data-testid="intake-guidance">
          {selected.available
            ? `${selected.title}：${selected.subtitle}。${selected.recovery ?? '在这里开始，服务端会记录真实状态。'}`
            : `${selected.title}当前不可用：${selected.reason ?? '当前部署未提供该能力。'}${selected.recovery === undefined ? '' : ` 恢复入口：${selected.recovery}`}`}
        </p>
      )}
    </section>
  )
}
