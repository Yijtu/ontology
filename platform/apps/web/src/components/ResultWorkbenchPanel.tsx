import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProvenanceEvidenceView, PublishedAnswer, ResourceRef } from '@ontology/contracts'
import type {
  ResultHistoryView,
  ResultSource,
  VerifiedResultExport,
  VerifiedResultLoad,
  VerifiedTablePageView,
} from '../api/results'
import { classifyPublicError } from '../state/public-errors'
import type { PublicFailure } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { PublishedAnswerBody } from './PublishedAnswerBody'
import type { PublishedAnswerLabelKind } from './PublishedAnswerBody'
import { Button, Drawer } from './ui'
import { VerifiedCell } from './project/VerifiedCell'
import { useRequestFence } from './project/useRequestFence'
import { EvidenceSummary } from './project/EvidenceSummary'
import type { AnswerSourceView, SavedCellSelector } from '../api/source-views'
import { boundAnswerSource } from '../api/source-views'
import { AnswerSourceContent } from './project/AnswerSourceContent'
import './project/project-workbench.css'

/**
 * The public typed-result workbench (SPEC v0.3a execution-evidence §EX-7.1, asset-data-ui §9.2,
 * issue V03-040 / #212). It renders the three public views of the SAME verified answer version:
 *
 *  - **正文** — the verified narrative body (`PublishedAnswerBody`), which only shows statements
 *    bound to evidence; it never invents a subject, value, relation or rule conclusion.
 *  - **结果表** — a formal table is read only through the server's verified-table reader, one
 *    page of one fixed revision at a time. A table without a full-table verification receipt is
 *    refused, and a raw artifact is never rendered as a formal value.
 *  - **依据** — the provenance/source view of the evidence a cell/statement points at, keeping
 *    current, history-limited and missing sources explicitly apart.
 *
 * The panel is data-only: it consumes a `ResultSource` the host injects, so the same component is
 * mounted for any scenario without an industry-name branch.
 */

export type ResultWorkbenchTab = 'body' | 'tables' | 'evidence' | 'history'

export interface ResultWorkbenchPanelProps {
  readonly source: ResultSource
  readonly runId: string
  readonly initialTab?: ResultWorkbenchTab
  readonly initialTableId?: string
  readonly resolveLabel?: (id: string, kind: PublishedAnswerLabelKind) => string | undefined
  readonly onOpenEvidence?: (ref: ResourceRef) => void
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly load: VerifiedResultLoad }
  | { readonly status: 'error'; readonly failure: PublicFailure }

const TAB_LABELS: Readonly<Record<ResultWorkbenchTab, string>> = {
  body: '正文',
  tables: '结果表',
  evidence: '依据',
  history: '历史版本',
}

const VALIDITY_LABELS: Readonly<Record<string, string>> = {
  current: '当前有效',
  superseded: '已被新版本取代',
  withdrawn: '已撤回',
  unverifiable: '无法核验',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '读取结果失败'
}
function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  )
}

function resultOf(load: VerifiedResultLoad): Extract<VerifiedResultLoad, { kind: 'verified' }> | undefined {
  return load.kind === 'verified' ? load : undefined
}

function collectEvidenceRefs(page: VerifiedTablePageView | undefined): readonly ResourceRef[] {
  if (page === undefined) return []
  const seen = new Set<string>()
  const refs: ResourceRef[] = []
  for (const row of page.rows) {
    for (const binding of row.bindings) {
      const ref = binding.evidenceRef
      const key = `${ref.kind}\u0000${ref.id}\u0000${ref.version}\u0000${ref.digest}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(ref)
    }
  }
  return refs
}

function readabilityOf(view: ProvenanceEvidenceView | undefined): 'current' | 'historical' | 'missing' {
  if (view === undefined) return 'missing'
  if (view.outcome !== 'verifiable') return 'missing'
  if (view.sources.length > 0 && view.sources.every((source) => source.reReadability === 're_readable'))
    return 'current'
  if (view.sources.some((source) => source.reReadability === 'archived_snapshot_only')) return 'historical'
  if (view.archivedResult?.verified === true) return 'historical'
  return 'missing'
}

function TableView({
  state,
  tableId,
  onOpenEvidence,
}: {
  readonly state: {
    readonly page?: VerifiedTablePageView
    readonly loading: boolean
    readonly error?: string
    readonly blocked?: string
  }
  readonly tableId: string
  readonly onOpenEvidence?: (ref: ResourceRef, selector: SavedCellSelector) => void
}) {
  if (state.blocked !== undefined) {
    return (
      <p data-testid="result-table-blocked" role="alert">
        结果表 {tableId} 缺少完整表核验回执，不能作为正式结果展示。
      </p>
    )
  }
  if (state.error !== undefined) {
    return (
      <p data-testid="result-table-error" role="alert">
        读取结果表失败：{state.error}
      </p>
    )
  }
  if (state.loading || state.page === undefined) {
    return <p data-testid="result-table-loading">正在读取结果表…</p>
  }
  const page = state.page
  return (
    <div
      className="result-workbench__table"
      data-testid="result-table"
      data-page={page.pageIndex}
      data-pages={page.pageCount}
    >
      <p data-testid="result-table-coverage" data-truncated={page.coverage.truncated}>
        第 {page.pageIndex + 1}/{page.pageCount} 页 · 共 {page.totalRows} 行 · 返回 {page.coverage.returned}{' '}
        行{page.complete ? '' : '（不完整）'}
      </p>
      <div className="project-table" tabIndex={0} role="region" aria-label="已核验结果表">
        <table>
          <thead>
            <tr>
              <th>行标识</th>
              {page.columns.map((column) => (
                <th key={column.columnRef}>{column.displayLabel ?? column.semanticPredicate}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.rowKey} data-testid="result-table-row" data-row-key={row.rowKey}>
                <td data-testid="result-table-subject">{row.subject ?? row.rowKey}</td>
                {page.columns.map((column) => (
                  <td key={column.columnRef} data-testid={`result-table-cell-${column.columnRef}`}>
                    <VerifiedCell value={row.cells[column.columnRef]} valueType={column.valueType} />
                    <div>
                      {row.bindings
                        .filter((binding) => binding.columnRef === column.columnRef)
                        .map((binding, index) => (
                          <button
                            className="project-source-button"
                            key={`${binding.evidenceRef.id}:${index}`}
                            type="button"
                            data-testid="result-cell-evidence"
                            data-evidence-id={binding.evidenceRef.id}
                            onClick={() => onOpenEvidence?.(binding.evidenceRef, { tableId: page.tableId, rowKey: row.rowKey, columnRef: column.columnRef })}
                            aria-label={`查看${column.displayLabel ?? column.semanticPredicate}的来源`}
                          >
                            来源 ↗
                          </button>
                        ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EvidenceView({
  view,
  sourceView,
  loading,
  error,
}: {
  readonly view?: ProvenanceEvidenceView
  readonly sourceView?: AnswerSourceView
  readonly loading: boolean
  readonly error?: string
}) {
  if (loading) return <p data-testid="result-evidence-loading">正在读取依据…</p>
  if (error !== undefined) {
    return (
      <p data-testid="result-evidence-error" role="alert">
        读取依据失败：{error}
      </p>
    )
  }
  if (sourceView !== undefined)
    return <AnswerSourceContent key={`${sourceView.answerId}:${sourceView.evidenceId}`} view={sourceView} />
  if (view === undefined) {
    return <p data-testid="result-evidence-empty">请选择一条来源以查看其依据。</p>
  }
  const readability = readabilityOf(view)
  return (
    <section
      className="result-workbench__evidence"
      data-testid="result-evidence"
      data-readability={readability}
    >
      <EvidenceSummary evidence={view} />
      <details className="project-audit">
        <summary>证据标识与类型</summary>
        <p data-testid="result-evidence-id">{view.evidenceId}</p>
        <p data-testid="result-evidence-kind">
          {view.kind} · {view.dataMode}
        </p>
      </details>
      <p data-testid="result-evidence-outcome" data-outcome={view.outcome}>
        结果：{view.outcome === 'verifiable' ? '可核验' : '不可核验'}
        {view.asOf === undefined ? '' : ` · 历史时点 ${view.asOf}`}
      </p>
      <ul data-testid="result-evidence-sources">
        {view.sources.map((source, index) => (
          <li
            key={`${source.sourceRef.namespace}:${source.sourceRef.sourceId}:${index}`}
            data-readability={source.reReadability}
          >
            {source.sourceRef.sourceId} ·{' '}
            {source.reReadability === 're_readable'
              ? '可重读原始来源'
              : source.reReadability === 'archived_snapshot_only'
                ? '仅归档快照'
                : '来源不可用'}
          </li>
        ))}
      </ul>
    </section>
  )
}

function HistoryView({
  state,
  onSelect,
  selectedRunId,
}: {
  readonly state: { readonly view?: ResultHistoryView; readonly loading: boolean; readonly error?: string }
  readonly onSelect: (entry: ResultHistoryView['entries'][number]) => void
  readonly selectedRunId: string
}) {
  if (state.loading) return <p data-testid="history-loading">正在读取结果修订历史…</p>
  if (state.error !== undefined) {
    return (
      <p data-testid="history-error" role="alert">
        读取结果修订历史失败：{state.error}
      </p>
    )
  }
  if (state.view === undefined) return null
  return (
    <section
      className="result-workbench__history"
      data-testid="result-history"
      data-logical-key={state.view.logicalKey}
    >
      <p data-testid="history-current" data-answer-id={state.view.currentAnswerId}>
        当前结果版本已标记
        {state.view.projectRevision === undefined ? '' : ` · 项目修订 ${state.view.projectRevision}`}
      </p>
      <ul className="project-history-list">
        {state.view.entries.map((entry) => (
          <li
            key={entry.answerId}
            data-testid="history-revision"
            data-read-kind={entry.readKind}
            data-answer-id={entry.answerId}
            data-run-id={entry.runId}
            data-content-hash={entry.contentHash}
          >
            <button
              type="button"
              aria-current={entry.runId === selectedRunId ? 'true' : undefined}
              onClick={() => onSelect(entry)}
            >
              修订 {entry.revisionIndex} · {entry.label}
              <small>
                {entry.publishedAt} · {entry.publicationKind === 'history_limited' ? '历史受限' : '已核验'} ·
                固定版本读取
              </small>
            </button>
            <details className="project-audit">
              <summary>版本标识</summary>
              <code>{entry.contentHash}</code>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ResultWorkbenchPanel({
  source,
  runId,
  initialTab = 'body',
  initialTableId,
  resolveLabel,
  onOpenEvidence,
}: ResultWorkbenchPanelProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [tab, setTab] = useState<ResultWorkbenchTab>(initialTab)
  const [tableId, setTableId] = useState<string | undefined>(initialTableId)
  const [tableState, setTableState] = useState<{
    page?: VerifiedTablePageView
    loading: boolean
    error?: string
    blocked?: string
  }>({ loading: false })
  const [evidenceRef, setEvidenceRef] = useState<ResourceRef | undefined>()
  const [evidenceState, setEvidenceState] = useState<{
    view?: ProvenanceEvidenceView
    sourceView?: AnswerSourceView
    loading: boolean
    error?: string
  }>({ loading: false })
  const [historyState, setHistoryState] = useState<{
    view?: ResultHistoryView
    loading: boolean
    error?: string
  }>({ loading: false })
  const [exportState, setExportState] = useState<{
    data?: VerifiedResultExport
    loading: boolean
    error?: string
  }>({ loading: false })
  const [reloadNonce, setReloadNonce] = useState(0)
  const [historySelection, setHistorySelection] = useState<{
    owner: string
    runId: string
    answerId: string
    contentHash: string
  }>()
  const selection = historySelection?.owner === runId ? historySelection : undefined
  const selectedRunId = selection?.runId ?? runId
  const scope = useMemo(() => ({ source, selectedRunId, reloadNonce }), [source, selectedRunId, reloadNonce])
  const [loadedScope, setLoadedScope] = useState<unknown>()
  const beginRequest = useRequestFence(scope)
  const autoLoadedFor = useRef<string | undefined>(undefined)

  useEffect(() => {
    const request = beginRequest('result')
    setLoad({ status: 'loading' })
    setTableState({ loading: false })
    setEvidenceState({ loading: false })
    setEvidenceRef(undefined)
    setHistoryState({ loading: false })
    setExportState({ loading: false })
    setTableId(initialTableId)
    autoLoadedFor.current = undefined
    void source
      .loadResult(selectedRunId)
      .then((result) => {
        if (!request.current()) return
        if (
          result.kind === 'verified' &&
          (result.answer.answerId !== result.view.answerId ||
            result.view.runId !== selectedRunId ||
            (selection !== undefined &&
              (result.view.answerId !== selection.answerId ||
                result.view.contentHash !== selection.contentHash)))
        ) {
          setLoad({
            status: 'ready',
            load: {
              kind: 'blocked',
              code: 'REVISION_CHANGED',
              message: '读取到的版本与所选结果不一致，请重新选择历史版本。',
            },
          })
          return
        }
        setLoad({ status: 'ready', load: result })
        setLoadedScope(scope)
      })
      .catch((error: unknown) => {
        if (request.current()) setLoad({ status: 'error', failure: classifyPublicError(error) })
      })
  }, [source, selectedRunId, selection, initialTableId, beginRequest, scope])

  const verified = loadedScope === scope && load.status === 'ready' ? resultOf(load.load) : undefined
  const answerId = verified?.answer.answerId
  const tables = verified?.view.tables ?? []

  const openTablePage = useCallback(
    async (nextTableId: string, cursor?: string) => {
      if (answerId === undefined || verified === undefined) return
      const request = beginRequest('table')
      const summary = tables.find((table) => table.tableId === nextTableId)
      if (summary === undefined || summary.verificationReceiptRef === undefined) {
        setTableState({ loading: false, blocked: nextTableId })
        return
      }
      setTableState({ loading: true })
      try {
        const page = await source.loadTablePage(answerId, nextTableId, cursor)
        if (!request.current()) return
        if (
          page.answerId !== answerId ||
          page.tableId !== nextTableId ||
          page.resultManifestDigest !== (summary.tableManifestDigest ?? verified?.view.resultManifestDigest) ||
          !sameRef(page.resultManifestRef, summary.tableManifestRef ?? verified.view.resultManifestRef) ||
          !sameRef(page.tableVerificationReceiptRef, summary.verificationReceiptRef)
        ) {
          setTableState({ loading: false, error: '结果表版本或核验回执发生变化，已停止展示。' })
          return
        }
        setTableState({ page, loading: false })
      } catch (error) {
        if (request.current()) setTableState({ loading: false, error: errorMessage(error) })
      }
    },
    [answerId, source, tables, verified, beginRequest],
  )

  useEffect(() => {
    if (verified === undefined || answerId === undefined) return
    if (autoLoadedFor.current === answerId) return
    const first = initialTableId ?? verified.view.tables[0]?.tableId
    if (first === undefined) return
    autoLoadedFor.current = answerId
    setTableId(first)
    void openTablePage(first)
  }, [verified, answerId, initialTableId, openTablePage])

  const selectEvidence = useCallback(
    async (ref: ResourceRef, selector?: SavedCellSelector) => {
      const request = beginRequest('evidence')
      setEvidenceRef(ref)
      setEvidenceState({ loading: true })
      try {
        if (source.loadSource !== undefined && verified !== undefined) {
          if (ref.kind !== 'evidence') throw new Error('请从该陈述的证据来源查看原文与原始单元格。')
          const sourceView = boundAnswerSource(
            await source.loadSource(verified.answer, ref, request.signal, selector),
            verified.answer,
            ref,
            selector,
          )
          if (request.current()) setEvidenceState({ loading: false, sourceView })
        } else {
          const view = await source.loadEvidence(ref)
          if (request.current()) setEvidenceState({ loading: false, view })
        }
      } catch (error) {
        if (request.current()) setEvidenceState({ loading: false, error: errorMessage(error) })
      }
    },
    [source, verified, beginRequest],
  )

  const loadHistory = useCallback(async () => {
    if (historyState.view !== undefined || historyState.loading) return
    const request = beginRequest('history')
    setHistoryState({ loading: true })
    try {
      const view = await source.loadHistory(runId)
      if (request.current()) setHistoryState({ loading: false, view })
    } catch (error) {
      if (request.current()) setHistoryState({ loading: false, error: errorMessage(error) })
    }
  }, [source, runId, historyState.view, historyState.loading, beginRequest])

  const requestExport = useCallback(async () => {
    const request = beginRequest('export')
    setExportState({ loading: true })
    try {
      const data = await source.requestExport(selectedRunId)
      if (!request.current()) return
      if (data.versions.answerId !== answerId || data.versions.contentHash !== verified?.view.contentHash)
        throw new Error('导出版本与当前所选结果不一致。')
      setExportState({ loading: false, data })
    } catch (error) {
      if (request.current()) setExportState({ loading: false, error: errorMessage(error) })
    }
  }, [source, selectedRunId, answerId, verified, beginRequest])

  const openEvidence = onOpenEvidence
  const handleEvidence = (ref: ResourceRef, selector?: SavedCellSelector) => {
    void selectEvidence(ref, selector)
    // Keep the selected result and its scroll position while the source drawer is open.
  }

  const exportHref =
    exportState.data === undefined
      ? undefined
      : `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(exportState.data))}`

  return (
    <section
      className="result-workbench project-page"
      data-testid="result-workbench"
      data-run-id={selectedRunId}
    >
      {selection === undefined ? null : (
        <div className="project-notice">
          正在读取所选历史版本。<Button onClick={() => setHistorySelection(undefined)}>返回本次运行</Button>
        </div>
      )}
      {load.status === 'loading' ? <p data-testid="result-loading">正在读取已核验结果…</p> : null}
      {load.status === 'error' ? (
        <PublicStateNotice
          testId="result-error"
          failure={load.failure}
          onRecover={() => setReloadNonce((previous) => previous + 1)}
        />
      ) : null}
      {load.status === 'ready' && load.load.kind === 'in_progress' ? (
        <p data-testid="result-in-progress">运行尚未结束（{load.load.state}）：没有可展示的已核验结果。</p>
      ) : null}
      {load.status === 'ready' && load.load.kind === 'unavailable' ? (
        <p data-testid="result-unavailable" data-code={load.load.code}>
          该运行没有已核验结果：{load.load.message}
        </p>
      ) : null}
      {load.status === 'ready' && load.load.kind === 'blocked' ? (
        <p data-testid="result-blocked" data-code={load.load.code} role="alert">
          已核验结果被拒绝展示：{load.load.message}
        </p>
      ) : null}

      {verified === undefined ? null : (
        <>
          <header className="result-workbench__meta">
            <h3 data-testid="result-publication-kind">
              {verified.view.publicationKind === 'history_limited' ? '历史受限已核验结果' : '已核验结果'}
            </h3>
            <p data-testid="result-validity" data-state={verified.view.currentValidity.state}>
              有效性：
              {VALIDITY_LABELS[verified.view.currentValidity.state] ?? verified.view.currentValidity.state}
              {verified.view.currentValidity.reason === undefined
                ? ''
                : `（${verified.view.currentValidity.reason}）`}
            </p>
            <p data-testid="result-domain-status">领域状态：{verified.view.domainStatus}</p>
            <p data-testid="result-coverage" data-truncated={verified.view.coverage.truncated}>
              覆盖：返回 {verified.view.coverage.returned} 条
              {verified.view.coverage.truncated ? '（已截断，非完整）' : ''}
            </p>
            <details className="project-audit">
              <summary>核验与版本信息</summary>
              <p data-testid="result-content-hash">
                <code>{verified.view.contentHash}</code>
              </p>
              <p>
                运行：<code>{selectedRunId}</code>
              </p>
            </details>
            <div className="result-workbench__export">
              <button
                type="button"
                data-testid="result-export"
                disabled={exportState.loading}
                onClick={() => void requestExport()}
              >
                导出 JSON
              </button>
              {exportState.error === undefined ? null : (
                <span data-testid="result-export-error" role="alert">
                  导出失败：{exportState.error}
                </span>
              )}
              {exportState.data === undefined ? null : (
                <span
                  data-testid="result-export-view"
                  data-content-hash={exportState.data.versions.contentHash}
                  data-answer-id={exportState.data.versions.answerId}
                >
                  export@{exportState.data.schemaVersion} · {exportState.data.versions.contentHash}
                  {exportHref === undefined ? null : (
                    <a
                      data-testid="result-export-download"
                      download={`verified-result-${runId}.json`}
                      href={exportHref}
                    >
                      下载
                    </a>
                  )}
                </span>
              )}
            </div>
            {verified.view.limitations.length === 0 ? null : (
              <ul data-testid="result-limitations">
                {verified.view.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            )}
          </header>

          <nav className="result-workbench__tabs project-local-tabs" aria-label="结果视图">
            {(['body', 'tables', 'evidence', 'history'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                data-testid={`result-tab-${entry}`}
                data-active={tab === entry}
                aria-current={tab === entry ? 'page' : undefined}
                onClick={() => {
                  setTab(entry)
                  if (entry === 'history') void loadHistory()
                }}
              >
                {TAB_LABELS[entry]}
              </button>
            ))}
          </nav>

          {tab === 'body' ? (
            <div data-testid="result-body">
              <PublishedAnswerBody
                answer={verified.answer as PublishedAnswer}
                {...(source.loadSource === undefined ? {} : { loadSource: source.loadSource })}
                {...(resolveLabel === undefined || selection !== undefined ? {} : { resolveLabel })}
                onEvidenceReference={handleEvidence}
              />
            </div>
          ) : null}

          {tab === 'tables' ? (
            <div data-testid="result-tables">
              {tables.length === 0 ? (
                <p data-testid="result-tables-empty">该结果没有正式结果表。</p>
              ) : (
                <>
                  <ul className="result-workbench__table-tabs" data-testid="result-table-tabs">
                    {tables.map((table) => (
                      <li key={table.tableId}>
                        <button
                          type="button"
                          data-testid={`result-table-tab-${table.tableId}`}
                          data-active={tableId === table.tableId}
                          onClick={() => {
                            setTableId(table.tableId)
                            void openTablePage(table.tableId)
                          }}
                        >
                          {table.tableId}（{table.totalRows} 行）
                        </button>
                      </li>
                    ))}
                  </ul>
                  {tableId === undefined ? null : (
                    <>
                      <TableView state={tableState} tableId={tableId} onOpenEvidence={handleEvidence} />
                      {tableState.page?.cursor === undefined ? null : (
                        <button
                          type="button"
                          data-testid="result-table-next"
                          disabled={tableState.loading}
                          onClick={() => void openTablePage(tableId, tableState.page?.cursor)}
                        >
                          下一页
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          ) : null}

          {tab === 'evidence' ? (
            <div data-testid="result-evidence-tab">
              {evidenceRef === undefined ? (
                <p data-testid="result-evidence-hint">
                  从结果表或正文中选择一条来源，查看其当前/历史/缺失状态。可用来源：
                  {collectEvidenceRefs(tableState.page).length === 0 ? '（先在结果表页选择）' : ''}
                </p>
              ) : null}
              <EvidenceView {...evidenceState} />
            </div>
          ) : null}

          {tab === 'history' ? (
            <div data-testid="result-history-tab">
              <HistoryView
                state={historyState}
                selectedRunId={selectedRunId}
                onSelect={(entry) => {
                  setHistorySelection({
                    owner: runId,
                    runId: entry.runId,
                    answerId: entry.answerId,
                    contentHash: entry.contentHash,
                  })
                  setTab('body')
                }}
              />
            </div>
          ) : null}
        </>
      )}
      <Drawer
        open={loadedScope === scope && evidenceRef !== undefined}
        title="结果依据"
        onClose={() => setEvidenceRef(undefined)}
      >
        <EvidenceView {...evidenceState} />
        {onOpenEvidence === undefined || evidenceRef === undefined ? null : (
          <Button variant="quiet" onClick={() => openEvidence?.(evidenceRef)}>
            查看完整依赖与历史
          </Button>
        )}
      </Drawer>
    </section>
  )
}
