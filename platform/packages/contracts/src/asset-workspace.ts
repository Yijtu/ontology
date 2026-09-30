import type {
  AssetDraftCandidateRef,
  AssetDraftVersion,
  IndustryWorkspace,
  IndustryWorkspaceBoundary,
  IndustryWorkspaceState,
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { NewOutboxMessage } from './job-store'
import type { ToolContext } from './trusted'

/**
 * Runtime shape guards for the v0.3a workspace/project boundary (SPEC §3, AGENTS).
 *
 * These are deliberately hand-written and dependency-free: the adapter persists
 * caller-supplied documents and must reject a malformed boundary value before any
 * SQL runs, but `contracts` may not import a schema library and the adapter may
 * not import the host's ajv. The JSON Schema remains the canonical declaration;
 * these guards cover the fields this store writes and reads back.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function isRevisionString(value: unknown): value is RevisionString {
  return typeof value === 'string' && REVISION_PATTERN.test(value)
}

function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function isVersionRef(value: unknown): value is VersionRef {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.version) &&
    isSha256Digest(value.digest)
  )
}

export function isResourceRef(value: unknown): value is ResourceRef {
  if (!isRecord(value)) return false
  return (
    isUuid(value.id) &&
    isNonEmptyString(value.version) &&
    isSha256Digest(value.digest) &&
    isNonEmptyString(value.kind)
  )
}

function isIndustryWorkspaceBoundary(value: unknown): value is IndustryWorkspaceBoundary {
  if (!isRecord(value)) return false
  if (!isStringArray(value.goals) || !isStringArray(value.included) || !isStringArray(value.excluded)) {
    return false
  }
  if (!isRecord(value.applicability)) return false
  const applicability = value.applicability
  if (applicability.region !== undefined && !isNonEmptyString(applicability.region)) return false
  if (applicability.validFrom !== undefined && !isNonEmptyString(applicability.validFrom)) return false
  if (applicability.validTo !== undefined && !isNonEmptyString(applicability.validTo)) return false
  return true
}

function isIndustryWorkspaceState(value: unknown): value is IndustryWorkspaceState {
  return value === 'draft' || value === 'review' || value === 'published' || value === 'archived'
}

/**
 * Runtime guard for the editable workspace boundary. The JSON Schema remains the
 * canonical declaration; this covers the fields an edit may change so a malformed
 * boundary is rejected before any SQL runs.
 */
export function assertIndustryWorkspaceBoundaryShape(
  value: unknown,
): asserts value is IndustryWorkspaceBoundary {
  if (!isIndustryWorkspaceBoundary(value)) throw invalidWorkspace('boundary is malformed')
}

/**
 * Validate a workspace-metadata patch. A patch that sets `displayName` must keep it a
 * non-empty string and any `boundary` must pass the boundary guard; the store applies each
 * set field and leaves an omitted one unchanged.
 */
export function assertIndustryWorkspacePatchShape(value: unknown): asserts value is IndustryWorkspacePatch {
  if (!isRecord(value)) throw invalidWorkspace('workspacePatch must be an object')
  if (value.displayName !== undefined && !isNonEmptyString(value.displayName)) {
    throw invalidWorkspace('workspacePatch.displayName must be a non-empty string')
  }
  if (value.boundary !== undefined) assertIndustryWorkspaceBoundaryShape(value.boundary)
}

function isAssetDraftCandidateRef(value: unknown): value is AssetDraftCandidateRef {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.logicalId) &&
    isUuid(value.candidateId) &&
    isSha256Digest(value.digest)
  )
}

/**
 * Validate the workspace read/write shape before it is persisted. A malformed
 * boundary, a non-uuid id or a non-decimal revision is rejected as
 * `INVALID_WORKSPACE` instead of being written and failing later on read.
 */
export function assertIndustryWorkspaceShape(value: unknown): asserts value is IndustryWorkspace {
  if (!isRecord(value)) throw invalidWorkspace('industry workspace must be an object')
  if (!isUuid(value.workspaceId)) throw invalidWorkspace('industry workspace id must be a uuid')
  if (!isNonEmptyString(value.namespace)) throw invalidWorkspace('namespace must be a non-empty string')
  if (!isNonEmptyString(value.displayName)) throw invalidWorkspace('displayName must be a non-empty string')
  if (!isIndustryWorkspaceBoundary(value.boundary)) throw invalidWorkspace('boundary is malformed')
  if (!isRevisionString(value.headRevision)) throw invalidWorkspace('headRevision must be a decimal string')
  if (!isIndustryWorkspaceState(value.state)) throw invalidWorkspace('state is not a known workspace state')
  if (value.latestPublishedPackRef !== undefined && !isVersionRef(value.latestPublishedPackRef)) {
    throw invalidWorkspace('latestPublishedPackRef is malformed')
  }
}

/**
 * Validate one immutable draft revision. `candidateRefs` point at immutable
 * candidate versions, so each entry must carry a uuid candidate id and digest.
 */
export function assertAssetDraftVersionShape(value: unknown): asserts value is AssetDraftVersion {
  if (!isRecord(value)) throw invalidDraft('asset draft version must be an object')
  if (!isUuid(value.workspaceId)) throw invalidDraft('draft workspaceId must be a uuid')
  if (!isRevisionString(value.revision)) throw invalidDraft('draft revision must be a decimal string')
  if (!isSha256Digest(value.digest)) throw invalidDraft('draft digest must be a sha256 digest')
  if (!isResourceRef(value.documentSetRef)) throw invalidDraft('documentSetRef is malformed')
  if (!Array.isArray(value.candidateRefs) || !value.candidateRefs.every(isAssetDraftCandidateRef)) {
    throw invalidDraft('candidateRefs is malformed')
  }
  if (value.basePackRef !== undefined && !isVersionRef(value.basePackRef)) {
    throw invalidDraft('basePackRef is malformed')
  }
  if (value.syntheticExampleSetRef !== undefined && !isResourceRef(value.syntheticExampleSetRef)) {
    throw invalidDraft('syntheticExampleSetRef is malformed')
  }
  if (value.validationRef !== undefined && !isResourceRef(value.validationRef)) {
    throw invalidDraft('validationRef is malformed')
  }
}

function invalidWorkspace(message: string): IndustryWorkspaceStoreError {
  return new IndustryWorkspaceStoreError('INVALID_WORKSPACE', message)
}

function invalidDraft(message: string): IndustryWorkspaceStoreError {
  return new IndustryWorkspaceStoreError('INVALID_DRAFT', message)
}

export interface IndustryWorkspaceListFilter {
  readonly state?: IndustryWorkspaceState
  readonly limit?: number
}

/**
 * One atomic create: the mutable workspace head plus its first immutable draft
 * revision, the transactional outbox message anchored to `outboxJobId`.
 */
export interface CreateIndustryWorkspaceInput {
  readonly workspace: IndustryWorkspace
  readonly firstDraft: AssetDraftVersion
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
  readonly outboxJobId: Uuid
}

/**
 * The mutable workspace metadata an append may update in the same compare-and-swap.
 * `displayName` and `boundary` are the only editable workspace fields (SPEC v0.3a §8.1
 * PATCH semantics); `state` is never set through a draft append, so a model or an
 * ordinary project user cannot publish a definition by editing the workspace.
 */
export interface IndustryWorkspacePatch {
  readonly displayName?: string
  readonly boundary?: IndustryWorkspaceBoundary
}

/**
 * One compare-and-swap draft append. `expectedRevision` is the head the caller
 * last read; a mismatch is a VERSION_CONFLICT and never overwrites the winner.
 */
export interface AppendAssetDraftInput {
  readonly expectedRevision: RevisionString
  readonly draft: AssetDraftVersion
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
  readonly outboxJobId: Uuid
  /**
   * Optional workspace-metadata edit committed atomically with the draft append.
   * Absent means the workspace row keeps its current display name and boundary.
   */
  readonly workspacePatch?: IndustryWorkspacePatch
}

export interface IndustryWorkspaceWriteResult {
  readonly workspace: IndustryWorkspace
  readonly draft: AssetDraftVersion
  /** False when the call replayed an earlier idempotent write. */
  readonly created: boolean
}

export type IndustryWorkspaceStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'WORKSPACE_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DRAFT_REVISION_INVALID'
  | 'INVALID_WORKSPACE'
  | 'INVALID_DRAFT'

export class IndustryWorkspaceStoreError extends Error {
  readonly code: IndustryWorkspaceStoreErrorCode

  constructor(code: IndustryWorkspaceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndustryWorkspaceStoreError'
    this.code = code
  }
}

/**
 * Control persistence for the industry workspace draft head (SPEC v0.3a §3.1/§4.1).
 *
 * Every method runs in the trusted tenant/space scope and RLS is a second layer
 * behind the explicit scope predicate. The workspace head is compare-and-swap:
 * `appendDraft` with a stale `expectedRevision` fails with VERSION_CONFLICT.
 * Draft revisions are append-only; there is no update or delete path.
 */
export interface IndustryWorkspaceStore {
  createWorkspace(
    input: CreateIndustryWorkspaceInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult>
  getWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace | undefined>
  listWorkspaces(
    scopeRef: ScopeRef,
    filter: IndustryWorkspaceListFilter,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace[]>
  getDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion | undefined>
  listDrafts(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion[]>
  appendDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    input: AppendAssetDraftInput,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult>
}
