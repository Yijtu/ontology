import {
  WorkbenchOverviewError,
  assertWorkbenchOverviewShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  WorkbenchBlocker,
  WorkbenchCapability,
  WorkbenchCapabilitySource,
  WorkbenchCounts,
  WorkbenchNextStep,
  WorkbenchOverview,
  WorkbenchOverviewReader,
  WorkbenchProjectState,
  WorkbenchReadinessSummary,
  WorkbenchSpaceState,
  WorkbenchStateReader,
  WorkbenchSubject,
  WorkbenchTargetRef,
  WorkbenchWorkspaceState,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * The knowledge-workbench overview service (design §2.2/§2.4/§2.5, A-R01/A-R06/A-R07).
 *
 * It reads persisted workspace/project/candidate/job/readiness/publication state through the
 * `WorkbenchStateReader` port and derives a **deterministic** next step and counts — the same state
 * always yields the same projection, so a todo is never guessed by a model. The projection is a
 * fixed-revision, read-only view: it is not a new approval truth, and executing a step re-authorizes
 * and re-validates inside the owning service.
 *
 * Every read runs in the trusted scope; a subject that is not visible there is a `NOT_FOUND`, so a
 * permission change can never leak another tenant's or space's counts.
 */
export interface WorkbenchOverviewServiceDependencies {
  readonly state: WorkbenchStateReader
  readonly capabilities: WorkbenchCapabilitySource
  readonly now?: () => string
}

const REVISION_ZERO: RevisionString = '0'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkbenchOverviewError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkbenchOverviewError('SCOPE_MISMATCH', 'the trusted context carries an inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertRequestScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  const scope = scopeOf(ctx)
  if (scopeRef.tenantId !== scope.tenantId || scopeRef.spaceId !== scope.spaceId) {
    throw new WorkbenchOverviewError('SCOPE_MISMATCH', 'the requested scope does not match the trusted principal scope')
  }
}

/**
 * Detect a moved subject when the caller supplied an expected revision (a real revision, not the
 * `'0'` "no expectation" sentinel). The response then carries the current revision so the caller can
 * refresh; a moved revision is refused rather than silently projected under the stale one.
 */
function assertNotMoved(requestedRevision: RevisionString, currentRevision: RevisionString, label: string): void {
  if (requestedRevision !== REVISION_ZERO && requestedRevision !== currentRevision) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', `the ${label} moved to revision ${currentRevision}; re-read the overview`)
  }
}

function targetKindWorkspace(workspaceId: Uuid): WorkbenchTargetRef {
  return { kind: 'industry_workspace', id: workspaceId }
}

function targetKindProject(projectId: Uuid): WorkbenchTargetRef {
  return { kind: 'project', id: projectId }
}

/** The deterministic workspace workflow (design §2.5): source -> confirm -> admit -> generate -> review -> publish. */
export function deriveWorkspaceSteps(state: WorkbenchWorkspaceState): readonly WorkbenchNextStep[] {
  const target = targetKindWorkspace(state.workspaceId)
  const steps: WorkbenchNextStep[] = []
  if (state.sourceCount === 0) {
    steps.push({ action: 'choose_source', label: '选择料源', reason: '该工作区还没有任何知识来源', target })
    return steps
  }
  if (state.proposedSourceCount > 0) {
    steps.push({
      action: 'confirm_sources',
      label: '确认调研来源',
      reason: `${String(state.proposedSourceCount)} 个来源待确认`,
      target,
    })
  }
  const approvedNotAdmitted = Math.max(0, state.approvedSourceCount - state.admittedSourceCount)
  if (approvedNotAdmitted > 0) {
    steps.push({
      action: 'admit_sources',
      label: '完成来源纳入',
      reason: `${String(approvedNotAdmitted)} 个已审核来源尚未纳入建模`,
      target,
    })
  }
  if (state.admittedSourceCount > 0 && state.candidateCount === 0) {
    steps.push({ action: 'generate_candidates', label: '生成候选资产', reason: '已有纳入来源，但还没有候选资产', target })
  }
  if (state.candidateCount > 0 && state.candidatesPendingReview > 0) {
    steps.push({
      action: 'review_candidates',
      label: '审核候选资产',
      reason: `${String(state.candidatesPendingReview)} 条候选资产待审核`,
      target,
    })
  }
  if (state.validationSatisfied && state.publishedPackRef === undefined) {
    steps.push({ action: 'validate_and_publish', label: '验证并发布行业包', reason: '验证已满足，行业包尚未发布', target })
  }
  return steps
}

/** The deterministic project workflow: mount -> data -> readiness -> records -> task. */
export function deriveProjectSteps(state: WorkbenchProjectState): readonly WorkbenchNextStep[] {
  const target = targetKindProject(state.projectId)
  const steps: WorkbenchNextStep[] = []
  if (state.mountedPackRef === undefined) {
    steps.push({ action: 'map_project_data', label: '挂载行业包并接入数据', reason: '该项目尚未挂载任何行业包版本', target })
    return steps
  }
  if (state.readiness.some((entry) => entry.state === 'failed' || entry.state === 'revoked')) {
    steps.push({ action: 'map_project_data', label: '处理数据构建失败', reason: '有数据构建处于失败或失效状态', target })
  }
  if (state.readiness.length === 0 || state.readiness.some((entry) => entry.state === 'pending' || entry.state === 'building')) {
    steps.push({ action: 'map_project_data', label: '接入并等待数据就绪', reason: '项目数据尚未构建或仍在进行', target })
  }
  if (state.recordsPendingConfirmation > 0) {
    steps.push({
      action: 'confirm_records',
      label: '处理待确认记录',
      reason: `${String(state.recordsPendingConfirmation)} 条记录待确认`,
      target,
    })
  }
  const allReady = state.readiness.length > 0 && state.readiness.every((entry) => entry.state === 'ready')
  if (allReady && state.recordsPendingConfirmation === 0 && state.availableTaskCount > 0) {
    steps.push({ action: 'run_task', label: '开始任务', reason: `${String(state.availableTaskCount)} 个可用任务`, target })
  }
  return steps
}

function readinessBlocker(entry: WorkbenchReadinessSummary, projectId: Uuid): WorkbenchBlocker {
  return {
    code: `READINESS_${entry.kind.toUpperCase()}_${entry.state.toUpperCase()}`,
    message: `项目数据就绪 “${entry.kind}” 处于 ${entry.state}${entry.errorCode === undefined ? '' : `（${entry.errorCode}）`}`,
    retryable: entry.retryable,
    recoveryAction: 'map_project_data',
    target: targetKindProject(projectId),
  }
}

/** The scope-wide next step, derived from the summary counts only (no per-subject identity leaks). */
export function deriveSpaceSteps(state: WorkbenchSpaceState): readonly WorkbenchNextStep[] {
  const steps: WorkbenchNextStep[] = []
  if (state.workspaceCount === 0) {
    steps.push({ action: 'choose_source', label: '创建行业工作区并选择料源', reason: '当前空间还没有行业工作区' })
  }
  if (state.proposedSources > 0) {
    steps.push({ action: 'confirm_sources', label: '确认调研来源', reason: `${String(state.proposedSources)} 个来源待确认` })
  }
  if (state.approvedSourcesNotAdmitted > 0) {
    steps.push({ action: 'admit_sources', label: '完成来源纳入', reason: `${String(state.approvedSourcesNotAdmitted)} 个已审核来源尚未纳入建模` })
  }
  if (state.candidatesPendingReview > 0) {
    steps.push({ action: 'review_candidates', label: '审核候选资产', reason: `${String(state.candidatesPendingReview)} 条候选资产待审核` })
  }
  if (state.recordsPendingConfirmation > 0) {
    steps.push({ action: 'confirm_records', label: '处理待确认记录', reason: `${String(state.recordsPendingConfirmation)} 条记录待确认` })
  }
  if (state.blockedTasks > 0) {
    steps.push({ action: 'map_project_data', label: '处理数据阻断', reason: `${String(state.blockedTasks)} 个数据构建处于失败或失效状态` })
  }
  if (steps.length === 0 && state.projectCount > 0) {
    steps.push({ action: 'run_task', label: '开始任务', reason: '当前空间的能力与数据已就绪' })
  }
  return steps
}

export class WorkbenchOverviewService implements WorkbenchOverviewReader {
  readonly #state: WorkbenchStateReader
  readonly #capabilities: WorkbenchCapabilitySource
  readonly #now: () => string

  constructor(dependencies: WorkbenchOverviewServiceDependencies) {
    this.#state = dependencies.state
    this.#capabilities = dependencies.capabilities
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async readOverview(scopeRef: ScopeRef, subject: WorkbenchSubject, ctx: ToolContext): Promise<WorkbenchOverview> {
    assertRequestScope(scopeRef, ctx)
    switch (subject.kind) {
      case 'space':
        return this.#spaceOverview(scopeRef, ctx)
      case 'industry_workspace':
        return this.#workspaceOverview(scopeRef, subject.workspaceId, subject.revision, ctx)
      case 'project':
        return this.#projectOverview(scopeRef, subject.projectId, subject.revision, ctx)
    }
  }

  async #spaceOverview(scopeRef: ScopeRef, ctx: ToolContext): Promise<WorkbenchOverview> {
    const [state, capabilities] = await Promise.all([
      this.#state.readSpaceState(scopeRef, ctx),
      this.#capabilities.readCapabilities(scopeRef, ctx),
    ])
    const counts: WorkbenchCounts = {
      proposedSources: state.proposedSources,
      approvedSourcesNotAdmitted: state.approvedSourcesNotAdmitted,
      candidatesPendingReview: state.candidatesPendingReview,
      recordsPendingConfirmation: state.recordsPendingConfirmation,
      blockedTasks: state.blockedTasks,
    }
    return this.#project(scopeRef, { kind: 'space' }, REVISION_ZERO, '当前空间概览', counts, deriveSpaceSteps(state), [], capabilities)
  }

  async #workspaceOverview(scopeRef: ScopeRef, workspaceId: Uuid, requestedRevision: RevisionString, ctx: ToolContext): Promise<WorkbenchOverview> {
    const [state, capabilities] = await Promise.all([
      this.#state.readWorkspaceState(scopeRef, workspaceId, ctx),
      this.#capabilities.readCapabilities(scopeRef, ctx),
    ])
    if (state === undefined) {
      throw new WorkbenchOverviewError('NOT_FOUND', `industry workspace ${workspaceId} is not visible in this scope`)
    }
    if (state.workspaceId !== workspaceId) {
      throw new WorkbenchOverviewError('STORE_FAILED', 'the state reader returned a workspace for a different id')
    }
    assertNotMoved(requestedRevision, state.revision, '行业工作区')
    const counts: WorkbenchCounts = {
      proposedSources: state.proposedSourceCount,
      approvedSourcesNotAdmitted: Math.max(0, state.approvedSourceCount - state.admittedSourceCount),
      candidatesPendingReview: state.candidatesPendingReview,
      recordsPendingConfirmation: 0,
      blockedTasks: 0,
    }
    const blockers: WorkbenchBlocker[] = state.state === 'archived'
      ? [{ code: 'WORKSPACE_ARCHIVED', message: '该行业工作区已归档', retryable: false, target: targetKindWorkspace(workspaceId) }]
      : []
    const subject: WorkbenchSubject = { kind: 'industry_workspace', workspaceId, revision: state.revision }
    return this.#project(scopeRef, subject, state.revision, '行业工作区概览', counts, deriveWorkspaceSteps(state), blockers, capabilities)
  }

  async #projectOverview(scopeRef: ScopeRef, projectId: Uuid, requestedRevision: RevisionString, ctx: ToolContext): Promise<WorkbenchOverview> {
    const [state, capabilities] = await Promise.all([
      this.#state.readProjectState(scopeRef, projectId, ctx),
      this.#capabilities.readCapabilities(scopeRef, ctx),
    ])
    if (state === undefined) {
      throw new WorkbenchOverviewError('NOT_FOUND', `project ${projectId} is not visible in this scope`)
    }
    if (state.projectId !== projectId) {
      throw new WorkbenchOverviewError('STORE_FAILED', 'the state reader returned a project for a different id')
    }
    assertNotMoved(requestedRevision, state.revision, '项目')
    const blocked = state.readiness.filter((entry) => entry.state === 'failed' || entry.state === 'revoked')
    const counts: WorkbenchCounts = {
      proposedSources: 0,
      approvedSourcesNotAdmitted: 0,
      candidatesPendingReview: 0,
      recordsPendingConfirmation: state.recordsPendingConfirmation,
      blockedTasks: blocked.length,
    }
    const blockers = state.readiness
      .filter((entry) => entry.state !== 'ready')
      .map((entry) => readinessBlocker(entry, projectId))
    const subject: WorkbenchSubject = { kind: 'project', projectId, revision: state.revision }
    return this.#project(scopeRef, subject, state.revision, '项目概览', counts, deriveProjectSteps(state), blockers, capabilities)
  }

  #project(
    scopeRef: ScopeRef,
    subject: WorkbenchSubject,
    revision: RevisionString,
    summary: string,
    counts: WorkbenchCounts,
    nextSteps: readonly WorkbenchNextStep[],
    blockers: readonly WorkbenchBlocker[],
    capabilities: readonly WorkbenchCapability[],
  ): WorkbenchOverview {
    const asOf: Rfc3339UtcTimestamp = this.#now()
    // The digest pins exactly the deterministic projection content; `asOf` is excluded so the
    // same persisted state always produces the same digest (mirroring the resolved-profile hash).
    const digest: Sha256Digest = sha256DigestOf(
      canonicalJson({ scopeRef, subject, revision, summary, counts, nextSteps, blockers, capabilities }),
    )
    const overview: WorkbenchOverview = {
      schemaVersion: 'workbench-overview@1',
      scopeRef,
      subject,
      revision,
      digest,
      summary,
      counts,
      nextSteps,
      blockers,
      capabilities,
      asOf,
    }
    // Boundary validation: an unavailable ability without a reason, a bad count or a stale target is
    // refused here instead of being returned as a half-formed projection.
    assertWorkbenchOverviewShape(overview)
    return overview
  }
}
