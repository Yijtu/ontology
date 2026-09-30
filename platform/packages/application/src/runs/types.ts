import type {
  CreateRunContext,
  ProfileRef,
  QuestionRewrite,
  ResolvedProfileRef,
  ResourceRef,
  RevisionString,
  RunExecutionBinding,
  RunExecutionRequest,
  RunPreferences,
  RunState,
  RuntimeCheckpointRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SseEventType,
  TaskCapabilityStatus,
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
  /**
   * Optional fixed project/input/task binding (SPEC v0.3a §EX-2.1). When present the server
   * resolves and archives an immutable execution binding before the run is created; when absent
   * the existing question path is unchanged.
   */
  readonly execution?: RunExecutionRequest
}

export interface CreateRunResult {
  readonly runId: Uuid
  readonly state: RunState
  readonly revision: RevisionString
  readonly resolvedProfileHash: Sha256Digest
  readonly reused: boolean
  /** The archived execution binding ref, when the run carried a task/input binding. */
  readonly executionBindingRef?: ResourceRef
}

/** The server-side result of resolving one run execution binding. */
export interface RunExecutionResolution {
  readonly executionBindingRef: ResourceRef
  readonly binding: RunExecutionBinding
  /** Present for task mode; the explicit capability/readiness preflight outcome. */
  readonly capability?: TaskCapabilityStatus
}

export interface RunExecutionBinderInput {
  readonly runId: Uuid
  readonly request: RunExecutionRequest
  readonly profileBinding: RunProfileBinding
}

/**
 * Resolves, validates and archives the immutable execution binding for a run. The composition
 * root implements it with the preflight service; the run service receives it by injection so it
 * never imports an adapter, a project store or a schema library.
 */
export interface RunExecutionBinder {
  bindExecution(
    input: RunExecutionBinderInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RunExecutionResolution>
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
  /** The archived execution binding ref the run is pinned to, when it carried a task binding. */
  readonly executionBindingRef?: ResourceRef
  /**
   * The persisted question-rewrite trace, when a bounded rewrite step ran before collection.
   * It lets the public run read surface replay original → rewrite → generated SQL (LOCAL-080).
   */
  readonly questionRewrite?: QuestionRewrite
}

export interface PublicRunEvent {
  readonly id: RevisionString
  readonly event: SseEventType
  readonly data: Readonly<Record<string, unknown>>
  readonly occurredAt: string
}
