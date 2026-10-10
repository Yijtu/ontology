import type {
  CompletenessStatus,
  MappingRef,
  NonEmptyString,
  ProjectReadinessKind,
  ProjectReadinessState,
  ProjectRevision,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ReadinessError,
  ReadinessProjection,
  ReadinessTargetRef,
  ResolvedProfileRef,
  Rfc3339UtcTimestamp,
  ResourceRef,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { NewOutboxMessage } from './job-store'
import type { ToolContext } from './trusted'
import type { ProjectEvolutionPlan } from './project-evolution'
import {
  isRecord,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isUuid,
  isVersionRef,
} from './asset-workspace'

/**
 * Runtime shape guards for the v0.3a project-revision boundary (SPEC §3.2/§3.3).
 * The canonical declaration stays JSON Schema; these guards reject a malformed
 * revision before it is written, so a later reader never has to trust an
 * unvalidated projection (AGENTS: boundary data is validated at runtime).
 */
function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.length > 0
}

function isProjectRevisionRef(value: unknown): value is ProjectRevisionRef {
  if (!isRecord(value)) return false
  return (
    isUuid(value.projectId) &&
    isRevisionString(value.revision) &&
    isSha256Digest(value.digest)
  )
}

function isResolvedProfileRef(value: unknown): value is ResolvedProfileRef {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.version) &&
    isSha256Digest(value.snapshotHash)
  )
}

function isMappingRef(value: unknown): value is MappingRef {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.version) &&
    isSha256Digest(value.digest) &&
    isNonEmptyString(value.role) &&
    isRecord(value.sourceObjectRef)
  )
}

function isVersionRefArray(value: unknown): value is VersionRef[] {
  return Array.isArray(value) && value.every(isVersionRef)
}

function isMappingRefArray(value: unknown): value is MappingRef[] {
  return Array.isArray(value) && value.length > 0 && value.every(isMappingRef)
}

export function assertProjectRevisionBodyShape(value: unknown): asserts value is ProjectRevisionBody {
  if (!isRecord(value)) throw invalidRevision('project revision body must be an object')
  if (value.executionPurpose !== undefined && value.executionPurpose !== 'synthetic_validation') throw invalidRevision('executionPurpose must be the host synthetic validation marker')
  if (value.schemaVersion !== 'project-revision@1') {
    throw invalidRevision('project revision body must declare schemaVersion project-revision@1')
  }
  if (!isUuid(value.projectId)) throw invalidRevision('project revision body projectId must be a uuid')
  if (!isRevisionString(value.revision)) throw invalidRevision('project revision body revision must be a decimal string')
  if (!isVersionRef(value.industryPackRef)) throw invalidRevision('industryPackRef is malformed')
  if (!isVersionRef(value.definitionRef)) throw invalidRevision('definitionRef is malformed')
  if (!isMappingRefArray(value.mappingRefs)) throw invalidRevision('mappingRefs must be a non-empty mapping array')
  if (!isResolvedProfileRef(value.profileRef)) throw invalidRevision('profileRef is malformed')
  if (!isResourceRef(value.documentSetRef)) throw invalidRevision('documentSetRef is malformed')
  if (value.approvedInputRef !== undefined && !isResourceRef(value.approvedInputRef)) {
    throw invalidRevision('approvedInputRef is malformed')
  }
  if (value.datasetSnapshotRef !== undefined && !isResourceRef(value.datasetSnapshotRef)) {
    throw invalidRevision('datasetSnapshotRef is malformed')
  }
  if (value.documentIndexRef !== undefined && !isResourceRef(value.documentIndexRef)) {
    throw invalidRevision('documentIndexRef is malformed')
  }
  if (!isVersionRefArray(value.semanticPublicationRefs)) {
    throw invalidRevision('semanticPublicationRefs must be a version-ref array')
  }
  if (!isRevisionString(value.sourceVisibilityEpoch)) {
    throw invalidRevision('sourceVisibilityEpoch must be a decimal string')
  }
  if (!isNonEmptyString(value.changeReason)) throw invalidRevision('changeReason must be a non-empty string')
}

/**
 * Validate one immutable project revision read envelope: the body plus the
 * digest-bearing `ref` that pins it. The digest is not recomputed here (that is
 * the application's canonical hash); the shape is what the store must refuse to
 * persist when malformed.
 */
export function assertProjectRevisionShape(value: unknown): asserts value is ProjectRevision {
  if (!isRecord(value)) throw invalidRevision('project revision must be an object')
  const ref = value.ref
  if (!isProjectRevisionRef(ref)) throw invalidRevision('project revision ref is malformed')
  const body: Record<string, unknown> = { ...value }
  delete body.ref
  // The read envelope keeps `projectId`/`revision` in `ref`, so supply them when
  // checking the shared body shape rather than requiring duplicate top-level fields.
  assertProjectRevisionBodyShape({
    ...body,
    schemaVersion: 'project-revision@1',
    projectId: ref.projectId,
    revision: ref.revision,
  })
}

function invalidRevision(message: string): ProjectStoreError {
  return new ProjectStoreError('INVALID_REVISION', message)
}

export type ProjectState = 'draft' | 'active' | 'archived'

export type FieldConfirmationStatus = 'pending' | 'confirmed' | 'conflict'

/**
 * The mutable project head. `headRevision` is the compare-and-swap counter behind
 * If-Match; the project row itself carries no pins, because every pin lives in an
 * immutable revision.
 */
export interface ProjectRecord {
  readonly projectId: Uuid
  readonly title: NonEmptyString
  readonly headRevision: RevisionString
  /** Last fully activated revision; a newer head can be a bounded evolution in review. */
  readonly activeRevision?: RevisionString
  readonly stagingWritable?: boolean
  readonly state: ProjectState
  readonly createdBy: string
  readonly createdAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
}

export interface ProjectListFilter {
  readonly state?: ProjectState
  readonly limit?: number
}

/**
 * One append-only field-confirmation event. `confirmationRevision` is assigned by
 * the store per `(project, record, field)`, so a later correction is a new row and
 * the earlier decision is never rewritten.
 */
export interface FieldConfirmationEventRecord {
  readonly projectId: Uuid
  readonly recordId: Uuid
  readonly recordRevision: RevisionString
  readonly fieldId: string
  readonly confirmationRevision: RevisionString
  readonly contentDigest: Sha256Digest
  readonly status: FieldConfirmationStatus
  readonly actor: string
  readonly sourceRef: ResourceRef
  readonly reason?: string
  readonly eventPayload: Readonly<Record<string, unknown>>
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface CreateProjectInput {
  readonly projectId: Uuid
  readonly title: NonEmptyString
  readonly state?: ProjectState
  /** The first immutable revision; `ref.revision` must be '1' and match the project id. */
  readonly firstRevision: ProjectRevision
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
  readonly outboxJobId: Uuid
}

export interface AppendProjectRevisionInput {
  readonly expectedRevision: RevisionString
  /** The appended revision; `ref.revision` must be `expectedRevision + 1`. */
  readonly revision: ProjectRevision
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
  readonly outboxJobId: Uuid
  /** Host-produced bounded rebuild plan, committed with the staging revision/outbox. */
  readonly evolution?: ProjectEvolutionPlan
}

export interface AppendFieldConfirmationInput {
  readonly recordId: Uuid
  readonly fieldId: string
  readonly recordRevision: RevisionString
  readonly contentDigest: Sha256Digest
  readonly status: FieldConfirmationStatus
  readonly sourceRef: ResourceRef
  readonly reason?: string
  readonly eventPayload: Readonly<Record<string, unknown>>
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
}

export interface ProjectWriteResult {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  /** False when the call replayed an earlier idempotent write. */
  readonly created: boolean
}

export type ProjectStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_INVALID'
  | 'INVALID_REVISION'
  | 'INVALID_CONFIRMATION'

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode

  constructor(code: ProjectStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectStoreError'
    this.code = code
  }
}

/**
 * Control persistence for customer projects and their immutable revisions
 * (SPEC v0.3a §3.2/§3.3/§4.1).
 *
 * Every method runs in the trusted tenant/space scope with RLS underneath. The
 * project head is compare-and-swap: `appendRevision` with a stale
 * `expectedRevision` fails with VERSION_CONFLICT. Revisions are append-only and a
 * readiness projection is never written back into one. Field confirmations are
 * append-only events with a store-assigned revision.
 */
export interface ProjectStore {
  createProject(
    input: CreateProjectInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult>
  getProject(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRecord | undefined>
  listProjects(
    scopeRef: ScopeRef,
    filter: ProjectListFilter,
    ctx: ToolContext,
  ): Promise<ProjectRecord[]>
  getRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectRevision | undefined>
  listRevisions(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRevision[]>
  appendRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendProjectRevisionInput,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult>
  appendFieldConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendFieldConfirmationInput,
    ctx: ToolContext,
  ): Promise<FieldConfirmationEventRecord>
  listFieldConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<FieldConfirmationEventRecord[]>
}

export const PROJECT_READINESS_KINDS: readonly ProjectReadinessKind[] = [
  'published_semantics',
  'dataset',
  'document_index',
]

export const PROJECT_READINESS_STATES: readonly ProjectReadinessState[] = [
  'pending',
  'building',
  'ready',
  'failed',
  'revoked',
]

const COMPLETENESS_STATES: readonly CompletenessStatus[] = ['complete', 'partial', 'truncated', 'unknown']

function isReadinessTargetRef(value: unknown): value is ReadinessTargetRef {
  return isResourceRef(value) || isVersionRef(value)
}

function isReadinessError(value: unknown): value is ReadinessError {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.code) &&
    typeof value.retryable === 'boolean' &&
    isNonEmptyString(value.message)
  )
}

/**
 * Validate one readiness projection before the store persists it. The projection is a
 * separate CAS-activatable record, so a malformed target/state must be refused at the
 * boundary rather than trusted by a later reader (AGENTS: boundary data is validated at runtime).
 */
export function assertReadinessProjectionShape(value: unknown): asserts value is ReadinessProjection {
  if (!isRecord(value)) throw invalidReadiness('readiness projection must be an object')
  if (!isProjectRevisionRef(value.projectRevisionRef)) {
    throw invalidReadiness('projectRevisionRef is malformed')
  }
  if (!PROJECT_READINESS_KINDS.includes(value.kind as ProjectReadinessKind)) {
    throw invalidReadiness('readiness kind is not one of published_semantics/dataset/document_index')
  }
  if (!isReadinessTargetRef(value.targetRef)) {
    throw invalidReadiness('targetRef must be a ResourceRef or a VersionRef')
  }
  if (!PROJECT_READINESS_STATES.includes(value.state as ProjectReadinessState)) {
    throw invalidReadiness('readiness state is not pending/building/ready/failed/revoked')
  }
  if (!COMPLETENESS_STATES.includes(value.completeness as CompletenessStatus)) {
    throw invalidReadiness('completeness is not complete/partial/truncated/unknown')
  }
  for (const field of ['expectedCount', 'processedCount', 'failedCount'] as const) {
    const count = value[field]
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw invalidReadiness(`${field} must be a non-negative integer`)
    }
  }
  if (!isSha256Digest(value.targetDigest)) throw invalidReadiness('targetDigest must be a sha256 digest')
  if (!isRevisionString(value.fenceRevision)) throw invalidReadiness('fenceRevision must be a decimal string')
  if (value.receiptRef !== undefined && !isResourceRef(value.receiptRef)) {
    throw invalidReadiness('receiptRef is malformed')
  }
  if (value.jobId !== undefined && !isUuid(value.jobId)) throw invalidReadiness('jobId must be a uuid')
  if (value.error !== undefined && !isReadinessError(value.error)) throw invalidReadiness('error is malformed')
}

/** Everything the store needs to CAS-upsert one readiness projection. */
export interface UpsertProjectReadinessInput {
  readonly projectRevisionRef: ProjectRevisionRef
  readonly kind: ProjectReadinessKind
  readonly targetRef: ReadinessTargetRef
  readonly state: ProjectReadinessState
  readonly completeness: CompletenessStatus
  readonly expectedCount: number
  readonly processedCount: number
  readonly failedCount: number
  readonly targetDigest: Sha256Digest
  readonly receiptRef?: ResourceRef
  readonly fenceRevision: RevisionString
  readonly jobId?: Uuid
  readonly error?: ReadinessError
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ProjectReadinessUpsertResult {
  readonly projection: ReadinessProjection
  /** False when the call replayed an idempotent write or lost to a newer fence. */
  readonly created: boolean
}

export type ProjectReadinessStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FENCE_STALE'
  | 'INVALID_PROJECTION'

export class ProjectReadinessStoreError extends Error {
  readonly code: ProjectReadinessStoreErrorCode

  constructor(code: ProjectReadinessStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectReadinessStoreError'
    this.code = code
  }
}

/**
 * Control persistence for the independent per-revision readiness projections (SPEC v0.3a §3.2/§4.1).
 *
 * A projection is not part of the project revision digest. `upsertProjection` is a
 * fence-revision compare-and-swap: a late build whose `fenceRevision` is older than the stored
 * one is refused (`FENCE_STALE`), so a build that finished after a source was revoked can never
 * reactivate the old target. The target digest is what a reader re-checks before trusting `ready`.
 */
export interface ProjectReadinessStore {
  upsertProjection(
    scopeRef: ScopeRef,
    input: UpsertProjectReadinessInput,
    ctx: ToolContext,
  ): Promise<ProjectReadinessUpsertResult>
  getProjection(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    kind: ProjectReadinessKind,
    ctx: ToolContext,
  ): Promise<ReadinessProjection | undefined>
  listProjections(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    ctx: ToolContext,
  ): Promise<ReadinessProjection[]>
}

function invalidReadiness(message: string): ProjectReadinessStoreError {
  return new ProjectReadinessStoreError('INVALID_PROJECTION', message)
}
