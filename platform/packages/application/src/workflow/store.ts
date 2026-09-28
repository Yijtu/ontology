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
    const key = `${scopePrefix(ctx)}${manifest.manifestId}`
    const existing = this.#inputManifests.get(key)
    if (existing === undefined) {
      if (manifest.revision !== '1') throw new WorkflowControllerError('VERSION_CONFLICT', 'input manifest must start at revision 1')
      this.#inputManifests.set(key, clone(manifest))
      return clone(manifest)
    }
    const nextRevision = (BigInt(existing.revision) + 1n).toString()
    if (manifest.revision === nextRevision && manifest.runId === existing.runId) {
      this.#inputManifests.set(key, clone(manifest))
      return clone(manifest)
    }
    if (manifest.revision === existing.revision && JSON.stringify(manifest) === JSON.stringify(existing)) return clone(existing)
    throw new WorkflowControllerError('VERSION_CONFLICT', `input manifest ${manifest.manifestId} revision changed`)
  }

  async getInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest | undefined> {
    const found = this.#inputManifests.get(`${scopePrefix(ctx)}${manifestId}`)
    return found === undefined ? undefined : clone(found)
  }

  async saveRunState(state: WorkflowRunState, expectedRevision: string, ctx: ToolContext): Promise<WorkflowRunState> {
    const key = `${scopePrefix(ctx)}${state.runId}`
    const existing = this.#runStates.get(key)
    const actualRevision = existing?.revision ?? '0'
    if (actualRevision !== expectedRevision || state.revision !== (BigInt(expectedRevision) + 1n).toString()) {
      if (existing !== undefined && existing.revision === state.revision && JSON.stringify(existing) === JSON.stringify(state)) return clone(existing)
      throw new WorkflowControllerError('VERSION_CONFLICT', `workflow state ${state.runId} revision changed`)
    }
    this.#runStates.set(key, clone(state))
    return clone(state)
  }

  async getRunState(runId: Uuid, ctx: ToolContext): Promise<WorkflowRunState | undefined> {
    const found = this.#runStates.get(`${scopePrefix(ctx)}${runId}`)
    return found === undefined ? undefined : clone(found)
  }
}
