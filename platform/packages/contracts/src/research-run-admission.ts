import type {
  AuthoringCommandKind,
  CreateRunContext,
  ProfileRef,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  RunPreferences,
  Sha256Digest,
  ScopeRef,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ResearchExecutionGoal, ResearchLimits } from './research-execution'
import type { ModelingBrief } from './modeling-brief'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid, isVersionRef } from './asset-workspace'

/**
 * Research run admission (design §4/§8, node S05).
 *
 * A research run may only be scheduled **after its acceptance is complete**: the brief, the frozen
 * draft, the authorization receipt, the model/tool snapshots, the original deadline, the one shared
 * ledger and the input manifest are all persisted before the run becomes dispatch-ready. The
 * admission record is the durable accept/ready marker that gates dispatch: an admission that is
 * still `preparing` is never taken over by `reconcileOpenRuns()` and its run is never normally
 * dispatched, so a half-prepared run can never execute.
 *
 * The admission is idempotent on its request key: two concurrent submissions of the same logical
 * request resolve to exactly one run id, one research id, one manifest, one admission and one
 * dispatch. The request digest the admission pins covers the research goal **and** the
 * authorization content, not just an ordinary question string.
 */

export const RESEARCH_RUN_ADMISSION_SCHEMA = 'research-run-admission@1'

export type ResearchRunAdmissionState = 'preparing' | 'ready'

/**
 * The immutable request that admits one research run. It is the *fixed* accept pipeline input: the
 * workspace and frozen draft revision, the modelling brief, the run context/preferences, the
 * effective allowed domains and the research limits (whose `deadline` is the original deadline).
 * Identity and roles are never read from here — they come from the trusted `ToolContext`.
 */
export interface ResearchRunAdmissionRequest {
  readonly schemaVersion: 'research-run-admission-request@1'
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
  readonly brief: ModelingBrief
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  /** The effective allowlist (deployment/space policy ∩ the user's selection); never widened. */
  readonly allowedDomains: readonly string[]
  /** Source/candidate caps plus the original wall-clock deadline. */
  readonly limits: ResearchLimits
  /** The already-authorized material the run may read (`document_search`/`ontology_lookup`). */
  readonly materialScopeRefs?: readonly ResourceRef[]
  readonly idempotencyKey: string
}

/**
 * The authorization receipt fixed before the run starts. It is written once, archived and
 * **read back** so a reader can prove who authorized the run, what it may write, which material it
 * may read, which domains it may reach and the effective quota it may spend. A preflight that
 * changes any of these is detected at accept time and refuses the run instead of silently
 * retargeting the recipient.
 */
export interface ResearchAuthorizationReceipt {
  readonly schemaVersion: 'research-authorization-receipt@1'
  readonly researchId: Uuid
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
  /** The operator the receipt was issued to (trusted context only). */
  readonly operatorSubjectId: string
  readonly operatorRoles: readonly string[]
  /** The controlled authoring commands the run may invoke (e.g. `submit_candidates`). */
  readonly allowedCommands: readonly AuthoringCommandKind[]
  /** The already-authorized material the run may read, as immutable refs. */
  readonly materialScopeRefs: readonly ResourceRef[]
  /** The domains the run's public search may reach. */
  readonly allowedDomains: readonly string[]
  /** The pinned budget dimensions (the effective quota; a user may only tighten the policy). */
  readonly effectiveQuota: ResearchLimits
  /** The original deadline the run was authorized under. */
  readonly deadline: Rfc3339UtcTimestamp
  readonly profileRef: ProfileRef
  /** The content hash of the frozen workspace-research config the receipt was issued against. */
  readonly configSnapshotHash: Sha256Digest
  readonly issuedAt: Rfc3339UtcTimestamp
}

/**
 * The durable admission record. `state` is the dispatch-ready barrier: only a `ready` admission may
 * be dispatched or reconciled. `modelSnapshotRefs` are the snapshots the run's pinned model binding
 * was fixed to (S02); `configSnapshotRef` is the archived frozen workspace-research config that pins
 * the tool set, the runtime and the policy the run is frozen to.
 */
export interface ResearchRunAdmission {
  readonly schemaVersion: 'research-run-admission@1'
  readonly runId: Uuid
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
  readonly idempotencyKey: string
  /** Digest of the goal + authorization content this admission was accepted under. */
  readonly requestDigest: Sha256Digest
  readonly state: ResearchRunAdmissionState
  readonly goal: ResearchExecutionGoal
  readonly briefRef: ResourceRef
  readonly authorizationReceiptRef: ResourceRef
  readonly configSnapshotRef: ResourceRef
  readonly modelSnapshotRefs: readonly VersionRef[]
  readonly toolSnapshotRefs: readonly VersionRef[]
  readonly configSnapshotHash: Sha256Digest
  readonly createdAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
  readonly readyAt?: Rfc3339UtcTimestamp
}

/** The write-once input of `begin`. The store mints no id and derives no digest. */
export interface NewResearchRunAdmission {
  readonly runId: Uuid
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly goal: ResearchExecutionGoal
  readonly briefRef: ResourceRef
  readonly authorizationReceiptRef: ResourceRef
  readonly configSnapshotRef: ResourceRef
  readonly modelSnapshotRefs: readonly VersionRef[]
  readonly toolSnapshotRefs: readonly VersionRef[]
  readonly configSnapshotHash: Sha256Digest
  readonly createdAt: Rfc3339UtcTimestamp
}

export type ResearchRunAdmissionErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'STORE_FAILED'

export class ResearchRunAdmissionError extends Error {
  readonly code: ResearchRunAdmissionErrorCode

  constructor(code: ResearchRunAdmissionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchRunAdmissionError'
    this.code = code
  }
}

/**
 * Persistence for research run admissions. `begin` is a write-once, idempotent claim on
 * `(tenant, space, idempotency_key)`: a replay with the same digest returns the stored record, and a
 * different digest under the same key is `IDEMPOTENCY_CONFLICT`, never an overwrite. `markReady`
 * flips the dispatch-ready barrier and is idempotent. Every method runs in the trusted tenant/space
 * scope, so RLS is a second layer behind the application filter.
 */
export interface ResearchRunAdmissionStore {
  begin(scopeRef: ScopeRef, admission: NewResearchRunAdmission, ctx: ToolContext): Promise<ResearchRunAdmission>
  markReady(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<ResearchRunAdmission>
  get(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<ResearchRunAdmission | undefined>
  findByIdempotencyKey(scopeRef: ScopeRef, idempotencyKey: string, ctx: ToolContext): Promise<ResearchRunAdmission | undefined>
}

/** Runtime validation of a persisted admission. A malformed row is rejected before it is trusted. */
export function assertResearchRunAdmissionShape(value: unknown): asserts value is ResearchRunAdmission {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== RESEARCH_RUN_ADMISSION_SCHEMA ||
    !isUuid(value['runId']) ||
    !isUuid(value['researchId']) ||
    !isUuid(value['workspaceId']) ||
    typeof value['draftRevision'] !== 'string' ||
    typeof value['idempotencyKey'] !== 'string' ||
    typeof value['requestDigest'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value['requestDigest']) ||
    (value['state'] !== 'preparing' && value['state'] !== 'ready') ||
    !isResourceRef(value['briefRef']) ||
    !isResourceRef(value['authorizationReceiptRef']) ||
    !isResourceRef(value['configSnapshotRef']) ||
    !Array.isArray(value['modelSnapshotRefs']) ||
    !value['modelSnapshotRefs'].every(isVersionRef) ||
    !Array.isArray(value['toolSnapshotRefs']) ||
    !value['toolSnapshotRefs'].every(isVersionRef) ||
    typeof value['configSnapshotHash'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value['configSnapshotHash']) ||
    typeof value['createdAt'] !== 'string' ||
    typeof value['updatedAt'] !== 'string' ||
    (value['readyAt'] !== undefined && typeof value['readyAt'] !== 'string') ||
    ((value['state'] === 'ready') !== (typeof value['readyAt'] === 'string')) ||
    !isRecord(value['goal']) ||
    value['goal']['kind'] !== 'industry_workspace_research' ||
    !isUuid(value['goal']['workspaceId']) ||
    typeof value['goal']['draftRevision'] !== 'string'
  ) {
    throw new ResearchRunAdmissionError('STORE_FAILED', 'a stored research run admission is malformed')
  }
}
