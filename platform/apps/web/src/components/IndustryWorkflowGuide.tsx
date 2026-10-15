import { useCallback, useEffect, useRef, useState } from 'react'
import type { EffectiveModelSelection, ModelCapability } from '../api/model-connections'
import { readEffectiveModels } from '../api/model-connections'
import { readCandidateSources } from '../api/source-library'
import type { WorkbenchClient } from '../api/client'
import { EffectiveModelSummary, modelNameOf } from './EffectiveModelSummary'
import { CAPABILITY_LABELS, EFFECTIVE_STATE_LABELS, SELECTION_REASON_LABELS } from './model-settings-labels'
import { Button, StateFeedback, StatusBadge } from './ui'
import './ontology/ontology.css'

/**
 * The continuous industry workbench flow (design §1.5/§2.5/§3 N09): 来源 → 生成候选 → 编辑 →
 * 审核 → 验证 → 发布. It strings the existing surfaces into one readable chain and, at every step,
 * names the research/generation model actually resolved for this workspace and the real source or
 * candidate the user must act on next.
 *
 * It only ever renders server data: the counts come from the source catalogue, the candidate-source
 * review store and the candidate lists; the model strip is the resolved `EffectiveModelSelection`.
 * When a capability is unconfigured or the read is refused, the step still exposes the manual entry
 * it needs (upload, edit, human review) and shows the concrete reason — a missing model never blocks
 * a manual path. A blocked/attention step links to the *specific* source or candidate, never a bare
 * "something failed". Review semantics and the validation/CQ gate stay owned by their own panels;
 * this guide never collapses the two reviews into one vague "confirm".
 */

export type IndustryWorkflowStage = 'sources' | 'review' | 'publish'

export type IndustryWorkflowStepId = 'sources' | 'generate' | 'edit' | 'review' | 'validate' | 'publish'

export interface IndustryWorkflowTarget {
  readonly stage: IndustryWorkflowStage
  /** A concrete candidate to select in the review workbench. */
  readonly candidateId?: string
  /** A concrete source to focus in the source library. */
  readonly sourceId?: string
}

export type IndustryWorkflowStepStatus = 'done' | 'attention' | 'pending'

export interface IndustryWorkflowStep {
  readonly id: IndustryWorkflowStepId
  readonly order: number
  readonly title: string
  readonly status: IndustryWorkflowStepStatus
  readonly detail: string
  readonly capability?: ModelCapability
  readonly target: IndustryWorkflowTarget
  /** The manual entry that stays available when the step's model is missing. */
  readonly manual?: string
}

export interface IndustryWorkflowInputs {
  readonly corpusSourceCount: number
  readonly pendingSourceReviewCount: number
  readonly approvedNotAdmittedCount: number
  readonly definitionCandidateCount: number
  readonly ruleActionCandidateCount: number
  readonly pendingSourceConfirmationCount: number
  readonly selections: readonly EffectiveModelSelection[]
  readonly firstPendingSourceId?: string
  readonly firstPendingCandidateId?: string
  readonly firstCandidateId?: string
  /** A concrete classified reason when the model read itself failed (permission or service). */
  readonly modelReadFailure?: string
}

function selectionFor(
  selections: readonly EffectiveModelSelection[],
  capability: ModelCapability,
): EffectiveModelSelection | undefined {
  return selections.find((selection) => selection.capability === capability)
}

/** The concrete reason a step's model is unavailable, or undefined when it is usable. */
export function modelUnavailableReason(
  selection: EffectiveModelSelection | undefined,
  readFailure: string | undefined,
): string | undefined {
  if (readFailure !== undefined) return readFailure
  if (selection === undefined) return '未返回该能力的生效模型'
  if (selection.state === 'available') return undefined
  if (selection.blockedReason !== undefined) return SELECTION_REASON_LABELS[selection.blockedReason]
  return EFFECTIVE_STATE_LABELS[selection.state]
}

/**
 * Derive the six steps from real server counts. Kept pure so the copy, statuses and the exact
 * target of every jump can be asserted without a browser. No step invents a pass/fail it cannot
 * read: 验证/发布 point at their own panel, which owns the deterministic validation/CQ gate.
 */
export function deriveIndustryWorkflow(inputs: IndustryWorkflowInputs): readonly IndustryWorkflowStep[] {
  const candidateCount = inputs.definitionCandidateCount + inputs.ruleActionCandidateCount
  const generationReason = modelUnavailableReason(selectionFor(inputs.selections, 'generation'), inputs.modelReadFailure)
  const researchReason = modelUnavailableReason(selectionFor(inputs.selections, 'research'), inputs.modelReadFailure)

  const sourcesStatus: IndustryWorkflowStepStatus = inputs.pendingSourceReviewCount > 0
    ? 'attention'
    : inputs.corpusSourceCount > 0 || inputs.approvedNotAdmittedCount > 0 ? 'done' : 'pending'
  const sourcesDetail = inputs.pendingSourceReviewCount > 0
    ? `待审核 ${String(inputs.pendingSourceReviewCount)} 份来源；已纳入语料 ${String(inputs.corpusSourceCount)} 份。`
    : inputs.corpusSourceCount > 0
      ? `已纳入语料 ${String(inputs.corpusSourceCount)} 份来源；来源类别与审核分别记录。`
      : '还没有来源。上传、AI 搜寻或文件映射后，在这里确认类别与纳入。'

  const generateStatus: IndustryWorkflowStepStatus = candidateCount > 0 ? 'done' : 'pending'
  const generateDetail = candidateCount > 0
    ? `当前 ${String(inputs.definitionCandidateCount)} 个定义候选、${String(inputs.ruleActionCandidateCount)} 个规则/动作候选；生成只产候选，需人工核对依据。`
    : '还没有候选。先确认来源，再从所选真实资料生成；生成不会自动批准。'

  const reviewStatus: IndustryWorkflowStepStatus = inputs.pendingSourceConfirmationCount > 0
    ? 'attention'
    : candidateCount > 0 ? 'done' : 'pending'
  const reviewDetail = inputs.pendingSourceConfirmationCount > 0
    ? `${String(inputs.pendingSourceConfirmationCount)} 条候选缺少可定位依据：先确认来源，再逐条人工审核。`
    : '逐条人工批准；语义事实审核与项目实例审核是两件事，不会合并成一次含糊的「确认」。'

  return [
    {
      id: 'sources',
      order: 1,
      title: '来源',
      status: sourcesStatus,
      detail: sourcesDetail,
      capability: 'research',
      target: inputs.firstPendingSourceId === undefined
        ? { stage: 'sources' }
        : { stage: 'sources', sourceId: inputs.firstPendingSourceId },
      ...(researchReason === undefined ? {} : { manual: `研究模型不可用（${researchReason}）；仍可上传或粘贴资料，并人工阅读原文。` }),
    },
    {
      id: 'generate',
      order: 2,
      title: '生成候选',
      status: generateStatus,
      detail: generateDetail,
      capability: 'generation',
      target: { stage: 'review' },
      ...(generationReason === undefined ? {} : { manual: `生成模型不可用（${generationReason}）；仍可手动编辑已有候选并确认真实来源。` }),
    },
    {
      id: 'edit',
      order: 3,
      title: '编辑',
      status: candidateCount > 0 ? 'done' : 'pending',
      detail: '人工修改候选的结构、类型与单位；编辑后产生新候选，仍需重新确认依据并单独审核。',
      target: inputs.firstCandidateId === undefined
        ? { stage: 'review' }
        : { stage: 'review', candidateId: inputs.firstCandidateId },
    },
    {
      id: 'review',
      order: 4,
      title: '审核',
      status: reviewStatus,
      detail: reviewDetail,
      target: inputs.firstPendingCandidateId === undefined
        ? { stage: 'review' }
        : { stage: 'review', candidateId: inputs.firstPendingCandidateId },
    },
    {
      id: 'validate',
      order: 5,
      title: '验证',
      status: 'pending',
      detail: '运行语义校验与 CQ 门；结果由服务端报告，概览不预判通过与否。',
      target: { stage: 'publish' },
    },
    {
      id: 'publish',
      order: 6,
      title: '发布',
      status: 'pending',
      detail: '语义校验与 CQ 通过后才能发布不可变版本；当前部署可执行是独立的一面。',
      target: { stage: 'publish' },
    },
  ]
}

export interface IndustryWorkflowGuideProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  readonly readOnly?: boolean
  readonly activeStage?: IndustryWorkflowStage
  readonly onOpenStage: (target: IndustryWorkflowTarget) => void
  readonly onConfigureModel?: () => void
  readonly refreshKey?: number
}

type Phase = 'loading' | 'ready' | 'failure'

interface GuideSnapshot {
  readonly corpusSourceCount: number
  readonly candidateSourceCount: number
  readonly pendingSourceReviewCount: number
  readonly approvedNotAdmittedCount: number
  readonly firstPendingSourceId?: string
  readonly definitionCandidateCount: number
  readonly ruleActionCandidateCount: number
  readonly pendingSourceConfirmationCount: number
  readonly firstPendingCandidateId?: string
  readonly firstCandidateId?: string
  readonly selections: readonly EffectiveModelSelection[]
  readonly modelReadFailure?: string
  readonly sourceReadFailure?: string
}

const EMPTY_SNAPSHOT: GuideSnapshot = {
  corpusSourceCount: 0,
  candidateSourceCount: 0,
  pendingSourceReviewCount: 0,
  approvedNotAdmittedCount: 0,
  definitionCandidateCount: 0,
  ruleActionCandidateCount: 0,
  pendingSourceConfirmationCount: 0,
  selections: [],
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : '请求无法完成。'
}

export function IndustryWorkflowGuide({
  client,
  workspaceId,
  readOnly = false,
  activeStage,
  onOpenStage,
  onConfigureModel,
  refreshKey,
}: IndustryWorkflowGuideProps) {
  const [snapshot, setSnapshot] = useState<GuideSnapshot>(EMPTY_SNAPSHOT)
  const [phase, setPhase] = useState<Phase>('loading')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const epoch = useRef(0)
  const abort = useRef<AbortController | undefined>(undefined)

  const load = useCallback(async () => {
    const token = ++epoch.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setPhase('loading')
    setFailure(undefined)
    const [corpus, library, definitions, ruleActions, models] = await Promise.allSettled([
      client.getWorkspaceSources(workspaceId, controller.signal),
      readCandidateSources(client, workspaceId, controller.signal),
      client.listDefinitionCandidates(workspaceId, { limit: 250 }),
      client.listRuleActionCandidates(workspaceId, { limit: 250 }),
      readEffectiveModels(client, { kind: 'industry_workspace', workspaceId }, ['generation', 'research', 'decision_jev'], controller.signal),
    ])
    if (controller.signal.aborted || epoch.current !== token) return
    if (corpus.status === 'rejected' && library.status === 'rejected' && definitions.status === 'rejected' && ruleActions.status === 'rejected' && models.status === 'rejected') {
      setSnapshot(EMPTY_SNAPSHOT)
      setFailure(reasonOf(corpus.reason))
      setPhase('failure')
      return
    }
    const corpusSources = corpus.status === 'fulfilled' && corpus.value.workspace.workspaceId === workspaceId
      ? corpus.value.sources
      : []
    const candidateSources = library.status === 'fulfilled' && library.value.availability === 'ready' ? library.value.sources : []
    const definitionCandidates = definitions.status === 'fulfilled' ? definitions.value : []
    const ruleActionCandidates = ruleActions.status === 'fulfilled' ? ruleActions.value : []
    const selections = models.status === 'fulfilled' ? models.value : []
    const pendingCandidateSources = candidateSources.filter((source) => source.reviewState === 'proposed')
    const approvedNotAdmitted = candidateSources.filter((source) => source.reviewState === 'approved' && !corpusSources.some((entry) => entry.sourceRef.id === source.contentRef.id))
    const pendingDefinitions = definitionCandidates.filter((candidate) => candidate.pendingConfirmation)
    const firstCandidateId = definitionCandidates[0]?.candidateId ?? ruleActionCandidates[0]?.candidateId
    setSnapshot({
      corpusSourceCount: corpusSources.length,
      candidateSourceCount: candidateSources.length,
      pendingSourceReviewCount: pendingCandidateSources.length,
      approvedNotAdmittedCount: approvedNotAdmitted.length,
      ...(pendingCandidateSources[0] === undefined ? {} : { firstPendingSourceId: pendingCandidateSources[0].sourceId }),
      definitionCandidateCount: definitionCandidates.length,
      ruleActionCandidateCount: ruleActionCandidates.length,
      pendingSourceConfirmationCount: pendingDefinitions.length,
      ...(pendingDefinitions[0] === undefined ? {} : { firstPendingCandidateId: pendingDefinitions[0].candidateId }),
      ...(firstCandidateId === undefined ? {} : { firstCandidateId }),
      selections,
      ...(models.status === 'rejected' ? { modelReadFailure: reasonOf(models.reason) } : {}),
      ...(corpus.status === 'rejected' ? { sourceReadFailure: reasonOf(corpus.reason) } : {}),
    })
    setPhase('ready')
  }, [client, workspaceId])

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT)
    void load()
    return () => { epoch.current++; abort.current?.abort() }
  }, [load])

  useEffect(() => {
    if (refreshKey === undefined || refreshKey === 0) return
    void load()
  }, [refreshKey, load])

  const steps = deriveIndustryWorkflow({
    corpusSourceCount: snapshot.corpusSourceCount,
    pendingSourceReviewCount: snapshot.pendingSourceReviewCount,
    approvedNotAdmittedCount: snapshot.approvedNotAdmittedCount,
    ...(snapshot.firstPendingSourceId === undefined ? {} : { firstPendingSourceId: snapshot.firstPendingSourceId }),
    definitionCandidateCount: snapshot.definitionCandidateCount,
    ruleActionCandidateCount: snapshot.ruleActionCandidateCount,
    pendingSourceConfirmationCount: snapshot.pendingSourceConfirmationCount,
    ...(snapshot.firstPendingCandidateId === undefined ? {} : { firstPendingCandidateId: snapshot.firstPendingCandidateId }),
    ...(snapshot.firstCandidateId === undefined ? {} : { firstCandidateId: snapshot.firstCandidateId }),
    selections: snapshot.selections,
    ...(snapshot.modelReadFailure === undefined ? {} : { modelReadFailure: snapshot.modelReadFailure }),
  })

  const toneOf = (status: IndustryWorkflowStepStatus): 'neutral' | 'success' | 'warning' => {
    if (status === 'done') return 'success'
    if (status === 'attention') return 'warning'
    return 'neutral'
  }
  const statusLabel = (status: IndustryWorkflowStepStatus): string => {
    if (status === 'done') return '已具备'
    if (status === 'attention') return '待处理'
    return '待完成'
  }

  if (phase === 'loading' && snapshot === EMPTY_SNAPSHOT) {
    return <div data-testid="industry-workflow-loading">
      <StateFeedback title="正在读取工作流状态" description="读取来源、候选与当前生效模型。" tone="loading" />
    </div>
  }

  return (
    <section className="ontology-workflow-guide" data-testid="industry-workflow" data-phase={phase} data-workspace-id={workspaceId} data-readonly={readOnly}>
      <header className="ontology-workflow-head">
        <div>
          <p className="ontology-eyebrow">行业工作流</p>
          <h2>来源 → 生成候选 → 编辑 → 审核 → 验证 → 发布</h2>
          <p>每一步显示实际使用的研究/生成模型与来源。模型未配置也不阻断：人工上传、编辑与审核始终可用。</p>
        </div>
        <div className="ontology-actions">
          <Button disabled={phase === 'loading'} onClick={() => void load()}>刷新工作流状态</Button>
          {onConfigureModel === undefined ? null : <Button variant="quiet" onClick={onConfigureModel} data-testid="industry-workflow-configure">前往 AI 设置</Button>}
        </div>
      </header>

      {failure === undefined ? null : (
        <p role="alert" className="ontology-notice" data-testid="industry-workflow-failure">
          工作流状态读取失败：{failure}
          <Button variant="quiet" onClick={() => void load()}>重新读取</Button>
        </p>
      )}
      {snapshot.sourceReadFailure === undefined ? null : (
        <p role="status" className="ontology-notice" data-testid="industry-workflow-source-failure">来源目录暂不可读：{snapshot.sourceReadFailure}。来源步骤仍可进入并重试。</p>
      )}

      <ol className="ontology-flow" data-testid="industry-workflow-steps">
        {steps.map((step) => {
          const active = activeStage === step.target.stage
          const selection = step.capability === undefined ? undefined : selectionFor(snapshot.selections, step.capability)
          const modelState = step.capability === undefined
            ? undefined
            : selection === undefined ? (snapshot.modelReadFailure === undefined ? 'unconfigured' : 'unreadable') : selection.state
          return (
            <li
              key={step.id}
              className={`ontology-flow__step${active ? ' is-active' : ''}`}
              data-testid="industry-workflow-step"
              data-step={step.id}
              data-status={step.status}
              data-active={active}
              {...(step.capability === undefined ? {} : { 'data-capability': step.capability })}
              {...(modelState === undefined ? {} : { 'data-model-state': modelState })}
            >
              <button
                type="button"
                className="ontology-flow__button"
                data-testid={`industry-workflow-step-${step.id}`}
                aria-current={active ? 'step' : undefined}
                onClick={() => onOpenStage(step.target)}
              >
                <span className="ontology-flow__order" aria-hidden="true">{step.order}</span>
                <span className="ontology-flow__body">
                  <span className="ontology-flow__head">
                    <strong>{step.title}</strong>
                    <StatusBadge tone={toneOf(step.status)}>{statusLabel(step.status)}</StatusBadge>
                  </span>
                  <span className="ontology-flow__detail">{step.detail}</span>
                  {step.capability === undefined ? null : (
                    <span className="ontology-flow__model" data-testid={`industry-workflow-model-${step.capability}`}>
                      {step.capability === 'research' ? '研究模型' : CAPABILITY_LABELS[step.capability]}：
                      {selection === undefined ? (snapshot.modelReadFailure === undefined ? '未配置' : '无法读取') : modelNameOf(selection)}
                    </span>
                  )}
                  {step.manual === undefined ? null : (
                    <span className="ontology-flow__manual" data-testid={`industry-workflow-manual-${step.id}`}>{step.manual}</span>
                  )}
                  {step.target.sourceId === undefined && step.target.candidateId === undefined ? null : (
                    <span className="ontology-flow__target" data-testid={`industry-workflow-target-${step.id}`}
                      data-target-source-id={step.target.sourceId} data-target-candidate-id={step.target.candidateId}>
                      去处理具体项 →
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {phase === 'failure' ? <p className="ontology-hint">工作流状态暂不可用；可直接进入各步骤并重试。恢复入口保留当前工作区上下文。</p> : null}

      {snapshot.selections.length === 0 ? (
        <p className="ontology-hint" data-testid="industry-workflow-model-note">
          {snapshot.modelReadFailure === undefined ? '当前工作区未解析到生效模型；上传、编辑、审核与确定性验证不依赖模型。' : `无法读取生效模型：${snapshot.modelReadFailure}（可能无权限）。人工处理路径不受影响。`}
        </p>
      ) : (
        <div className="model-effective__list" data-testid="industry-workflow-models">
          {snapshot.selections.map((selection) => (
            <EffectiveModelSummary key={selection.capability} selection={selection} variant="compact" {...(onConfigureModel === undefined ? {} : { onConfigure: onConfigureModel })} />
          ))}
        </div>
      )}
    </section>
  )
}
