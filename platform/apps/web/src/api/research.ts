import {
  RESEARCH_STAGES,
  RESEARCH_STATUSES,
  assertEffectiveToolSelectionShape,
  assertResearchExecutionAnyShape,
  isResearchExecutionV2,
} from '@ontology/contracts'
import type {
  DefinitionCandidateKind,
  EffectiveToolSelection,
  ModelingBrief,
  ModelingBriefMustCover,
  ResearchCoverage,
  ResearchExecutionAny,
  ResearchExecutionV2,
  ResearchLimits,
  ResearchSourceRef,
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
 *
 * A run is read through `research-execution@2` (the agentic-research projection, design §8) when the
 * backend serves it, and through the legacy `@1` record otherwise. `@2` adds the per-`mustCover`
 * coverage gaps, the human todos, the evidence list, the candidate receipts and the honest usage;
 * `@1` records stay readable and simply omit those richer groups.
 */

/** Either projection version a reader must render without re-deriving one field from another. */
export type ResearchExecutionView = ResearchExecutionAny

/** The projection version of a run view, for the rare branch that needs the richer `@2` groups. */
export function researchViewVersion(research: ResearchExecutionView): 'research-execution@1' | 'research-execution@2' {
  return research.schemaVersion
}

/** The `@2` projection, or `undefined` for a legacy `@1` record. */
export function asResearchV2(research: ResearchExecutionView): ResearchExecutionV2 | undefined {
  return isResearchExecutionV2(research) ? research : undefined
}

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
  /** The questions the run must cover; shown as coverage gaps and never as completed progress. */
  readonly mustCover?: readonly ModelingBriefMustCover[]
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

/**
 * The exact body the N08 run route accepts: the brief's fields plus the two counts and the deadline,
 * with policy/budget refs pinned server-side. It is deliberately flat (the route rejects unknown
 * fields), and it carries only the public brief the user submitted — no record, original or secret.
 */
function researchRunBody(request: ResearchRunRequest): Record<string, unknown> {
  return {
    goal: request.brief.goal,
    allowedResearchDomains: request.brief.allowedResearchDomains,
    targetKinds: request.brief.targetKinds,
    ...(request.brief.freshnessHint === undefined ? {} : { freshnessHint: request.brief.freshnessHint }),
    ...(request.brief.mustCover === undefined ? {} : { mustCover: request.brief.mustCover }),
    sourceLimit: request.limits.sourceLimit,
    candidateLimit: request.limits.candidateLimit,
    deadline: request.limits.deadline,
  }
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
  if (draft.mustCover !== undefined) {
    if (draft.mustCover.length > 64) return { valid: false, reason: '必须覆盖的问题最多 64 条。' }
    const named = draft.mustCover.filter((entry) => entry.name.trim().length > 0)
    if (named.length !== draft.mustCover.length) return { valid: false, reason: '必须覆盖的问题需要填写名称。' }
  }
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
    ...(draft.mustCover === undefined || draft.mustCover.length === 0 ? {} : { mustCover: draft.mustCover }),
  }
  return {
    brief,
    limits: { sourceLimit: draft.sourceLimit, candidateLimit: draft.candidateLimit, deadline },
    allowedDomains: draft.allowedDomains,
  }
}

function parseExecution(value: unknown): ResearchExecutionView {
  try {
    assertResearchExecutionAnyShape(value)
  } catch {
    return invalidWire()
  }
  return value
}

/** Accept the run record under the documented envelope key, or as the bare execution. */
function researchFromEnvelope(value: unknown): ResearchExecutionView {
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
): Promise<ResearchExecutionView> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`
  const value = await client.requestJson<unknown>('POST', path, { ...options, body: researchRunBody(request), idempotencyKey })
  return researchFromEnvelope(value)
}

/** Read one run by id. A silent route surfaces as an error the caller classifies, never a fake run. */
export async function readResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  researchId: string,
  signal?: AbortSignal,
): Promise<ResearchExecutionView> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  return researchFromEnvelope(value)
}

/**
 * Append research grounded in an already-ended run (design §3/§10). It is a **new** execution with a
 * new authorization and budget, linked to the previous products, never a revival or retry of the
 * exhausted one. The route is `/continuations` on the previous run; when it is not served the caller
 * classifies the failure and never fabricates a run.
 */
export async function continueResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  previousResearchId: string,
  request: ResearchRunRequest,
  idempotencyKey: string,
  options: RequestOptions = {},
): Promise<ResearchExecutionView> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(previousResearchId)}/continuations`
  const value = await client.requestJson<unknown>('POST', path, { ...options, body: researchRunBody(request), idempotencyKey })
  return researchFromEnvelope(value)
}

export async function cancelResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  researchId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ResearchExecutionView> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}/cancel`
  const value = await client.requestJson<unknown>('POST', path, {
    body: {},
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  return researchFromEnvelope(value)
}

/**
 * Resume a non-terminal run (design §3/§10): the server re-arms the same execution, reusing its
 * original binding and budget. It never revives a terminal run — that is what `continueResearchRun`
 * is for. When the route is not served the caller classifies the failure and never fabricates a run.
 */
export async function resumeResearchRun(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  researchId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ResearchExecutionView> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}/resume`
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

export function researchOutcome(research: ResearchExecutionView): ResearchOutcome {
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

export function isResearchActive(research: ResearchExecutionView): boolean {
  return research.status === 'queued' || research.status === 'running'
}

/**
 * An ending that cannot be revived in place: the user may still append a **new** research run
 * grounded in the products this one produced (design §3). A live run and a waiting-for-review run
 * are never offered this.
 */
export function researchCanContinue(research: ResearchExecutionView): boolean {
  const outcome = researchOutcome(research)
  return outcome === 'cancelled' || outcome === 'failed' || outcome === 'partial' || outcome === 'no_results'
}

/** A bounded, honest label for why a terminal run may be continued; never a fake success. */
export function researchContinuationReason(research: ResearchExecutionView): string {
  switch (research.stopReason) {
    case 'budget_exhausted':
      return '本次额度已用尽，原执行不可复活。'
    case 'deadline_exceeded':
      return '本次已超过时限而结束。'
    case 'cancelled':
      return '本次已取消，已提交的候选会保留。'
    case 'provider_failed':
      return '检索方失败导致本次未完成。'
    case 'no_results':
      return '本次未找到可归档材料。'
    case 'partial_results':
      return '本次只得到部分结果。'
    default:
      return '本次已结束。'
  }
}

/** The candidate sources this run proposed, for the "候选来源" product group. */
export function researchSourceGroups(research: ResearchExecutionView): readonly ResearchSourceRef[] {
  return research.sources ?? []
}

/** Pages discovered but never archived: links only, never citable as a formal basis. */
export function hasNoArchivedSnapshot(coverage: ResearchCoverage): boolean {
  return coverage.archivedSnapshots === 0
}

/* ----------------------------------------------------------------------------------------- */
/* The search service actually used, docked to the tool-connection contract (design §9/§10)    */
/* ----------------------------------------------------------------------------------------- */

/** The one tool a research run reads public pages through; a tool connection, not a model. */
export const SEARCH_SERVICE_TOOL_ID = 'web_search' as const

/**
 * The resolved public search service for a workspace, or an honest reason it cannot be named.
 * `unavailable` means the effective-tool surface is not served yet (R06 not merged): the UI shows
 * the reason and never invents a service, endpoint or credential state.
 */
export type SearchServiceAvailability =
  | { readonly state: 'available'; readonly selection: EffectiveToolSelection }
  | { readonly state: 'blocked'; readonly reason: string; readonly selection: EffectiveToolSelection }
  | { readonly state: 'unavailable'; readonly reason: string }

const TOOL_SELECTION_REASON_LABELS: Readonly<Record<string, string>> = {
  TOOL_NOT_CONFIGURED: '未配置公共搜索服务',
  TOOL_DISABLED: '公共搜索服务已停用',
  TOOL_CAPABILITY_MISMATCH: '该连接不提供网页搜索能力',
  CREDENTIAL_MISSING: '公共搜索服务的凭据缺失',
  TOOL_IN_USE: '该搜索服务正被其他运行使用，暂不可改',
  TOOL_BINDING_REVOKED: '本运行绑定的搜索连接已被撤销',
}

/** The resolved selection carries no credential; only its name, revision and blocked reason show. */
export function searchServiceReason(selection: EffectiveToolSelection): string {
  if (selection.blockedReason !== undefined) return TOOL_SELECTION_REASON_LABELS[selection.blockedReason] ?? selection.blockedReason
  switch (selection.state) {
    case 'disabled':
      return '公共搜索服务已停用'
    case 'unconfigured':
      return '当前空间与工作区都没有配置公共搜索服务'
    case 'blocked':
      return '公共搜索服务不可用'
    default:
      return '搜索服务可用'
  }
}

function parseEffectiveToolSelection(value: unknown): EffectiveToolSelection | undefined {
  try {
    assertEffectiveToolSelectionShape(value)
    return value
  } catch {
    return undefined
  }
}

/**
 * Read the effective `web_search` tool for a workspace. It mirrors the effective-models read: the
 * scope is re-checked server-side, and any credential-shaped field fails closed. When the route is
 * not served the caller shows the reason instead of a fabricated "已配置搜索服务".
 */
export async function readEffectiveSearchService(
  client: Pick<WorkbenchClient, 'requestJson'>,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SearchServiceAvailability> {
  const query = new URLSearchParams({ scope: `workspace:${workspaceId}`, tools: SEARCH_SERVICE_TOOL_ID })
  try {
    const value = await client.requestJson<unknown>('GET', `/api/v1/core/ai/effective-tools?${query.toString()}`, signal === undefined ? {} : { signal })
    if (!Array.isArray(value)) return { state: 'unavailable', reason: '公共搜索服务的生效选择无法识别（响应格式不符）。' }
    const parsed = value.map((entry) => parseEffectiveToolSelection(entry)).filter((entry): entry is EffectiveToolSelection => entry !== undefined)
    const selection = parsed.find((entry) => entry.toolId === SEARCH_SERVICE_TOOL_ID)
    if (selection === undefined) return { state: 'unavailable', reason: '当前部署未返回公共搜索服务的生效选择。' }
    if (selection.state === 'available') return { state: 'available', selection }
    return { state: 'blocked', reason: searchServiceReason(selection), selection }
  } catch (error) {
    return { state: 'unavailable', reason: searchServiceFailureReason(error) }
  }
}

/** A stable, user-facing reason the search service cannot be named; a missing route is named as such. */
export function searchServiceFailureReason(error: unknown): string {
  if (isResearchSurfaceMissing(error)) {
    return '当前部署未接入 AI 工具连接目录，无法确认实际使用的公共搜索服务；开始时由服务端固定实际搜索连接，界面不会补造服务商。'
  }
  if (error instanceof ApiError && error.permissionDenied) return '当前账号没有查看工具连接的权限；请联系管理员确认公共搜索服务。'
  return '公共搜索服务的生效选择暂时无法读取；开始时由服务端固定实际搜索连接。'
}

export {
  RESEARCH_STAGES,
  RESEARCH_STATUSES,
}
