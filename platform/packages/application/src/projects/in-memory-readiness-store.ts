import {
  ProjectReadinessStoreError,
  assertReadinessProjectionShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  ProjectReadinessKind,
  ProjectReadinessStore,
  ProjectReadinessUpsertResult,
  ProjectRevisionRef,
  ReadinessProjection,
  ScopeRef,
  ToolContext,
  UpsertProjectReadinessInput,
} from '@ontology/contracts'

interface StoredProjection {
  readonly scopeKey: string
  readonly projection: ReadinessProjection
  readonly requestDigest: string
  readonly idempotencyKey: string
}

function scopeKeyOf(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function projectionKey(ref: ProjectRevisionRef, kind: ProjectReadinessKind): string {
  return `${ref.projectId}\u0000${ref.revision}\u0000${kind}`
}

function projectionOf(input: UpsertProjectReadinessInput): ReadinessProjection {
  return {
    projectRevisionRef: input.projectRevisionRef,
    kind: input.kind,
    targetRef: input.targetRef,
    state: input.state,
    completeness: input.completeness,
    expectedCount: input.expectedCount,
    processedCount: input.processedCount,
    failedCount: input.failedCount,
    targetDigest: input.targetDigest,
    fenceRevision: input.fenceRevision,
    ...(input.receiptRef === undefined ? {} : { receiptRef: input.receiptRef }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

function assertTrusted(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProjectReadinessStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new ProjectReadinessStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

/**
 * An in-memory readiness store that mirrors the fence-CAS semantics of the PostgreSQL adapter.
 * It is a test double for the application unit suite; the real acceptance runs against
 * `PostgresProjectReadinessStore`.
 */
export class InMemoryProjectReadinessStore implements ProjectReadinessStore {
  readonly #byKey = new Map<string, StoredProjection>()
  readonly #byIdempotencyKey = new Map<string, StoredProjection>()

  async upsertProjection(
    scopeRef: ScopeRef,
    input: UpsertProjectReadinessInput,
    ctx: ToolContext,
  ): Promise<ProjectReadinessUpsertResult> {
    assertTrusted(scopeRef, ctx)
    const projection = projectionOf(input)
    assertReadinessProjectionShape(projection)

    const scopeKey = scopeKeyOf(scopeRef)
    const idempotencyKey = `${scopeKey}\u0000${input.idempotencyKey}`
    const replay = this.#byIdempotencyKey.get(idempotencyKey)
    if (replay !== undefined) {
      if (replay.requestDigest !== input.requestDigest) {
        throw new ProjectReadinessStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different readiness payload',
        )
      }
      return { projection: replay.projection, created: false }
    }

    const key = `${scopeKey}\u0000${projectionKey(input.projectRevisionRef, input.kind)}`
    const existing = this.#byKey.get(key)
    if (existing !== undefined) {
      const sameFence = existing.projection.fenceRevision === projection.fenceRevision
      const newerFence = BigInt(projection.fenceRevision) > BigInt(existing.projection.fenceRevision)
      if (!newerFence && !(sameFence && existing.projection.targetDigest === projection.targetDigest)) {
        throw new ProjectReadinessStoreError(
          'FENCE_STALE',
          `readiness ${input.kind} for revision ${input.projectRevisionRef.revision} was already built at a fence >= ${input.fenceRevision}`,
        )
      }
    }

    const stored: StoredProjection = {
      scopeKey,
      projection,
      requestDigest: input.requestDigest,
      idempotencyKey,
    }
    this.#byKey.set(key, stored)
    this.#byIdempotencyKey.set(idempotencyKey, stored)
    return { projection, created: existing === undefined }
  }

  async getProjection(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    kind: ProjectReadinessKind,
    ctx: ToolContext,
  ): Promise<ReadinessProjection | undefined> {
    assertTrusted(scopeRef, ctx)
    return this.#byKey.get(`${scopeKeyOf(scopeRef)}\u0000${projectionKey(projectRevisionRef, kind)}`)?.projection
  }

  async listProjections(
    scopeRef: ScopeRef,
    projectRevisionRef: ProjectRevisionRef,
    ctx: ToolContext,
  ): Promise<ReadinessProjection[]> {
    assertTrusted(scopeRef, ctx)
    const scopeKey = scopeKeyOf(scopeRef)
    return [...this.#byKey.values()]
      .filter(
        (stored) =>
          stored.scopeKey === scopeKey &&
          stored.projection.projectRevisionRef.projectId === projectRevisionRef.projectId &&
          stored.projection.projectRevisionRef.revision === projectRevisionRef.revision,
      )
      .map((stored) => stored.projection)
      .sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))
  }
}
