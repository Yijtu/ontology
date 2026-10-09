import { assertProjectDocumentMembershipShape, sha256OfCanonical } from '@ontology/contracts'
import type {
  ListProjectDocumentsFilter,
  ProjectDocumentMembership,
  ProjectDocumentPage,
  ProjectDocumentStore,
  ProjectDocumentWriteResult,
  ProjectIndexReceipt,
  ProjectIndexReceiptWriteResult,
  ProjectVisibility,
  RecordProjectIndexReceiptInput,
  RegisterProjectDocumentInput,
  ReviseProjectDocumentInput,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { DocumentSearchError } from './errors'
import { resolveTrustedScope, scopeKey } from './scope'

const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500

function clone<T>(value: T): T {
  return structuredClone(value)
}

function projectKey(scope: ScopeRef, projectId: Uuid): string {
  return `${scopeKey(scope)}\u0000${projectId}`
}

function documentKey(scope: ScopeRef, projectId: Uuid, documentId: Uuid): string {
  return `${projectKey(scope, projectId)}\u0000${documentId}`
}

function receiptKey(projectKeyValue: string, collectionRef: string, generation: string): string {
  return `${projectKeyValue}\u0000${collectionRef}\u0000${generation}`
}

function nextRevision(current: RevisionString): RevisionString {
  return (BigInt(current) + 1n).toString()
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { offset?: unknown }).offset !== 'number'
    ) {
      throw new Error('bad cursor')
    }
    const offset = (parsed as { offset: number }).offset
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad cursor')
    return offset
  } catch (error) {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'the project document cursor is malformed', {
      cause: error,
    })
  }
}

/**
 * Reference `ProjectDocumentStore` for unit tests and local composition. It
 * enforces the same invariants as the database store — scope isolation,
 * append-only membership revisions, a monotonic per-project visibility epoch and
 * the receipt epoch CAS — so a unit test cannot pass on behaviour the real store
 * would reject.
 */
export class InMemoryProjectDocumentStore implements ProjectDocumentStore {
  readonly #visibility = new Map<string, ProjectVisibility>()
  readonly #memberships = new Map<string, ProjectDocumentMembership[]>()
  readonly #receipts = new Map<string, ProjectIndexReceipt>()

  async registerDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RegisterProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const project = projectKey(scope, projectId)
    const current = this.#visibility.get(project) ?? {
      projectId,
      epoch: '0',
      membershipRevision: '0',
    }
    const existing = await this.getMembership(scope, projectId, input.documentId, ctx)
    if (existing !== undefined) {
      const pins = (value: RegisterProjectDocumentInput | ProjectDocumentMembership) => ({ documentRef: value.documentRef, documentDigest: value.documentDigest,
        parseId: value.parseId, parseRef: value.parseRef, textDigest: value.textDigest, precision: value.precision, sourceRef: value.sourceRef ?? null })
      if (existing.state !== 'active' || sha256OfCanonical(pins(existing)) !== sha256OfCanonical(pins(input))) throw new DocumentSearchError('INVALID_ARGUMENT', 'import cannot mutate or revive an existing withdrawn document')
      return { membership: existing, visibility: clone(current), created: false }
    }
    const epoch = nextRevision(current.epoch)
    const membershipRevision = nextRevision(current.membershipRevision)
    const membership: ProjectDocumentMembership = {
      projectId,
      documentId: input.documentId,
      state: 'active',
      membershipRevision,
      documentRef: clone(input.documentRef),
      documentDigest: input.documentDigest,
      parseId: input.parseId,
      parseRef: clone(input.parseRef),
      textDigest: input.textDigest,
      precision: input.precision,
      ...(input.sourceRef === undefined ? {} : { sourceRef: clone(input.sourceRef) }),
      visibilityEpoch: epoch,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      recordedAt: input.recordedAt,
    }
    assertProjectDocumentMembershipShape(membership)
    this.#appendMembership(project, input.documentId, membership)
    this.#visibility.set(project, {
      projectId,
      epoch,
      membershipRevision,
    })
    return {
      membership: clone(membership),
      visibility: { projectId, epoch, membershipRevision },
      created: true,
    }
  }

  async reviseDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: ReviseProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const project = projectKey(scope, projectId)
    const current = this.#visibility.get(project) ?? {
      projectId,
      epoch: '0',
      membershipRevision: '0',
    }
    const existing = await this.getMembership(scope, projectId, input.documentId, ctx)
    if (existing === undefined) {
      throw new DocumentSearchError(
        'INDEX_NOT_FOUND',
        `document ${input.documentId} is not a member of project ${projectId}`,
      )
    }
    if (existing.state !== 'active') {
      throw new DocumentSearchError(
        'INVALID_ARGUMENT',
        `document ${input.documentId} is already ${existing.state} and cannot be revised again`,
      )
    }
    if (input.op === 'replace' && input.replacement === undefined) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'a replace revision requires a replacement document')
    }
    if (input.op === 'retract' && input.replacement !== undefined) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'a retract revision must not carry a replacement document')
    }

    const epoch = nextRevision(current.epoch)
    const membershipRevision = nextRevision(current.membershipRevision)
    const replacementId = input.replacement?.documentId
    const revised: ProjectDocumentMembership = {
      ...existing,
      state: input.op === 'retract' ? 'retracted' : 'replaced',
      membershipRevision,
      visibilityEpoch: epoch,
      ...(replacementId === undefined ? {} : { replacedBy: replacementId }),
      reason: input.reason,
      recordedAt: input.recordedAt,
    }
    this.#appendMembership(project, input.documentId, revised)

    if (input.replacement !== undefined) {
      const replacement: ProjectDocumentMembership = {
        projectId,
        documentId: input.replacement.documentId,
        state: 'active',
        membershipRevision,
        documentRef: clone(input.replacement.documentRef),
        documentDigest: input.replacement.documentDigest,
        parseId: input.replacement.parseId,
        parseRef: clone(input.replacement.parseRef),
        textDigest: input.replacement.textDigest,
        precision: input.replacement.precision,
        ...(input.replacement.sourceRef === undefined
          ? {}
          : { sourceRef: clone(input.replacement.sourceRef) }),
        visibilityEpoch: epoch,
        reason: input.reason,
        recordedAt: input.recordedAt,
      }
      assertProjectDocumentMembershipShape(replacement)
      this.#appendMembership(project, input.replacement.documentId, replacement)
    }

    this.#visibility.set(project, { projectId, epoch, membershipRevision })
    return {
      membership: clone(revised),
      visibility: { projectId, epoch, membershipRevision },
      created: true,
    }
  }

  async getVisibility(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectVisibility | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const found = this.#visibility.get(projectKey(scope, projectId))
    return found === undefined ? undefined : clone(found)
  }

  async getMembership(
    scopeRef: ScopeRef,
    projectId: Uuid,
    documentId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectDocumentMembership | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const revisions = this.#memberships.get(documentKey(scope, projectId, documentId))
    const latest = revisions?.at(-1)
    return latest === undefined ? undefined : clone(latest)
  }

  async listDocuments(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: ListProjectDocumentsFilter,
    ctx: ToolContext,
  ): Promise<ProjectDocumentPage> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
    const offset = filter.cursor === undefined ? 0 : decodeCursor(filter.cursor)
    const prefix = `${projectKey(scope, projectId)}\u0000`
    const current: ProjectDocumentMembership[] = []
    for (const [key, revisions] of this.#memberships) {
      if (!key.startsWith(prefix)) continue
      const latest = revisions.at(-1)
      if (latest === undefined) continue
      if (filter.state !== undefined && latest.state !== filter.state) continue
      current.push(latest)
    }
    current.sort((left, right) => (left.documentId < right.documentId ? -1 : left.documentId > right.documentId ? 1 : 0))
    const page = current.slice(offset, offset + limit)
    const more = offset + page.length < current.length
    return {
      memberships: page.map(clone),
      nextCursor: more ? encodeCursor(offset + page.length) : null,
    }
  }

  async recordIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RecordProjectIndexReceiptInput,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceiptWriteResult> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const project = projectKey(scope, projectId)
    const visibility = this.#visibility.get(project)
    const currentEpoch = visibility?.epoch ?? '0'
    const receipt: ProjectIndexReceipt = {
      projectId,
      collectionRef: input.collectionRef,
      generation: input.generation,
      visibilityEpoch: input.visibilityEpoch,
      membershipRevision: input.membershipRevision,
      targetDigest: input.targetDigest,
      indexRef: clone(input.indexRef),
      documentCount: input.documentCount,
      sourceDocumentCount: input.sourceDocumentCount,
      completeness: input.completeness,
      recordedAt: input.recordedAt,
    }
    if (input.visibilityEpoch !== currentEpoch) {
      // The epoch advanced after the build started: refuse to activate.
      return { receipt, activated: false }
    }
    this.#receipts.set(receiptKey(project, input.collectionRef, input.generation), receipt)
    return { receipt: clone(receipt), activated: true }
  }

  async getIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceipt | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const project = projectKey(scope, projectId)
    for (const [key, receipt] of this.#receipts) {
      if (key.startsWith(`${project}\u0000`) && receipt.generation === generation) {
        return clone(receipt)
      }
    }
    return undefined
  }

  #appendMembership(
    projectKeyValue: string,
    documentId: Uuid,
    membership: ProjectDocumentMembership,
  ): void {
    const key = `${projectKeyValue}\u0000${documentId}`
    const revisions = this.#memberships.get(key) ?? []
    revisions.push(clone(membership))
    this.#memberships.set(key, revisions)
  }

  /** Test helper: the current (highest-revision) membership for a document. */
  currentMemberships(scope: ScopeRef, projectId: Uuid): ProjectDocumentMembership[] {
    const prefix = `${projectKey(scope, projectId)}\u0000`
    const out: ProjectDocumentMembership[] = []
    for (const [key, revisions] of this.#memberships) {
      if (!key.startsWith(prefix)) continue
      const latest = revisions.at(-1)
      if (latest !== undefined) out.push(clone(latest))
    }
    return out
  }

  async close(): Promise<void> {
    this.#visibility.clear()
    this.#memberships.clear()
    this.#receipts.clear()
  }
}
