import type {
  ResearchCandidateReceiptSummary,
  ResearchCoverageGap,
  ResearchCoverageGapState,
  ResearchEvidenceItem,
  ResearchHumanTodo,
  ResearchHumanTodoKind,
} from '@ontology/contracts'
import type { CandidateSubmissionKind } from '@ontology/contracts'
import type { ResearchExecutionView, ResearchOutcome } from '../api/research'
import {
  RESEARCH_STOP_REASON_LABELS,
  RESEARCH_STATUS_LABELS,
  asResearchV2,
  hasNoArchivedSnapshot,
  isResearchActive,
  researchCanContinue,
  researchContinuationReason,
  researchOutcome,
} from '../api/research'
import { Button, StateFeedback, StatusBadge } from './ui'

/**
 * The running/terminal research activity view (design §3). It is reusable and honest: it shows the
 * persisted activity the server reports — searches, archived snapshots, submitted candidates, the
 * per-`mustCover` gaps, retrieval expressions, the read locations, candidate submit receipts and
 * failure codes — and it **never** renders the model's hidden reasoning or treats a planned step as
 * completed progress. At the end it presents the three product groups (candidate sources, candidate
 * assets, unresolved questions) from one entry.
 */
type Tone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ResearchProgressViewProps {
  readonly research: ResearchExecutionView
  readonly busy: boolean
  readonly onOpenGeneration?: () => void
  readonly onCancel: () => void
  readonly onRefresh: () => void
  /** Append a new run grounded in this run's products; only offered for a non-revivable ending. */
  readonly onContinue?: () => void
  readonly onNewRun: () => void
}

const OUTCOME_VIEW: Readonly<Record<Exclude<ResearchOutcome, 'active'>, { readonly label: string; readonly tone: Tone }>> = {
  awaiting_confirmation: { label: '等待人工确认来源', tone: 'warning' },
  completed: { label: '研究完成', tone: 'success' },
  partial: { label: '部分结果', tone: 'warning' },
  no_results: { label: '无结果', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
  failed: { label: '失败', tone: 'danger' },
}

const GAP_STATE_LABELS: Readonly<Record<ResearchCoverageGapState, string>> = {
  unresearched: '未查',
  material_found: '找到材料',
  conflicting: '有冲突',
  pending_confirmation: '待确认',
}

const CANDIDATE_KIND_LABELS: Readonly<Record<CandidateSubmissionKind, string>> = {
  source: '来源',
  definition: '定义',
  rule: '规则',
  action: '动作',
}

const LOCATOR_KIND_LABELS: Readonly<Record<ResearchEvidenceItem['locatorKind'], string>> = {
  web_page: '网页原文',
  document_span: '文档片段',
  table_row: '表格行',
  ontology_definition: '本体定义',
}

const HUMAN_TODO_LABELS: Readonly<Record<ResearchHumanTodoKind, string>> = {
  source_review: '待人工审核来源',
  candidate_review: '待人工审核候选',
  terminology_confirmation: '待确认术语含义',
  external_wait: '等待外部条件',
}

function toneOfStatus(research: ResearchExecutionView): Tone {
  const outcome = researchOutcome(research)
  if (outcome === 'active') return 'neutral'
  return OUTCOME_VIEW[outcome].tone
}

function isAssetReceipt(receipt: ResearchCandidateReceiptSummary): boolean {
  return receipt.kind !== 'source'
}

function GapRow({ gap }: { readonly gap: ResearchCoverageGap }) {
  return <li data-testid="research-coverage-gap" data-state={gap.state} data-kind={gap.kind}>
    <StatusBadge tone={gap.state === 'material_found' ? 'success' : gap.state === 'conflicting' ? 'danger' : gap.state === 'pending_confirmation' ? 'warning' : 'neutral'}>
      {GAP_STATE_LABELS[gap.state]}
    </StatusBadge>
    <strong>{gap.name}</strong>
    <span className="research-hint">证据 {gap.evidenceCount}</span>
    {gap.note === undefined ? null : <span className="research-hint">{gap.note}</span>}
  </li>
}

function EvidenceList({ evidence }: { readonly evidence: readonly ResearchEvidenceItem[] }) {
  if (evidence.length === 0) return <p className="research-hint" data-testid="research-evidence-empty">本轮还没有可回读的原文位置。</p>
  return <ul className="research-evidence" data-testid="research-evidence">
    {evidence.map((item, index) => <li key={`${item.sourceRef.id}:${index}`} data-testid="research-evidence-item" data-archived={item.archived} data-locator={item.locatorKind}>
      <span>{LOCATOR_KIND_LABELS[item.locatorKind]}</span>
      <code>{item.sourceRef.id}</code>
      <span className="research-hint">{item.archived ? '已归档，可回读原文' : '仅发现链接，未归档，不能作正式依据'}</span>
      <span className="research-hint">摘要 {item.digest.slice(0, 16)}…{item.parserVersion === undefined ? '' : ` · 解析版本 ${item.parserVersion}`}</span>
    </li>)}
  </ul>
}

function CandidateReceiptList({ receipts }: { readonly receipts: readonly ResearchCandidateReceiptSummary[] }) {
  if (receipts.length === 0) return <p className="research-hint" data-testid="research-receipts-empty">尚未提交候选资产。</p>
  return <ul className="research-receipts" data-testid="research-candidate-receipts">
    {receipts.map((receipt) => <li key={receipt.candidateId} data-testid="research-candidate-receipt" data-state={receipt.state} data-pending={receipt.pendingConfirmation}>
      <strong>{CANDIDATE_KIND_LABELS[receipt.kind]}</strong>
      <code>{receipt.candidateId}</code>
      <span className="research-hint">{receipt.state}{receipt.pendingConfirmation ? ' · 待来源确认' : ''}</span>
      {receipt.issueCodes.length === 0 ? null : <span className="research-hint" data-testid="research-receipt-issues">问题：{receipt.issueCodes.join('、')}</span>}
    </li>)}
  </ul>
}

function HumanTodoList({ todos }: { readonly todos: readonly ResearchHumanTodo[] }) {
  if (todos.length === 0) return null
  return <section data-testid="research-human-todos" aria-label="等待人工处理">
    <h4>工作流待人工</h4>
    <ul>{todos.map((todo) => <li key={todo.todoId} data-testid="research-human-todo" data-kind={todo.kind}>
      <strong>{HUMAN_TODO_LABELS[todo.kind]}</strong><span>{todo.message}</span>
    </li>)}</ul>
  </section>
}

export function ResearchProgressView({ research, busy, onOpenGeneration, onCancel, onRefresh, onContinue, onNewRun }: ResearchProgressViewProps) {
  const outcome = researchOutcome(research)
  const active = isResearchActive(research)
  const v2 = asResearchV2(research)
  const coverage = research.coverage
  const ending = outcome === 'active' ? undefined : OUTCOME_VIEW[outcome]
  const canGenerate = outcome === 'awaiting_confirmation' || outcome === 'completed'
  const canContinue = researchCanContinue(research)
  const gaps = v2?.coverageGaps ?? []
  const assetReceipts = (v2?.candidateReceipts ?? []).filter(isAssetReceipt)
  const unresolved = gaps.filter((gap) => gap.state !== 'material_found')
  const activity = active
    ? `正在继续检索与阅读；已完成检索 ${coverage.searchCalls} 次 · 归档 ${coverage.archivedSnapshots} 份 · 提出 ${research.candidateCount} 个候选`
    : `已完成检索 ${coverage.searchCalls} 次 · 归档 ${coverage.archivedSnapshots} 份 · 提出 ${research.candidateCount} 个候选`

  return <section className="research-progress" data-testid="research-progress" data-outcome={outcome} data-version={research.schemaVersion}>
    <header className="research-progress__head">
      <span data-testid="research-status"><StatusBadge tone={toneOfStatus(research)}>{RESEARCH_STATUS_LABELS[research.status]}</StatusBadge></span>
      <Button variant="quiet" onClick={onRefresh} disabled={busy} data-testid="research-refresh">刷新回读</Button>
      {active ? <Button variant="danger" onClick={onCancel} disabled={busy} data-testid="research-cancel">停止调研</Button> : null}
      {canContinue && onContinue !== undefined ? <Button variant="primary" onClick={onContinue} disabled={busy} data-testid="research-continue">基于已有结果追加调研</Button> : null}
      <Button variant="quiet" onClick={onNewRun} disabled={busy} data-testid="research-restart">新建研究</Button>
    </header>

    <p className="research-activity" data-testid="research-activity" aria-live="polite">{activity}</p>
    <p className="research-hint" data-testid="research-no-thinking">以下只展示可核对的活动、用量与缺口，不展示模型的隐藏思维过程。</p>

    {ending === undefined ? null : <p className="research-ending" data-testid="research-ending" data-outcome={outcome}>
      <strong>{ending.label}</strong>
      {research.stopReason === undefined ? null : `：停止原因 ${RESEARCH_STOP_REASON_LABELS[research.stopReason]}`}
      {outcome === 'no_results' ? '。本次检索没有任何可归档的快照，未产生来源候选。' : null}
      {outcome === 'cancelled' ? '。已提交的候选保留；取消后的迟到结果不会恢复或入库。' : null}
      {outcome === 'failed' ? '。已覆盖的范围与缺口会保留；可用同一来源追加调研。' : null}
    </p>}

    <dl className="research-counts" data-testid="research-counts">
      <div><dt>来源候选</dt><dd data-testid="research-source-count">{research.sourceCount}</dd></div>
      <div><dt>已生成候选</dt><dd data-testid="research-candidate-count">{research.candidateCount}</dd></div>
      <div><dt>检索调用</dt><dd>{coverage.searchCalls}</dd></div>
      <div><dt>已归档快照</dt><dd data-testid="research-archived-snapshots">{coverage.archivedSnapshots}</dd></div>
      <div><dt>仅发现链接（无快照）</dt><dd data-testid="research-skipped-without-snapshot">{coverage.skippedWithoutSnapshot}</dd></div>
      <div><dt>失败</dt><dd>{coverage.failedCount}</dd></div>
      <div><dt>结果被截断</dt><dd>{coverage.truncated ? '是' : '否'}</dd></div>
    </dl>

    {hasNoArchivedSnapshot(coverage) ? <p className="research-hint" data-testid="research-no-snapshot" role="note">
      本次没有任何已归档快照：仅发现的链接不能作为正式依据，也不会计入可纳入建模的来源。
    </p> : null}
    {coverage.skippedWithoutSnapshot > 0 ? <p className="research-hint" data-testid="research-links-only" role="note">
      有 {coverage.skippedWithoutSnapshot} 个页面仅发现链接、未归档快照，已标记为“仅发现链接，不能作正式依据”。
    </p> : null}

    <section className="research-coverage" data-testid="research-coverage" aria-label="按必须覆盖的问题呈现">
      <h4>覆盖情况（按必须覆盖的问题）</h4>
      {gaps.length === 0
        ? <p className="research-hint" data-testid="research-coverage-empty">本轮运行未按“必须覆盖的问题”逐项给出缺口（旧版记录不含该投影）；“找到材料”也≠已证明正确。</p>
        : <><ul className="research-gaps">{gaps.map((gap, index) => <GapRow key={`${gap.kind}:${gap.name}:${index}`} gap={gap} />)}</ul>
          <p className="research-hint">“找到材料”只表示定位到材料，不代表命题已证明正确；不使用无法解释的百分比。</p></>}
    </section>

    <details className="research-activity-detail" data-testid="research-activity-detail">
      <summary>查看本轮检索与来源</summary>
      <h4>候选来源</h4>
      {(research.sources ?? []).length === 0
        ? <p className="research-hint" data-testid="research-sources-empty">本轮尚未提出来源候选。</p>
        : <ul className="research-sources" data-testid="research-sources">
          {(research.sources ?? []).map((source) => <li key={source.sourceId} data-testid="research-source"><code>{source.sourceId}</code><span>{source.url}</span></li>)}
        </ul>}
      {v2 === undefined ? <p className="research-hint" data-testid="research-evidence-legacy">该记录使用旧版研究投影，未提供逐条证据与阅读位置。</p> : <EvidenceList evidence={v2.evidence} />}
      {v2 === undefined ? null : <dl className="research-usage" data-testid="research-usage">
        <div><dt>搜索次数</dt><dd>{v2.usage.searchCalls}</dd></div>
        <div><dt>归档份数</dt><dd>{v2.usage.archivedSnapshots}</dd></div>
        <div><dt>模型轮数 / token</dt><dd>{v2.usage.modelTurns} / {v2.usage.modelTokens}</dd></div>
        <div><dt>下载 / 读取字节</dt><dd>{v2.usage.bytesDownloaded} / {v2.usage.bytesRead}</dd></div>
        <div><dt>修复次数</dt><dd>{v2.usage.repairAttempts}</dd></div>
      </dl>}
      {v2?.usage.usageUnknown === true ? <p className="research-hint" data-testid="research-usage-unknown" role="note">部分用量无法确定；未确定的用量不会按零成本处理。</p> : null}
    </details>

    <section className="research-products" data-testid="research-products" aria-label="结束产物">
      <div><h4>候选资产</h4>
        {v2 === undefined
          ? <p className="research-hint" data-testid="research-assets-legacy">旧版记录只提供候选计数 {research.candidateCount}；逐条回执需新版研究投影。</p>
          : <CandidateReceiptList receipts={assetReceipts} />}</div>
      <div><h4>未解决问题</h4>
        {unresolved.length === 0 && (v2?.humanTodos.length ?? 0) === 0
          ? <p className="research-hint" data-testid="research-unresolved-empty">没有登记未解决问题。</p>
          : <ul className="research-unresolved" data-testid="research-unresolved">
            {unresolved.map((gap, index) => <li key={`${gap.kind}:${gap.name}:${index}`} data-state={gap.state}>{GAP_STATE_LABELS[gap.state]}：{gap.name}</li>)}
          </ul>}
        {v2 === undefined ? null : <HumanTodoList todos={v2.humanTodos} />}</div>
    </section>

    <p className="research-hint" data-testid="research-source-review-hint">
      来源候选登记为「AI 调研，待确认」。请到来源库逐条确认来源类别并完成纳入，审核通过与提升来源类别是两件事。
    </p>

    {canContinue ? <p className="research-hint" data-testid="research-continue-hint">
      {researchContinuationReason(research)}“追加调研”会新建一次明确授权的调研并关联本次产物，不会复活或重试原执行。
    </p> : null}

    {canGenerate && research.sourceCount > 0 ? <div className="research-actions">
      <Button variant="primary" data-testid="research-generate" disabled={onOpenGeneration === undefined}
        onClick={() => onOpenGeneration?.()}>确认来源并生成候选</Button>
      {onOpenGeneration === undefined ? <span className="research-hint">候选生成入口由行业工作台提供。</span> : null}
    </div> : null}

    {research.status === 'awaiting_confirmation' ? <StateFeedback tone="empty" title="执行已结束，工作流待人工"
      description="研究执行本身已结束，不会让 agent 空转等待；请在来源库完成来源审核与纳入。" /> : null}
  </section>
}
