import type {
  CreateRunContext,
  ProfileRef,
  ResolvedProfileRef,
  RevisionString,
  RunPreferences,
  RunState,
  RuntimeCheckpointRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SseEventType,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { ToolContext } from '@ontology/contracts'

/**
 * The binding a run locks at creation. `resolvedProfileHash` is the content hash of the
 * exact resolved manifest the run started under and `runtimeRef` is that manifest's exact
 * runtime component version. Both are stored immutably, so a later profile or component
 * version can never alter an existing run and a checkpoint can only be restored by the
 * runtime that wrote it.
 */
export interface RunProfileBinding {
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly resolvedProfileRef: ResolvedProfileRef
  readonly runtimeRef: VersionRef
}

/**
 * Resolves (and persists) the manifest a run binds to. The composition root implements it
 * with the profile resolver; the application layer receives it by injection so it never
 * imports an adapter, an industry pack or a validator.
 */
export interface RunProfileBinder {
  bindProfileForRun(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RunProfileBinding>
}

export interface CreateRunInput {
  /** Pre-allocated run id, so the request-scoped trusted context can name the run. */
  readonly runId: Uuid
  readonly profileRef: ProfileRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly idempotencyKey: string
}

export interface CreateRunResult {
  readonly runId: Uuid
  readonly state: RunState
  readonly revision: RevisionString
  readonly resolvedProfileHash: Sha256Digest
  readonly reused: boolean
}

export interface RespondToClarificationInput {
  readonly runId: Uuid
  readonly clarificationId: Uuid
  readonly typedResponse: Readonly<Record<string, unknown>>
  /** `undefined` means the If-Match header was absent and the call is rejected with 428. */
  readonly expectedRevision: RevisionString | undefined
}

export interface CancelRunInput {
  readonly runId: Uuid
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
}

export interface ResumeRunInput {
  readonly runId: Uuid
  readonly checkpointId: Uuid
  readonly runtimeKind: string
  readonly runtimeVersion: Semver
  readonly stateDigest: Sha256Digest
  readonly expectedRevision: RevisionString | undefined
}

export interface SaveCheckpointInput {
  readonly runId: Uuid
  readonly checkpointId: Uuid
  readonly runtimeKind: string
  readonly runtimeVersion: Semver
  readonly stateDigest: Sha256Digest
  readonly payload: Uint8Array
}

export interface RuntimeEventResult {
  readonly disposition: 'applied' | 'duplicate' | 'abandoned' | 'private'
  readonly runState: RunState
  readonly revision: RevisionString
  readonly eventId: Uuid
  readonly sequence?: RevisionString
  readonly abandonedAttemptId?: Uuid
}

export interface RunView {
  readonly runId: Uuid
  readonly state: RunState
  readonly revision: RevisionString
  readonly ownerSubjectId: string
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly createdAt: string
  readonly updatedAt: string
  readonly cancelReason?: string
  readonly cancelledAt?: string
  readonly pendingClarificationId?: Uuid
  /** Public checkpoint handle only; the private blob is never returned. */
  readonly checkpoint?: RuntimeCheckpointRef
}

export interface PublicRunEvent {
  readonly id: RevisionString
  readonly event: SseEventType
  readonly data: Readonly<Record<string, unknown>>
  readonly occurredAt: string
}
