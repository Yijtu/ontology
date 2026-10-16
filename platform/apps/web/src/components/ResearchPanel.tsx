import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelingBriefMustCover } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { EffectiveModelSelection } from '../api/model-connections'
import { readEffectiveModels } from '../api/model-connections'
import {
  buildResearchRequest,
  cancelResearchRun,
  continueResearchRun,
  isResearchActive,
  isResearchSurfaceMissing,
  parseDomains,
  readEffectiveSearchService,
  readResearchRun,
  researchFailureReason,
  startResearchRun,
  validateAuthorizationDraft,
} from '../api/research'
import type {
  ResearchAuthorizationDraft,
  ResearchExecutionView,
  SearchServiceAvailability,
} from '../api/research'
import { classifyPublicError } from '../state/public-errors'
import type { PublicFailure } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { Panel, StateFeedback, Button } from './ui'
import { ResearchAuthorizationSummary } from './ResearchAuthorizationSummary'
import { ResearchHistoryView } from './ResearchHistoryView'
import { ResearchProgressView } from './ResearchProgressView'

/**
 * The AI-research surface: the entry now converges on the business goal (design §2). The goal is
 * carried from the workspace and becomes the modelling-assistant task, so there is no separate long
 * research form. Before a run it shows a compact task confirmation (goal + must-cover, the actual
 * model and search service, the outbound content and enforceable limits); during a run it shows the
 * reusable progress view; and it keeps a reusable history of the runs it knows about.
 *
 * It never fabricates a run, a snapshot, a cost or a service. When the run surface is not wired it
 * shows the reason, so the entry still exists instead of a bare failure.
 */
export interface ResearchPanelProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  /** Read-only members may inspect the authorization and progress but never start a run. */
  readonly readOnly?: boolean
  /** Deep link (`?research=<id>`): the run to re-read on mount, so a refresh resumes the real state. */
  readonly initialResearchId?: string
  /** The workspace's own goal; it becomes the assistant task, so the user never re-types it. */
  readonly workspaceGoal?: string
  /** The questions the workspace requires the run to cover, shown per-item as coverage gaps. */
  readonly mustCover?: readonly ModelingBriefMustCover[]
  /** Called after sources are confirmed, to hand off to the candidate generation surface (N09). */
  readonly onOpenGeneration?: () => void
  readonly onConfigureModel?: () => void
  readonly onConfigureSearch?: () => void
  /** Reports the current run id so the host can keep it in the URL for refresh/re-read. */
  readonly onResearchChanged?: (researchId: string | undefined) => void
  readonly onClose?: () => void
}

const DEFAULTS = {
  sourceLimit: 20,
  candidateLimit: 25,
  timeLimitMinutes: 15,
  freshness: 'any' as const,
}

/** Keep at most one entry per run id, newest first, so the history never double-counts a run. */
function upsertRun(runs: readonly ResearchExecutionView[], next: ResearchExecutionView): readonly ResearchExecutionView[] {
  return [next, ...runs.filter((run) => run.researchId !== next.researchId)].slice(0, 20)
}

export function ResearchPanel({ client, workspaceId, readOnly = false, initialResearchId, workspaceGoal, mustCover = [], onOpenGeneration, onConfigureModel, onConfigureSearch, onResearchChanged, onClose }: ResearchPanelProps) {
  const [goal, setGoal] = useState(workspaceGoal ?? '')
  const [domainsText, setDomainsText] = useState('')
  const [targetKinds, setTargetKinds] = useState<ResearchAuthorizationDraft['targetKinds']>(['object'])
  const [freshness, setFreshness] = useState<ResearchAuthorizationDraft['freshnessHint']>(DEFAULTS.freshness)
  const [sourceLimit, setSourceLimit] = useState(String(DEFAULTS.sourceLimit))
  const [candidateLimit, setCandidateLimit] = useState(String(DEFAULTS.candidateLimit))
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(String(DEFAULTS.timeLimitMinutes))

  const [research, setResearch] = useState<ResearchExecutionView>()
  const [continuationOf, setContinuationOf] = useState<string>()
  const [history, setHistory] = useState<readonly ResearchExecutionView[]>([])
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<string>()
  const [failure, setFailure] = useState<PublicFailure>()
  const [notice, setNotice] = useState('')

  const [model, setModel] = useState<EffectiveModelSelection>()
  const [modelPhase, setModelPhase] = useState<'loading' | 'ready' | 'unresolvable'>('loading')
  const [searchService, setSearchService] = useState<SearchServiceAvailability>()

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
    ...(mustCover.length === 0 ? {} : { mustCover }),
  }), [goal, domains, targetKinds, freshness, sourceLimit, candidateLimit, timeLimitMinutes, mustCover])
  const validation = validateAuthorizationDraft(draft)

  // The goal is inherited from the workspace once it is read; an explicit edit is never overwritten.
  useEffect(() => {
    setGoal((current) => current.trim().length === 0 && workspaceGoal !== undefined ? workspaceGoal : current)
  }, [workspaceGoal])

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

  const loadSearchService = useCallback(async () => {
    const availability = await readEffectiveSearchService(client, workspaceId)
    if (live.current) setSearchService(availability)
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
      setHistory((runs) => upsertRun(runs, execution))
    } catch (error) {
      if (!live.current || epoch.current !== token || abort.signal.aborted) return
      if (isResearchSurfaceMissing(error)) setUnavailable(researchFailureReason(error))
      else setFailure(classifyPublicError(error))
    }
  }, [client, workspaceId])

  useEffect(() => { void loadModel() }, [loadModel])
  useEffect(() => { void loadSearchService() }, [loadSearchService])

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
    if (busy || readOnly || !validation.valid) return
    if (research !== undefined && continuationOf === undefined) return
    const previous = continuationOf
    const request = buildResearchRequest(workspaceId, draft, new Date())
    setBusy(true); setFailure(undefined); setNotice(''); setUnavailable(undefined)
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort
    if (previous === undefined && pendingKey.current === undefined) pendingKey.current = client.newRequestKey()
    try {
      const execution = previous === undefined
        ? await startResearchRun(client, workspaceId, request, pendingKey.current ?? client.newRequestKey(), { signal: abort.signal })
        : await continueResearchRun(client, workspaceId, previous, request, client.newRequestKey(), { signal: abort.signal })
      if (!live.current || abort.signal.aborted) return
      pendingKey.current = undefined
      setContinuationOf(undefined)
      setResearch(execution)
      setHistory((runs) => upsertRun(runs, execution))
      onResearchChanged?.(execution.researchId)
      setNotice(previous === undefined
        ? '调研任务已创建。研究只产出来源候选，需你逐条确认来源类别后才可纳入建模。'
        : '已基于已有结果发起追加调研（新的授权与额度）；前一次的候选会保留。')
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
      setHistory((runs) => upsertRun(runs, execution))
      setNotice('已请求停止。取消中的迟到结果不会恢复或入库；最终状态以重新读取为准，已提交的候选保留。')
    } catch (error) {
      if (live.current) setNotice(researchFailureReason(error))
    } finally {
      if (live.current) setBusy(false)
    }
  }

  const newRun = () => {
    setResearch(undefined); setContinuationOf(undefined); setUnavailable(undefined); setFailure(undefined); setNotice(''); pendingKey.current = undefined
    onResearchChanged?.(undefined)
  }

  const reset = () => {
    setGoal(workspaceGoal ?? ''); setDomainsText(''); setTargetKinds(['object']); setFreshness(DEFAULTS.freshness)
    setSourceLimit(String(DEFAULTS.sourceLimit)); setCandidateLimit(String(DEFAULTS.candidateLimit)); setTimeLimitMinutes(String(DEFAULTS.timeLimitMinutes))
  }

  const toggleKind = (kind: ResearchAuthorizationDraft['targetKinds'][number]) => {
    setTargetKinds((old) => old.includes(kind) ? old.filter((entry) => entry !== kind) : [...old, kind])
  }

  const setLimit = (field: 'source' | 'candidate' | 'time', value: string) => {
    if (field === 'source') setSourceLimit(value)
    else if (field === 'candidate') setCandidateLimit(value)
    else setTimeLimitMinutes(value)
  }

  const modelBlocked = modelPhase === 'ready' && model !== undefined && model.state !== 'available'
  const searchBlocked = searchService?.state === 'blocked'
  const surfaceBlocked = unavailable !== undefined
  const canStart = validation.valid && !modelBlocked && !searchBlocked && !surfaceBlocked && !busy && (research === undefined || continuationOf !== undefined) && !readOnly

  const blockedReasons: string[] = []
  if (modelBlocked && model !== undefined) {
    blockedReasons.push(`研究模型不可用：${model.state === 'disabled' ? '已停用' : model.state === 'blocked' ? '被阻断或缺少凭据' : '未配置'}。请由管理员在 AI 设置中配置研究模型后再开始。`)
  }
  if (searchBlocked && searchService !== undefined) {
    blockedReasons.push(`公共搜索服务不可用：${searchService.state === 'blocked' ? searchService.reason : ''}。请由管理员在 AI 设置中确认搜索连接后再开始。`)
  }

  return <Panel title="AI 搜寻公共资料" className="research-panel"
    description="从业务目标出发的建模助手任务；调研后由你确认来源，只产候选。研究产物不能直接发布，也不会自动成为项目事实。"
    actions={onClose === undefined ? undefined : <Button variant="quiet" onClick={onClose} data-testid="research-close">关闭</Button>}>
    <section data-testid="research-panel" data-availability={surfaceBlocked ? 'unavailable' : 'available'}>

      {surfaceBlocked ? <section data-testid="research-unavailable" data-unavailable="true">
        <StateFeedback tone="error" title="研究编排未接入" description={unavailable ?? ''} />
      </section> : null}
      {failure === undefined ? null : <PublicStateNotice testId="research-failure" failure={failure} onRecover={() => { void loadModel(); void loadSearchService() }} />}

      {research === undefined || continuationOf !== undefined ? <ResearchAuthorizationSummary
        goal={goal}
        mustCover={mustCover}
        domains={domains}
        domainsText={domainsText}
        targetKinds={targetKinds}
        freshnessHint={freshness}
        sourceLimit={sourceLimit}
        candidateLimit={candidateLimit}
        timeLimitMinutes={timeLimitMinutes}
        model={model}
        modelPhase={modelPhase}
        searchService={searchService}
        validation={validation}
        busy={busy}
        readOnly={readOnly}
        blockedReasons={blockedReasons}
        canStart={canStart}
        onGoalChange={setGoal}
        onDomainsChange={setDomainsText}
        onToggleKind={toggleKind}
        onFreshnessChange={setFreshness}
        onLimitChange={setLimit}
        onStart={() => void start()}
        onReset={reset}
        {...(onConfigureModel === undefined ? {} : { onConfigureModel })}
        {...(onConfigureSearch === undefined ? {} : { onConfigureSearch })}
        mode={continuationOf === undefined ? 'new' : 'continuation'}
        {...(continuationOf === undefined ? {} : { continuationOfRun: continuationOf, onCancelContinuation: () => setContinuationOf(undefined) })}
      /> : <ResearchProgressView
        research={research}
        busy={busy}
        {...(onOpenGeneration === undefined ? {} : { onOpenGeneration })}
        onCancel={() => void cancel()}
        onRefresh={() => void loadRun(research.researchId)}
        onContinue={() => setContinuationOf(research.researchId)}
        onNewRun={newRun}
      />}

      {notice ? <p role="status" className="research-notice" data-testid="research-notice">{notice}</p> : null}

      <ResearchHistoryView runs={history} {...(research === undefined ? {} : { currentId: research.researchId })} onOpen={(id) => void loadRun(id)} />
    </section>
  </Panel>
}
