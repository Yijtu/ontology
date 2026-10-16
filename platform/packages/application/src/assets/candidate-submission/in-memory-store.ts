import { CandidateSubmissionStoreError, assertCandidateSubmissionRecordShape, isToolContext } from '@ontology/contracts'
import type {
  CandidateSourceLink,
  CandidateSubmissionRecord,
  CandidateSubmissionStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId
    || scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new CandidateSubmissionStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference submission store for unit tests and local composition. It enforces the same invariants
 * as the database implementation — tenant/space scoping and idempotent `record` (a replayed key
 * returns the stored receipt, a reused key with a different digest is a conflict) — so the service
 * is exercised against the real rules.
 */
export class InMemoryCandidateSubmissionStore implements CandidateSubmissionStore {
  readonly #records = new Map<string, CandidateSubmissionRecord>()
  readonly #links = new Map<string, CandidateSourceLink[]>()

  async findByKey(
    scopeRef: ScopeRef,
    input: { readonly runId: Uuid; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<CandidateSubmissionRecord | undefined> {
    resolveScope(scopeRef, ctx)
    const record = this.#records.get(`${scopeKey(scopeRef)}\u0000${input.runId}\u0000${input.idempotencyKey}`)
    return record === undefined ? undefined : clone(record)
  }

  async record(
    scopeRef: ScopeRef,
    input: { readonly record: CandidateSubmissionRecord },
    ctx: ToolContext,
  ): Promise<{ readonly record: CandidateSubmissionRecord; readonly replayed: boolean }> {
    resolveScope(scopeRef, ctx)
    assertCandidateSubmissionRecordShape(input.record)
    const scope = scopeKey(scopeRef)
    const key = `${scope}\u0000${input.record.runId}\u0000${input.record.idempotencyKey}`
    const existing = this.#records.get(key)
    if (existing !== undefined) {
      if (existing.commandDigest !== input.record.commandDigest) {
        throw new CandidateSubmissionStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for a different submission')
      }
      return { record: clone(existing), replayed: true }
    }
    this.#records.set(key, clone(input.record))
    for (const link of input.record.links) {
      const linkKey = `${scope}\u0000${link.candidateId}`
      const list = this.#links.get(linkKey) ?? []
      list.push(clone(link))
      this.#links.set(linkKey, list)
    }
    return { record: clone(input.record), replayed: false }
  }

  async listLinksForCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSourceLink[]> {
    resolveScope(scopeRef, ctx)
    return (this.#links.get(`${scopeKey(scopeRef)}\u0000${candidateId}`) ?? []).map(clone)
  }

  async listUnconfirmedByWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSubmissionRecord[]> {
    resolveScope(scopeRef, ctx)
    const prefix = `${scopeKey(scopeRef)}\u0000`
    return [...this.#records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => record.workspaceId === workspaceId && record.links.some((link) => link.pendingConfirmation))
      .map(clone)
  }
}
