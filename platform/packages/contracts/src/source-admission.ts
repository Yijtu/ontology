import type {
  AssetDraftVersion,
  IndustryWorkspace,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { AppendAssetDraftInput } from './asset-workspace'
import type { CandidateSourceReviewState } from './candidate-source'
import type { GroundingDocumentSet, SourceTrustTier } from './source-grounding'
import type { StructuredParseOptions } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isRevisionString, isUuid } from './asset-workspace'

/**
 * Admitting a *reviewed* candidate source into a workspace's modelling corpus (design §2.1/§2.2).
 *
 * A `SourceAdmission` is the immutable receipt of the fixed admission order: it binds the exact
 * source review revision, the parse binding the source resolves to, and the new immutable
 * `GroundingDocumentSet` the workspace now drafts from. Nothing here is an approval by itself —
 * admission only follows an already-approved review, and the tier the source was reviewed under is
 * copied **explicitly** so a new write path can never promote an unconfirmed source to
 * `customer_authoritative` through a store default.
 */
export type SourceAdmissionKind = 'document' | 'table'

/** The exact table selection approved at admission; the parser caps cannot be widened here. */
export type SourceAdmissionTableOptions = Pick<StructuredParseOptions,
  'headerRow' | 'dataStartRow' | 'delimiter' | 'quote' | 'sheetId' | 'sheetName'>

export interface SourceAdmission {
  readonly schemaVersion: 'source-admission@1'
  readonly admissionId: Uuid
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  /** The reviewed source revision this admission pinned. */
  readonly sourceRevision: RevisionString
  /** The appended review event the admission rests on, when the store recorded one. */
  readonly sourceReviewEventId?: Uuid
  /** The tier recorded explicitly at admission time; never inferred from a default. */
  readonly trustTier: SourceTrustTier
  /** The readable logical document the admitted source resolves to; always `kind: 'document'`. */
  readonly sourceRef: ResourceRef
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly kind: SourceAdmissionKind
  readonly tableOptions?: SourceAdmissionTableOptions
  /** The new immutable workspace document set that now carries this source. */
  readonly documentSetRef: ResourceRef
  /** The workspace draft revision this admission created. */
  readonly draftRevision: RevisionString
  readonly draftDigest: Sha256Digest
  readonly admittedBy: string
  readonly admittedAt: Rfc3339UtcTimestamp
  /** The command idempotency key so a replay can be recognised without re-archiving. */
  readonly idempotencyKey: string
}

/** The versioned admission command; it never carries a secret. */
export interface SourceAdmissionCommand {
  readonly schemaVersion: 'source-admission-command@1'
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  readonly expectedSourceRevision: RevisionString
  readonly expectedWorkspaceRevision: RevisionString
  readonly parseOptions?: SourceAdmissionTableOptions
  readonly idempotencyKey: string
}

export interface SourceAdmissionReceipt {
  readonly admissionId: Uuid
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  readonly sourceRevision: RevisionString
  readonly trustTier: SourceTrustTier
  readonly documentSetRef: ResourceRef
  readonly draftRevision: RevisionString
  readonly draftDigest: Sha256Digest
  readonly replayed: boolean
}

export interface SourceAdmissionListPage {
  readonly admissions: readonly SourceAdmission[]
  readonly nextCursor?: string
}

/**
 * The authorized snapshot readback a host performs before admitting a source (design §2.2 step ②).
 * The implementation must verify the pinned digest and bounded size before returning, and must
 * never substitute different bytes for the pin.
 */
export interface SourceAdmissionSnapshot {
  readonly mediaType: string
  readonly byteSize: number
  readonly bytes: Uint8Array
}
export interface SourceAdmissionContentPort {
  readPinned(scope: ScopeRef,
    input: { readonly contentRef: ResourceRef; readonly contentDigest: Sha256Digest },
    ctx: ToolContext): Promise<SourceAdmissionSnapshot>
}

/** The logical document/parse binding produced from verified bytes (design §2.2 step ③). */
export interface SourceAdmissionBinding {
  readonly kind: SourceAdmissionKind
  /** A real `document` ref; an arbitrary `artifact` is never a legal document. */
  readonly sourceRef: ResourceRef
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly coverage: 'complete' | 'partial' | 'failed'
  readonly tableOptions?: SourceAdmissionTableOptions
}
export interface SourceAdmissionParserPort {
  bind(input: {
    readonly workspaceId: Uuid
    readonly sourceId: Uuid
    readonly contentRef: ResourceRef
    readonly mediaType: string
    readonly byteSize: number
    readonly bytes: Uint8Array
    readonly parseOptions?: SourceAdmissionTableOptions
  }, ctx: ToolContext): Promise<SourceAdmissionBinding>
}

/** Publishes a new immutable workspace corpus (design §2.2 step ④). */
export interface GroundingDocumentSetWriterPort {
  publish(scope: ScopeRef, manifest: GroundingDocumentSet, ctx: ToolContext): Promise<ResourceRef>
}

/**
 * One atomic admission (design §2.2 step ⑤). `append` carries the immutable next draft and its
 * transactional outbox; the store re-reads the source revision and the workspace head under the
 * same control transaction, so a stale source review or a stale workspace head is a VERSION_CONFLICT
 * and never a partial write.
 */
export interface AdmitSourceInput {
  readonly admission: SourceAdmission
  readonly expectedSourceRevision: RevisionString
  readonly expectedWorkspaceRevision: RevisionString
  readonly append: AppendAssetDraftInput
  readonly requestDigest: Sha256Digest
}
export interface SourceAdmissionWriteResult {
  readonly admission: SourceAdmission
  readonly workspace: IndustryWorkspace
  readonly draft: AssetDraftVersion
  readonly created: boolean
}

export interface SourceAdmissionStore {
  getAdmission(scopeRef: ScopeRef, admissionId: Uuid, ctx: ToolContext): Promise<SourceAdmission | undefined>
  /** The latest admission recorded for one source, so a replay can be recognised cheaply. */
  findAdmissionBySource(scopeRef: ScopeRef, workspaceId: Uuid, sourceId: Uuid, ctx: ToolContext): Promise<SourceAdmission | undefined>
  listAdmissions(scopeRef: ScopeRef, workspaceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext): Promise<SourceAdmissionListPage>
  admitSource(scopeRef: ScopeRef, input: AdmitSourceInput, ctx: ToolContext): Promise<SourceAdmissionWriteResult>
  close?(): Promise<void>
}

/**
 * A retraction appends an event and raises a visibility fence while preserving the original
 * snapshot and the review history (design §2.2/§2.7). The source row's current state is only the
 * latest projection; the append-only events remain readable.
 */
export interface SourceRetraction {
  readonly schemaVersion: 'source-retraction@1'
  readonly retractionId: Uuid
  readonly eventId: Uuid
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  readonly previousState: CandidateSourceReviewState
  readonly sourceRevision: RevisionString
  readonly reason: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly idempotencyKey: string
}

export interface SourceRetractionCommand {
  readonly schemaVersion: 'source-retraction-command@1'
  readonly workspaceId: Uuid
  readonly sourceId: Uuid
  readonly expectedRevision: RevisionString
  readonly reason: string
  readonly idempotencyKey: string
}

export interface SourceRetractionReceipt {
  readonly sourceId: Uuid
  readonly workspaceId: Uuid
  /** The new current-projection revision after the retraction. */
  readonly revision: RevisionString
  readonly eventId: Uuid
  readonly replayed: boolean
}

export interface CandidateSourceRetractionStore {
  retractSource(scopeRef: ScopeRef, input: {
    readonly workspaceId: Uuid
    readonly sourceId: Uuid
    readonly expectedRevision: RevisionString
    readonly reason: string
    readonly actor: string
    readonly idempotencyKey: string
  }, ctx: ToolContext): Promise<SourceRetractionReceipt>
  listRetractions(scopeRef: ScopeRef, sourceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext): Promise<{ readonly retractions: readonly SourceRetraction[]; readonly nextCursor?: string }>
}

export type SourceAdmissionErrorCode =
  | 'INVALID_REQUEST' | 'FORBIDDEN' | 'SCOPE_MISMATCH' | 'NOT_FOUND' | 'NOT_APPROVED'
  | 'SOURCE_RETRACTED' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'ALREADY_ADMITTED'
  | 'PARSE_NOT_COMPLETE' | 'DIGEST_MISMATCH' | 'MISSING_ORIGINAL' | 'UNSUPPORTED_MEDIA_TYPE'
  | 'EMPTY_SOURCE' | 'STORE_FAILED'

export class SourceAdmissionError extends Error {
  constructor(readonly code: SourceAdmissionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceAdmissionError'
  }
}

const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTableOptions(value: unknown): value is SourceAdmissionTableOptions {
  if (!isRecord(value)) return false
  const keys = ['headerRow', 'dataStartRow', 'delimiter', 'quote', 'sheetId', 'sheetName']
  if (Object.keys(value).some((key) => !keys.includes(key))) return false
  if (['headerRow', 'dataStartRow'].some((key) => value[key] !== undefined
    && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1))) return false
  if (value['delimiter'] !== undefined && ![',', ';', '\t', '|'].includes(String(value['delimiter']))) return false
  if (value['quote'] !== undefined && !['"', "'"].includes(String(value['quote']))) return false
  return !['sheetId', 'sheetName'].some((key) => value[key] !== undefined && !isNonEmptyString(value[key]))
}

/** Runtime validation of the versioned admission command before any write is attempted. */
export function assertSourceAdmissionCommandShape(value: unknown): asserts value is SourceAdmissionCommand {
  if (!isRecord(value) || value.schemaVersion !== 'source-admission-command@1'
    || !isUuid(value.workspaceId) || !isUuid(value.sourceId)
    || typeof value.expectedSourceRevision !== 'string' || !REVISION_PATTERN.test(value.expectedSourceRevision)
    || typeof value.expectedWorkspaceRevision !== 'string' || !REVISION_PATTERN.test(value.expectedWorkspaceRevision)
    || !isNonEmptyString(value.idempotencyKey) || value.idempotencyKey.length > 256
    || (value.parseOptions !== undefined && !isTableOptions(value.parseOptions))) {
    throw new SourceAdmissionError('INVALID_REQUEST', 'invalid source admission command')
  }
}

/** Runtime validation of the versioned retraction command before any write is attempted. */
export function assertSourceRetractionCommandShape(value: unknown): asserts value is SourceRetractionCommand {
  if (!isRecord(value) || value.schemaVersion !== 'source-retraction-command@1'
    || !isUuid(value.workspaceId) || !isUuid(value.sourceId)
    || !isRevisionString(value.expectedRevision)
    || !isNonEmptyString(value.reason) || value.reason.length > 4000
    || !isNonEmptyString(value.idempotencyKey) || value.idempotencyKey.length > 256) {
    throw new SourceAdmissionError('INVALID_REQUEST', 'invalid source retraction command')
  }
}

/** Runtime validation at the immutable receipt boundary. */
export function assertSourceAdmissionShape(value: unknown): asserts value is SourceAdmission {
  if (!isRecord(value) || value.schemaVersion !== 'source-admission@1'
    || !isUuid(value.admissionId) || !isUuid(value.workspaceId) || !isUuid(value.sourceId)
    || !isRevisionString(value.sourceRevision) || !isUuid(value.parseId)
    || !isNonEmptyString(value.parserVersion) || !['document', 'table'].includes(String(value.kind))
    || !['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic'].includes(String(value.trustTier))
    || !isResourceRef(value.sourceRef) || value.sourceRef.kind !== 'document'
    || !isResourceRef(value.documentSetRef) || !isRevisionString(value.draftRevision)
    || typeof value.draftDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.draftDigest)
    || !isNonEmptyString(value.admittedBy) || !isNonEmptyString(value.idempotencyKey)) {
    throw new SourceAdmissionError('INVALID_REQUEST', 'invalid source admission')
  }
}
