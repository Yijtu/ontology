import type { ProjectSourceCatalogue } from '../../api/project-workbench'
import { VerifiedCell } from './VerifiedCell'

const COVERAGE = { complete: '完整', partial: '部分', truncated: '已截断', unknown: '未知' }
export function NativeSourcePreview({ catalogue }: { readonly catalogue: ProjectSourceCatalogue }) {
  return (
    <section className="project-section">
      <h4>实际原始资料预览</h4>
      {catalogue.sources.length === 0 ? (
        <p>当前资料集尚无活动来源。</p>
      ) : (
        catalogue.sources.map((source) => (
          <details key={source.documentId} className="project-source-preview">
            <summary>
              {source.name ?? `${source.format?.toUpperCase() ?? '文档'} 原始资料`} ·{' '}
              {source.precision === 'approximate' ? '近似投影' : '精确定位'}
            </summary>
            {source.coverage === undefined ? (
              <p>服务端未报告解析覆盖情况。</p>
            ) : (
              <p>
                解析覆盖：{COVERAGE[source.coverage.completeness]} · 已解析 {source.coverage.parsedUnits}/
                {source.coverage.totalUnits} 单位 · 跳过 {source.coverage.skippedUnits}
                。下方为有界预览，行数不表示完整数据集。
              </p>
            )}
            {(source.tables ?? []).map((table) => (
              <div key={table.tableId}>
                <h5>
                  {table.name ?? table.sheetName ?? '结构化记录'} · 表头第 {table.headerRow} 行
                </h5>
                <p className="project-source-note">当前返回 {table.rows.length} 条预览记录。</p>
                <div
                  className="project-table"
                  tabIndex={0}
                  role="region"
                  aria-label={`${source.name ?? '原始资料'}预览`}
                >
                  <table>
                    <thead>
                      <tr>
                        {table.columns.map((column) => (
                          <th key={column.columnIndex}>{column.header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.map((row) => (
                        <tr key={row.sourceRowKey}>
                          {table.columns.map((column) => (
                            <td key={column.columnIndex}>
                              <VerifiedCell
                                value={row.cells.find((cell) => cell.columnIndex === column.columnIndex)?.raw}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <details className="project-audit">
              <summary>保存的文件与解析选择</summary>
              <p>
                <code>
                  {source.originalRef.id}@{source.originalRef.version}
                </code>
              </p>
              <p>
                <code>{source.originalRef.digest}</code>
              </p>
              <p>
                <code>{source.parseId}</code>
              </p>
              <pre>{JSON.stringify(source.options ?? null, null, 2)}</pre>
            </details>
          </details>
        ))
      )}
    </section>
  )
}
