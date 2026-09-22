import { RunServiceError } from '@ontology/application'
import type { RunProfileBinder } from '@ontology/application'
import { isToolContext } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  BudgetRemaining,
  ProfileRef,
  ProfileStore,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  ToolId,
  Uuid,
  WorkflowManifestStore,
} from '@ontology/contracts'

/**
 * The sanitised progress projection the business query UI reads (C6 `GET /runs/{id}`:
 * "sanitized state/budget"). It carries the run's shared budget remaining and the
 * resolved scenario scope — the enabled tools, whether web search is available and the
 * domains the trusted context approves — and nothing else. No secret value, no resolved
 * credential and no unverified draft text is ever part of this projection.
 */
export interface DegradationView {
  readonly capability: string
  readonly reason: string
  readonly fallback: string
}

export interface RunScopeView {
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  /** True only when the resolved scenario enables `web_search` for the run. */
  readonly webSearchEnabled: boolean
  /** The enabled tool ids of the resolved scenario; the UI offers only these. */
  readonly toolIds: readonly ToolId[]
  /** The domains the trusted context approves; never a wildcard. */
  readonly allowedDomains: readonly string[]
  readonly explicitDegradations: readonly DegradationView[]
}

export interface RunProgressView {
  readonly budget?: BudgetRemaining
  readonly scope?: RunScopeView
}

/** The run fields the progress projection needs; satisfied structurally by `RunView`. */
export interface RunProgressSubject {
  readonly runId: Uuid
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
}

/**
 * The narrow read surface the run-progress projection needs. It resolves the scenario
 * scope for a profile (so the ask form offers only what the profile allows) and reads the
 * shared budget for an existing run. The composition root implements it from the profile
 * store, the run-profile binder, the workflow manifest store and the budget ledger.
 */
export interface RunProgressReader {
  scopeForProfile(profileRef: ProfileRef, ctx: ToolContext): Promise<RunScopeView>
  progressForRun(subject: RunProgressSubject, ctx: ToolContext): Promise<RunProgressView>
}

export interface RunProgressDependencies {
  readonly profiles: ProfileStore
  readonly binder: RunProfileBinder
  readonly manifests: WorkflowManifestStore
  readonly budget: BudgetLedgerPort
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new RunServiceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new RunServiceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/**
 * Read-only projection of the resolved scenario scope and the shared run budget. It never
 * writes budget and never widens a scope: the enabled tool set comes from the immutable
 * resolved profile the run locked, and the approved domains come from the trusted request
 * context. The budget is the single run ledger (ADR-14), so a clarification round reads the
 * same remaining amount and never resets it.
 */
export class RunProgressService implements RunProgressReader {
  readonly #profiles: ProfileStore
  readonly #binder: RunProfileBinder
  readonly #manifests: WorkflowManifestStore
  readonly #budget: BudgetLedgerPort

  constructor(dependencies: RunProgressDependencies) {
    this.#profiles = dependencies.profiles
    this.#binder = dependencies.binder
    this.#manifests = dependencies.manifests
    this.#budget = dependencies.budget
  }

  async scopeForProfile(profileRef: ProfileRef, ctx: ToolContext): Promise<RunScopeView> {
    const binding = await this.#binder.bindProfileForRun(profileRef, scopeOf(ctx), ctx)
    return this.#scopeOf(binding.profileRef, binding.resolvedProfileHash, ctx)
  }

  async progressForRun(subject: RunProgressSubject, ctx: ToolContext): Promise<RunProgressView> {
    const scope = await this.#scopeOf(subject.profileRef, subject.resolvedProfileHash, ctx)
    const manifest = await this.#manifests.getRunManifest(subject.runId, ctx)
    if (manifest === undefined) {
      // The workflow has not opened its budget ledger yet; the scope is still knowable, but
      // no budget is invented.
      return { scope }
    }
    const snapshot = await this.#budget.remaining(manifest.budgetLedgerId, ctx)
    return { scope, budget: snapshot.remaining }
  }

  async #scopeOf(
    profileRef: ProfileRef,
    resolvedProfileHash: Sha256Digest,
    ctx: ToolContext,
  ): Promise<RunScopeView> {
    const record = await this.#profiles.findResolvedProfile(
      profileRef,
      resolvedProfileHash,
      scopeOf(ctx),
      ctx,
    )
    if (record === undefined) {
      throw new RunServiceError(
        'PROFILE_INCOMPATIBLE',
        `the resolved scenario ${profileRef.id}@${profileRef.version} (${resolvedProfileHash}) is not available`,
      )
    }
    const resolved = record.resolved
    return {
      profileRef,
      resolvedProfileHash,
      webSearchEnabled: resolved.toolBindings.some(
        (binding) => binding.toolId === 'web_search' && binding.enabled,
      ),
      toolIds: resolved.toolBindings
        .filter((binding) => binding.enabled)
        .map((binding) => binding.toolId),
      allowedDomains: [...ctx.allowedResources.domains],
      explicitDegradations: resolved.explicitDegradations.map((degradation) => ({
        capability: degradation.capability,
        reason: degradation.reason,
        fallback: degradation.fallback,
      })),
    }
  }
}
