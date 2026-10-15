import { RESEARCH_STAGES, RESEARCH_STATUSES, assertResearchExecutionShape } from '@ontology/contracts'
import type {
  DefinitionCandidateKind,
  ModelingBrief,
  ResearchCoverage,
  ResearchExecution,
  ResearchLimits,
  ResearchStage,
  ResearchStatus,
  ResearchStopReason,
  WebSearchFreshnessHint,
} from '@ontology/contracts'
import { isRecord } from '@ontology/contracts'
import type { RequestOptions, WorkbenchClient } from './client'
import { ApiError } from './errors'
import { invalidWire } from './ontology'

/**
 * The bounded AI-research client (design §1.4/§2.3/§2.4, A-R02). It talks to the async research
 * run surface `POST/GET /api/v1/industry-workspaces/:id/research-runs` that the research
 * orchestration owns. That surface is not part of the merged base yet, so every reader degrades to
 * an explicit `unavailable` reason instead of inventing a run — the UI never fabricates sources,
 * coverage numbers or a cost estimate.
 *
 * Two things this module deliberately does *not* do: it never re-derives the two counts (a source
 * is not a candidate) and it never turns the server-pinned `stopReason` into a silent success.
 */

export const RESEARCH_STAGE_LABELS: Readonly<Record<ResearchStage, string>> = {
  planning: '规划查询',
  searching: '检索公共资料',
  archiving: '归档快照',
  awaiting_source_review: '待确认来源',
  generating_candidates: '生成候选',
  completed: '已完成',
}

export const RESEARCH_STATUS_LABELS: Readonly<Record<ResearchStatus, string>> = {
  queued: '排队中',
  running: '进行中',
  awaiting_confirmation: '等待人工确认',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

/** Stop reasons are shown verbatim; `partial_results` is an honest bounded ending, not a success. */
export const RESEARCH_STOP_REASON_LABELS: Readonly<Record<ResearchStopReason, string>> = {
  completed: '正常完成',
  partial_results: '部分结果',
  cancelled: '已取消',
  deadline_exceeded: '超过时限',
  budget_exhausted: '额度用尽',
  no_results: '无结果',
  provider_failed: '检索方失败',
}

export const FRESHNESS_LABELS: Readonly<Record<WebSearchFreshnessHint, string>> = {
  any: '不限时间',
  day: '近一天',
  week: '近一周',
  month: '近一月',
  year: '近一年',
}

/** The candidate kinds a research brief may target; rules/actions stay in their own generators. */
export const RESEARCH_TARGET_KINDS: readonly DefinitionCandidateKind[] = ['object', 'attribute', 'relation']
export const RESEARCH_TARGET_KIND_LABELS: Readonly<Record<DefinitionCandidateKind, string>> = {
  object: '对象',
  attribute: '属性',
  relation: '关系',
}

/** A bounded, user-submitted public research brief. It carries only the fields the user typed. */
export interface ResearchAuthorizationDraft {
  readonly goal: string
  readonly allowedDomains: readonly string[]
  readonly targetKinds: readonly DefinitionCandidateKind[]
  readonly freshnessHint: WebSearchFreshnessHint
  readonly sourceLimit: number
  readonly candidateLimit: number
  readonly timeLimitMinutes: number
}

/**
 * The request body the run surface fixes before a run starts. `allowedDomains` is the user's own
 * selection; the deployment/space policy is intersected server-side and the model can never widen
 * it. It contains no project record, private original, history answer or credential — only the
 * brief the user explicitly submitted.
 */
export interface ResearchRunRequest {
  readonly brief: ModelingBrief
  readonly limits: ResearchLimits
  readonly allowedDomains: readonly string[]
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/iu

export interface ResearchDraftValidation {
  readonly valid: boolean
  readonly reason?: string
}

/** Validate the draft client-side so an obviously invalid brief never becomes a provider call. */
export function validateAuthorizationDraft(draft: ResearchAuthorizationDraft): ResearchDraftValidation {
  if (draft.goal.trim().length === 0) return { valid: false, reason: '请填写业务目标。' }
  if (draft.goal.length > 2000) return { valid: false, reason: '业务目标过长（上限 2000 字）。' }
  if (draft.allowedDomains.length === 0) return { valid: false, reason: '至少填写一个允许检索的域名。' }
  if (draft.allowedDomains.length > 32) return { valid: false, reason: '允许域名最多 32 个。' }
  const bad = draft.allowedDomains.find((domain) => !DOMAIN.test(domain))
  if (bad !== undefined) return { valid: false, reason: `域名“${bad}”格式不正确，示例：example.com。` }
  if (new Set(draft.allowedDomains).size !== draft.allowedDomains.length) return { valid: false, reason: '允许域名不能重复。' }
  if (draft.targetKinds.length === 0) return { valid: false, reason: '至少选择一种候选类型。' }
  if (!Number.isSafeInteger(draft.sourceLimit) || draft.sourceLimit < 1 || draft.sourceLimit > 200) return { valid: false, reason: '来源数上限须在 1..200。' }
  if (!Number.isSafeInteger(draft.candidateLimit) || draft.candidateLimit < 1 || draft.candidateLimit > 500) return { valid: false, reason: '候选数上限须在 1..500。' }
  if (!Number.isSafeInteger(draft.timeLimitMinutes) || draft.timeLimitMinutes < 1 || draft.timeLimitMinutes > 120) return { valid: false, reason: '时限须在 1..120 分钟。' }
  return { valid: true }
}

/** Parse one comma/newline/space separated domain list into a normalised, de-duplicated array. */
export function parseDomains(text: string): readonly string[] {
  const seen = new Set<string>()
  for (const token of text.split(/[\s,，、;；]+/u)) {
    const value = token.trim().toLowerCase()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
  }
  return [...seen]
}

/** Build the fixable request from a validated draft; `deadline` is derived from the time limit. */
export function buildResearchRequest(workspaceId: string, draft: ResearchAuthorizationDraft, now: Date): ResearchRunRequest {
  const deadline = new Date(now.getTime() + draft.timeLimitMinutes * 60_000).toISOString()
  const brief: ModelingBrief = {
    schemaVersion: 'modeling-brief@1',
    workspaceId,
    goal: draft.goal.trim(),
    allowedResearchDomains: draft.allowedDomains,
    freshnessHint: draft.freshnessHint,
    targetKinds: draft.targetKinds,
  }
  return {
    brief,
    limits: { sourceLimit: draft.sourceLimit, candidateLimit: draft.candidateLimit, deadline },
    allowedDomains: draft.allowedDomains,
  }
}

function parseExecution(value: unknown): ResearchExecution {
  try {
    assertResearchExecutionShape(value)
  } catch {
    return invalidWire()
  }
  return value
}

/** Accept the run record under the documented envelope key, or as the bare execution. */
function researchFromEnvelope(value: unknown): ResearchExecution {
  if (!isRecord(value)) return invalidWire()
  if (isRecord(value['research'])) return parseExecution(value['research'])
  if (isRecord(value['execution'])) return parseExecution(value['execution'])
  return parseExecution(value)
}

/**
 * `true` when the failure means the async research/run surface is not served at all (route absent),
 * as opposed to an authorization, budget or scope error the user can act on.
 */
export function isResearchSurfaceMissing(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 404 || error.status === 405 || error.status === 501
      || error.code === 'NOT_FOUND' || error.code === 'HTTP_404' || error.code === 'HTTP_405')
}

export async function startResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  request: ResearchRunRequest,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ResearchExecution> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`
  const value = await client.requestJson<unknown>('POST', path, { ...options, body: request, idempotencyKey })
  return researchFromEnvelope(value)
}

/** Read one run by id. A silent route surfaces as an error the caller classifies, never a fake run. */
export async function readResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  researchId: string,
  signal?: AbortSignal,
): Promise<ResearchExecution> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  return researchFromEnvelope(value)
}

export async function cancelResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  researchId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ResearchExecution> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}/cancel`
  const value = await client.requestJson<unknown>('POST', path, {
    body: {},
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  return researchFromEnvelope(value)
}

/** A user-facing reason for a research failure; a missing route names the missing capability. */
export function researchFailureReason(error: unknown): string {
  if (isResearchSurfaceMissing(error)) {
    return '当前部署未接入受控的研究编排服务，无法创建或读取研究任务；已保存的授权输入会保留，接入后即可重试。'
  }
  if (error instanceof ApiError) {
    if (error.permissionDenied) return '当前账号没有发起公共研究的权限；请联系管理员授予研究者角色。'
    if (error.code === 'CAPABILITY_NOT_CONFIGURED') return '研究能力尚未配置：需要受控的公共搜索、快照归档与研究模型。'
    if (error.code === 'BUDGET_EXHAUSTED') return '研究额度已用尽；追加调研是一次新的明确授权，需重新确认范围与额度。'
    if (error.conflict) return '研究记录已更新；请刷新回读最新状态后再操作。'
    return `${error.message}（${error.code}）`
  }
  return error instanceof Error ? error.message : '研究请求未完成。'
}

/** The honest terminal shape of one run; used to pick the visible ending, never to fake success. */
export type ResearchOutcome =
  | 'active'
  | 'awaiting_confirmation'
  | 'completed'
  | 'partial'
  | 'no_results'
  | 'cancelled'
  | 'failed'

export function researchOutcome(research: ResearchExecution): ResearchOutcome {
  switch (research.status) {
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'running':
    case 'queued':
      return 'active'
    case 'awaiting_confirmation':
      return 'awaiting_confirmation'
    case 'completed':
      switch (research.stopReason) {
        case 'no_results':
          return 'no_results'
        case 'partial_results':
          return 'partial'
        case 'cancelled':
          return 'cancelled'
        case 'deadline_exceeded':
        case 'budget_exhausted':
        case 'provider_failed':
          return 'failed'
        default:
          return 'completed'
      }
    default:
      return 'failed'
  }
}

export function isResearchActive(research: ResearchExecution): boolean {
  return research.status === 'queued' || research.status === 'running'
}

/** Pages discovered but never archived: links only, never citable as a formal basis. */
export function hasNoArchivedSnapshot(coverage: ResearchCoverage): boolean {
  return coverage.archivedSnapshots === 0
}

export {
  RESEARCH_STAGES,
  RESEARCH_STATUSES,
}
