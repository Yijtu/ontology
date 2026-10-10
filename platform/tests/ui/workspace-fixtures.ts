import { randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { IndustryWorkspaceService, InMemoryJobStore, JobService } from '@ontology/application'
import {
  IndustryWorkspaceStoreError,
  assertAssetDraftVersionShape,
  assertIndustryWorkspaceShape,
  createToolContext,
  isToolContext,
} from '@ontology/contracts'
import type {
  AppendAssetDraftInput,
  AssetDraftVersion,
  CreateIndustryWorkspaceInput,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IndustryWorkspaceWriteResult,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'

/**
 * Test-only in-memory `IndustryWorkspaceStore` plus a real Fastify harness for the ontology
 * workspace home. It enforces the same scope/CAS/idempotency rules as the PostgreSQL store so the
 * browser E2E drives real HTTP behaviour (create, refresh readback, If-Match conflict) rather than
 * a hand-written fake.
 */
export const WORKSPACE_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

export const WORKSPACE_ALL_ROLES =
  'platform-admin,profile-editor,data-editor,semantic-reviewer,business-user,scoped-reader'

type MutableWorkspace = { -readonly [Key in keyof IndustryWorkspace]: IndustryWorkspace[Key] }

interface WorkspaceEntry {
  workspace: MutableWorkspace
  drafts: AssetDraftVersion[]
}

interface IdempotencyEntry {
  readonly requestDigest: string
  readonly result: IndustryWorkspaceWriteResult
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function scopePrefix(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new IndustryWorkspaceStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IndustryWorkspaceStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new IndustryWorkspaceStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

export class InMemoryIndustryWorkspaceStore implements IndustryWorkspaceStore {
  readonly #workspaces = new Map<string, WorkspaceEntry>()
  readonly #idempotency = new Map<string, IdempotencyEntry>()

  applyPublicationCheckpoint(scope: ScopeRef, workspaceId: Uuid, checkpoint: AssetDraftVersion): void {
    const entry = this.#require(scope, workspaceId)
    assertAssetDraftVersionShape(checkpoint)
    if (checkpoint.workspaceId !== workspaceId || BigInt(checkpoint.revision) !== BigInt(entry.workspace.headRevision) + 1n || checkpoint.publicationCheckpoint?.sourceDraftRef.revision !== entry.workspace.headRevision) throw new Error('invalid physical publication checkpoint fixture')
    entry.drafts.push(clone(checkpoint))
    entry.workspace.headRevision = checkpoint.revision
  }

  async createWorkspace(
    input: CreateIndustryWorkspaceInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    resolveScope(scopeRef, ctx)
    const idempotencyKey = `${scopePrefix(scopeRef)}${input.idempotencyKey}`
    const existing = this.#idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new IndustryWorkspaceStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was used with a different payload')
      }
      return clone(existing.result)
    }
    assertIndustryWorkspaceShape(input.workspace)
    assertAssetDraftVersionShape(input.firstDraft)
    if (input.firstDraft.workspaceId !== input.workspace.workspaceId) {
      throw new IndustryWorkspaceStoreError('INVALID_DRAFT', 'the first draft must belong to the created workspace')
    }
    this.#workspaces.set(`${scopePrefix(scopeRef)}${input.workspace.workspaceId}`, {
      workspace: clone(input.workspace),
      drafts: [clone(input.firstDraft)],
    })
    const result: IndustryWorkspaceWriteResult = {
      workspace: clone(input.workspace),
      draft: clone(input.firstDraft),
      created: true,
    }
    this.#idempotency.set(idempotencyKey, { requestDigest: input.requestDigest, result: clone(result) })
    return result
  }

  async getWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace | undefined> {
    resolveScope(scopeRef, ctx)
    const entry = this.#workspaces.get(`${scopePrefix(scopeRef)}${workspaceId}`)
    return entry === undefined ? undefined : clone(entry.workspace)
  }

  async listWorkspaces(
    scopeRef: ScopeRef,
    filter: IndustryWorkspaceListFilter,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace[]> {
    resolveScope(scopeRef, ctx)
    const prefix = scopePrefix(scopeRef)
    const all = [...this.#workspaces.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => clone(entry.workspace))
      .filter((workspace) => filter.state === undefined || workspace.state === filter.state)
    return typeof filter.limit === 'number' ? all.slice(0, filter.limit) : all
  }

  async getDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    revision: string,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const entry = this.#require(scopeRef, workspaceId)
    const draft = entry.drafts.find((candidate) => candidate.revision === revision)
    return draft === undefined ? undefined : clone(draft)
  }

  async listDrafts(scopeRef: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<AssetDraftVersion[]> {
    resolveScope(scopeRef, ctx)
    const entry = this.#require(scopeRef, workspaceId)
    return [...entry.drafts]
      .sort((left, right) => (BigInt(left.revision) < BigInt(right.revision) ? -1 : 1))
      .map(clone)
  }

  async appendDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    input: AppendAssetDraftInput,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    resolveScope(scopeRef, ctx)
    const idempotencyKey = `${scopePrefix(scopeRef)}${input.idempotencyKey}`
    const existing = this.#idempotency.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new IndustryWorkspaceStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was used with a different payload')
      }
      return clone(existing.result)
    }
    const entry = this.#require(scopeRef, workspaceId)
    if (entry.workspace.headRevision !== input.expectedRevision) {
      throw new IndustryWorkspaceStoreError(
        'VERSION_CONFLICT',
        `workspace head is ${entry.workspace.headRevision}, not ${input.expectedRevision}`,
      )
    }
    assertAssetDraftVersionShape(input.draft)
    if (input.draft.workspaceId !== workspaceId) {
      throw new IndustryWorkspaceStoreError('INVALID_DRAFT', 'the draft must belong to the appended workspace')
    }
    const next = clone(entry.workspace)
    const patch = input.workspacePatch
    if (patch !== undefined) {
      if (patch.displayName !== undefined) next.displayName = patch.displayName
      if (patch.boundary !== undefined) next.boundary = clone(patch.boundary)
    }
    next.headRevision = input.draft.revision
    assertIndustryWorkspaceShape(next)
    entry.workspace = next
    entry.drafts.push(clone(input.draft))
    const result: IndustryWorkspaceWriteResult = {
      workspace: clone(next),
      draft: clone(input.draft),
      created: true,
    }
    this.#idempotency.set(idempotencyKey, { requestDigest: input.requestDigest, result: clone(result) })
    return result
  }

  #require(scopeRef: ScopeRef, workspaceId: Uuid): WorkspaceEntry {
    const entry = this.#workspaces.get(`${scopePrefix(scopeRef)}${workspaceId}`)
    if (entry === undefined) {
      throw new IndustryWorkspaceStoreError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} does not exist`)
    }
    return entry
  }
}

export function workspaceTrustedContext(roles: readonly string[], subjectId = 'e2e-owner'): ToolContext {
  return createToolContext({
    principal: {
      tenantId: WORKSPACE_SCOPE.tenantId,
      subjectId,
      roles: [...roles],
      scopes: [],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: '0.3.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: WORKSPACE_SCOPE.tenantId,
      spaceId: WORKSPACE_SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-workspace-fixture',
  })
}

/** Fixed-principal authenticator for the browser E2E harness (loopback only). */
export function workspaceAuthenticator(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: WORKSPACE_SCOPE.tenantId,
      subjectId: 'e2e-owner',
      roles: WORKSPACE_ALL_ROLES.split(','),
      scopes: [],
      authEpoch: 1,
    },
    spaceId: WORKSPACE_SCOPE.spaceId,
  }
}

export interface WorkspaceHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly jobStore: InMemoryJobStore
  /** Advance a real created job to a partly-failed stage so the UI can prove partial != success. */
  readonly seedPartialJob: (jobId: string) => Promise<void>
  readonly close: () => Promise<void>
}

export async function startWorkspaceHarness(): Promise<WorkspaceHarness> {
  const workspaceStore = new InMemoryIndustryWorkspaceStore()
  const jobStore = new InMemoryJobStore()
  const workspaceService = new IndustryWorkspaceService({
    store: workspaceStore,
    jobs: jobStore,
    newId: () => randomUUID(),
  })
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const app = createApiServer({
    authenticate: workspaceAuthenticator,
    jobs: { service: jobService },
    industryWorkspaces: { service: workspaceService },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the workspace API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const client = new WorkbenchClient({ baseUrl })
  const ctx = workspaceTrustedContext(['platform-admin', 'profile-editor', 'data-editor'])

  const seedPartialJob = async (jobId: string): Promise<void> => {
    const now = new Date().toISOString()
    const lease = await jobStore.acquireLease(
      WORKSPACE_SCOPE,
      { workerId: 'e2e-worker', now, leaseDurationMs: 60_000, jobId },
      ctx,
    )
    if (lease === undefined) throw new Error(`job ${jobId} was not claimable`)
    await jobStore.advanceStage(
      WORKSPACE_SCOPE,
      jobId,
      lease.attempt.attemptId,
      { stage: 'parsed', counts: { total: 10, processed: 7, failed: 3, skipped: 0 }, completedAt: now },
      ctx,
    )
    await jobStore.failAttempt(
      WORKSPACE_SCOPE,
      jobId,
      lease.attempt.attemptId,
      {
        error: { code: 'INVALID_SCHEMA', stage: 'parsed', message: '3 行无法解析', retryable: true, occurredAt: now },
        failedAt: now,
      },
      ctx,
    )
  }

  return {
    app,
    client,
    baseUrl,
    jobStore,
    seedPartialJob,
    close: async () => {
      await app.close()
    },
  }
}
