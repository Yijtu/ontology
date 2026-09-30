import type {
  CompletenessStatus,
  DocumentSpan,
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  SourceRef,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { SpanPrecision } from './document-parse'
import type { ToolContext } from './trusted'
import {
  isRecord,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isUuid,
} from './asset-workspace'

/**
 * Public contract for a project's fixed document corpus and its BM25 index
 * (SPEC v0.3a asset-data-ui §7, issue V03-019 / #191).
 *
 * The collection reference is host-minted as `project:<projectId>`; a client or
 * model can only ask for the documents of the project it is already scoped to.
 * A membership pins exactly one original/parse/text revision of one document;
 * the active corpus is the set of `active` current memberships, not the whole
 * space's parse list.
 */

export type ProjectDocumentState = 'active' | 'retracted' | 'replaced'

export const PROJECT_DOCUMENT_STATES: readonly ProjectDocumentState[] = [
  'active',
  'retracted',
  'replaced',
]

/** The host-minted keyword collection for one project. */
export function projectCollectionRef(projectId: Uuid): string {
  return `project:${projectId}`
}

/**
 * One append-only membership revision. The current state of a document is its
 * highest `membershipRevision`; a retraction/replacement appends a new revision
 * so the earlier state is never erased.
 */
export interface ProjectDocumentMembership {
  readonly projectId: Uuid
  readonly documentId: Uuid
  readonly state: ProjectDocumentState
  readonly membershipRevision: RevisionString
  /** The immutable original the span points at (`kind: 'document'`). */
  readonly documentRef: ResourceRef
  readonly documentDigest: Sha256Digest
  readonly parseId: Uuid
  /** The parse run artifact set (`kind: 'artifact'`). */
  readonly parseRef: ResourceRef
  readonly textDigest: Sha256Digest
  /** Whether the membership's spans are byte-exact or approximate (SPEC D3.2). */
  readonly precision: SpanPrecision
  readonly sourceRef?: SourceRef
  /** The project visibility epoch the membership was written under. */
  readonly visibilityEpoch: RevisionString
  readonly replacedBy?: Uuid
  readonly reason?: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** The per-project monotonic epoch every reader fences against. */
export interface ProjectVisibility {
  readonly projectId: Uuid
  readonly epoch: RevisionString
  readonly membershipRevision: RevisionString
}

export interface RegisterProjectDocumentInput {
  readonly documentId: Uuid
  readonly documentRef: ResourceRef
  readonly documentDigest: Sha256Digest
  readonly parseId: Uuid
  readonly parseRef: ResourceRef
  readonly textDigest: Sha256Digest
  readonly precision: SpanPrecision
  readonly sourceRef?: SourceRef
  readonly reason?: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type ProjectDocumentOp = 'retract' | 'replace'

export interface ReplaceProjectDocumentInput {
  readonly documentId: Uuid
  readonly documentRef: ResourceRef
  readonly documentDigest: Sha256Digest
  readonly parseId: Uuid
  readonly parseRef: ResourceRef
  readonly textDigest: Sha256Digest
  readonly precision: SpanPrecision
  readonly sourceRef?: SourceRef
}

export interface ReviseProjectDocumentInput {
  readonly documentId: Uuid
  readonly op: ProjectDocumentOp
  readonly reason: string
  /** Required when `op === 'replace'`; rejected when `op === 'retract'`. */
  readonly replacement?: ReplaceProjectDocumentInput
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ProjectDocumentWriteResult {
  readonly membership: ProjectDocumentMembership
  readonly visibility: ProjectVisibility
  /** False when the call replayed an idempotent write. */
  readonly created: boolean
}

export interface ListProjectDocumentsFilter {
  readonly state?: ProjectDocumentState
  readonly cursor?: string
  readonly limit?: number
}

export interface ProjectDocumentPage {
  readonly memberships: readonly ProjectDocumentMembership[]
  readonly nextCursor: string | null
}

/**
 * A successful build's verified target: the generation, the epoch and membership
 * revision it indexed, and the exact corpus digest it validated.
 */
export interface ProjectIndexReceipt {
  readonly projectId: Uuid
  readonly collectionRef: string
  readonly generation: RevisionString
  readonly visibilityEpoch: RevisionString
  readonly membershipRevision: RevisionString
  readonly targetDigest: Sha256Digest
  readonly indexRef: VersionRef
  readonly documentCount: number
  readonly sourceDocumentCount: number
  readonly completeness: CompletenessStatus
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface RecordProjectIndexReceiptInput {
  readonly collectionRef: string
  readonly generation: RevisionString
  readonly visibilityEpoch: RevisionString
  readonly membershipRevision: RevisionString
  readonly targetDigest: Sha256Digest
  readonly indexRef: VersionRef
  readonly documentCount: number
  readonly sourceDocumentCount: number
  readonly completeness: CompletenessStatus
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ProjectIndexReceiptWriteResult {
  readonly receipt: ProjectIndexReceipt
  /**
   * False when the project visibility epoch advanced past the build's epoch, so
   * the receipt was refused: a stale build must not reactivate a withdrawn corpus.
   */
  readonly activated: boolean
}

export type ProjectDocumentIndexState = 'pending' | 'building' | 'ready' | 'stale' | 'failed'

/** The read projection a UI or task consumes to know whether search is usable. */
export interface ProjectDocumentIndexStatus {
  readonly projectId: Uuid
  readonly collectionRef: string
  readonly state: ProjectDocumentIndexState
  readonly visibilityEpoch: RevisionString
  readonly membershipRevision: RevisionString
  /** The epoch a `ready` index receipt was verified against, when one exists. */
  readonly indexEpoch?: RevisionString
  readonly generation?: RevisionString
  readonly indexRef?: VersionRef
  /** `docCount` is the indexed chunk count; `sourceDocumentCount` is the file count. */
  readonly documentCount: number
  readonly sourceDocumentCount: number
  readonly completeness: CompletenessStatus
  /** Explicit reason when the index is not ready (built from the current state). */
  readonly reason?: string
  readonly retryable: boolean
}

/** One returned fragment: text plus the fixed revision/span it came from. */
export interface ProjectDocumentFragment {
  readonly documentId: Uuid
  readonly documentRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly locator: DocumentSpan['locator']
  readonly text: string
  readonly textDigest: Sha256Digest
  readonly quoteDigest: Sha256Digest
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: SpanPrecision
  /** The membership revision this fragment was served from. */
  readonly revision: RevisionString
  readonly score: number
  /** Duplicate copies of the same underlying content collapsed into this span. */
  readonly duplicateCount: number
  /** True when this document's membership is no longer active (historical read). */
  readonly historical: boolean
}

export interface ProjectDocumentSearchRequest {
  readonly projectId: Uuid
  readonly query: NonEmptyString
  readonly limit?: number
  readonly maxBytesPerFragment?: number
}

/** The explicit coverage limits of a bounded fragment page. */
export interface ProjectDocumentCoverage {
  readonly returned: number
  readonly knownTotal: number
  readonly truncated: boolean
  readonly completeness: CompletenessStatus
  readonly maxFragments: number
  readonly maxBytesPerFragment: number
}

export interface ProjectDocumentSearchResult {
  readonly projectId: Uuid
  readonly collectionRef: string
  readonly query: string
  readonly fragments: readonly ProjectDocumentFragment[]
  readonly state: ProjectDocumentIndexState
  readonly matchedTotal: number
  readonly coverage: ProjectDocumentCoverage
  readonly indexEpoch?: RevisionString
  readonly visibilityEpoch: RevisionString
  readonly generation?: RevisionString
  readonly scoreKind: 'bm25' | 'none'
  /** True when the visibility epoch moved between the start and the return. */
  readonly historical: boolean
}

export type ProjectDocumentStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_MEMBERSHIP'
  | 'INVALID_REVISION'

export class ProjectDocumentStoreError extends Error {
  readonly code: ProjectDocumentStoreErrorCode

  constructor(code: ProjectDocumentStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectDocumentStoreError'
    this.code = code
  }
}

/**
 * Control persistence for the project document corpus and its index receipts.
 *
 * Every method runs in the trusted tenant/space scope with RLS underneath.
 * `registerDocument`/`reviseDocument` append a membership revision and bump the
 * project visibility epoch, so any in-flight reader or build observes the change
 * at its next epoch check. `recordIndexReceipt` is the epoch CAS: a receipt whose
 * epoch is older than the current project epoch is refused and reported as not
 * activated.
 */
export interface ProjectDocumentStore {
  registerDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RegisterProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult>
  reviseDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: ReviseProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult>
  getVisibility(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectVisibility | undefined>
  getMembership(
    scopeRef: ScopeRef,
    projectId: Uuid,
    documentId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectDocumentMembership | undefined>
  listDocuments(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: ListProjectDocumentsFilter,
    ctx: ToolContext,
  ): Promise<ProjectDocumentPage>
  recordIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RecordProjectIndexReceiptInput,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceiptWriteResult>
  getIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceipt | undefined>
}

export function isProjectDocumentMembership(value: unknown): value is ProjectDocumentMembership {
  if (!isRecord(value)) return false
  if (!isUuid(value.projectId) || !isUuid(value.documentId)) return false
  if (!PROJECT_DOCUMENT_STATES.includes(value.state as ProjectDocumentState)) return false
  if (!isRevisionString(value.membershipRevision)) return false
  if (!isResourceRef(value.documentRef) || !isSha256Digest(value.documentDigest)) return false
  if (!isUuid(value.parseId) || !isResourceRef(value.parseRef)) return false
  if (!isSha256Digest(value.textDigest)) return false
  if (value.precision !== 'exact' && value.precision !== 'approximate') return false
  if (!isRevisionString(value.visibilityEpoch)) return false
  if (value.replacedBy !== undefined && !isUuid(value.replacedBy)) return false
  return true
}

/**
 * Validate one membership before the store persists it. The canonical
 * declaration stays JSON Schema; this guard refuses a malformed membership at the
 * boundary so a later reader never trusts an unvalidated row (AGENTS).
 */
export function assertProjectDocumentMembershipShape(
  value: unknown,
): asserts value is ProjectDocumentMembership {
  if (!isProjectDocumentMembership(value)) {
    throw new ProjectDocumentStoreError('INVALID_MEMBERSHIP', 'project document membership is malformed')
  }
}
