import { isRecord, isResourceRef, isRevisionString, isSha256Digest, isUuid } from '@ontology/contracts'
import type { ResourceRef } from '@ontology/contracts'
import type { WorkbenchClient, RequestOptions } from './client'
import { ApiError } from './errors'

export interface SourceFragmentView {
  readonly sourceIndex: number
  readonly fragmentIndex: number
  readonly sourceRef: ResourceRef
  readonly text: string
  readonly table?: { readonly columns: readonly string[]; readonly cells: readonly string[] }
  readonly locator: unknown
  readonly precision: string
}
export interface GroundingView {
  readonly workspaceRevision: string
  readonly documentSetRef: ResourceRef
  readonly coverage: 'complete' | 'partial' | 'failed'
  readonly sources: readonly { readonly sourceRef: ResourceRef; readonly status: string; readonly reasons: readonly string[] }[]
  readonly fragments: readonly SourceFragmentView[]
  readonly usage: { readonly bytes: number; readonly readBytes: number; readonly fragments: number; readonly pages: number; readonly inputTokens: number }
}
export function invalidWire(): never {
  throw new ApiError(502, { code: 'INVALID_RESPONSE', message: '服务返回的资料或候选格式无法确认。', retryable: false, reasons: [], missingCapabilities: [] })
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) return invalidWire()
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidWire()
  return value
}
function canonicalRef(ref: ResourceRef | undefined): string { return ref === undefined ? "" : `${ref.id}:${ref.version}:${ref.digest}:${ref.kind}` }
export function parseGrounding(value: unknown): GroundingView {
  if (!isRecord(value) || !isRevisionString(value['workspaceRevision']) || !isResourceRef(value['documentSetRef']) ||
    !['complete', 'partial', 'failed'].includes(String(value['coverage'])) || !Array.isArray(value['sources']) ||
    !Array.isArray(value['fragments']) || !isRecord(value['usage'])) return invalidWire()
  const coverage = value['coverage']
  if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'failed') return invalidWire()
  const sources = value['sources'].map((source: unknown) => {
    if (!isRecord(source) || !isResourceRef(source['sourceRef']) || typeof source['status'] !== 'string') return invalidWire()
    return { sourceRef: source['sourceRef'], status: source['status'], reasons: strings(source['reasons']) }
  })
  const fragments = value['fragments'].map((fragment: unknown): SourceFragmentView => {
    if (!isRecord(fragment) || !isResourceRef(fragment['sourceRef']) || !isRecord(fragment['content']) || !isRecord(fragment['sourceSpan'])) return invalidWire()
    const content = fragment['content']
    const span = fragment['sourceSpan']
    if (!isUuid(span['parseId']) || !isRecord(span['locator']) || (span['kind'] === 'structured' ? !isUuid(span['recordId']) || !isSha256Digest(span['rowDigest']) : !isUuid(span['chunkId']) || !isSha256Digest(span['quoteDigest']) || !isSha256Digest(span['textDigest']) || !['exact', 'approximate'].includes(String(span['precision'])))) return invalidWire()
    const common = { sourceIndex: count(fragment['sourceIndex']), fragmentIndex: count(fragment['fragmentIndex']), sourceRef: fragment['sourceRef'], locator: span['locator'], precision: span['kind'] === 'structured' ? 'exact' : typeof span['precision'] === 'string' ? span['precision'] : '未提供' }
    if (content['kind'] === 'text' && typeof content['text'] === 'string') return { ...common, text: content['text'] }
    if (content['kind'] !== 'table' || !Array.isArray(content['columns']) || !Array.isArray(content['cells'])) return invalidWire()
    const columns = content['columns'].map((column: unknown) => {
      if (!isRecord(column)) return invalidWire()
      const label = column['header']
      if (typeof label !== 'string') return invalidWire()
      return label
    })
    const cells = content['cells'].map((cell: unknown) => {
      if (!isRecord(cell) || typeof cell['raw'] !== 'string') return invalidWire()
      return cell['raw']
    })
    return { ...common, text: cells.join(' · '), table: { columns, cells } }
  })
  if (fragments.some((f) => canonicalRef(sources[f.sourceIndex]?.sourceRef) !== canonicalRef(f.sourceRef)) || new Set(fragments.map((f) => `${f.sourceIndex}:${f.fragmentIndex}`)).size !== fragments.length) return invalidWire()
  const usage = value['usage']
  return { workspaceRevision: value['workspaceRevision'], documentSetRef: value['documentSetRef'], coverage, sources, fragments,
    usage: { bytes: count(usage['bytes']), readBytes: count(usage['readBytes']), fragments: count(usage['fragments']), pages: count(usage['pages']), inputTokens: count(usage['inputTokens']) } }
}
export async function readGrounding(client: WorkbenchClient, workspaceId: string, sourceRefs: readonly ResourceRef[], options: RequestOptions): Promise<GroundingView> {
  const value = await client.requestJson('POST', `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/source-grounding`, { ...options, body: { sourceRefs } })
  return parseGrounding(value)
}
export interface HumanReviewView { readonly candidateId: string; readonly revision: string; readonly contentDigest?: string; readonly decision: string; readonly reason: string }
export async function readHumanReviews(client: WorkbenchClient, candidateId: string, signal?: AbortSignal): Promise<readonly HumanReviewView[]> {
  const value = await client.requestJson('GET', `/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`, { ...(signal === undefined ? {} : { signal }) })
  if (!isRecord(value) || !Array.isArray(value['reviews'])) return invalidWire()
  return value['reviews'].map((review: unknown) => {
    if (!isRecord(review) || review['candidateId'] !== candidateId || !isUuid(review['candidateId']) || !isRevisionString(review['revision']) || review['contentDigest'] !== undefined && !isSha256Digest(review['contentDigest']) || typeof review['decision'] !== 'string' || typeof review['reason'] !== 'string') return invalidWire()
    return { candidateId: review['candidateId'], revision: review['revision'], ...(isSha256Digest(review['contentDigest']) ? { contentDigest: review['contentDigest'] } : {}), decision: review['decision'], reason: review['reason'] }
  })
}
