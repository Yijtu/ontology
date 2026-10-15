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
  readonly trustTier?: SourceTrustTier
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
 * Submit one versioned review (accept / reject / re-tier). It carries the mandatory reason and basis
 * references the design adds, pins the revision with `If-Match` and is idempotent by key. The service
 * owns `reviewedBy`, the workspace check and the audit event; the browser never asserts identity here.
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
      ...(request.trustTier === undefined ? {} : { trustTier: request.trustTier }),
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
