import { MaterializationStoreError, isToolContext } from '@ontology/contracts'
import type {
  CommitProjectionInput,
  MaterializationFence,
  MaterializationStore,
  MarkProjectionDirtyInput,
  OpenMaterializationFenceInput,
  ProjectionCommitResult,
  ProjectionSlice,
  ProjectionState,
  ReadProjectionSlicesRequest,
  RevisionString,
  ScopeRef,
  SourceWatermark,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new MaterializationStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new MaterializationStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new MaterializationStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function compareRevision(left: RevisionString, right: RevisionString): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

function covers(slice: ProjectionSlice, validAt: string): boolean {
  if (slice.validity.validFrom > validAt) return false
  const validTo = slice.validity.validTo
  return validTo === undefined || validAt < validTo
}

function sliceKey(slice: ProjectionSlice): string {
  return `${slice.propositionKey}\u0000${slice.validity.validFrom}\u0000${slice.validity.validTo ?? ''}\u0000${slice.recordedSeq}`
}

interface ScopeState {
  generation: number
  watermark: SourceWatermark
  dirty: boolean
  dirtyReason?: string
  readonly fences: Map<Uuid, MaterializationFence>
  readonly slices: Map<string, ProjectionSlice>
}

function emptyState(): ScopeState {
  return {
    generation: 0,
    watermark: { kind: 'sequence', value: '0' },
    dirty: false,
    fences: new Map(),
    slices: new Map(),
  }
}

/**
 * Reference materialisation store for unit tests and local composition. It enforces the same
 * invariants as the database implementation — tenant/space scoping, compare-and-swap on the
 * projection generation, append-only slices keyed by `(proposition, validity, recordedSeq)`,
 * a dirty flag and fence lifecycle — so the service is exercised against the real rules.
 */
export class InMemoryMaterializationStore implements MaterializationStore {
  readonly #scopes = new Map<string, ScopeState>()

  #state(scopeRef: ScopeRef): ScopeState {
    const key = scopeKey(scopeRef)
    const existing = this.#scopes.get(key)
    if (existing !== undefined) return existing
    const created = emptyState()
    this.#scopes.set(key, created)
    return created
  }

  #projectionState(scopeRef: ScopeRef, state: ScopeState): ProjectionState {
    return {
      scopeRef: clone(scopeRef),
      generation: String(state.generation),
      watermark: clone(state.watermark),
      dirty: state.dirty,
    }
  }

  async getProjectionState(scopeRef: ScopeRef, ctx: ToolContext): Promise<ProjectionState | undefined> {
    resolveScope(scopeRef, ctx)
    const key = scopeKey(scopeRef)
    const state = this.#scopes.get(key)
    if (state === undefined) return undefined
    return this.#projectionState(scopeRef, state)
  }

  async markDirty(
    scopeRef: ScopeRef,
    input: MarkProjectionDirtyInput,
    ctx: ToolContext,
  ): Promise<ProjectionState> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    state.dirty = true
    state.dirtyReason = input.reason
    return this.#projectionState(scopeRef, state)
  }

  async openFence(
    scopeRef: ScopeRef,
    input: OpenMaterializationFenceInput,
    ctx: ToolContext,
  ): Promise<MaterializationFence> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    const fence: MaterializationFence = {
      fenceId: input.fenceId,
      scopeRef: clone(scopeRef),
      generation: String(state.generation),
      reason: input.reason,
      propositionKeys: [...input.propositionKeys],
      state: 'open',
      openedAt: input.openedAt,
    }
    state.fences.set(fence.fenceId, fence)
    return clone(fence)
  }

  async closeFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    closedAt: string,
    ctx: ToolContext,
  ): Promise<MaterializationFence> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    const fence = state.fences.get(fenceId)
    if (fence === undefined) {
      throw new MaterializationStoreError('FENCE_NOT_FOUND', `fence ${fenceId} is not visible in this scope`)
    }
    const closed: MaterializationFence = { ...fence, state: 'closed', closedAt }
    state.fences.set(fenceId, closed)
    return clone(closed)
  }

  async getFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    ctx: ToolContext,
  ): Promise<MaterializationFence | undefined> {
    resolveScope(scopeRef, ctx)
    const fence = this.#scopes.get(scopeKey(scopeRef))?.fences.get(fenceId)
    return fence === undefined ? undefined : clone(fence)
  }

  async listOpenFences(scopeRef: ScopeRef, ctx: ToolContext): Promise<MaterializationFence[]> {
    resolveScope(scopeRef, ctx)
    const state = this.#scopes.get(scopeKey(scopeRef))
    if (state === undefined) return []
    return [...state.fences.values()]
      .filter((fence) => fence.state === 'open')
      .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
      .map(clone)
  }

  async readSlices(
    scopeRef: ScopeRef,
    request: ReadProjectionSlicesRequest,
    ctx: ToolContext,
  ): Promise<ProjectionSlice[]> {
    resolveScope(scopeRef, ctx)
    const state = this.#scopes.get(scopeKey(scopeRef))
    if (state === undefined) return []
    let slices = [...state.slices.values()]
    if (request.propositionKeys !== undefined) {
      const wanted = new Set(request.propositionKeys)
      slices = slices.filter((slice) => wanted.has(slice.propositionKey))
    }
    if (request.validAt !== undefined) {
      const validAt = request.validAt
      slices = slices.filter((slice) => covers(slice, validAt))
    }
    if (request.asOfRecordedSeq !== undefined) {
      const asOf = request.asOfRecordedSeq
      slices = slices.filter((slice) => compareRevision(slice.recordedSeq, asOf) <= 0)
    }
    slices.sort((left, right) =>
      left.propositionKey.localeCompare(right.propositionKey) ||
      left.validity.validFrom.localeCompare(right.validity.validFrom) ||
      compareRevision(left.recordedSeq, right.recordedSeq),
    )
    return slices.slice(0, request.limit ?? slices.length).map(clone)
  }

  async commitProjection(
    scopeRef: ScopeRef,
    input: CommitProjectionInput,
    ctx: ToolContext,
  ): Promise<ProjectionCommitResult> {
    resolveScope(scopeRef, ctx)
    const state = this.#state(scopeRef)
    if (String(state.generation) !== input.expectedGeneration) {
      throw new MaterializationStoreError(
        'GENERATION_CONFLICT',
        `the projection is at generation ${String(state.generation)}, not ${input.expectedGeneration}`,
      )
    }
    const fenceIds = [...input.fenceId === undefined ? [] : [input.fenceId], ...input.additionalFenceIds ?? []]
    if ((input.additionalFenceIds?.length ?? 0) > 0) {
      if (input.fenceId === undefined || fenceIds.length > 8 || new Set(fenceIds).size !== fenceIds.length) {
        throw new MaterializationStoreError('MATERIALIZATION_STORE_FAILED', 'a projection batch requires at most eight distinct fences')
      }
      if (fenceIds.some((fenceId) => !state.fences.has(fenceId))) throw new MaterializationStoreError('FENCE_NOT_FOUND', 'the projection batch contains a fence outside its actual scope or projection')
    }
    const generation = String(state.generation + 1)
    let appended = 0
    for (const slice of input.slices) {
      const stamped: ProjectionSlice = { ...slice, generation }
      state.slices.set(sliceKey(stamped), stamped)
      appended += 1
    }
    state.generation += 1
    state.watermark = clone(input.watermark)
    state.dirty = false
    delete state.dirtyReason
    for (const fenceId of fenceIds) {
      const fence = state.fences.get(fenceId)
      if (fence !== undefined && fence.state === 'open') {
        state.fences.set(fenceId, { ...fence, state: 'closed', closedAt: input.committedAt })
      }
    }
    return { state: this.#projectionState(scopeRef, state), appendedSlices: appended }
  }
}
