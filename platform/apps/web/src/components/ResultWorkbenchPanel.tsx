import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProvenanceEvidenceView, PublishedAnswer, ResourceRef } from '@ontology/contracts'
import type { ResultSource, VerifiedResultLoad, VerifiedTablePageView } from '../api/results'
import { PublishedAnswerBody } from './PublishedAnswerBody'
import type { PublishedAnswerLabelKind } from './PublishedAnswerBody'

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

export type ResultWorkbenchTab = 'body' | 'tables' | 'evidence'

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
  | { readonly status: 'error'; readonly message: string }

const TAB_LABELS: Readonly<Record<ResultWorkbenchTab, string>> = {
  body: '正文',
  tables: '结果表',
  evidence: '依据',
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

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function readabilityOf(view: ProvenanceEvidenceView | undefined): 'current' | 'historical' | 'missing' {
  if (view === undefined) return 'missing'
  if (view.outcome !== 'verifiable') return 'missing'
  if (view.originalSourceReReadable) return 'current'
  if (view.asOf !== undefined || view.validAt !== undefined) return 'historical'
  if (view.sources.some((source) => source.reReadability === 'archived_snapshot_only')) return 'historical'
  return 'missing'
}

function TableView({
  state,
  tableId,
  onOpenEvidence,
}: {
  readonly state: { readonly page?: VerifiedTablePageView; readonly loading: boolean; readonly error?: string; readonly blocked?: string }
  readonly tableId: string
  readonly onOpenEvidence?: (ref: ResourceRef) => void
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
    <div className="result-workbench__table" data-testid="result-table" data-page={page.pageIndex} data-pages={page.pageCount}>
      <p data-testid="result-table-coverage" data-truncated={page.coverage.truncated}>
        第 {page.pageIndex + 1}/{page.pageCount} 页 · 共 {page.totalRows} 行 · 返回 {page.coverage.returned} 行
        {page.complete ? '' : '（不完整）'}
      </p>
      <table>
        <thead>
          <tr>
            <th>行标识</th>
            {page.columns.map((column) => (
              <th key={column.columnRef}>{column.displayLabel ?? column.semanticPredicate}</th>
            ))}
            <th>依据</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr key={row.rowKey} data-testid="result-table-row" data-row-key={row.rowKey}>
              <td data-testid="result-table-subject">{row.subject ?? row.rowKey}</td>
              {page.columns.map((column) => (
                <td key={column.columnRef} data-testid={`result-table-cell-${column.columnRef}`}>
                  {cellText(row.cells[column.columnRef])}
                </td>
              ))}
              <td>
                {row.bindings.slice(0, 1).map((binding, index) => (
                  <button
                    key={`${binding.columnRef}:${index}`}
                    type="button"
                    data-testid="result-cell-evidence"
                    data-evidence-id={binding.evidenceRef.id}
                    onClick={() => onOpenEvidence?.(binding.evidenceRef)}
                  >
                    来源
                  </button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EvidenceView({
  view,
  loading,
  error,
}: {
  readonly view?: ProvenanceEvidenceView
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
  if (view === undefined) {
    return <p data-testid="result-evidence-empty">请选择一条来源以查看其依据。</p>
  }
  const readability = readabilityOf(view)
  return (
    <section className="result-workbench__evidence" data-testid="result-evidence" data-readability={readability}>
      <p data-testid="result-evidence-id">{view.evidenceId}</p>
      <p data-testid="result-evidence-kind">
        {view.kind} · {view.dataMode}
      </p>
      <p data-testid="result-evidence-outcome" data-outcome={view.outcome}>
        结果：{view.outcome === 'verifiable' ? '可核验' : '不可核验'}
        {view.asOf === undefined ? '' : ` · 历史时点 ${view.asOf}`}
      </p>
      <ul data-testid="result-evidence-sources">
        {view.sources.map((source, index) => (
          <li key={`${source.sourceRef.namespace}:${source.sourceRef.sourceId}:${index}`} data-readability={source.reReadability}>
            {source.sourceRef.sourceId} · {source.reReadability === 're_readable' ? '可重读原始来源' : source.reReadability === 'archived_snapshot_only' ? '仅归档快照' : '来源不可用'}
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
  const [tableState, setTableState] = useState<{ page?: VerifiedTablePageView; loading: boolean; error?: string; blocked?: string }>({ loading: false })
  const [evidenceRef, setEvidenceRef] = useState<ResourceRef | undefined>()
  const [evidenceState, setEvidenceState] = useState<{ view?: ProvenanceEvidenceView; loading: boolean; error?: string }>({ loading: false })
  const autoLoadedFor = useRef<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    void source
      .loadResult(runId)
      .then((result) => {
        if (!cancelled) setLoad({ status: 'ready', load: result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: errorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [source, runId])

  const verified = load.status === 'ready' ? resultOf(load.load) : undefined
  const answerId = verified?.answer.answerId
  const tables = verified?.view.tables ?? []

  const openTablePage = useCallback(
    async (nextTableId: string, cursor?: string) => {
      if (answerId === undefined) return
      const summary = tables.find((table) => table.tableId === nextTableId)
      if (summary !== undefined && summary.verificationReceiptRef === undefined) {
        setTableState({ loading: false, blocked: nextTableId })
        return
      }
      setTableState((previous) => ({
        loading: true,
        ...(previous.page === undefined ? {} : { page: previous.page }),
      }))
      try {
        const page = await source.loadTablePage(answerId, nextTableId, cursor)
        setTableState({ page, loading: false })
      } catch (error) {
        setTableState({ loading: false, error: errorMessage(error) })
      }
    },
    [answerId, source, tables],
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
    async (ref: ResourceRef) => {
      setEvidenceRef(ref)
      setTab('evidence')
      setEvidenceState({ loading: true })
      try {
        const view = await source.loadEvidence(ref)
        setEvidenceState({ loading: false, view })
      } catch (error) {
        setEvidenceState({ loading: false, error: errorMessage(error) })
      }
    },
    [source],
  )

  const openEvidence = onOpenEvidence
  const handleEvidence = (ref: ResourceRef) => {
    void selectEvidence(ref)
    openEvidence?.(ref)
  }

  return (
    <section className="result-workbench" data-testid="result-workbench" data-run-id={runId}>
      {load.status === 'loading' ? <p data-testid="result-loading">正在读取已核验结果…</p> : null}
      {load.status === 'error' ? (
        <p data-testid="result-error" role="alert">
          读取已核验结果失败：{load.message}
        </p>
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
              有效性：{VALIDITY_LABELS[verified.view.currentValidity.state] ?? verified.view.currentValidity.state}
              {verified.view.currentValidity.reason === undefined ? '' : `（${verified.view.currentValidity.reason}）`}
            </p>
            <p data-testid="result-domain-status">领域状态：{verified.view.domainStatus}</p>
            <p data-testid="result-coverage" data-truncated={verified.view.coverage.truncated}>
              覆盖：返回 {verified.view.coverage.returned} 条{verified.view.coverage.truncated ? '（已截断，非完整）' : ''}
            </p>
            <p data-testid="result-content-hash">{verified.view.contentHash}</p>
            {verified.view.limitations.length === 0 ? null : (
              <ul data-testid="result-limitations">
                {verified.view.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            )}
          </header>

          <nav className="result-workbench__tabs" aria-label="结果视图">
            {(['body', 'tables', 'evidence'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                data-testid={`result-tab-${entry}`}
                data-active={tab === entry}
                aria-current={tab === entry ? 'page' : undefined}
                onClick={() => setTab(entry)}
              >
                {TAB_LABELS[entry]}
              </button>
            ))}
          </nav>

          {tab === 'body' ? (
            <div data-testid="result-body">
              <PublishedAnswerBody
                answer={verified.answer as PublishedAnswer}
                {...(resolveLabel === undefined ? {} : { resolveLabel })}
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
        </>
      )}
    </section>
  )
}
