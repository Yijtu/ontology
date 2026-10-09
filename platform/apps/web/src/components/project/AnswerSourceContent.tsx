import { useState } from 'react'
import type { AnswerSourceView } from '../../api/source-views'
import { EvidenceSummary } from './EvidenceSummary'
import { formatLocator, VerifiedCell } from './VerifiedCell'

const MODE = {
  synthetic: '合成数据',
  observed: '观测数据',
  forecast: '预测数据',
  simulation: '仿真数据',
  live: '实机数据',
}
export function AnswerSourceContent({ view }: { readonly view: AnswerSourceView }) {
  const [cellIndex, setCellIndex] = useState<number>()
  const cell = cellIndex === undefined ? undefined : view.cells?.[cellIndex]
  const readability =
    view.readability === 're_readable'
      ? 'current'
      : view.readability === 'archived_snapshot_only'
        ? 'historical'
        : 'missing'
  return (
    <section className="project-source-reader" data-testid="result-evidence" data-readability={readability}>
      <h3>{view.title}</h3>
      <div className="project-result-status">
        <span className={`project-state project-state--${view.precision === 'exact' ? 'ready' : 'partial'}`}>
          {view.precision === 'exact' ? '精确来源定位' : '近似来源投影'}
        </span>
        <span className="project-state">{MODE[view.dataMode]}</span>
      </div>
      <p>
        {view.readability === 're_readable'
          ? '原始来源可按所选答案的固定版本重读。'
          : view.readability === 'archived_snapshot_only'
            ? '原始来源当前不可重读，以下内容来自核验时保存的归档快照。'
            : '该来源当前无法核验，不能展示为可用的原文或正式数据。'}
      </p>
      {view.readability === 'unverifiable' ? null : (
        <>
          {view.family === 'structured_qa' ? (
            <p className="project-notice">
              结构化问答使用近似文本投影。下方为实际原始单元格，不表示精确逐字引文。
            </p>
          ) : null}
          {view.text === undefined || view.family === 'structured_qa' ? null : (
            <blockquote>{view.text}</blockquote>
          )}
          {view.cells === undefined || view.cells.length === 0 ? null : (
            <div className="project-table" tabIndex={0} role="region" aria-label="原始单元格">
              <table>
                <thead>
                  <tr>
                    <th>字段 / 位置</th>
                    <th>原始值</th>
                    <th>原始定位</th>
                  </tr>
                </thead>
                <tbody>
                  {view.cells.map((origin, index) => (
                    <tr key={index} data-selected={cellIndex === index}>
                      <td>
                        {origin.columnLabel ?? '原始单元格'}
                        {origin.rowLabel === undefined ? null : <small>{origin.rowLabel}</small>}
                      </td>
                      <td>
                        <VerifiedCell value={origin.raw} />
                      </td>
                      <td>
                        <button
                          className="project-source-button"
                          type="button"
                          onClick={() => setCellIndex(index)}
                        >
                          {formatLocator(origin.locator)} ↗
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cell === undefined ? null : (
            <div className="project-support-group" data-testid="original-cell-location">
              <h4>原始单元格</h4>
              <p>{formatLocator(cell.locator)}</p>
              <blockquote>
                <VerifiedCell value={cell.raw} />
              </blockquote>
              <p className="project-source-note">位置来自该答案保存的原文件、解析与映射记录。</p>
            </div>
          )}
        </>
      )}
      {view.support === undefined ? null : <EvidenceSummary evidence={view.support} />}
      <details className="project-audit">
        <summary>答案、证据与原始版本</summary>
        <dl>
          <dt>固定答案</dt>
          <dd>
            <code>{view.answerId}</code>
          </dd>
          <dt>答案内容摘要</dt>
          <dd>
            <code>{view.answerRef.digest}</code>
          </dd>
          <dt>证据</dt>
          <dd>
            <code>{view.evidenceId}</code>
          </dd>
          {view.originalRef === undefined ? null : (
            <>
              <dt>原始文件</dt>
              <dd>
                <code>
                  {view.originalRef.id}@{view.originalRef.version}
                </code>
              </dd>
              <dt>原始文件摘要</dt>
              <dd>
                <code>{view.originalRef.digest}</code>
              </dd>
            </>
          )}
          {view.parseRef === undefined ? null : (
            <>
              <dt>解析版本</dt>
              <dd>
                <code>
                  {view.parseRef.id}@{view.parseRef.version}
                </code>
              </dd>
            </>
          )}
          {cell === undefined ? null : (
            <>
              <dt>实际定位</dt>
              <dd>
                <code>{JSON.stringify(cell.locator)}</code>
              </dd>
            </>
          )}
        </dl>
      </details>
    </section>
  )
}
