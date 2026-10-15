import {
  InstanceReviewError,
  isToolContext,
} from '@ontology/contracts'
import type {
  AppendInstanceConfirmationInput,
  AppendInstanceRecordInput,
  InstanceConfirmationEvent,
  InstanceRecordView,
  InstanceReviewListFilter,
  InstanceReviewStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/**
 * In-memory `InstanceReviewStore` used by focused unit tests and the loopback browser E2E
 * harness. It enforces the same scope, CAS and idempotency rules as the PostgreSQL store so a
 * passing test proves real review behaviour rather than a permissive fake:
 *
 *  - every call re-derives the scope from the trusted context and rejects a mismatch;
 *  - `appendRecordRevision` is compare-and-swap on the record head;
 *  - a replayed idempotency key returns the original result, and the same key with a different
 *    payload is an IDEMPOTENCY_CONFLICT.
 */

function clone<T>(value: T): T {
  return structuredClone(value)
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function recordKey(scopeRef: ScopeRef, projectId: Uuid, recordId: Uuid): string {
  return `${scopeKey(scopeRef)}\u0000${projectId}\u0000${recordId}`
}

function confirmationKey(scopeRef: ScopeRef, projectId: Uuid, recordId: Uuid, fieldId: string): string {
  return `${recordKey(scopeRef, projectId, recordId)}\u0000${fieldId}`
}

function requestDigestOf(value: unknown): string {
  return JSON.stringify(value)
}

function nextRevisionOf(current: string): string {
  return (BigInt(current) + 1n).toString()
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new InstanceReviewError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new InstanceReviewError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new InstanceReviewError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

interface IdempotentRecord {
  readonly kind: 'record'
  readonly digest: string
  readonly result: InstanceRecordView
}

interface IdempotentConfirmation {
  readonly kind: 'confirmation'
  readonly digest: string
  readonly result: InstanceConfirmationEvent
}

type IdempotentEntry = IdempotentRecord | IdempotentConfirmation

export class InMemoryInstanceReviewStore implements InstanceReviewStore {
  readonly #records = new Map<string, InstanceRecordView[]>()
  readonly #confirmations = new Map<string, InstanceConfirmationEvent[]>()
  readonly #idempotency = new Map<string, IdempotentEntry>()

  async listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: InstanceReviewListFilter,
    ctx: ToolContext,
  ): Promise<InstanceRecordView[]> {
    resolveScope(scopeRef, ctx)
    const prefix = `${scopeKey(scopeRef)}\u0000${projectId}\u0000`
    const latest: InstanceRecordView[] = []
    for (const [key, revisions] of this.#records.entries()) {
      if (!key.startsWith(prefix)) continue
      const current = revisions[revisions.length - 1]
      if (current === undefined) continue
      if (filter.status !== undefined && !current.fields.some((field) => field.status === filter.status)) continue
      if (filter.publicationState !== undefined && current.publicationState !== filter.publicationState) continue
      latest.push(clone(current))
    }
    latest.sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
    return typeof filter.limit === 'number' ? latest.slice(0, filter.limit) : latest
  }

  async getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceRecordView | undefined> {
    resolveScope(scopeRef, ctx)
    const revisions = this.#records.get(recordKey(scopeRef, projectId, recordId))
    const current = revisions?.[revisions.length - 1]
    return current === undefined ? undefined : clone(current)
  }

  async appendRecordRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceRecordInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    resolveScope(scopeRef, ctx)
    const idempotencyKey = `${scopeKey(scopeRef)}\u0000${input.idempotencyKey}`
    const existing = this.#idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.kind !== 'record' || existing.digest !== requestDigestOf(input)) {
        throw new InstanceReviewError('IDEMPOTENCY_CONFLICT', 'the idempotency key was used with a different payload')
      }
      return clone(existing.result)
    }
    const key = recordKey(scopeRef, projectId, input.recordId)
    const revisions = this.#records.get(key) ?? []
    const current = revisions[revisions.length - 1]
    const currentRevision = current?.recordRevision ?? '0'
    if (currentRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record head is ${currentRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    const revision = nextRevisionOf(currentRevision)
    const record: InstanceRecordView = {
      projectId,
      recordId: input.recordId,
      recordRevision: revision,
      objectTypeRef: input.objectTypeRef,
      identity: {
        ...(input.identityBinding === undefined ? {} : { binding: clone(input.identityBinding) }),
        state: input.identityState,
        confidence: input.identityConfidence,
        candidates: clone(input.identityCandidates),
        ...(input.matchedEntityId === undefined ? {} : { matchedEntityId: input.matchedEntityId }),
        sameNameDifferentMeaning: input.sameNameDifferentMeaning,
        cannotLinkEntityIds: clone(input.cannotLinkEntityIds),
        adjudications: clone(input.adjudications),
        decisionRevision: input.adjudications.length === 0 ? '0' : String(input.adjudications.length),
      },
      fields: clone(input.fields),
      relations: clone(input.relations),
      publicationState: input.publicationState,
      ...(input.publishedRevision === undefined ? {} : { publishedRevision: input.publishedRevision }),
      sourceRef: clone(input.sourceRef),
      actor: input.actor,
      recordedAt: input.recordedAt,
    }
    revisions.push(record)
    this.#records.set(key, revisions)
    this.#idempotency.set(idempotencyKey, { kind: 'record', digest: requestDigestOf(input), result: clone(record) })
    return clone(record)
  }

  async appendConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceConfirmationInput,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent> {
    resolveScope(scopeRef, ctx)
    const idempotencyKey = `${scopeKey(scopeRef)}\u0000${input.idempotencyKey}`
    const existing = this.#idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.kind !== 'confirmation' || existing.digest !== requestDigestOf(input)) {
        throw new InstanceReviewError('IDEMPOTENCY_CONFLICT', 'the idempotency key was used with a different payload')
      }
      return clone(existing.result)
    }
    const key = confirmationKey(scopeRef, projectId, input.recordId, input.fieldId)
    const events = this.#confirmations.get(key) ?? []
    const nextRevision = nextRevisionOf(events[events.length - 1]?.confirmationRevision ?? '0')
    const event: InstanceConfirmationEvent = {
      projectId,
      recordId: input.recordId,
      fieldId: input.fieldId,
      recordRevision: input.recordRevision,
      confirmationRevision: nextRevision,
      status: input.status,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      actor: input.actor,
      recordedAt: input.recordedAt,
    }
    events.push(event)
    this.#confirmations.set(key, events)
    this.#idempotency.set(idempotencyKey, {
      kind: 'confirmation',
      digest: requestDigestOf(input),
      result: clone(event),
    })
    return clone(event)
  }

  async listConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent[]> {
    resolveScope(scopeRef, ctx)
    const prefix = `${recordKey(scopeRef, projectId, recordId)}\u0000`
    const all: InstanceConfirmationEvent[] = []
    for (const [key, events] of this.#confirmations.entries()) {
      if (!key.startsWith(prefix)) continue
      all.push(...events)
    }
    all.sort((left, right) =>
      left.fieldId < right.fieldId
        ? -1
        : left.fieldId > right.fieldId
          ? 1
          : BigInt(left.confirmationRevision) < BigInt(right.confirmationRevision)
            ? -1
            : 1,
    )
    return all.map(clone)
  }
}
