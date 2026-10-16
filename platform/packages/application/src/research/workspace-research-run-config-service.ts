import {
  WorkspaceResearchConfigError,
  assertResolvedWorkspaceResearchProfileShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ComputeBinding,
  IndustryWorkspaceStore,
  ModelBinding,
  ResourceRef,
  ResolvedWorkspaceResearchProfile,
  ScopeRef,
  ToolBinding,
  ToolContext,
  VersionRef,
  WorkspaceResearchProfileSpec,
  WorkspaceResearchRunConfigStore,
  WorkspaceResearchRunRequest,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * The resource kind of the immutable draft snapshot a workspace-research config pins. It is a
 * reference only (id/version/digest); the draft bytes live in the workspace store, never here.
 */
const RESEARCH_DRAFT_REF_KIND = 'draft'

export interface WorkspaceResearchRunConfigDependencies {
  /** Reads the exact workspace draft the config freezes; supplied by the composition root. */
  readonly workspaces: IndustryWorkspaceStore
  /** Immutable, write-once config persistence. */
  readonly configs: WorkspaceResearchRunConfigStore
  /** The host's research runtime component version the config pins. */
  readonly runtimeRef: VersionRef
  /** The agentic-research policy version the config pins. */
  readonly policyRef: VersionRef
  /** The public data tools the research run may call (web_search/document_search/ontology_lookup). */
  readonly toolBindings: readonly ToolBinding[]
  /** Registered compute operations the research run may call, when any. */
  readonly computeBindings?: readonly ComputeBinding[]
  /**
   * The profile-declared model bindings. A workspace-research run binds its model per-execution
   * (`industry_workspace` + `research`), not here, so this is normally empty.
   */
  readonly modelBindings?: Readonly<Record<string, ModelBinding>>
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkspaceResearchConfigError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkspaceResearchConfigError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/**
 * Resolve the deterministic content hash of a workspace-research profile. It covers the exact
 * workspace, the frozen draft revision/digest and the public execution config, but not the
 * `snapshotHash`/`resolvedAt` the hash itself produces, so the hash is stable across a re-resolve.
 */
export function resolvedWorkspaceResearchProfileDigest(
  spec: WorkspaceResearchProfileSpec,
  resolvedVersions: readonly VersionRef[],
  explicitDegradations: readonly unknown[],
): string {
  return sha256DigestOf(
    canonicalJson({
      schemaVersion: spec.schemaVersion,
      workspaceId: spec.workspaceId,
      draftRevision: spec.draftRevision,
      draftRef: spec.draftRef,
      runtimeRef: spec.runtimeRef,
      modelBindings: spec.modelBindings,
      toolBindings: spec.toolBindings,
      computeBindings: spec.computeBindings,
      policyRef: spec.policyRef,
      resolvedVersions,
      explicitDegradations,
    }),
  )
}

/**
 * Resolve the versioned workspace-research run configuration for one draft revision (design §8, S04).
 *
 * It fixes the real workspace and the exact immutable draft revision it models, plus the public
 * execution config the common gateway needs. It requires **no** project, scenario or published
 * industry pack; the model is bound separately per execution (`industry_workspace` + `research`).
 *
 * The resolve is immutable per (workspaceId, draftRevision): resolving the same revision again
 * returns the stored row unchanged, and editing the workspace draft only ever produces a newer
 * revision, so an earlier run's configuration can never be retargeted. A requested draft revision
 * that does not exist is `DRAFT_NOT_FOUND`, never a fabricated empty config.
 */
export class WorkspaceResearchRunConfigService {
  readonly #workspaces: IndustryWorkspaceStore
  readonly #configs: WorkspaceResearchRunConfigStore
  readonly #runtimeRef: VersionRef
  readonly #policyRef: VersionRef
  readonly #toolBindings: readonly ToolBinding[]
  readonly #computeBindings: readonly ComputeBinding[]
  readonly #modelBindings: Readonly<Record<string, ModelBinding>>
  readonly #now: () => string

  constructor(dependencies: WorkspaceResearchRunConfigDependencies) {
    this.#workspaces = dependencies.workspaces
    this.#configs = dependencies.configs
    this.#runtimeRef = dependencies.runtimeRef
    this.#policyRef = dependencies.policyRef
    this.#toolBindings = [...dependencies.toolBindings]
    this.#computeBindings = [...(dependencies.computeBindings ?? [])]
    this.#modelBindings = { ...(dependencies.modelBindings ?? {}) }
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async resolveForRun(
    request: WorkspaceResearchRunRequest,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile> {
    const scopeRef = scopeOf(ctx)
    if (!isUuid(request.workspaceId)) {
      throw new WorkspaceResearchConfigError('INVALID_CONFIG', 'workspaceId must be a uuid')
    }
    if (typeof request.draftRevision !== 'string' || !/^(0|[1-9]\d*)$/.test(request.draftRevision)) {
      throw new WorkspaceResearchConfigError('INVALID_CONFIG', 'draftRevision must be a decimal revision string')
    }

    // The config for a draft revision is immutable: a replay returns the stored row unchanged, so
    // an edit to the workspace head can never retarget the run that resolved the earlier revision.
    const existing = await this.#configs.getResolved(scopeRef, request.workspaceId, request.draftRevision, ctx)
    if (existing !== undefined) return existing

    const draft = await this.#workspaces.getDraft(scopeRef, request.workspaceId, request.draftRevision, ctx).catch(mapWorkspaceError)
    if (draft === undefined) {
      throw new WorkspaceResearchConfigError('DRAFT_NOT_FOUND', `draft revision ${request.draftRevision} is not visible for workspace ${request.workspaceId}`)
    }
    const draftRef: ResourceRef = { id: draft.workspaceId, version: draft.revision, digest: draft.digest, kind: RESEARCH_DRAFT_REF_KIND }
    const spec: WorkspaceResearchProfileSpec = {
      schemaVersion: 'workspace-research-profile-spec@1',
      workspaceId: draft.workspaceId,
      draftRevision: draft.revision,
      draftRef,
      runtimeRef: this.#runtimeRef,
      modelBindings: this.#modelBindings,
      toolBindings: [...this.#toolBindings],
      computeBindings: [...this.#computeBindings],
      policyRef: this.#policyRef,
    }
    const resolvedVersions: readonly VersionRef[] = [this.#runtimeRef]
    const explicitDegradations: readonly never[] = []
    const snapshotHash = resolvedWorkspaceResearchProfileDigest(spec, resolvedVersions, explicitDegradations)
    const resolved: ResolvedWorkspaceResearchProfile = {
      ...spec,
      resolvedVersions: [...resolvedVersions],
      explicitDegradations: [...explicitDegradations],
      snapshotHash,
      resolvedAt: this.#now(),
    }
    assertResolvedWorkspaceResearchProfileShape(resolved)
    return this.#configs.putResolved(scopeRef, resolved, ctx)
  }
}

function mapWorkspaceError(error: unknown): never {
  // The workspace store's own classified failures are preserved; a malformed draft is a config error.
  if (error instanceof WorkspaceResearchConfigError) throw error
  throw new WorkspaceResearchConfigError(
    'STORE_FAILED',
    error instanceof Error ? error.message : 'the workspace draft could not be read',
    { cause: error },
  )
}
