import { useId } from 'react'
import type { GroundingView } from '../../api/ontology'
import { sourceReasonLabels } from './labels'
import { StatusBadge, DataTable } from '../ui'
export function SourceEvidencePane({ value, selected, onSelect }: { readonly value: GroundingView | undefined; readonly selected: string; readonly onSelect: (key: string) => void }) {
  const groupId = useId()
  if (value === undefined) return <div className="ontology-empty"><h3>查看真实来源</h3><p>选择候选并读取依据。片段来自已确认的原始资料，不由编辑器补写。</p></div>
  return <div><header className="ontology-pane-heading"><h3>原始依据</h3><StatusBadge tone={value.coverage === 'complete' ? 'success' : 'warning'}>{value.coverage === 'complete' ? '已完整读取' : value.coverage === 'partial' ? '只读到部分资料' : '读取失败'}</StatusBadge></header>
    <p className="ontology-hint">实际读取 {value.usage.fragments} 个片段 · {value.usage.readBytes} 字节 · {value.usage.pages} 页</p>
    {value.sources.map((source, index) => <div className="ontology-source-status" key={`${source.sourceRef.id}:${index}`}><strong>资料 {index + 1}</strong> · {source.status === 'complete' ? '完整' : source.status === 'partial' ? '部分' : '失败'}{source.reasons.length > 0 ? <div><p>{source.reasons.map((reason) => sourceReasonLabels[reason] ?? '来源读取存在未解析的问题').join('、')}</p><details><summary>读取问题代码</summary><p>{source.reasons.join('、')}</p></details></div> : null}</div>)}
    {value.fragments.length === 0 ? <p role="status">没有可确认的真实片段。表头可供理解字段，不能作为数据行的来源确认。</p> : value.fragments.map((fragment) => {
      const key = `${fragment.sourceIndex}:${fragment.fragmentIndex}`
      return <article key={key} className={`ontology-fragment ${selected === key ? 'ontology-fragment--selected' : ''}`}><label className="ontology-fragment-choice"><input type="radio" name={`ontology-source-fragment-${groupId}`} checked={selected === key} onChange={() => onSelect(key)} /><strong>资料 {fragment.sourceIndex + 1} · 片段 {fragment.fragmentIndex + 1}</strong></label>
        {fragment.table === undefined ? <blockquote>{fragment.text}</blockquote> : <DataTable caption="原始表格数据行"><thead><tr>{fragment.table.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody><tr>{fragment.table.cells.map((cell, index) => <td key={index}>{cell === '' ? '（原文为空）' : cell}</td>)}</tr></tbody></DataTable>}
        <p className="ontology-hint">定位精度：{fragment.precision === 'exact' ? '精确' : fragment.precision === 'approximate' ? '近似（需核对）' : fragment.precision}</p><details><summary>定位与版本信息</summary><pre>{JSON.stringify({ sourceRef: fragment.sourceRef, locator: fragment.locator }, null, 2)}</pre></details>
      </article>
    })}</div>
}
