import {
  EMPTY_JOB_COUNTS,
  IndustryWorkspaceStoreError,
  JobStoreError,
  assertIndustryWorkspaceShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AssetDraftCandidateRef,
  AssetDraftVersion,
  IndustryWorkspace,
  IndustryWorkspaceBoundary,
  IndustryWorkspaceListFilter,
  IndustryWorkspacePatch,
  IndustryWorkspaceStore,
  IndustryWorkspaceWriteResult,
  JobStore,
  NewLogicalJobRecord,
  NewOutboxMessage,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { IndustryWorkspaceError } from './errors'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']

/**
 * The outbox topics this surface emits. The workspace create/append itself is the durable
 * state change; the message lets a future generation/materialisation consumer pick the
 * revision up without a second state table.
 */
export const INDUSTRY_WORKSPACE_CREATED_TOPIC = 'asset.workspace.created'
export const INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC = 'asset.draft.appended'

/**
 * The anchor job every workspace write attaches its transactional outbox row to.
 *
 * The draft store writes the outbox inside the same control transaction as the workspace
 * state change, and `job_outbox.job_id` is a foreign key into `jobs`. Workspace generation
 * is not implemented on this card, so one idempotent anchor job per scope carries the
 * outbox rows until the generation pipeline registers its own job kind; it is content-keyed
 * and therefore shared, not a new job per request.
 */
const ANCHOR_SOURCE_REF = 'industry-workspace-anchor'
const ANCHOR_DOCUMENT_REF = 'industry-workspace-anchor'
const ANCHOR_PIPELINE_VERSION = '1.0.0'
const ANCHOR_IDEMPOTENCY_KEY = 'industry-workspace-anchor'
const FIRST_REVISION: RevisionString = '1'

export interface IndustryWorkspaceServiceDependencies {
  readonly store: IndustryWorkspaceStore
  /** Used only to anchor the transactional outbox FK; no workspace job is executed here. */
  readonly jobs: JobStore
  readonly newId?: () => string
  readonly now?: () => string
}

export interface CreateIndustryWorkspaceInput {
  readonly namespace: string
  readonly displayName: string
  readonly boundary: IndustryWorkspaceBoundary
  /** The immutable source set the first draft was captured from. */
  readonly documentSetRef: ResourceRef
}

/** A workspace metadata edit (PATCH): only the display name and boundary are editable. */
export interface EditIndustryWorkspaceInput {
  /** `undefined` means the If-Match header was absent; the call is rejected with 428. */
  readonly expectedRevision: RevisionString | undefined
  readonly displayName?: string
  readonly boundary?: IndustryWorkspaceBoundary
  readonly reason: string
}

/**
 * One immutable draft operation. `edit` appends a new draft revision that fixes the edited
 * sources/candidates and (optionally) the workspace boundary; the previous revision is
 * never mutated and an earlier candidate approval cannot be carried onto the new revision.
 */
export interface DraftOperationInput {
  readonly operation: 'edit'
  readonly expectedRevision: RevisionString | undefined
  readonly reason: string
  readonly displayName?: string
  readonly boundary?: IndustryWorkspaceBoundary
  readonly documentSetRef?: ResourceRef
  readonly candidateRefs?: readonly AssetDraftCandidateRef[]
  readonly basePackRef?: VersionRef
  readonly syntheticExampleSetRef?: ResourceRef
  readonly validationRef?: ResourceRef
}

/** The new head after an edit, with the localised field list that changed. */
export interface IndustryWorkspaceEditView extends IndustryWorkspaceWriteResult {
  readonly changes: readonly string[]
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new IndustryWorkspaceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IndustryWorkspaceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new IndustryWorkspaceError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may manage industry workspaces',
  )
}

function requireRevision(revision: RevisionString | undefined): RevisionString {
  if (revision === undefined) {
    throw new IndustryWorkspaceError(
      'REVISION_REQUIRED',
      'an If-Match revision is required to edit a workspace',
    )
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new IndustryWorkspaceError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

/** Convert a store/job failure into a classified domain failure (never a raw 500). */
function mapStoreError(error: unknown): never {
  if (error instanceof IndustryWorkspaceStoreError) {
    switch (error.code) {
      case 'SCOPE_MISMATCH':
        throw new IndustryWorkspaceError('SCOPE_MISMATCH', error.message, { cause: error })
      case 'WORKSPACE_NOT_FOUND':
        throw new IndustryWorkspaceError('WORKSPACE_NOT_FOUND', error.message, { cause: error })
      case 'DRAFT_NOT_FOUND':
        throw new IndustryWorkspaceError('DRAFT_NOT_FOUND', error.message, { cause: error })
      case 'VERSION_CONFLICT':
        throw new IndustryWorkspaceError('VERSION_CONFLICT', error.message, { cause: error })
      case 'IDEMPOTENCY_CONFLICT':
        throw new IndustryWorkspaceError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
      case 'DRAFT_REVISION_INVALID':
      case 'INVALID_WORKSPACE':
      case 'INVALID_DRAFT':
        throw new IndustryWorkspaceError('INVALID_ARGUMENT', error.message, { cause: error })
    }
  }
  if (error instanceof JobStoreError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      throw new IndustryWorkspaceError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
    }
    throw new IndustryWorkspaceError('INVALID_ARGUMENT', error.message, { cause: error })
  }
  throw error
}

function sortedCandidateRefs(refs: readonly AssetDraftCandidateRef[]): AssetDraftCandidateRef[] {
  return [...refs].sort((left, right) =>
    left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0,
  )
}

/** Content digest of one immutable draft revision, excluding the digest field itself. */
function draftDigest(draft: Omit<AssetDraftVersion, 'digest'>): Sha256Digest {
  return sha256DigestOf(
    canonicalJson({
      workspaceId: draft.workspaceId,
      revision: draft.revision,
      basePackRef: draft.basePackRef ?? null,
      documentSetRef: draft.documentSetRef,
      candidateRefs: sortedCandidateRefs(draft.candidateRefs),
      syntheticExampleSetRef: draft.syntheticExampleSetRef ?? null,
      validationRef: draft.validationRef ?? null,
    }),
  )
}

function changesOf(
  before: IndustryWorkspace,
  after: IndustryWorkspace,
  previousDraft: AssetDraftVersion,
  nextDraft: AssetDraftVersion,
): string[] {
  const changes: string[] = []
  if (before.displayName !== after.displayName) changes.push('displayName')
  if (canonicalJson(before.boundary) !== canonicalJson(after.boundary)) changes.push('boundary')
  if (canonicalJson(previousDraft.documentSetRef) !== canonicalJson(nextDraft.documentSetRef)) {
    changes.push('documentSetRef')
  }
  if (
    canonicalJson(sortedCandidateRefs(previousDraft.candidateRefs)) !==
    canonicalJson(sortedCandidateRefs(nextDraft.candidateRefs))
  ) {
    changes.push('candidateRefs')
  }
  return changes
}

/**
 * The industry-workspace management service (SPEC v0.3a §3.1/§8.1).
 *
 * It owns draft-revision identity, digesting and the compare-and-swap edit semantics on top
 * of the injected `IndustryWorkspaceStore`. Every write requires a trusted editor context and
 * an idempotency key; every edit reads the current head, appends one immutable draft revision
 * and lets the store's `FOR UPDATE` CAS decide the winner. It never sets the workspace
 * `state`, so a model or an ordinary project user cannot publish a definition through it.
 */
export class IndustryWorkspaceService {
  readonly #store: IndustryWorkspaceStore
  readonly #jobs: JobStore
  readonly #newId: () => string
  readonly #now: () => string

  constructor(dependencies: IndustryWorkspaceServiceDependencies) {
    this.#store = dependencies.store
    this.#jobs = dependencies.jobs
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async createWorkspace(
    input: CreateIndustryWorkspaceInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)

    const recordedAt = this.#now()
    const workspaceId = this.#newId()
    const workspace: IndustryWorkspace = {
      workspaceId,
      namespace: input.namespace,
      displayName: input.displayName,
      boundary: input.boundary,
      headRevision: FIRST_REVISION,
      state: 'draft',
    }
    this.#assertWorkspace(workspace)
    const draft = this.#buildDraft(workspaceId, FIRST_REVISION, {
      documentSetRef: input.documentSetRef,
    })
    const requestDigest = sha256DigestOf(
      canonicalJson({
        namespace: input.namespace,
        displayName: input.displayName,
        boundary: input.boundary,
        documentSetRef: input.documentSetRef,
      }),
    )
    const outboxJobId = await this.#ensureAnchorJob(scopeRef, ctx, recordedAt)
    const outbox = this.#outbox(
      INDUSTRY_WORKSPACE_CREATED_TOPIC,
      { workspaceId, revision: FIRST_REVISION },
      `ws-created-${workspaceId}-${FIRST_REVISION}`,
      recordedAt,
    )
    return this.#store
      .createWorkspace(
        {
          workspace,
          firstDraft: draft,
          idempotencyKey,
          requestDigest,
          actor,
          recordedAt,
          outbox,
          outboxJobId,
        },
        scopeRef,
        ctx,
      )
      .catch(mapStoreError)
  }

  async getWorkspace(workspaceId: Uuid, ctx: ToolContext): Promise<IndustryWorkspace> {
    const scopeRef = scopeOf(ctx)
    return this.#requireWorkspace(scopeRef, workspaceId, ctx)
  }

  async listWorkspaces(
    filter: IndustryWorkspaceListFilter,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace[]> {
    const scopeRef = scopeOf(ctx)
    return this.#store.listWorkspaces(scopeRef, filter, ctx).catch(mapStoreError)
  }

  async listDrafts(workspaceId: Uuid, ctx: ToolContext): Promise<AssetDraftVersion[]> {
    const scopeRef = scopeOf(ctx)
    await this.#requireWorkspace(scopeRef, workspaceId, ctx)
    return this.#store.listDrafts(scopeRef, workspaceId, ctx).catch(mapStoreError)
  }

  async getDraft(
    workspaceId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion> {
    const scopeRef = scopeOf(ctx)
    const draft = await this.#store.getDraft(scopeRef, workspaceId, revision, ctx).catch(mapStoreError)
    if (draft === undefined) {
      throw new IndustryWorkspaceError(
        'DRAFT_NOT_FOUND',
        `draft revision ${revision} is not visible in this scope`,
      )
    }
    return draft
  }

  /** `PATCH /industry-workspaces/:id`: edit the boundary/name and append a draft revision. */
  async editWorkspace(
    workspaceId: Uuid,
    input: EditIndustryWorkspaceInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceEditView> {
    return this.#applyEdit(
      workspaceId,
      {
        operation: 'edit',
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.boundary === undefined ? {} : { boundary: input.boundary }),
      },
      idempotencyKey,
      actor,
      ctx,
    )
  }

  /** `POST /industry-workspaces/:id/draft-operations`: append one immutable draft revision. */
  async draftOperation(
    workspaceId: Uuid,
    input: DraftOperationInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceEditView> {
    if (input.operation !== 'edit') {
      throw new IndustryWorkspaceError('INVALID_ARGUMENT', "operation must be 'edit'")
    }
    return this.#applyEdit(workspaceId, input, idempotencyKey, actor, ctx)
  }

  async #applyEdit(
    workspaceId: Uuid,
    input: DraftOperationInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceEditView> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    const expectedRevision = requireRevision(input.expectedRevision)
    if (input.reason.trim().length === 0) {
      throw new IndustryWorkspaceError('INVALID_ARGUMENT', 'reason must be a non-empty string')
    }

    const current = await this.#requireWorkspace(scopeRef, workspaceId, ctx)
    const patch: IndustryWorkspacePatch = {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.boundary === undefined ? {} : { boundary: input.boundary }),
    }
    const nextRevision = (BigInt(current.headRevision) + 1n).toString()
    this.#assertWorkspace({
      ...current,
      displayName: input.displayName ?? current.displayName,
      boundary: input.boundary ?? current.boundary,
      headRevision: nextRevision,
    })

    const previous = await this.#latestDraft(scopeRef, workspaceId, ctx)
    const basePackRef = input.basePackRef ?? previous.basePackRef
    const syntheticExampleSetRef = input.syntheticExampleSetRef ?? previous.syntheticExampleSetRef
    const validationRef = input.validationRef ?? previous.validationRef
    const draft = this.#buildDraft(workspaceId, nextRevision, {
      documentSetRef: input.documentSetRef ?? previous.documentSetRef,
      candidateRefs: input.candidateRefs ?? previous.candidateRefs,
      ...(basePackRef === undefined ? {} : { basePackRef }),
      ...(syntheticExampleSetRef === undefined ? {} : { syntheticExampleSetRef }),
      ...(validationRef === undefined ? {} : { validationRef }),
    })

    const recordedAt = this.#now()
    // The digest is derived from the *request* only, so replaying the same Idempotency-Key
    // after the head advanced still matches the stored row instead of a false conflict.
    const requestDigest = sha256DigestOf(
      canonicalJson({
        workspaceId,
        expectedRevision,
        reason: input.reason,
        displayName: input.displayName ?? null,
        boundary: input.boundary ?? null,
        documentSetRef: input.documentSetRef ?? null,
        candidateRefs: input.candidateRefs ?? null,
        basePackRef: input.basePackRef ?? null,
        syntheticExampleSetRef: input.syntheticExampleSetRef ?? null,
        validationRef: input.validationRef ?? null,
      }),
    )
    const outboxJobId = await this.#ensureAnchorJob(scopeRef, ctx, recordedAt)
    const outbox = this.#outbox(
      INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC,
      { workspaceId, revision: nextRevision, reason: input.reason },
      `ws-appended-${workspaceId}-${nextRevision}`,
      recordedAt,
    )

    try {
      const result = await this.#store.appendDraft(
        scopeRef,
        workspaceId,
        {
          expectedRevision,
          draft,
          idempotencyKey,
          requestDigest,
          actor,
          recordedAt,
          outbox,
          outboxJobId,
          ...(Object.keys(patch).length === 0 ? {} : { workspacePatch: patch }),
        },
        ctx,
      )
      return { ...result, changes: changesOf(current, result.workspace, previous, result.draft) }
    } catch (error) {
      if (error instanceof IndustryWorkspaceStoreError && error.code === 'VERSION_CONFLICT') {
        const latest = await this.#store.getWorkspace(scopeRef, workspaceId, ctx).catch(() => undefined)
        throw new IndustryWorkspaceError('VERSION_CONFLICT', error.message, {
          cause: error,
          reasons: [
            `expectedRevision=${expectedRevision}`,
            `currentRevision=${latest?.headRevision ?? 'unknown'}`,
          ],
        })
      }
      mapStoreError(error)
    }
  }

  #assertWorkspace(workspace: IndustryWorkspace): void {
    try {
      assertIndustryWorkspaceShape(workspace)
    } catch (error) {
      if (error instanceof IndustryWorkspaceStoreError) {
        throw new IndustryWorkspaceError('INVALID_ARGUMENT', error.message, { cause: error })
      }
      throw error
    }
  }

  async #requireWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace> {
    const workspace = await this.#store.getWorkspace(scopeRef, workspaceId, ctx).catch(mapStoreError)
    if (workspace === undefined) {
      throw new IndustryWorkspaceError(
        'WORKSPACE_NOT_FOUND',
        `workspace ${workspaceId} is not visible in this scope`,
      )
    }
    return workspace
  }

  async #latestDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion> {
    const drafts = await this.#store.listDrafts(scopeRef, workspaceId, ctx).catch(mapStoreError)
    const latest = drafts[drafts.length - 1]
    if (latest === undefined) {
      throw new IndustryWorkspaceError(
        'DRAFT_NOT_FOUND',
        `workspace ${workspaceId} has no draft revision to edit`,
      )
    }
    return latest
  }

  #buildDraft(
    workspaceId: Uuid,
    revision: RevisionString,
    fields: {
      readonly documentSetRef: ResourceRef
      readonly candidateRefs?: readonly AssetDraftCandidateRef[]
      readonly basePackRef?: VersionRef
      readonly syntheticExampleSetRef?: ResourceRef
      readonly validationRef?: ResourceRef
    },
  ): AssetDraftVersion {
    const content = {
      workspaceId,
      revision,
      documentSetRef: fields.documentSetRef,
      candidateRefs: sortedCandidateRefs(fields.candidateRefs ?? []),
      ...(fields.basePackRef === undefined ? {} : { basePackRef: fields.basePackRef }),
      ...(fields.syntheticExampleSetRef === undefined
        ? {}
        : { syntheticExampleSetRef: fields.syntheticExampleSetRef }),
      ...(fields.validationRef === undefined ? {} : { validationRef: fields.validationRef }),
    }
    return { ...content, digest: draftDigest(content) }
  }

  async #ensureAnchorJob(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    createdAt: Rfc3339UtcTimestamp,
  ): Promise<Uuid> {
    const inputDigest = sha256DigestOf(
      canonicalJson({
        kind: 'ingestion',
        sourceRef: ANCHOR_SOURCE_REF,
        documentRef: ANCHOR_DOCUMENT_REF,
        datasetRef: null,
        pipelineVersion: ANCHOR_PIPELINE_VERSION,
      }),
    )
    const record: NewLogicalJobRecord = {
      jobId: this.#newId(),
      kind: 'ingestion',
      sourceRef: ANCHOR_SOURCE_REF,
      documentRef: ANCHOR_DOCUMENT_REF,
      pipelineVersion: ANCHOR_PIPELINE_VERSION,
      idempotencyKey: ANCHOR_IDEMPOTENCY_KEY,
      inputDigest,
      counts: EMPTY_JOB_COUNTS,
      createdAt,
      createdBy: ctx.principal.subjectId,
    }
    const result = await this.#jobs.insertJob(scopeRef, record, ctx).catch(mapStoreError)
    return result.job.jobId
  }

  #outbox(
    topic: string,
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    recordedAt: Rfc3339UtcTimestamp,
  ): NewOutboxMessage {
    return {
      outboxId: this.#newId(),
      topic,
      payload,
      idempotencyKey,
      availableAt: recordedAt,
      createdAt: recordedAt,
    }
  }
}
