import type {
  ProfileRef,
  ResolvedWorkspaceResearchProfile,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  Uuid,
  WorkspaceResearchProfileSpec,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isRevisionString, isSha256Digest, isUuid, isVersionRef } from './asset-workspace'

/**
 * Workspace-research run configuration (design §8, S04).
 *
 * An agentic research run against an industry workspace has **no project, no scenario and no
 * published industry pack** to resolve a scenario `ResolvedProfile` from. Instead it binds a
 * separate, versioned **workspace-research profile** that fixes the real workspace and the exact
 * immutable draft revision it models (`workspaceId + draftRevision + draftRef`). The common tool
 * gateway only ever depends on the *public execution config* it actually uses (the enabled public
 * data tools and registered compute), so a run config can exist before any industry pack does.
 *
 * The model is bound per-execution (`industry_workspace` + `research`), never here: this config
 * carries no credential, no service address and no mapping.
 */

/**
 * The reserved profile-ref namespace a workspace-research run binds. It encodes the exact
 * workspace so two workspaces can never share a profile identity, and the draft revision so a
 * later edit produces a different ref. A scenario profile never uses this prefix.
 */
export const WORKSPACE_RESEARCH_PROFILE_ID_PREFIX = 'workspace-research:'

export function workspaceResearchProfileRef(
  workspaceId: Uuid,
  draftRevision: RevisionString,
): ProfileRef {
  return { id: `${WORKSPACE_RESEARCH_PROFILE_ID_PREFIX}${workspaceId}`, version: `${draftRevision}.0.0` }
}

export function isWorkspaceResearchProfileRef(ref: ProfileRef): boolean {
  return typeof ref.id === 'string' && ref.id.startsWith(WORKSPACE_RESEARCH_PROFILE_ID_PREFIX)
}

/** The workspace a reserved workspace-research profile ref names, or `undefined` if it is not one. */
export function workspaceIdOfResearchProfileRef(ref: ProfileRef): Uuid | undefined {
  if (!isWorkspaceResearchProfileRef(ref)) return undefined
  const workspaceId = ref.id.slice(WORKSPACE_RESEARCH_PROFILE_ID_PREFIX.length)
  return isUuid(workspaceId) ? workspaceId : undefined
}

/** The draft revision a reserved workspace-research profile version names (`<revision>.0.0`). */
export function draftRevisionOfResearchProfileVersion(version: string): RevisionString | undefined {
  const [revision] = version.split('.')
  return revision !== undefined && isRevisionString(revision) ? revision : undefined
}

/**
 * The immutable request a workspace-research run config is resolved from. It names the real
 * workspace and the exact draft revision the run must be frozen to; the server reads the actual
 * draft, so a caller can never supply a digest the workspace does not have.
 */
export interface WorkspaceResearchRunRequest {
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
}

export type WorkspaceResearchConfigErrorCode =
  | 'SCOPE_MISMATCH'
  | 'DRAFT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_CONFIG'
  | 'NOT_FOUND'
  | 'STORE_FAILED'

export class WorkspaceResearchConfigError extends Error {
  readonly code: WorkspaceResearchConfigErrorCode

  constructor(code: WorkspaceResearchConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceResearchConfigError'
    this.code = code
  }
}

/**
 * Persistence for resolved workspace-research run configs. It is write-once per
 * `(tenant_id, space_id, workspace_id, draft_revision)`: resolving the same draft again returns the
 * stored row unchanged, so editing the workspace draft later can never rewrite an earlier run's
 * configuration. Every method runs in the trusted tenant/space scope.
 */
export interface WorkspaceResearchRunConfigStore {
  /** Write once for the exact draft revision; a different digest for the same key is a conflict. */
  putResolved(
    scopeRef: ScopeRef,
    config: ResolvedWorkspaceResearchProfile,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile>
  getResolved(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    draftRevision: RevisionString,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile | undefined>
  findResolvedBySnapshot(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    draftRevision: RevisionString,
    snapshotHash: Sha256Digest,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile | undefined>
}

/**
 * Runtime validation of a persisted workspace-research profile. It is written as the adapter
 * boundary guard: a malformed value or one naming a different workspace id than its draft ref is
 * rejected before any SQL runs, exactly like the other hand-written workspace guards.
 */
export function assertWorkspaceResearchProfileSpecShape(
  value: unknown,
): asserts value is WorkspaceResearchProfileSpec {
  assertWorkspaceResearchProfileFields(value)
}

export function assertResolvedWorkspaceResearchProfileShape(
  value: unknown,
): asserts value is ResolvedWorkspaceResearchProfile {
  assertWorkspaceResearchProfileFields(value)
  if (!isRecord(value)) throw invalidConfig('a resolved workspace-research profile must be an object')
  if (!Array.isArray(value['resolvedVersions']) || !value['resolvedVersions'].every(isVersionRef)) {
    throw invalidConfig('resolvedVersions must be an array of version refs')
  }
  if (!Array.isArray(value['explicitDegradations'])) {
    throw invalidConfig('explicitDegradations must be an array')
  }
  if (!isSha256Digest(value['snapshotHash'])) throw invalidConfig('snapshotHash must be a sha256 digest')
  if (typeof value['resolvedAt'] !== 'string' || value['resolvedAt'].length === 0) {
    throw invalidConfig('resolvedAt must be a timestamp')
  }
}

function assertWorkspaceResearchProfileFields(value: unknown): void {
  if (!isRecord(value) || value['schemaVersion'] !== 'workspace-research-profile-spec@1') {
    throw invalidConfig('a workspace-research profile must carry schemaVersion workspace-research-profile-spec@1')
  }
  if (!isUuid(value['workspaceId'])) throw invalidConfig('workspaceId must be a uuid')
  if (!isRevisionString(value['draftRevision'])) throw invalidConfig('draftRevision must be a decimal revision string')
  if (!isResourceRef(value['draftRef'])) throw invalidConfig('draftRef must be a resource reference')
  // The draft ref id is the workspace id and its version is the draft revision; a mismatch would
  // let a config name a draft that belongs to another workspace or revision.
  if (value['draftRef'].id !== value['workspaceId'] || value['draftRef'].version !== value['draftRevision']) {
    throw invalidConfig('draftRef must pin the exact workspace and draft revision')
  }
  if (!isVersionRef(value['runtimeRef'])) throw invalidConfig('runtimeRef must be a version ref')
  if (!isRecord(value['modelBindings'])) throw invalidConfig('modelBindings must be an object')
  if (!Array.isArray(value['toolBindings'])) throw invalidConfig('toolBindings must be an array')
  if (!Array.isArray(value['computeBindings'])) throw invalidConfig('computeBindings must be an array')
  if (!isVersionRef(value['policyRef'])) throw invalidConfig('policyRef must be a version ref')
}

function invalidConfig(message: string): WorkspaceResearchConfigError {
  return new WorkspaceResearchConfigError('INVALID_CONFIG', message)
}
