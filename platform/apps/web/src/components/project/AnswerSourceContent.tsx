import type { AnswerSourceView } from '../../api/source-views'
import { EvidenceSummary } from './EvidenceSummary'
import { SourceFragmentContent } from './SourceFragmentContent'

const MODE = { synthetic: '合成数据', observed: '观测数据', forecast: '预测数据', simulation: '仿真数据', live: '实机数据' }
export function AnswerSourceContent({ view }: { readonly view: AnswerSourceView }) {
  const approximate = view.precision === 'approximate' || view.fragments?.some((fragment) => fragment.precision === 'approximate') === true
  const readability = view.readability === 're_readable' ? 'current' : view.readability === 'archived_snapshot_only' ? 'historical' : 'missing'
  const fragments = view.family === 'data_query' ? [] : view.fragments ?? (view.text !== undefined || view.cells !== undefined ? [view] : [])
  const structured = view.family === 'structured_qa' || fragments.some((fragment) => fragment.precision === 'approximate' && fragment.cells !== undefined)
  return <section className="project-source-reader" data-testid="result-evidence" data-readability={readability}>
    <h3>{view.title}</h3>
    <div className="project-result-status"><span className={`project-state project-state--${approximate ? 'partial' : 'ready'}`}>{view.family === 'data_query' ? '固定查询 / 计算结果' : approximate ? '包含近似来源' : '精确来源定位'}</span><span className="project-state">{MODE[view.dataMode]}</span></div>
    <p>{view.readability === 'unverifiable' ? '该来源当前无法核验，不能展示为可用的原文或正式数据。' : view.family === 'data_query' ? '正式表格与陈述继续按该答案的已核验结果展示。' : view.readability === 're_readable' ? '原始来源可按所选答案的固定版本重读。' : '当前显示核验时保存的固定来源，不能作为当前来源仍有效的证明。'}</p>
    {view.readability === 'unverifiable' ? null : <>
      {view.family === 'data_query' ? <p className="project-notice">本次保存的查询/计算结果；暂不支持回读原始表格单元格。{view.sourceReadLimitation === undefined ? null : <small>{view.sourceReadLimitation}</small>}</p> : null}
      {approximate ? <p className="project-notice">{structured ? '结构化问答使用近似文本投影。下方为实际原始单元格，不表示精确逐字引文。' : '来源定位保持近似状态，不能作为精确逐字引文。'}</p> : null}
      {fragments.map((fragment, index) => <SourceFragmentContent key={`${fragment.originalRef?.id ?? 'saved'}:${fragment.originalRef?.digest ?? ''}:${JSON.stringify(fragment.locator ?? index)}`} fragment={fragment} {...(fragments.length > 1 ? { label: `来源片段 ${index + 1}` } : {})} />)}
      {view.family !== 'data_query' ? null : <details className="project-audit" data-testid="query-source-archive"><summary>查询归档与固定输入版本</summary>
        {view.archivedPayload === undefined && view.text === undefined ? null : <pre>{view.archivedPayload === undefined ? view.text : JSON.stringify(view.archivedPayload, null, 2)}</pre>}
        <dl>{view.fixedInputRef === undefined ? null : <><dt>固定输入</dt><dd><code>{view.fixedInputRef.id}@{view.fixedInputRef.version}</code></dd><dt>输入摘要</dt><dd><code>{view.fixedInputRef.digest}</code></dd></>}
        {view.fixedDatasetSnapshotRef === undefined ? null : <><dt>固定数据快照</dt><dd><code>{view.fixedDatasetSnapshotRef.id}@{view.fixedDatasetSnapshotRef.version}</code></dd><dt>快照摘要</dt><dd><code>{view.fixedDatasetSnapshotRef.digest}</code></dd></>}</dl>
      </details>}
    </>}
    {view.support === undefined ? null : <EvidenceSummary evidence={view.support} />}
    <details className="project-audit"><summary>答案与证据版本</summary><dl><dt>固定答案</dt><dd><code>{view.answerId}</code></dd><dt>答案内容摘要</dt><dd><code>{view.answerRef.digest}</code></dd><dt>证据</dt><dd><code>{view.evidenceId}</code></dd></dl></details>
  </section>
}
