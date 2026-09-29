import { useCallback, useEffect, useReducer, useState } from 'react'
import type {
  DependencyGraphView,
  EvidenceDependencyDirection,
  EvidenceDependencySupportState,
  HistoricalAssertionView,
  ProvenanceEvidenceView,
  ResourceRef,
  SourceReReadability,
} from '@ontology/contracts'
import { ApiError } from '../api/errors'
import type { WorkbenchClient } from '../api/client'
import { evidenceReducer, initialEvidenceState } from '../state/evidence'
import type { EvidenceEvent } from '../state/evidence'
import type { WorkbenchError } from '../state/workbench'
import { StatePanel } from './StatePanel'
import { useViewport } from './useViewport'

/**
 * The on-demand provenance and history surface (US-017/US-022, FR-19/FR-30, SPEC C6/C3.1/C4).
 *
 * It expands a conclusion into the evidence the server actually holds — the rule, the AND
 * premise groups (with "other equivalent supports" preserved), the source snapshots and their
 * re-readability — and pages the real dependency graph on demand. It deliberately renders
 * explicit server fields only: there is no fabricated chain-of-thought, and a truncated
 * traversal is shown as truncated rather than as a complete graph.
 */
export interface EvidencePanelProps {
  readonly client: WorkbenchClient
  /** Deep-linked evidence id (`?evidence=<id>`). */
  readonly initialEvidenceId?: string
  /** Exact source ref selected from a verified answer body. */
  readonly initialReference?: ResourceRef
  /** Deep-linked object id for the history view (`?object=<id>`). */
  readonly initialObjectId?: string
}

const REREADABILITY_LABEL: Readonly<Record<SourceReReadability, string>> = {
  re_readable: '原来源可重读',
  archived_snapshot_only: '仅归档快照（原来源不保证可重读）',
  unverifiable: '不可验证（原来源与归档均不可用）',
}

const SUPPORT_STATE_LABEL: Readonly<Record<EvidenceDependencySupportState, string>> = {
  not_rule: '直接证据，不适用规则支撑',
  resolved: '支撑来源已解析',
  not_applicable: '规则不适用，未提供正向支撑',
  unknown: '支撑状态未知',
  conflict: '支撑状态冲突',
  ambiguous: '匹配到多个规则实例，无法唯一定位',
  unavailable: '不可变支撑记录不可用',
  incomplete: '支撑记录不完整',
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'the request could not be completed',
  }
}

function failureEvent(error: unknown): EvidenceEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toError(error) }
  }
  if (error instanceof ApiError && error.code === 'CAPABILITY_NOT_CONFIGURED') {
    return { type: 'notConfigured', error: toError(error) }
  }
  return { type: 'failed', error: toError(error) }
}

function historyFailureEvent(error: unknown): EvidenceEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toError(error) }
  }
  return { type: 'historyFailed', error: toError(error) }
}

function graphFailureEvent(error: unknown): EvidenceEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toError(error) }
  }
  return { type: 'graphFailed', error: toError(error) }
}

function BasisPanel({ evidence }: { readonly evidence: ProvenanceEvidenceView }) {
  return (
    <section className="evidence__basis" data-testid="evidence-basis" data-outcome={evidence.outcome}>
      <h3>实际依据（服务端记录）</h3>
      <p className="evidence__note" data-testid="basis-note">
        仅展示服务端提供的依据（规则、前提组、来源快照定位），不展示模型思维链。
      </p>
      <dl className="evidence__facts">
        <dt>结论 ID</dt>
        <dd data-testid="basis-evidence-id">{evidence.evidenceId}</dd>
        <dt>结论类型</dt>
        <dd data-testid="basis-kind">{evidence.kind}</dd>
        <dt>数据模式</dt>
        <dd data-testid="basis-data-mode">{evidence.dataMode}</dd>
        <dt>可验证性</dt>
        <dd data-testid="basis-outcome">{evidence.outcome}</dd>
        <dt>完整性摘要校验</dt>
        <dd data-testid="basis-integrity">{String(evidence.integrityVerified)}</dd>
        <dt>记录时间</dt>
        <dd data-testid="basis-recorded-at">{evidence.recordedAt}</dd>
        <dt>观测时间</dt>
        <dd data-testid="basis-observed-at">{evidence.observedAt}</dd>
        <dt>结果摘要</dt>
        <dd data-testid="basis-result-digest">{evidence.resultDigest}</dd>
        {evidence.producedBy.runId === undefined ? null : (
          <>
            <dt>产生运行</dt>
            <dd data-testid="basis-run">{evidence.producedBy.runId}</dd>
          </>
        )}
      </dl>
      {evidence.reason === undefined ? null : (
        <p className="evidence__unverifiable" data-testid="basis-reason" role="alert">
          不可验证原因：{evidence.reason}
        </p>
      )}

      <h4>规则</h4>
      {evidence.ruleRefs.length === 0 ? (
        <p data-testid="rule-none">直接观测，无规则推导。</p>
      ) : (
        <ul className="evidence__rules" data-testid="rule-refs">
          {evidence.ruleRefs.map((rule) => (
            <li key={`${rule.id}@${rule.version}`} data-testid="rule-ref">
              规则 {rule.id}@{rule.version}
            </li>
          ))}
        </ul>
      )}

      <section className="evidence__support" data-testid="support-resolution"
        data-state={evidence.supportResolution?.state ?? 'unknown'}
        data-complete={evidence.supportResolution?.complete ?? false}>
        <h4>规则支撑完整性</h4>
        <p data-testid="support-resolution-state">
          {evidence.supportResolution === undefined
            ? '服务端未报告规则支撑完整性'
            : `${SUPPORT_STATE_LABEL[evidence.supportResolution.state]}（${evidence.supportResolution.complete ? '完整' : '不完整'}）`}
        </p>
        {evidence.supportResolution?.reason === undefined ? null : (
          <p data-testid="support-resolution-reason">{evidence.supportResolution.reason}</p>
        )}
      </section>

      <h4>前提组（AND of OR）</h4>
      {evidence.premiseGroups.length === 0 ? (
        <p data-testid="premise-none">无规则前提组。</p>
      ) : (
        <ul className="evidence__premises" data-testid="premise-groups">
          {evidence.premiseGroups.map((group) => (
            <li key={group.groupId} data-testid="premise-group" data-alternatives={group.alternativeEvidenceIds.length}>
              前提组 {group.groupId}：
              {group.alternativeEvidenceIds.map((id) => (
                <span key={id} className="evidence__premise-id" data-testid="premise-evidence">
                  {id}
                </span>
              ))}
              {group.alternativeEvidenceIds.length > 1 ? (
                <span className="evidence__alternatives" data-testid="premise-alternatives">
                  另有等价依据（{group.alternativeEvidenceIds.length - 1} 条），撤回一条不会删除结论。
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4>来源快照（SQL / 文档定位与可重读性）</h4>
      {evidence.sources.length === 0 ? (
        <p data-testid="source-none">无来源快照。</p>
      ) : (
        <ul className="evidence__sources" data-testid="source-snapshots">
          {evidence.sources.map((source) => (
            <li
              key={`${source.sourceRef.namespace}:${source.sourceRef.sourceId}:${source.readAt}`}
              data-testid="source-snapshot"
              data-rereadability={source.reReadability}
            >
              <p className="evidence__locator" data-testid="source-locator">
                定位：{source.sourceRef.namespace}://{source.sourceRef.sourceId} · schema {source.schemaVersion}
              </p>
              <p data-testid="source-read-at">
                读取时间：{source.readAt} · 一致性：{source.consistency}
              </p>
              <p className="evidence__reread" data-testid="source-rereadability">
                {REREADABILITY_LABEL[source.reReadability]}
              </p>
              {source.reason === undefined ? null : (
                <p className="evidence__reread-reason" data-testid="source-reread-reason">
                  {source.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p data-testid="original-source-rereadable" data-rereadable={evidence.originalSourceReReadable}>
        所有已列来源证据均可复核（含归档快照）：{evidence.originalSourceReReadable ? '是' : '否'}
      </p>
      {evidence.archivedResult === undefined ? null : (
        <p data-testid="archived-result" data-verified={evidence.archivedResult.verified}>
          归档结果工件：{evidence.archivedResult.verified ? '已校验' : '缺失或损坏'}
        </p>
      )}
    </section>
  )
}

function GraphPanel({
  graph,
  graphPages,
  graphCursor,
  graphError,
  busy,
  direction,
  depth,
  onDirection,
  onDepth,
  onLoad,
}: {
  readonly graph: DependencyGraphView | undefined
  readonly graphPages: number
  readonly graphCursor: string | undefined
  readonly graphError: WorkbenchError | undefined
  readonly busy: boolean
  readonly direction: EvidenceDependencyDirection
  readonly depth: number
  readonly onDirection: (direction: EvidenceDependencyDirection) => void
  readonly onDepth: (depth: number) => void
  readonly onLoad: (append: boolean) => void
}) {
  return (
    <section className="evidence__graph" data-testid="evidence-graph">
      <h3>证据依赖图（按需分页）</h3>
      <label className="evidence__field">
        <span>方向</span>
        <select
          data-testid="graph-direction"
          value={direction}
          onChange={(event) => onDirection(event.target.value === 'inbound' ? 'inbound' : 'outbound')}
        >
          <option value="outbound">outbound（该结论依赖谁）</option>
          <option value="inbound">inbound（谁依赖该结论）</option>
        </select>
      </label>
      <label className="evidence__field">
        <span>深度</span>
        <input
          type="number"
          min={0}
          data-testid="graph-depth"
          value={depth}
          onChange={(event) => onDepth(Number(event.target.value))}
        />
      </label>
      <button type="button" data-testid="load-graph" disabled={busy} onClick={() => onLoad(false)}>
        加载依赖图
      </button>

      {graphError === undefined ? null : (
        <p className="evidence__error" data-testid="graph-error" data-code={graphError.code} role="alert">
          依赖图不可读（{graphError.code}）：{graphError.message}
        </p>
      )}

      {graph === undefined ? null : (
        <>
          <p data-testid="graph-meta">
            根 {graph.rootEvidenceId} · 方向 {graph.direction} · 深度 {graph.depth} · 已加载 {graphPages} 页 · 节点{' '}
            {graph.nodes.length} · 边 {graph.edges.length}
          </p>

          {graph.coverage.truncated ? (
            <p className="evidence__truncated" data-testid="graph-truncated" role="alert">
              遍历已截断：本页不是完整依赖图，不能据此判断“不存在其他依据”。返回 {graph.coverage.returned}
              {graph.coverage.knownTotal === undefined ? '' : ` / 共 ${graph.coverage.knownTotal}`}。
            </p>
          ) : (
            <p className="evidence__complete" data-testid="graph-complete" role="status">
              遍历已覆盖请求深度与页大小，未截断。
            </p>
          )}

          <section className="evidence__support-coverage" data-testid="graph-support-coverage"
            data-complete={graph.coverage.support?.complete ?? false}>
            <h4>规则支撑覆盖</h4>
            <p data-testid="graph-support-completeness">
              {graph.coverage.support === undefined
                ? '服务端未报告规则支撑完整性'
                : graph.coverage.support.complete
                  ? '已访问节点的规则支撑来源均已完整解析。'
                  : '部分节点的规则支撑未知或不完整，不能据此判断不存在其他依据。'}
            </p>
            {graph.coverage.support === undefined ? null : (
              <ul data-testid="graph-support-resolutions">
                {graph.coverage.support.resolutions.map((entry) => (
                  <li key={entry.evidenceId} data-testid="graph-support-resolution"
                    data-state={entry.resolution.state} data-complete={entry.resolution.complete}>
                    {entry.evidenceId}：{SUPPORT_STATE_LABEL[entry.resolution.state]}
                    {entry.resolution.reason === undefined ? '' : `（${entry.resolution.reason}）`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ul className="evidence__nodes" data-testid="graph-nodes" data-count={graph.nodes.length}>
            {graph.nodes.map((node) => (
              <li key={node.evidenceId} data-testid="graph-node" data-outcome={node.outcome} data-depth={node.depth}>
                深度 {node.depth} · {node.evidenceId}
                {node.kind === undefined ? '' : ` · ${node.kind}`}
                {node.outcome === 'unverifiable' ? '（不可验证）' : ''}
              </li>
            ))}
          </ul>

          <ul className="evidence__edges" data-testid="graph-edges" data-count={graph.edges.length}>
            {graph.edges.map((edge) => (
              <li
                key={`${edge.fromEvidenceId}->${edge.toEvidenceId}:${edge.relation}:${edge.origin}`}
                data-testid="graph-edge"
                data-origin={edge.origin}
              >
                {edge.fromEvidenceId} → {edge.toEvidenceId}（{edge.relation} / {edge.origin}）
              </li>
            ))}
          </ul>

          {graphCursor === undefined ? null : (
            <button type="button" data-testid="load-more-graph" disabled={busy} onClick={() => onLoad(true)}>
              加载更多（cursor）
            </button>
          )}
        </>
      )}
    </section>
  )
}

function AssertionRow({ assertion }: { readonly assertion: HistoricalAssertionView }) {
  return (
    <li data-testid="history-assertion" data-status={assertion.status} data-version={assertion.version}>
      <span data-testid="assertion-version">版本 {assertion.version}</span>
      <span data-testid="assertion-status"> · {assertion.status}</span>
      {assertion.revisionKind === undefined ? null : (
        <span data-testid="assertion-revision-kind"> · {assertion.revisionKind}</span>
      )}
      <span data-testid="assertion-value"> · {JSON.stringify(assertion.value)}</span>
      <span data-testid="assertion-recorded-at"> · 记录于 {assertion.recordedAt}</span>
      {assertion.revisionReason === undefined ? null : (
        <span data-testid="assertion-reason"> · 理由 {assertion.revisionReason}</span>
      )}
    </li>
  )
}

export function EvidencePanel({ client, initialEvidenceId, initialObjectId, initialReference }: EvidencePanelProps) {
  const viewport = useViewport()
  const [state, dispatch] = useReducer(evidenceReducer, undefined, initialEvidenceState)
  const [evidenceInput, setEvidenceInput] = useState(initialEvidenceId ?? (initialReference?.kind === 'evidence' ? initialReference.id : ''))
  const [asOfInput, setAsOfInput] = useState('')
  const [validAtInput, setValidAtInput] = useState('')
  const [objectInput, setObjectInput] = useState(initialObjectId ?? '')
  const [recordedAtInput, setRecordedAtInput] = useState('')
  const [historyValidAtInput, setHistoryValidAtInput] = useState('')
  const [baseVersion, setBaseVersion] = useState('')
  const [compareVersion, setCompareVersion] = useState('')

  const loadEvidence = useCallback(
    async (evidenceId: string, asOf: string, validAt: string) => {
      dispatch({
        type: 'evidenceLoadStarted',
        evidenceId,
        ...(asOf.trim().length === 0 ? {} : { asOf: asOf.trim() }),
        ...(validAt.trim().length === 0 ? {} : { validAt: validAt.trim() }),
      })
      try {
        const evidence = await client.getEvidence(evidenceId, {
          ...(asOf.trim().length === 0 ? {} : { asOf: asOf.trim() }),
          ...(validAt.trim().length === 0 ? {} : { validAt: validAt.trim() }),
        })
        dispatch({ type: 'evidenceLoaded', evidence })
      } catch (error) {
        dispatch(failureEvent(error))
      }
    },
    [client],
  )

  const loadGraph = useCallback(
    async (append: boolean) => {
      const evidenceId = state.evidenceId
      if (evidenceId === undefined) return
      dispatch({ type: 'graphLoadStarted' })
      try {
        const page = await client.getEvidenceDependencies(evidenceId, {
          direction: state.direction,
          depth: state.depth,
          ...(append && state.graphCursor !== undefined ? { cursor: state.graphCursor } : {}),
        })
        dispatch({
          type: 'graphLoaded',
          graph: page.graph,
          nextCursor: page.nextCursor ?? page.graph.coverage.cursor,
          append,
        })
      } catch (error) {
        dispatch(graphFailureEvent(error))
      }
    },
    [client, state.evidenceId, state.direction, state.depth, state.graphCursor],
  )

  const loadHistory = useCallback(
    async (objectId: string, recordedAt: string, validAt: string) => {
      dispatch({ type: 'historyLoadStarted', objectId })
      try {
        const page = await client.getObjectHistory(objectId, {
          ...(recordedAt.trim().length === 0 ? {} : { recordedAt: recordedAt.trim() }),
          ...(validAt.trim().length === 0 ? {} : { validAt: validAt.trim() }),
        })
        dispatch({ type: 'historyLoaded', view: page.view, nextCursor: page.nextCursor })
      } catch (error) {
        dispatch(historyFailureEvent(error))
      }
    },
    [client],
  )

  const selectedEvidenceId = initialEvidenceId ?? (initialReference?.kind === 'evidence' ? initialReference.id : undefined)
  useEffect(() => {
    if (selectedEvidenceId !== undefined) void loadEvidence(selectedEvidenceId, '', '')
  }, [selectedEvidenceId, loadEvidence])

  useEffect(() => {
    if (initialObjectId !== undefined) void loadHistory(initialObjectId, '', '')
  }, [initialObjectId, loadHistory])

  useEffect(() => {
    // With nothing deep-linked there is no request yet: an explicit empty/awaiting-input state.
    if (selectedEvidenceId === undefined && initialObjectId === undefined) dispatch({ type: 'awaitInput' })
  }, [selectedEvidenceId, initialObjectId])

  const phase = state.phase
  const evidence = state.evidence
  const historical = state.asOf !== undefined || state.validAt !== undefined

  return (
    <section
      className={`evidence evidence--${viewport}`}
      data-testid="evidence-panel"
      data-viewport={viewport}
      data-phase={phase}
    >
      <header className="panel__header">
        <h2>证据展开与历史对比</h2>
        <p className="panel__hint">
          从结论按需展开实际依据（规则、前提组、来源快照定位）与依赖图；大图分页并显式标注截断。历史版本始终可回看，
          依据变化会清除旧比较结果。
        </p>
      </header>

      {initialReference === undefined ? null : (
        <aside className="evidence__selected-ref" data-testid="selected-source-reference" data-kind={initialReference.kind}>
          <h3>答案来源引用</h3>
          <p><code>{initialReference.kind}:{initialReference.id}@{initialReference.version}</code></p>
          <p><code>{initialReference.digest}</code></p>
          {initialReference.kind === 'evidence' ? null : (
            <p data-testid="source-reference-viewer-unavailable">
              此引用已从答案精确保留；当前证据查看器仅展开已归档的 evidence 记录。
            </p>
          )}
        </aside>
      )}

      {phase === 'loading' || phase === 'not_configured' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel phase={phase} {...(state.error === undefined ? {} : { error: state.error })} />
      ) : null}

      {phase === 'empty' ? <StatePanel phase="empty" title="输入证据或对象 ID 开始" /> : null}

      {phase === 'empty' || phase === 'ready' ? (
        <div className="evidence__body">
          <section className="evidence__lookup" data-testid="evidence-lookup">
            <h3>展开结论依据</h3>
            <label className="evidence__field">
              <span>证据 ID</span>
              <input
                type="text"
                data-testid="evidence-id-input"
                value={evidenceInput}
                onChange={(event) => setEvidenceInput(event.target.value)}
              />
            </label>
            <label className="evidence__field">
              <span>历史系统版本 asOf（可选）</span>
              <input
                type="text"
                data-testid="evidence-asof-input"
                value={asOfInput}
                onChange={(event) => setAsOfInput(event.target.value)}
              />
            </label>
            <label className="evidence__field">
              <span>历史业务时间 validAt（可选）</span>
              <input
                type="text"
                data-testid="evidence-validat-input"
                value={validAtInput}
                onChange={(event) => setValidAtInput(event.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="load-evidence"
              disabled={state.busy || evidenceInput.trim().length === 0}
              onClick={() => void loadEvidence(evidenceInput.trim(), asOfInput, validAtInput)}
            >
              加载依据
            </button>
          </section>

          {evidence === undefined ? (
            <p className="evidence__prompt" data-testid="evidence-prompt">
              输入证据 ID 后加载，展开该结论的真实依据。
            </p>
          ) : (
            <>
              <p data-testid="evidence-scope" data-historical={historical}>
                {historical
                  ? `历史视图（asOf=${state.asOf ?? '—'}，validAt=${state.validAt ?? '—'}）`
                  : '当前视图'}
              </p>
              <BasisPanel evidence={evidence} />
              <GraphPanel
                graph={state.graph}
                graphPages={state.graphPages}
                graphCursor={state.graphCursor}
                graphError={state.graphError}
                busy={state.busy}
                direction={state.direction}
                depth={state.depth}
                onDirection={(direction) => dispatch({ type: 'setDirection', direction })}
                onDepth={(depth) => dispatch({ type: 'setDepth', depth })}
                onLoad={(append) => void loadGraph(append)}
              />
            </>
          )}

          <section className="evidence__history" data-testid="history-section">
            <h3>对象历史与版本对比</h3>
            <label className="evidence__field">
              <span>对象 ID</span>
              <input
                type="text"
                data-testid="object-id-input"
                value={objectInput}
                onChange={(event) => setObjectInput(event.target.value)}
              />
            </label>
            <label className="evidence__field">
              <span>历史系统版本 recordedAt（可选）</span>
              <input
                type="text"
                data-testid="history-recordedat-input"
                value={recordedAtInput}
                onChange={(event) => setRecordedAtInput(event.target.value)}
              />
            </label>
            <label className="evidence__field">
              <span>历史业务时间 validAt（可选）</span>
              <input
                type="text"
                data-testid="history-validat-input"
                value={historyValidAtInput}
                onChange={(event) => setHistoryValidAtInput(event.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="load-history"
              disabled={state.busy || objectInput.trim().length === 0}
              onClick={() => void loadHistory(objectInput.trim(), recordedAtInput, historyValidAtInput)}
            >
              加载历史
            </button>

            {state.historyError === undefined ? null : (
              <p className="evidence__error" data-testid="history-error" data-code={state.historyError.code} role="alert">
                历史不可读（{state.historyError.code}）：{state.historyError.message}
              </p>
            )}

            {state.history === undefined ? (
              <p data-testid="history-prompt">输入对象 ID 后加载，查看不可变的历史版本。</p>
            ) : (
              <>
                <p data-testid="history-meta">
                  对象 {state.history.objectId} · 版本 {state.history.assertions.length} 条
                  {state.history.coverage.truncated ? ' · 已截断' : ''}
                </p>
                {state.history.coverage.truncated ? (
                  <p className="evidence__truncated" data-testid="history-truncated" role="alert">
                    历史页已截断：还有更早/更多的版本未加载。
                  </p>
                ) : null}
                <ol className="evidence__assertions" data-testid="history-assertions" data-count={state.history.assertions.length}>
                  {state.history.assertions.map((assertion) => (
                    <AssertionRow key={`${assertion.statementId}:${assertion.version}`} assertion={assertion} />
                  ))}
                </ol>

                <div className="evidence__compare">
                  <label className="evidence__field">
                    <span>基准版本</span>
                    <input
                      type="text"
                      data-testid="base-version-input"
                      value={baseVersion}
                      onChange={(event) => setBaseVersion(event.target.value)}
                    />
                  </label>
                  <label className="evidence__field">
                    <span>对比版本</span>
                    <input
                      type="text"
                      data-testid="compare-version-input"
                      value={compareVersion}
                      onChange={(event) => setCompareVersion(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="compare-versions"
                    onClick={() => dispatch({ type: 'compareRequested', baseVersion, compareVersion })}
                  >
                    比较版本
                  </button>
                  <button type="button" data-testid="clear-comparison" onClick={() => dispatch({ type: 'compareCleared' })}>
                    清除比较
                  </button>
                </div>

                {state.comparison === undefined ? null : (
                  <div className="evidence__comparison" data-testid="history-comparison">
                    <h4>
                      版本 {state.comparison.baseVersion} → {state.comparison.compareVersion}
                    </h4>
                    {state.comparison.identical ? (
                      <p data-testid="comparison-identical">两版本字段一致。</p>
                    ) : (
                      <ul data-testid="comparison-changes">
                        {state.comparison.changes.map((change) => (
                          <li key={change.field} data-testid="comparison-change" data-field={change.field}>
                            {change.field}：{change.from} → {change.to}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          {state.notice === undefined ? null : (
            <p className="evidence__notice" data-testid="evidence-notice" role="status">
              {state.notice}
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}
