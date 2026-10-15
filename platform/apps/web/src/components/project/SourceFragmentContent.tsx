import { useState } from 'react'
import type { AnswerSourceView } from '../../api/source-views'
import { formatLocator, VerifiedCell } from './VerifiedCell'

type SourceFragment = Pick<AnswerSourceView, 'precision' | 'text' | 'cells' | 'originalRef' | 'parseRef' | 'locator'>

/** One actual original owns this text/cell selection; files never share a locator target. */
export function SourceFragmentContent({ fragment, label }: { readonly fragment: SourceFragment; readonly label?: string }) {
  const [cellIndex, setCellIndex] = useState<number>()
  const cell = cellIndex === undefined ? undefined : fragment.cells?.[cellIndex]
  return <section className="project-support-group" data-testid="answer-source-fragment">
    {label === undefined ? null : <h4>{label}</h4>}
    <p className="project-source-note">{fragment.precision === 'approximate' ? fragment.cells === undefined ? '近似来源定位' : '近似文本投影 · 原始单元格定位' : '精确来源定位'}</p>
    {fragment.locator === undefined ? null : <p>{formatLocator(fragment.locator)}</p>}
    {fragment.text === undefined || fragment.precision === 'approximate' && fragment.cells !== undefined ? null : <blockquote>{fragment.text}</blockquote>}
    {fragment.cells === undefined || fragment.cells.length === 0 ? null : <div className="project-table" tabIndex={0} role="region" aria-label={`${label ?? '来源'}的原始单元格`}><table><thead><tr><th>字段 / 位置</th><th>原始值</th><th>原始定位</th></tr></thead><tbody>{fragment.cells.map((origin, index) => <tr key={index} data-selected={cellIndex === index}><td>{origin.columnLabel ?? '原始单元格'}{origin.rowLabel === undefined ? null : <small>{origin.rowLabel}</small>}</td><td><VerifiedCell value={origin.raw} /></td><td><button className="project-source-button" type="button" onClick={() => setCellIndex(index)}>{formatLocator(origin.locator)} ↗</button></td></tr>)}</tbody></table></div>}
    {cell === undefined ? null : <div className="project-support-group" data-testid="original-cell-location"><h4>原始单元格</h4><p>{formatLocator(cell.locator)}</p><blockquote><VerifiedCell value={cell.raw} /></blockquote><p className="project-source-note">位置来自本片段对应的原文件、解析与映射记录。</p></div>}
    {fragment.originalRef === undefined && fragment.parseRef === undefined && fragment.locator === undefined && cell === undefined ? null : <details className="project-audit"><summary>原始文件与解析版本</summary><dl>
      {fragment.originalRef === undefined ? null : <><dt>原始文件</dt><dd><code>{fragment.originalRef.id}@{fragment.originalRef.version}</code></dd><dt>文件摘要</dt><dd><code>{fragment.originalRef.digest}</code></dd></>}
      {fragment.parseRef === undefined ? null : <><dt>解析版本</dt><dd><code>{fragment.parseRef.id}@{fragment.parseRef.version}</code></dd><dt>解析摘要</dt><dd><code>{fragment.parseRef.digest}</code></dd></>}
      {cell === undefined && fragment.locator === undefined ? null : <><dt>实际定位</dt><dd><code>{JSON.stringify(cell?.locator ?? fragment.locator)}</code></dd></>}
    </dl></details>}
  </section>
}
