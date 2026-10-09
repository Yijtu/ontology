import type {
  DomainResultStatus,
  ProvenanceEvidenceView,
  PublishedAnswer,
  ResourceRef,
  RunState,
  Sha256Digest,
  TableArtifactRow,
  TableColumnDescriptor,
  ToolCoverage,
  VersionRef,
} from '@ontology/contracts'
import type { RunAnswerResult } from './query'
import type { AnswerSourceLoader } from './source-views'

/**
 * The public typed-result / table read surface (SPEC v0.3a execution-evidence §EX-7.1/§EX-9,
 * asset-data-ui §9.2). It is the only shape the browser uses to render a formal table: a
 * `VerifiedResultView` that describes the verified tables of the exact published answer, and a
 * paged `TablePageReadView` of one archived page of one fixed revision.
 *
 * Nothing here carries raw compute JSON or an unverified artifact: the result view exposes only
 * the verified manifest projection (table descriptors, coverage, domain status, validity), and a
 * page is served by the server's verified-table reader which refuses a table that has no
 * full-table verification receipt. The browser must never build a formal value from a draft or
 * from a "latest" dataset.
 *
 * The runtime guards are local to `apps/web` so the browser bundle never pulls the contracts'
 * `node:crypto` digest helpers; only the data-only types are imported.
 */

/** One table descriptor projection. `verificationReceiptRef` is absent for a raw artifact. */
export interface VerifiedTableSummary {
  readonly tableId: string
  readonly totalRows: number
  readonly columns: readonly TableColumnDescriptor[]
  readonly complete: boolean
  readonly verificationReceiptRef?: ResourceRef
}

/** The authorized, data-only projection of a verified `typed-result-manifest@1`. */
export interface VerifiedResultView {
  readonly answerId: string
  readonly runId: string
  readonly contentHash: Sha256Digest
  readonly verificationId: string
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly publicationKind: 'verified' | 'history_limited'
  readonly coverage: ToolCoverage
  readonly domainStatus: DomainResultStatus
  readonly dataMode: string
  readonly tables: readonly VerifiedTableSummary[]
  readonly limitations: readonly string[]
  readonly currentValidity: {
    readonly state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
    readonly reason?: string
  }
}

/**
 * The verified page read envelope. It is the same shape the server's reader returns
 * (contracts `TablePageReadView`), re-declared with a local guard.
 */
export interface VerifiedTablePageView {
  readonly answerId: string
  readonly tableId: string
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly tableVerificationReceiptRef: ResourceRef
  readonly pageIndex: number
  readonly pageCount: number
  readonly totalRows: number
  readonly columns: readonly TableColumnDescriptor[]
  readonly rows: readonly TableArtifactRow[]
  readonly coverage: ToolCoverage
  readonly cursor?: string
  readonly complete: boolean
}

/**
 * The result revision history of one logical key (a project, or a single run) — the local,
 * data-only projection of the server's `result-history@1`. Each entry is an immutable
 * published version; `readKind` labels a fixed-version readback apart from an older history
 * read, and the hashes let a reader confirm an older revision was not rewritten.
 */
export interface ResultRevisionSummary {
  readonly answerId: string
  readonly runId: string
  readonly revisionIndex: number
  readonly contentHash: Sha256Digest
  readonly evidenceManifestHash: Sha256Digest
  readonly scenarioManifestHash: Sha256Digest
  readonly publicationKind: 'verified' | 'history_limited'
  readonly publishedAt: string
  readonly resultManifestRef?: ResourceRef
  readonly resultManifestDigest?: Sha256Digest
  readonly readKind: 'fixed_version' | 'history'
  readonly label: string
}

export interface ResultHistoryView {
  readonly schemaVersion: 'result-history@1'
  readonly logicalKey: string
  readonly projectId?: string
  readonly projectRevision?: string
  readonly currentAnswerId: string
  readonly entries: readonly ResultRevisionSummary[]
}

/**
 * The structured JSON export of one verified result version. The browser does not re-render it
 * field by field; it validates the version identity at the wire boundary and offers the exact
 * content the server produced as a download.
 */
export interface VerifiedResultExport {
  readonly schemaVersion: 'verified-result-export@1'
  readonly exportedAt: string
  readonly status: {
    readonly publicationKind: 'verified' | 'history_limited'
    readonly domainStatus: string
    readonly dataMode: string
    readonly coverage: ToolCoverage
    readonly limitations: readonly string[]
  }
  readonly versions: {
    readonly answerId: string
    readonly runId: string
    readonly contentHash: Sha256Digest
    readonly verificationId: string
    readonly resultManifestRef: ResourceRef
    readonly resultManifestDigest: Sha256Digest
  }
  readonly tables: readonly {
    readonly tableId: string
    readonly totalRows: number
    readonly complete: boolean
  }[]
  readonly sourceIndex: readonly {
    readonly evidenceId: string
    readonly evidenceRef: ResourceRef
    readonly resultDigest: Sha256Digest
    readonly boundBy: readonly ('claim' | 'assertion')[]
  }[]
}

/** The discriminated load of the result for one run. `blocked` is a verified refusal, not a failure. */
export type VerifiedResultLoad =
  | { readonly kind: 'verified'; readonly answer: PublishedAnswer; readonly view: VerifiedResultView }
  | { readonly kind: 'in_progress'; readonly state: RunState }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string }

/** The host-injected source of verified results. A host may bind it to HTTP or an in-process reader. */
export interface ResultSource {
  loadResult(runId: string): Promise<VerifiedResultLoad>
  loadTablePage(answerId: string, tableId: string, cursor?: string): Promise<VerifiedTablePageView>
  loadEvidence(ref: ResourceRef): Promise<ProvenanceEvidenceView>
  loadHistory(runId: string): Promise<ResultHistoryView>
  requestExport(runId: string): Promise<VerifiedResultExport>
  readonly loadSource?: AnswerSourceLoader
}

/** The structural client the result source needs; `WorkbenchClient` satisfies it. */
export interface ResultSourceClient {
  getAnswer(runId: string): Promise<RunAnswerResult>
  getVerifiedResult(answerId: string): Promise<VerifiedResultView>
  getAnswerTablePage(answerId: string, tableId: string, cursor?: string): Promise<VerifiedTablePageView>
  getEvidence(evidenceId: string): Promise<ProvenanceEvidenceView>
  getResultHistory(runId: string): Promise<ResultHistoryView>
  exportVerifiedResult(runId: string): Promise<VerifiedResultExport>
  readonly getAnswerSource?: AnswerSourceLoader
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function isResourceRef(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['version']) &&
    isDigest(value['digest']) &&
    isNonEmptyString(value['kind'])
  )
}

function isVersionRef(value: unknown): value is VersionRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['version']) &&
    isDigest(value['digest'])
  )
}

function isCoverage(value: unknown): value is ToolCoverage {
  return isRecord(value) && typeof value['returned'] === 'number' && typeof value['truncated'] === 'boolean'
}

const VALUE_TYPES = new Set([
  'decimal', 'quantity', 'money', 'string', 'boolean', 'entity_ref', 'relation_ref', 'rule_judgement', 'document_quote',
])

function isColumnDescriptor(value: unknown): value is TableColumnDescriptor {
  return (
    isRecord(value) &&
    isNonEmptyString(value['columnRef']) &&
    isNonEmptyString(value['semanticPredicate']) &&
    typeof value['valueType'] === 'string' &&
    VALUE_TYPES.has(value['valueType']) &&
    isNonEmptyString(value['schemaPointer']) &&
    (value['displayLabel'] === undefined || typeof value['displayLabel'] === 'string')
  )
}

function isCellBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value['rowKey']) &&
    isNonEmptyString(value['columnRef']) &&
    isResourceRef(value['evidenceRef']) &&
    isDigest(value['resultDigest']) &&
    isNonEmptyString(value['valuePointer']) &&
    isNonEmptyString(value['subjectPointer'])
  )
}

function isArtifactRow(value: unknown): value is TableArtifactRow {
  return (
    isRecord(value) &&
    isNonEmptyString(value['rowKey']) &&
    (value['subject'] === undefined || typeof value['subject'] === 'string') &&
    isRecord(value['cells']) &&
    Array.isArray(value['bindings']) &&
    value['bindings'].every(isCellBinding)
  )
}

function isTablePageReadView(value: unknown): value is VerifiedTablePageView {
  return (
    isRecord(value) &&
    isNonEmptyString(value['answerId']) &&
    isNonEmptyString(value['tableId']) &&
    isResourceRef(value['resultManifestRef']) &&
    isDigest(value['resultManifestDigest']) &&
    isResourceRef(value['tableVerificationReceiptRef']) &&
    typeof value['pageIndex'] === 'number' &&
    typeof value['pageCount'] === 'number' &&
    typeof value['totalRows'] === 'number' &&
    Array.isArray(value['columns']) &&
    value['columns'].every(isColumnDescriptor) &&
    Array.isArray(value['rows']) &&
    value['rows'].every(isArtifactRow) &&
    isCoverage(value['coverage']) &&
    (value['cursor'] === undefined || typeof value['cursor'] === 'string') &&
    typeof value['complete'] === 'boolean'
  )
}

function isTableSummary(value: unknown): value is VerifiedTableSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value['tableId']) &&
    typeof value['totalRows'] === 'number' &&
    Array.isArray(value['columns']) &&
    value['columns'].every(isColumnDescriptor) &&
    typeof value['complete'] === 'boolean' &&
    (value['verificationReceiptRef'] === undefined || isResourceRef(value['verificationReceiptRef']))
  )
}

function isCurrentValidity(value: unknown): value is VerifiedResultView['currentValidity'] {
  return (
    isRecord(value) &&
    (value['state'] === 'current' || value['state'] === 'superseded' ||
      value['state'] === 'withdrawn' || value['state'] === 'unverifiable') &&
    (value['reason'] === undefined || typeof value['reason'] === 'string')
  )
}

/** Validate a server-provided verified result view at the wire boundary. */
export function isVerifiedResultView(value: unknown): value is VerifiedResultView {
  return (
    isRecord(value) &&
    isNonEmptyString(value['answerId']) &&
    isNonEmptyString(value['runId']) &&
    isDigest(value['contentHash']) &&
    isNonEmptyString(value['verificationId']) &&
    isResourceRef(value['resultManifestRef']) &&
    isDigest(value['resultManifestDigest']) &&
    (value['publicationKind'] === 'verified' || value['publicationKind'] === 'history_limited') &&
    isCoverage(value['coverage']) &&
    isNonEmptyString(value['domainStatus']) &&
    isNonEmptyString(value['dataMode']) &&
    Array.isArray(value['tables']) &&
    value['tables'].every(isTableSummary) &&
    Array.isArray(value['limitations']) &&
    value['limitations'].every((entry) => typeof entry === 'string') &&
    isCurrentValidity(value['currentValidity'])
  )
}

function isRevisionSummary(value: unknown): value is ResultRevisionSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value['answerId']) &&
    isNonEmptyString(value['runId']) &&
    typeof value['revisionIndex'] === 'number' &&
    isDigest(value['contentHash']) &&
    isDigest(value['evidenceManifestHash']) &&
    isDigest(value['scenarioManifestHash']) &&
    (value['publicationKind'] === 'verified' || value['publicationKind'] === 'history_limited') &&
    typeof value['publishedAt'] === 'string' &&
    (value['resultManifestRef'] === undefined || isResourceRef(value['resultManifestRef'])) &&
    (value['resultManifestDigest'] === undefined || isDigest(value['resultManifestDigest'])) &&
    (value['readKind'] === 'fixed_version' || value['readKind'] === 'history') &&
    typeof value['label'] === 'string'
  )
}

/** Validate the server-provided result history at the wire boundary. */
export function isResultHistoryView(value: unknown): value is ResultHistoryView {
  return (
    isRecord(value) &&
    value['schemaVersion'] === 'result-history@1' &&
    isNonEmptyString(value['logicalKey']) &&
    isNonEmptyString(value['currentAnswerId']) &&
    Array.isArray(value['entries']) &&
    value['entries'].every(isRevisionSummary)
  )
}

/** Validate the server-provided structured export at the wire boundary. */
export function isVerifiedResultExport(value: unknown): value is VerifiedResultExport {
  if (!isRecord(value) || value['schemaVersion'] !== 'verified-result-export@1') return false
  const versions = value['versions']
  const status = value['status']
  return (
    isRecord(status) &&
    (status['publicationKind'] === 'verified' || status['publicationKind'] === 'history_limited') &&
    isRecord(versions) &&
    isNonEmptyString(versions['answerId']) &&
    isNonEmptyString(versions['runId']) &&
    isDigest(versions['contentHash']) &&
    isResourceRef(versions['resultManifestRef']) &&
    isDigest(versions['resultManifestDigest']) &&
    Array.isArray(value['tables']) &&
    Array.isArray(value['sourceIndex'])
  )
}

export { isTablePageReadView, isColumnDescriptor, isResourceRef, isVersionRef, isDigest }

/** Bind the verified-result source to the HTTP client. */
export function createWorkbenchResultSource(client: ResultSourceClient): ResultSource {
  return {
    async loadResult(runId: string): Promise<VerifiedResultLoad> {
      const answer = await client.getAnswer(runId)
      if (answer.kind === 'in_progress') return { kind: 'in_progress', state: answer.state }
      if (answer.kind === 'unavailable') return { kind: 'unavailable', code: answer.code, message: answer.message }
      const view = await client.getVerifiedResult(answer.answer.answerId)
      if (answer.answer.runId !== runId || view.runId !== runId || view.answerId !== answer.answer.answerId || view.contentHash !== answer.answer.contentHash) {
        return { kind: 'blocked', code: 'REVISION_CHANGED', message: '答案正文与核验结果的版本不一致。' }
      }
      return { kind: 'verified', answer: answer.answer, view }
    },
    loadTablePage: (answerId, tableId, cursor) => client.getAnswerTablePage(answerId, tableId, cursor),
    loadEvidence: (ref) => client.getEvidence(ref.id),
    loadHistory: (runId) => client.getResultHistory(runId),
    requestExport: (runId) => client.exportVerifiedResult(runId),
    ...(client.getAnswerSource === undefined ? {} : { loadSource: client.getAnswerSource.bind(client) }),
  }
}
