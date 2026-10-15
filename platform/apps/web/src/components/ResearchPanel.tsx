import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ResearchExecution } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { EffectiveModelSelection } from '../api/model-connections'
import { readEffectiveModels } from '../api/model-connections'
import {
  FRESHNESS_LABELS,
  RESEARCH_STAGE_LABELS,
  RESEARCH_STAGES,
  RESEARCH_STATUS_LABELS,
  RESEARCH_STOP_REASON_LABELS,
  RESEARCH_TARGET_KIND_LABELS,
  RESEARCH_TARGET_KINDS,
  buildResearchRequest,
  cancelResearchRun,
  hasNoArchivedSnapshot,
  isResearchActive,
  isResearchSurfaceMissing,
  parseDomains,
  readResearchRun,
  researchFailureReason,
  researchOutcome,
  startResearchRun,
  validateAuthorizationDraft,
} from '../api/research'
import type { ResearchAuthorizationDraft, ResearchOutcome } from '../api/research'
import { classifyPublicError } from '../state/public-errors'
import type { PublicFailure } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { EffectiveModelSummary } from './EffectiveModelSummary'
import { Button, Field, Panel, StateFeedback, StatusBadge } from './ui'

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ResearchPanelProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  /** Read-only members may inspect the authorization and progress but never start a run. */
  readonly readOnly?: boolean
  /** Deep link (`?research=<id>`): the run to re-read on mount, so a refresh resumes the real state. */
  readonly initialResearchId?: string
  /** Called after sources are confirmed, to hand off to the candidate generation surface (N09). */
  readonly onOpenGeneration?: () => void
  /** Called when the research model is not resolvable, to jump to AI settings. */
  readonly onConfigureModel?: () => void
  /** Reports the current run id so the host can keep it in the URL for refresh/re-read. */
  readonly onResearchChanged?: (researchId: string | undefined) => void
  readonly onClose?: () => void
}

const DEFAULTS = {
  sourceLimit: 20,
  candidateLimit: 25,
  timeLimitMinutes: 15,
  freshness: 'any' as const,
} as const

/** The four endings carry a distinct label and tone so none is read as a generic success. */
const OUTCOME_VIEW: Readonly<Record<Exclude<ResearchOutcome, 'active'>, { readonly label: string; readonly tone: Tone }>> = {
  awaiting_confirmation: { label: '等待人工确认来源', tone: 'warning' },
  completed: { label: '研究完成', tone: 'success' },
  partial: { label: '部分结果', tone: 'warning' },
  no_results: { label: '无结果', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
  failed: { label: '失败', tone: 'danger' },
}

function toneOfStatus(execution: ResearchExecution): Tone {
  const outcome = researchOutcome(execution)
  if (outcome === 'active') return 'neutral'
  return OUTCOME_VIEW[outcome].tone
}

/**
 * The AI-research authorization and progress surface (design §1.4/§2.5, A-R02/N11).
 *
 * Before a run starts it states exactly what will be sent, to which services and under which
 * enforceable caps, and it names the actual model receiver (reused from the AI-settings surface).
 * Only the public brief the user submits is sent — no project record, private original, history
 * answer or credential. After sources exist it guides to candidate generation, which is a separate
 * authorized operation. When the orchestration surface is not wired it shows the reason and never
 * fabricates a run, a snapshot or a cost estimate.
 */
export function ResearchPanel({ client, workspaceId, readOnly = false, initialResearchId, onOpenGeneration, onConfigureModel, onResearchChanged, onClose }: ResearchPanelProps) {
  const [goal, setGoal] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [targetKinds, setTargetKinds] = useState<ResearchAuthorizationDraft['targetKinds']>(['object'])
  const [freshness, setFreshness] = useState<ResearchAuthorizationDraft['freshnessHint']>(DEFAULTS.freshness)
  const [sourceLimit, setSourceLimit] = useState(String(DEFAULTS.sourceLimit))
  const [candidateLimit, setCandidateLimit] = useState(String(DEFAULTS.candidateLimit))
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(String(DEFAULTS.timeLimitMinutes))

  const [research, setResearch] = useState<ResearchExecution>()
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<string>()
  const [failure, setFailure] = useState<PublicFailure>()
  const [notice, setNotice] = useState('')

  const [model, setModel] = useState<EffectiveModelSelection>()
  const [modelPhase, setModelPhase] = useState<'loading' | 'ready' | 'unresolvable'>('loading')

  const live = useRef(true)
  const controller = useRef<AbortController | undefined>(undefined)
  const epoch = useRef(0)
  const pendingKey = useRef<string | undefined>(undefined)

  const domains = useMemo(() => parseDomains(domainsText), [domainsText])
  const draft = useMemo<ResearchAuthorizationDraft>(() => ({
    goal,
    allowedDomains: domains,
    targetKinds,
    freshnessHint: freshness,
    sourceLimit: Number(sourceLimit),
    candidateLimit: Number(candidateLimit),
    timeLimitMinutes: Number(timeLimitMinutes),
  }), [goal, domains, targetKinds, freshness, sourceLimit, candidateLimit, timeLimitMinutes])
  const validation = validateAuthorizationDraft(draft)

  useEffect(() => () => { live.current = false; controller.current?.abort() }, [])

  const loadModel = useCallback(async () => {
    setModelPhase('loading')
    try {
      const selections = await readEffectiveModels(client, { kind: 'industry_workspace', workspaceId }, ['research'])
      if (!live.current) return
      setModel(selections.find((selection) => selection.capability === 'research'))
      setModelPhase('ready')
    } catch {
      if (!live.current) return
      setModel(undefined)
      setModelPhase('unresolvable')
    }
  }, [client, workspaceId])

  const loadRun = useCallback(async (researchId: string) => {
    const token = ++epoch.current
    const abort = new AbortController()
    controller.current?.abort()
    controller.current = abort
    try {
      const execution = await readResearchRun(client, workspaceId, researchId, abort.signal)
      if (!live.current || epoch.current !== token || abort.signal.aborted) return
      setUnavailable(undefined)
      setResearch(execution)
    } catch (error) {
      if (!live.current || epoch.current !== token || abort.signal.aborted) return
      if (isResearchSurfaceMissing(error)) setUnavailable(researchFailureReason(error))
      else setFailure(classifyPublicError(error))
    }
  }, [client, workspaceId])

  useEffect(() => { void loadModel() }, [loadModel])

  useEffect(() => {
    if (initialResearchId === undefined) return
    void loadRun(initialResearchId)
  }, [initialResearchId, loadRun])

  // Poll only while the run is queued/running; a terminal or confirmation state stops the timer.
  useEffect(() => {
    if (research === undefined || !isResearchActive(research)) return undefined
    const timer = setInterval(() => { void loadRun(research.researchId) }, 4000)
    return () => clearInterval(timer)
  }, [research, loadRun])

  const start = async () => {
    if (busy || readOnly || research !== undefined || !validation.valid) return
    const request = buildResearchRequest(workspaceId, draft, new Date())
    setBusy(true); setFailure(undefined); setNotice(''); setUnavailable(undefined)
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort
    if (pendingKey.current === undefined) pendingKey.current = client.newRequestKey()
    try {
      const execution = await startResearchRun(client, workspaceId, request, pendingKey.current, { signal: abort.signal })
      if (!live.current || abort.signal.aborted) return
      pendingKey.current = undefined
      setResearch(execution)
      onResearchChanged?.(execution.researchId)
      setNotice('研究任务已创建。研究只产出来源候选，需你逐条确认来源类别后才可纳入建模。')
    } catch (error) {
      if (!live.current || abort.signal.aborted) return
      if (isResearchSurfaceMissing(error)) setUnavailable(researchFailureReason(error))
      else setFailure(classifyPublicError(error))
    } finally {
      if (live.current) setBusy(false)
    }
  }

  const cancel = async () => {
    if (busy || research === undefined || !isResearchActive(research)) return
    setBusy(true); setNotice(''); setFailure(undefined)
    try {
      const execution = await cancelResearchRun(client, workspaceId, research.researchId, client.newRequestKey())
      if (!live.current) return
      setResearch(execution)
      setNotice('已请求取消。取消后的迟到结果不会恢复或入库；最终状态以重新读取为准。')
    } catch (error) {
      if (live.current) setNotice(researchFailureReason(error))
    } finally {
      if (live.current) setBusy(false)
    }
  }

  const restart = () => {
    setResearch(undefined); setUnavailable(undefined); setFailure(undefined); setNotice(''); pendingKey.current = undefined
    onResearchChanged?.(undefined)
  }

  const toggleKind = (kind: ResearchAuthorizationDraft['targetKinds'][number]) => {
    setTargetKinds((old) => old.includes(kind) ? old.filter((entry) => entry !== kind) : [...old, kind])
  }

  const modelBlocked = modelPhase === 'ready' && model !== undefined && model.state !== 'available'
  const surfaceBlocked = unavailable !== undefined
  const canStart = validation.valid && !modelBlocked && !surfaceBlocked && !busy && research === undefined && !readOnly

  return <Panel title="AI 搜寻公共资料" className="research-panel"
    description="调研后由你确认来源，只产候选。研究产物不能直接发布，也不会自动成为项目事实。"
    actions={onClose === undefined ? undefined : <Button variant="quiet" onClick={onClose} data-testid="research-close">关闭</Button>}>
    <section data-testid="research-panel" data-availability={surfaceBlocked ? 'unavailable' : 'available'}>

      <div className="research-disclaimers">
        <p className="research-notice" data-testid="research-scope-notice" role="note">
          仅外发你在下方明确提交的公共研究 brief。项目记录、私有原文、历史问答与密钥不会随研究一并外发。
        </p>
        <p className="research-notice" data-testid="research-candidate-notice" role="note">
          研究只产出来源候选，需人工确认来源类别后才可纳入建模；接受一份来源不会把它提升为公共标准。
        </p>
        <p className="research-hint" data-testid="research-domain-notice">
          允许域名 = 部署/空间授权策略 ∩ 你的选择。在此输入域名本身不构成授权，模型不能扩大该名单。
        </p>
      </div>

      <section className="research-receiver" aria-label="研究的实际模型接收方">
        <h3>实际接收方</h3>
        {modelPhase === 'loading' ? <StateFeedback tone="loading" title="正在解析研究模型" description="读取当前工作区生效的研究模型。" />
          : modelPhase === 'unresolvable' ? <p className="research-hint" data-testid="research-model-unresolvable">
              无法解析研究模型接收方；开始后服务端会在任务记录中固定实际接收方与版本。
              {onConfigureModel === undefined ? null : <Button variant="quiet" onClick={onConfigureModel}>前往 AI 设置</Button>}
            </p>
          : model === undefined ? <p className="research-hint" data-testid="research-model-missing">当前工作区没有解析到研究模型。</p>
            : <EffectiveModelSummary selection={model} {...(onConfigureModel === undefined ? {} : { onConfigure: onConfigureModel })} />}
      </section>

      {surfaceBlocked ? <section data-testid="research-unavailable" data-unavailable="true">
        <StateFeedback tone="error" title="研究编排未接入" description={unavailable ?? ''} />
      </section> : null}
      {failure === undefined ? null : <PublicStateNotice testId="research-failure" failure={failure} onRecover={() => void loadModel()} />}

      {research === undefined ? <form className="research-form" onSubmit={(event) => { event.preventDefault(); void start() }}>
        <Field label="业务目标" hint="例如“整理设备维护规则及其依据”。只说你要研究什么。">
          {(attributes) => <textarea {...attributes} data-testid="research-goal" rows={2} value={goal} disabled={busy} onChange={(event) => setGoal(event.target.value)} />}
        </Field>
        <Field label="允许检索的域名" hint="逗号或换行分隔，例如 example.com、standard.example.org；最多 32 个。">
          {(attributes) => <textarea {...attributes} data-testid="research-domains" rows={2} value={domainsText} disabled={busy} onChange={(event) => setDomainsText(event.target.value)} />}
        </Field>
        <fieldset className="research-kinds" data-testid="research-target-kinds">
          <legend>希望生成的候选类型</legend>
          {RESEARCH_TARGET_KINDS.map((kind) => <label key={kind}>
            <input type="checkbox" data-testid={`research-target-${kind}`} checked={targetKinds.includes(kind)} disabled={busy} onChange={() => toggleKind(kind)} />
            <span>{RESEARCH_TARGET_KIND_LABELS[kind]}</span>
          </label>)}
        </fieldset>
        <div className="research-limits">
          <Field label="时间范围">
            {(attributes) => <select {...attributes} data-testid="research-freshness" value={freshness} disabled={busy} onChange={(event) => setFreshness(event.target.value as ResearchAuthorizationDraft['freshnessHint'])}>
              {(Object.keys(FRESHNESS_LABELS) as readonly ResearchAuthorizationDraft['freshnessHint'][]).map((hint) => <option key={hint} value={hint}>{FRESHNESS_LABELS[hint]}</option>)}
            </select>}
          </Field>
          <Field label="来源数上限" hint="1..200">
            {(attributes) => <input {...attributes} data-testid="research-source-limit" inputMode="numeric" value={sourceLimit} disabled={busy} onChange={(event) => setSourceLimit(event.target.value)} />}
          </Field>
          <Field label="候选数上限" hint="1..500">
            {(attributes) => <input {...attributes} data-testid="research-candidate-limit" inputMode="numeric" value={candidateLimit} disabled={busy} onChange={(event) => setCandidateLimit(event.target.value)} />}
          </Field>
          <Field label="时限（分钟）" hint="1..120">
            {(attributes) => <input {...attributes} data-testid="research-time-limit" inputMode="numeric" value={timeLimitMinutes} disabled={busy} onChange={(event) => setTimeLimitMinutes(event.target.value)} />}
          </Field>
        </div>

        <section className="research-caps" data-testid="research-caps" aria-label="可强制执行的外发范围与额度">
          <h3>本次外发确认</h3>
          <dl>
            <div><dt>外发内容</dt><dd>仅上方的公共研究 brief（目标、允许域名、候选类型、时间范围）</dd></div>
            <div><dt>检索域</dt><dd>{domains.length === 0 ? '（尚未填写）' : domains.join('、')}</dd></div>
            <div><dt>接收方</dt><dd data-testid="research-cap-receiver">{modelPhase === 'ready' && model !== undefined ? `${model.connectionSummary?.name ?? '未配置'}（配置版本 ${model.connectionSummary?.revision ?? '—'}）` : '未能解析，开始后由服务端固定'}</dd></div>
            <div><dt>来源数上限</dt><dd>{Number.isSafeInteger(Number(sourceLimit)) ? sourceLimit : '—'}</dd></div>
            <div><dt>候选数上限</dt><dd>{Number.isSafeInteger(Number(candidateLimit)) ? candidateLimit : '—'}</dd></div>
            <div><dt>时限</dt><dd>{Number.isSafeInteger(Number(timeLimitMinutes)) ? `${timeLimitMinutes} 分钟` : '—'}</dd></div>
            <div><dt>预计费用</dt><dd data-testid="research-cost">{'当前无法估算（无可靠价格配置）；以调用/token 上限与时限作为可强制执行额度，用量未知不会显示为零成本。'}</dd></div>
          </dl>
        </section>

        {!validation.valid ? <p className="research-hint" data-testid="research-validation" data-valid="false">{validation.reason}</p> : null}
        {modelBlocked && model !== undefined ? <p className="research-hint" data-testid="research-model-blocked" role="alert">
          研究模型不可用：{model.state === 'disabled' ? '已停用' : model.state === 'blocked' ? '被阻断或缺少凭据' : '未配置'}。请由管理员在 AI 设置中配置研究模型后再开始。
        </p> : null}

        <div className="research-actions">
          <Button variant="primary" type="submit" data-testid="research-start" disabled={!canStart}>
            {busy ? '正在创建研究任务…' : '确认外发范围并开始调研'}
          </Button>
          <Button variant="quiet" onClick={restart} disabled={busy} data-testid="research-reset">重置输入</Button>
        </div>
        {readOnly ? <p className="research-hint" data-testid="research-readonly">只读角色可以查看授权范围与进度，但不能发起研究。</p> : null}
      </form> : <ResearchProgress research={research} busy={busy}
        {...(onOpenGeneration === undefined ? {} : { onOpenGeneration })}
        onCancel={() => void cancel()} onRefresh={() => void loadRun(research.researchId)} onRestart={restart} />}

      {notice && research !== undefined ? <p role="status" className="research-notice" data-testid="research-notice">{notice}</p> : null}
    </section>
  </Panel>
}

interface ResearchProgressProps {
  readonly research: ResearchExecution
  readonly busy: boolean
  readonly onOpenGeneration?: () => void
  readonly onCancel: () => void
  readonly onRefresh: () => void
  readonly onRestart: () => void
}

function ResearchProgress({ research, busy, onOpenGeneration, onCancel, onRefresh, onRestart }: ResearchProgressProps) {
  const outcome = researchOutcome(research)
  const active = isResearchActive(research)
  const stageIndex = RESEARCH_STAGES.indexOf(research.stage)
  const coverage = research.coverage
  const ending = outcome === 'active' ? undefined : OUTCOME_VIEW[outcome]
  const canGenerate = outcome === 'awaiting_confirmation' || outcome === 'completed'
  return <section className="research-progress" data-testid="research-progress" data-outcome={outcome}>
    <header className="research-progress__head">
      <span data-testid="research-status"><StatusBadge tone={toneOfStatus(research)}>{RESEARCH_STATUS_LABELS[research.status]}</StatusBadge></span>
      <Button variant="quiet" onClick={onRefresh} disabled={busy} data-testid="research-refresh">刷新回读</Button>
      <Button variant="quiet" onClick={onRestart} disabled={busy} data-testid="research-restart">新建研究</Button>
      {active ? <Button variant="danger" onClick={onCancel} disabled={busy} data-testid="research-cancel">取消研究</Button> : null}
    </header>

    <ol className="research-stages" data-testid="research-stages" data-stage={research.stage}>
      {RESEARCH_STAGES.map((stage) => <li key={stage} data-testid="research-stage" data-stage={stage}
        data-current={stage === research.stage} data-done={RESEARCH_STAGES.indexOf(stage) < stageIndex}>
        {RESEARCH_STAGE_LABELS[stage]}
      </li>)}
    </ol>

    {ending === undefined ? null : <p className="research-ending" data-testid="research-ending" data-outcome={outcome}>
      <strong>{ending.label}</strong>
      {research.stopReason === undefined ? null : `：停止原因 ${RESEARCH_STOP_REASON_LABELS[research.stopReason]}`}
      {outcome === 'no_results' ? '。本次检索没有任何可归档的快照，未产生来源候选。' : null}
      {outcome === 'cancelled' ? '。取消后的迟到结果不会恢复或入库。' : null}
      {outcome === 'failed' ? '。已覆盖的范围与缺口会保留；可用同一来源重新发起。' : null}
    </p>}

    <dl className="research-counts" data-testid="research-counts">
      <div><dt>来源候选</dt><dd data-testid="research-source-count">{research.sourceCount}</dd></div>
      <div><dt>已生成候选</dt><dd data-testid="research-candidate-count">{research.candidateCount}</dd></div>
      <div><dt>查询规划</dt><dd>{coverage.queriesPlanned}</dd></div>
      <div><dt>检索调用</dt><dd>{coverage.searchCalls}</dd></div>
      <div><dt>发现页面</dt><dd>{coverage.pagesDiscovered}</dd></div>
      <div><dt>已归档快照</dt><dd data-testid="research-archived-snapshots">{coverage.archivedSnapshots}</dd></div>
      <div><dt>仅发现链接（无快照）</dt><dd data-testid="research-skipped-without-snapshot">{coverage.skippedWithoutSnapshot}</dd></div>
      <div><dt>排除</dt><dd>{coverage.excludedCount}</dd></div>
      <div><dt>失败</dt><dd>{coverage.failedCount}</dd></div>
      <div><dt>结果被截断</dt><dd>{coverage.truncated ? '是' : '否'}</dd></div>
    </dl>

    {hasNoArchivedSnapshot(coverage) ? <p className="research-hint" data-testid="research-no-snapshot" role="note">
      本次没有任何已归档快照：仅发现的链接不能作为正式依据，也不会计入可纳入建模的来源。
    </p> : null}
    {coverage.skippedWithoutSnapshot > 0 ? <p className="research-hint" data-testid="research-links-only" role="note">
      有 {coverage.skippedWithoutSnapshot} 个页面仅发现链接、未归档快照，已标记为“仅发现链接，不能作正式依据”。
    </p> : null}

    <p className="research-hint" data-testid="research-source-review-hint">
      来源候选登记为「AI 调研，待确认」。请到来源库逐条确认来源类别并完成纳入，审核通过与提升来源类别是两件事。
    </p>

    {canGenerate && research.sourceCount > 0 ? <div className="research-actions">
      <Button variant="primary" data-testid="research-generate" disabled={onOpenGeneration === undefined}
        onClick={() => onOpenGeneration?.()}>确认来源并生成候选</Button>
      {onOpenGeneration === undefined ? <span className="research-hint">候选生成入口由行业工作台提供。</span> : null}
    </div> : null}
  </section>
}
