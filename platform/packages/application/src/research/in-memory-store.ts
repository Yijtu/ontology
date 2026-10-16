import { ResearchDocumentSetError, assertResearchDocumentMemberShape, isToolContext } from '@ontology/contracts'
import type {
  ResearchDocumentMember,
  ResearchDocumentMemberPage,
  ResearchDocumentSetStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'a host-minted trusted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function scopeKey(scope: ScopeRef): string {
  return `${scope.tenantId}|${scope.spaceId}`
}

function bindingKey(member: ResearchDocumentMember): string {
  return `${member.workspaceId}|${member.runId}|${member.kind}|${member.documentRef.digest}`
}

/**
 * Process-local `ResearchDocumentSetStore` for unit tests. It keeps the same scope and idempotency
 * rules as the PostgreSQL store — a member is unique per `(workspace, run, kind, document digest)`,
 * reads are bounded and paged, and cross-tenant reads are refused — so a unit test cannot pass with
 * behaviour the real store would reject.
 */
export class InMemoryResearchDocumentSetStore implements ResearchDocumentSetStore {
  readonly #members = new Map<string, ResearchDocumentMember>()
  readonly #byBinding = new Map<string, string>()

  async appendMember(
    scopeRef: ScopeRef,
    member: ResearchDocumentMember,
    ctx: ToolContext,
  ): Promise<{ readonly member: ResearchDocumentMember; readonly created: boolean }> {
    const scope = this.#assertScope(scopeRef, ctx)
    assertResearchDocumentMemberShape(member)
    const key = `${scopeKey(scope)}|${bindingKey(member)}`
    const existingId = this.#byBinding.get(key)
    if (existingId !== undefined) {
      const existing = this.#members.get(this.#key(scope, existingId))
      if (existing !== undefined) return { member: existing, created: false }
    }
    this.#members.set(this.#key(scope, member.memberId), member)
    this.#byBinding.set(key, member.memberId)
    return { member, created: true }
  }

  async getMember(scopeRef: ScopeRef, memberId: Uuid, ctx: ToolContext): Promise<ResearchDocumentMember | undefined> {
    const scope = this.#assertScope(scopeRef, ctx)
    return this.#members.get(this.#key(scope, memberId))
  }

  async listMembers(
    scopeRef: ScopeRef,
    input: { readonly workspaceId: Uuid; readonly runId: Uuid; readonly limit: number; readonly cursor?: string },
    ctx: ToolContext,
  ): Promise<ResearchDocumentMemberPage> {
    this.#assertScope(scopeRef, ctx)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200
      || (input.cursor !== undefined && input.cursor.length === 0)) {
      throw new ResearchDocumentSetError('INVALID_REQUEST', 'invalid bounded member page')
    }
    const all = [...this.#members.values()]
      .filter((member) => member.workspaceId === input.workspaceId && member.runId === input.runId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : left.memberId.localeCompare(right.memberId)))
    const start = input.cursor === undefined ? 0 : all.findIndex((member) => member.memberId === input.cursor) + 1
    const slice = all.slice(start, start + input.limit)
    const last = slice[slice.length - 1]
    return {
      members: slice,
      ...(start + input.limit < all.length && last !== undefined ? { nextCursor: last.memberId } : {}),
    }
  }

  #key(scope: ScopeRef, memberId: Uuid): string {
    return `${scopeKey(scope)}|${memberId}`
  }

  #assertScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
    const trusted = scopeOf(ctx)
    if (trusted.tenantId !== scopeRef.tenantId || trusted.spaceId !== scopeRef.spaceId) {
      throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return trusted
  }
}
