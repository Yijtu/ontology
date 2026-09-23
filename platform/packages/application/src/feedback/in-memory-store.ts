import { FeedbackStoreError, isToolContext } from '@ontology/contracts'
import type {
  FeedbackAppendResult,
  FeedbackRecord,
  FeedbackStore,
  NewFeedbackRecord,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function resolveStoreScope(
  scopeRef: ScopeRef,
  ctx: ToolContext,
): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new FeedbackStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new FeedbackStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new FeedbackStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference implementation of the feedback store for unit tests and local composition. It
 * enforces the same invariants as the database implementation — tenant/space scoping, an
 * append-only map with no update/delete, and an idempotency claim that rejects a different
 * payload — so the service is exercised against the real rules rather than a permissive fake.
 */
export class InMemoryFeedbackStore implements FeedbackStore {
  readonly #entries = new Map<string, FeedbackRecord>()
  readonly #byKey = new Map<string, string>()

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<FeedbackRecord | undefined> {
    resolveStoreScope(scopeRef, ctx)
    const entryKey = this.#byKey.get(`${scopePrefix(scopeRef)}${idempotencyKey}`)
    if (entryKey === undefined) return undefined
    const entry = this.#entries.get(entryKey)
    return entry === undefined ? undefined : clone(entry)
  }

  async append(
    scopeRef: ScopeRef,
    record: NewFeedbackRecord,
    ctx: ToolContext,
  ): Promise<FeedbackAppendResult> {
    resolveStoreScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const claimSlot = `${prefix}${record.idempotencyKey}`
    const claimedKey = this.#byKey.get(claimSlot)
    if (claimedKey !== undefined) {
      const existing = this.#entries.get(claimedKey)
      if (existing === undefined) {
        throw new FeedbackStoreError(
          'FEEDBACK_PERSIST_FAILED',
          'the idempotency claim references a missing feedback entry',
        )
      }
      if (existing.requestDigest !== record.requestDigest) {
        throw new FeedbackStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different feedback payload',
        )
      }
      return { feedback: clone(existing), inserted: false }
    }

    const entryKey = `${prefix}${record.feedbackId}`
    if (this.#entries.has(entryKey)) {
      throw new FeedbackStoreError(
        'FEEDBACK_PERSIST_FAILED',
        `feedback ${record.feedbackId} already exists`,
      )
    }
    const stored: FeedbackRecord = {
      ...clone(record),
      recordedAt: new Date().toISOString(),
    }
    this.#entries.set(entryKey, stored)
    this.#byKey.set(claimSlot, entryKey)
    return { feedback: clone(stored), inserted: true }
  }

  async listByRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<FeedbackRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    return this.#sorted(scopeRef, (entry) => entry.runId === runId)
  }

  async listByAnswer(
    scopeRef: ScopeRef,
    runId: Uuid,
    answerId: Uuid,
    ctx: ToolContext,
  ): Promise<FeedbackRecord[]> {
    resolveStoreScope(scopeRef, ctx)
    return this.#sorted(scopeRef, (entry) => entry.runId === runId && entry.answerId === answerId)
  }

  #sorted(scopeRef: ScopeRef, predicate: (entry: FeedbackRecord) => boolean): FeedbackRecord[] {
    const prefix = scopePrefix(scopeRef)
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => entry)
      .filter(predicate)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((entry) => clone(entry))
  }
}
