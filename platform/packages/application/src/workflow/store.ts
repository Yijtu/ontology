import { isToolContext } from '@ontology/contracts'
import type {
  RunManifest,
  ToolContext,
  Uuid,
  WorkflowInputManifest,
  WorkflowManifestStore,
  WorkflowRunState,
} from '@ontology/contracts'
import { WorkflowControllerError } from './errors'

function scopePrefix(ctx: ToolContext): string {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  return `${ctx.principal.tenantId}\u0000${ctx.allowedResources.spaceId}\u0000`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference implementation of the workflow manifest store for unit tests and local
 * composition. It enforces the ADR-14 invariants the controller relies on: exactly one run
 * manifest per run, an input manifest addressed by id, and tenant/space scoping. The
 * production store is a database adapter and is wired at the composition root.
 */
export class InMemoryWorkflowStore implements WorkflowManifestStore {
  readonly #runManifests = new Map<string, RunManifest>()
  readonly #inputManifests = new Map<string, WorkflowInputManifest>()
  readonly #runStates = new Map<string, WorkflowRunState>()

  async saveRunManifest(manifest: RunManifest, ctx: ToolContext): Promise<RunManifest> {
    const key = `${scopePrefix(ctx)}${manifest.runId}`
    const existing = this.#runManifests.get(key)
    if (existing !== undefined && existing.inputManifestId !== manifest.inputManifestId) {
      throw new WorkflowControllerError(
        'VERSION_CONFLICT',
        `run ${manifest.runId} already has an immutable manifest and cannot be re-opened`,
      )
    }
    if (existing === undefined) this.#runManifests.set(key, clone(manifest))
    return clone(this.#runManifests.get(key) ?? manifest)
  }

  async getRunManifest(runId: Uuid, ctx: ToolContext): Promise<RunManifest | undefined> {
    const found = this.#runManifests.get(`${scopePrefix(ctx)}${runId}`)
    return found === undefined ? undefined : clone(found)
  }

  async saveInputManifest(
    manifest: WorkflowInputManifest,
    ctx: ToolContext,
  ): Promise<WorkflowInputManifest> {
    this.#inputManifests.set(`${scopePrefix(ctx)}${manifest.manifestId}`, clone(manifest))
    return clone(manifest)
  }

  async getInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest | undefined> {
    const found = this.#inputManifests.get(`${scopePrefix(ctx)}${manifestId}`)
    return found === undefined ? undefined : clone(found)
  }

  async saveRunState(state: WorkflowRunState, ctx: ToolContext): Promise<WorkflowRunState> {
    this.#runStates.set(`${scopePrefix(ctx)}${state.runId}`, clone(state))
    return clone(state)
  }

  async getRunState(runId: Uuid, ctx: ToolContext): Promise<WorkflowRunState | undefined> {
    const found = this.#runStates.get(`${scopePrefix(ctx)}${runId}`)
    return found === undefined ? undefined : clone(found)
  }
}
