import {
  isRecord,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isUuid,
  SOURCE_TRUST_TIERS,
} from '@ontology/contracts'
import type { ResourceRef, SourceTrustTier } from '@ontology/contracts'
import type { RequestOptions, WorkbenchClient } from './client'
import { invalidWire } from './ontology'
import type { WorkspaceSourceView } from './workspace-authoring'

/**
 * The candidate-source read/review client (design §2.4 "来源审核命令" / §2.1 `CandidateSourceStore`).
 *
 * A candidate source is a *proposed* source with a provenance tier a human must review before it may
 * ground a publishable asset. This module is the only place the web app reads that tier, so the UI can
 * label the four-level 来源类别 without ever deriving an authority signal from search order or parse
 * success. The review command is a compare-and-swap on the exact revision the reviewer saw; a
 * `VERSION_CONFLICT` keeps the caller's draft instead of overwriting it.
 */
export type CandidateSourceKind = 'upload' | 'web_fetch' | 'standard_ref'
export type CandidateSourceReviewState = 'proposed' | 'approved' | 'rejected'
export type SourceIntakePurpose = 'industry_basis' | 'project_record'

export interface CandidateSourceRecordView {
  readonly sourceId: string
  readonly workspaceId: string
  readonly kind: CandidateSourceKind
  readonly trustTier: SourceTrustTier
  readonly reviewState: CandidateSourceReviewState
  readonly contentRef: ResourceRef
  readonly contentDigest: string
  readonly revision: string
  readonly recordedAt: string
  readonly proposedBy: string
  readonly title?: string
  readonly originUrl?: string
  readonly publisher?: string
  readonly researchRunId?: string
}

export const CANDIDATE_SOURCE_KINDS: readonly CandidateSourceKind[] = ['upload', 'web_fetch', 'standard_ref']
export const CANDIDATE_SOURCE_REVIEW_STATES: readonly CandidateSourceReviewState[] = ['proposed', 'approved', 'rejected']

/** The four provenance levels, phrased as the product's 来源类别 (design §1.4). No percentages. */
export const TRUST_TIER_LABELS: Readonly<Record<SourceTrustTier, string>> = {
  agent_researched: 'AI 调研，待确认',
  public_standard: '已确认公共标准/规范',
  customer_authoritative: '已确认业务权威资料',
  synthetic: '合成验证资料',
}
export const CANDIDATE_KIND_LABELS: Readonly<Record<CandidateSourceKind, string>> = {
  upload: '上传资料',
  web_fetch: '网页归档',
  standard_ref: '标准引用',
}
export const REVIEW_STATE_LABELS: Readonly<Record<CandidateSourceReviewState, string>> = {
  proposed: '待审核',
  approved: '已接受',
  rejected: '已拒绝',
}
export const INTAKE_PURPOSE_LABELS: Readonly<Record<SourceIntakePurpose, string>> = {
  industry_basis: '作为行业依据',
  project_record: '作为项目记录',
}

const PARSE_STATE_LABELS: Readonly<Record<string, string>> = {
  complete: '解析完成',
  parsed: '解析完成',
  partial: '部分解析',
  failed: '解析失败',
  pending: '等待解析',
  processing: '正在解析',
}

function isTrustTier(value: unknown): value is SourceTrustTier {
  return typeof value === 'string' && (SOURCE_TRUST_TIERS as readonly string[]).includes(value)
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseCandidateSource(value: unknown): CandidateSourceRecordView {
  if (!isRecord(value) || value['schemaVersion'] !== 'candidate-source@1'
    || !isUuid(value['sourceId']) || !isUuid(value['workspaceId'])
    || !CANDIDATE_SOURCE_KINDS.includes(value['kind'] as CandidateSourceKind)
    || !isTrustTier(value['trustTier']) || !isResourceRef(value['contentRef'])
    || !isSha256Digest(value['contentDigest']) || !isRevisionString(value['revision'])
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(value['reviewState'] as CandidateSourceReviewState)
    || typeof value['recordedAt'] !== 'string' || typeof value['proposedBy'] !== 'string') {
    return invalidWire()
  }
  const origin = isRecord(value['origin']) ? value['origin'] : {}
  const title = optionalText(value['title'])
  const originUrl = optionalText(origin['url'])
  const publisher = optionalText(origin['publisher'])
  const researchRunId = isUuid(value['researchRunId']) ? value['researchRunId'] : undefined
  return {
    sourceId: value['sourceId'], workspaceId: value['workspaceId'],
    kind: value['kind'] as CandidateSourceKind, trustTier: value['trustTier'],
    reviewState: value['reviewState'] as CandidateSourceReviewState,
    contentRef: value['contentRef'], contentDigest: value['contentDigest'], revision: value['revision'],
    recordedAt: value['recordedAt'], proposedBy: value['proposedBy'],
    ...(title === undefined ? {} : { title }), ...(originUrl === undefined ? {} : { originUrl }),
    ...(publisher === undefined ? {} : { publisher }), ...(researchRunId === undefined ? {} : { researchRunId }),
  }
}

/**
 * A tolerant read result. The candidate-source list is only reachable when the deployment wires the
 * review store; a deployment without it (or a legacy corpus-shaped payload) reports `unavailable`
 * with a concrete reason instead of failing the whole source workbench or inventing candidate rows.
 */
export type CandidateSourceReadResult =
  | { readonly availability: 'ready'; readonly sources: readonly CandidateSourceRecordView[]; readonly complete: boolean; readonly totalKnown?: number }
  | { readonly availability: 'unavailable'; readonly reason: string }

export async function readCandidateSources(client: WorkbenchClient, workspaceId: string, signal?: AbortSignal): Promise<CandidateSourceReadResult> {
  let value: unknown
  try {
    value = await client.requestJson('GET', `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/sources`, { ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    return { availability: 'unavailable', reason: error instanceof Error ? error.message : '来源审核接口未能读取。' }
  }
  if (!isRecord(value) || !Array.isArray(value['sources'])) {
    return { availability: 'unavailable', reason: '当前部署未提供来源审核接口；来源库只显示已纳入语料的真实资料。' }
  }
  try {
    const sources = value['sources'].map(parseCandidateSource)
    const totalKnown = typeof value['totalKnown'] === 'number' && Number.isSafeInteger(value['totalKnown']) && value['totalKnown'] >= 0 ? value['totalKnown'] : undefined
    return { availability: 'ready', sources, complete: value['complete'] !== false, ...(totalKnown === undefined ? {} : { totalKnown }) }
  } catch {
    return { availability: 'unavailable', reason: '来源审核接口返回了无法确认的格式；来源库只显示已纳入语料的真实资料。' }
  }
}

export interface CandidateSourceReviewRequest {
  readonly sourceId: string
  readonly reviewState: CandidateSourceReviewState
  readonly reason: string
  readonly expectedRevision: string
  readonly basisRefs: readonly ResourceRef[]
  readonly idempotencyKey: string
}
export interface CandidateSourceReviewResult {
  readonly sourceId: string
  readonly revision: string
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier: SourceTrustTier
  readonly replayed: boolean
}

/**
 * Submit one versioned review (accept / reject). It carries the mandatory reason and basis references
 * the design adds, pins the revision with `If-Match` and is idempotent by key. It deliberately does
 * **not** carry a `trustTier`: accepting a source never changes its provenance tier (design §7), so
 * an agent-researched proposal stays agent-researched until a separate promotion.
 */
export async function reviewCandidateSource(
  client: WorkbenchClient,
  workspaceId: string,
  request: CandidateSourceReviewRequest,
  options: RequestOptions = {},
): Promise<CandidateSourceReviewResult> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(request.sourceId)}/reviews`
  const value = await client.requestJson('POST', path, {
    ...options,
    body: {
      reviewState: request.reviewState,
      reason: request.reason,
      basisRefs: request.basisRefs,
    },
    ifMatch: request.expectedRevision,
    idempotencyKey: request.idempotencyKey,
  })
  if (!isRecord(value)) return invalidWire()
  const receipt = isRecord(value['receipt']) ? value['receipt'] : value
  const source = isRecord(value['source']) ? value['source'] : receipt
  if (!isRecord(source) || !isUuid(source['sourceId']) || source['sourceId'] !== request.sourceId
    || !isRevisionString(source['revision']) || !isTrustTier(source['trustTier'])
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(source['reviewState'] as CandidateSourceReviewState)) {
    return invalidWire()
  }
  return {
    sourceId: source['sourceId'], revision: source['revision'],
    reviewState: source['reviewState'] as CandidateSourceReviewState, trustTier: source['trustTier'],
    replayed: receipt['replayed'] === true,
  }
}

export interface CandidateSourcePromotionRequest {
  readonly sourceId: string
  readonly nextTrustTier: SourceTrustTier
  readonly reason: string
  readonly expectedRevision: string
  readonly basisRefs: readonly ResourceRef[]
  readonly idempotencyKey: string
}
export interface CandidateSourcePromotionResult {
  readonly sourceId: string
  readonly revision: string
  readonly reviewState: CandidateSourceReviewState
  readonly trustTier: SourceTrustTier
  readonly replayed: boolean
}

/**
 * Promote a source's provenance tier (design §7). This is a separate, platform-admin operation: it
 * raises an `agent_researched` proposal to a publishable tier without changing the review decision.
 * A server that refuses the caller returns 403 and the error is surfaced, never swallowed.
 */
export async function promoteCandidateSourceTier(
  client: WorkbenchClient,
  workspaceId: string,
  request: CandidateSourcePromotionRequest,
  options: RequestOptions = {},
): Promise<CandidateSourcePromotionResult> {
  const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(request.sourceId)}/tier-promotions`
  const value = await client.requestJson('POST', path, {
    ...options,
    body: {
      nextTrustTier: request.nextTrustTier,
      reason: request.reason,
      basisRefs: request.basisRefs,
    },
    ifMatch: request.expectedRevision,
    idempotencyKey: request.idempotencyKey,
  })
  if (!isRecord(value)) return invalidWire()
  const promotion = isRecord(value['promotion']) ? value['promotion'] : value
  if (!isRecord(promotion) || !isUuid(promotion['sourceId']) || promotion['sourceId'] !== request.sourceId
    || !isRevisionString(promotion['revision']) || !isTrustTier(promotion['trustTier'])
    || !CANDIDATE_SOURCE_REVIEW_STATES.includes(promotion['reviewState'] as CandidateSourceReviewState)) {
    return invalidWire()
  }
  return {
    sourceId: promotion['sourceId'], revision: promotion['revision'],
    reviewState: promotion['reviewState'] as CandidateSourceReviewState, trustTier: promotion['trustTier'],
    replayed: promotion['replayed'] === true,
  }
}

/** One source cited by a candidate in the read-only hand-off projection (design §3/§4/§7). */
export interface ReviewHandoffLinkView {
  readonly index: number
  readonly sourceRef: ResourceRef
  readonly reviewState: CandidateSourceReviewState | 'unknown'
  readonly trustTier: SourceTrustTier
  readonly admitted: boolean
  readonly groundsPublication: boolean
  readonly pendingConfirmation: boolean
  readonly blockReason?: string
}
export interface ReviewHandoffCandidateView {
  readonly candidateId: string
  readonly candidateKind: 'source' | 'definition' | 'rule' | 'action'
  readonly state: string
  readonly blocked: boolean
  readonly blockCodes: readonly string[]
  readonly pendingConfirmation: boolean
  readonly readiness: 'ready_for_review' | 'pending_sources' | 'regrounding_required' | 'unknown'
  readonly regroundedCandidateId?: string
  readonly links: readonly ReviewHandoffLinkView[]
  readonly allSourcesConfirmed: boolean
}

/**
 * The source→asset review hand-off read (design §3/§4/§7). It lists every candidate an agent
 * submitted whose sources are not all confirmed, keeping each source separate so the UI can show
 * exactly which one still blocks the candidate. A deployment without the projection reports
 * `unavailable` with a concrete reason instead of fabricating candidate rows.
 */
export type ReviewHandoffReadResult =
  | { readonly availability: 'ready'; readonly workspaceId: string; readonly candidates: readonly ReviewHandoffCandidateView[]; readonly asOf: string }
  | { readonly availability: 'unavailable'; readonly reason: string }

export async function readReviewHandoff(client: WorkbenchClient, workspaceId: string, signal?: AbortSignal): Promise<ReviewHandoffReadResult> {
  let value: unknown
  try {
    value = await client.requestJson('GET', `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/review-handoff`, { ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    return { availability: 'unavailable', reason: error instanceof Error ? error.message : '来源与资产审核衔接接口未能读取。' }
  }
  if (!isRecord(value) || !Array.isArray(value['candidates'])) {
    return { availability: 'unavailable', reason: '当前部署未提供来源与资产审核衔接接口；资产工作台只显示已提交候选。' }
  }
  try {
    const candidates = value['candidates'].map(parseHandoffCandidate)
    const asOf = typeof value['asOf'] === 'string' ? value['asOf'] : ''
    return { availability: 'ready', workspaceId, candidates, asOf }
  } catch {
    return { availability: 'unavailable', reason: '来源与资产审核衔接接口返回了无法确认的格式。' }
  }
}

function parseHandoffCandidate(value: unknown): ReviewHandoffCandidateView {
  if (!isRecord(value) || !isUuid(value['candidateId'])
    || !['source', 'definition', 'rule', 'action'].includes(String(value['candidateKind']))
    || typeof value['state'] !== 'string' || typeof value['blocked'] !== 'boolean'
    || !Array.isArray(value['blockCodes']) || typeof value['pendingConfirmation'] !== 'boolean'
    || !['ready_for_review', 'pending_sources', 'regrounding_required', 'unknown'].includes(String(value['readiness']))
    || !Array.isArray(value['links']) || typeof value['allSourcesConfirmed'] !== 'boolean') {
    return invalidWire()
  }
  const links = value['links'].map(parseHandoffLink)
  const regroundedCandidateId = isUuid(value['regroundedCandidateId']) ? value['regroundedCandidateId'] : undefined
  return {
    candidateId: value['candidateId'], candidateKind: value['candidateKind'] as ReviewHandoffCandidateView['candidateKind'],
    state: value['state'], blocked: value['blocked'],
    blockCodes: value['blockCodes'].filter((code): code is string => typeof code === 'string'),
    pendingConfirmation: value['pendingConfirmation'], readiness: value['readiness'] as ReviewHandoffCandidateView['readiness'],
    ...(regroundedCandidateId === undefined ? {} : { regroundedCandidateId }),
    links, allSourcesConfirmed: value['allSourcesConfirmed'],
  }
}

function parseHandoffLink(value: unknown): ReviewHandoffLinkView {
  if (!isRecord(value) || !Number.isSafeInteger(value['index'])
    || !isResourceRef(value['sourceRef']) || !isTrustTier(value['trustTier'])
    || !['proposed', 'approved', 'rejected', 'unknown'].includes(String(value['reviewState']))
    || typeof value['admitted'] !== 'boolean' || typeof value['groundsPublication'] !== 'boolean'
    || typeof value['pendingConfirmation'] !== 'boolean') {
    return invalidWire()
  }
  const blockReason = optionalText(value['blockReason'])
  return {
    index: Number(value['index']), sourceRef: value['sourceRef'],
    reviewState: value['reviewState'] as ReviewHandoffLinkView['reviewState'], trustTier: value['trustTier'],
    admitted: value['admitted'], groundsPublication: value['groundsPublication'],
    pendingConfirmation: value['pendingConfirmation'],
    ...(blockReason === undefined ? {} : { blockReason }),
  }
}

/** One row of the 来源库. The four axes stay separate so a reviewed source is never read as authoritative. */
export interface SourceLibraryEntry {
  readonly key: string
  readonly title: string
  readonly kindLabel: string
  readonly trustTierLabel: string
  readonly reviewStateLabel: string
  readonly parseStateLabel: string
  readonly admissionLabel: string
  readonly candidate: CandidateSourceRecordView | undefined
  readonly corpus: WorkspaceSourceView | undefined
  readonly previewRef: ResourceRef | undefined
  readonly note?: string
}

function parseStateOf(source: WorkspaceSourceView): string {
  return PARSE_STATE_LABELS[source.status] ?? '待核对解析状态'
}

function corpusFor(corpus: readonly WorkspaceSourceView[], ref: ResourceRef): WorkspaceSourceView | undefined {
  return corpus.find((source) => source.sourceRef.id === ref.id)
}

/**
 * Merge the two server-side source identities into one library list without collapsing their meanings:
 * uploads join the corpus on ingest, while a candidate keeps the review tier a human must confirm.
 * Deduplication is by the stable source id, so the same immutable original is not shown twice.
 */
export function mergeSourceLibrary(
  corpus: readonly WorkspaceSourceView[],
  candidates: readonly CandidateSourceRecordView[],
): readonly SourceLibraryEntry[] {
  const entries: SourceLibraryEntry[] = []
  const matchedCorpusIds = new Set<string>()
  for (const candidate of candidates) {
    const corpusSource = corpusFor(corpus, candidate.contentRef)
    if (corpusSource !== undefined) matchedCorpusIds.add(corpusSource.sourceRef.id)
    const title = candidate.title ?? corpusSource?.name ?? `${CANDIDATE_KIND_LABELS[candidate.kind]}（无标题）`
    entries.push({
      key: candidate.sourceId, title, kindLabel: CANDIDATE_KIND_LABELS[candidate.kind],
      trustTierLabel: TRUST_TIER_LABELS[candidate.trustTier], reviewStateLabel: REVIEW_STATE_LABELS[candidate.reviewState],
      parseStateLabel: corpusSource === undefined ? '尚未归档可读原文' : parseStateOf(corpusSource),
      admissionLabel: candidate.reviewState === 'rejected' ? '已拒绝，未纳入建模' : corpusSource === undefined ? '已审核，尚未纳入建模' : '已纳入建模',
      candidate, corpus: corpusSource, previewRef: corpusSource?.sourceRef,
      ...(candidate.originUrl === undefined ? {} : { note: candidate.originUrl }),
    })
  }
  for (const source of corpus) {
    if (matchedCorpusIds.has(source.sourceRef.id)) continue
    entries.push({
      key: source.sourceRef.id, title: source.name ?? '未命名资料', kindLabel: '上传资料',
      trustTierLabel: '上传（未记录来源类别）', reviewStateLabel: '未记录审核', parseStateLabel: parseStateOf(source),
      admissionLabel: '已纳入当前草稿语料', candidate: undefined, corpus: source, previewRef: source.sourceRef,
    })
  }
  return entries
}
