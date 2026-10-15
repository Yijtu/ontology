import {
  EMPTY_JOB_COUNTS,
  SourceAdmissionError,
  assertSourceAdmissionCommandShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  CandidateSourceStore,
  GroundingDocumentSetReaderPort,
  GroundingDocumentSetWriterPort,
  GroundingSourceApproval,
  IndustryWorkspaceStore,
  JobStore,
  NewLogicalJobRecord,
  NewOutboxMessage,
  RevisionString,
  ScopeRef,
  SourceAdmission,
  SourceAdmissionCommand,
  SourceAdmissionContentPort,
  SourceAdmissionParserPort,
  SourceAdmissionReceipt,
  SourceAdmissionStore,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { buildAssetDraft, nextDraftRevision, readLatestWorkspaceDraft } from '../workspace-draft'
import { SourceGroundingBudget } from './budget'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']

/** Transactional-outbox anchor job shared by source admission (mirrors the workspace edit path). */
const ADMISSION_ANCHOR_SOURCE_REF = 'workspace-source-admission-anchor'
const ADMISSION_ANCHOR_DOCUMENT_REF = 'workspace-source-admission-anchor'
const ADMISSION_ANCHOR_PIPELINE_VERSION = '1.0.0'
const ADMISSION_ANCHOR_IDEMPOTENCY_KEY = 'workspace-source-admission-anchor'

export interface WorkspaceSourceAdmissionDependencies {
  readonly sources: CandidateSourceStore
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace' | 'getDraft' | 'getLatestDraft' | 'listDrafts'>
  readonly documentSets: GroundingDocumentSetReaderPort
  readonly content: SourceAdmissionContentPort
  readonly parser: SourceAdmissionParserPort
  readonly writer: GroundingDocumentSetWriterPort
  readonly admissions: SourceAdmissionStore
  readonly jobs: JobStore
  readonly newId?: () => string
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new SourceAdmissionError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Admits a *reviewed* candidate source into the workspace modelling corpus, in the fixed order of
 * design §2.2: verify ownership / reviewed revision / target draft, read the pinned snapshot and
 * verify bytes/digest/format/parse coverage, build a readable document/parse binding, publish a new
 * immutable `GroundingDocumentSet` that carries the reviewed tier explicitly, then append the
 * admission record and the new draft under one control transaction that re-checks the source
 * revision and the workspace CAS. A failure before the transaction leaves the source in the
 * recoverable "reviewed, not yet admitted" state.
 */
export class WorkspaceSourceAdmissionService {
  readonly #dependencies: WorkspaceSourceAdmissionDependencies
  readonly #newId: () => string
  readonly #now: () => string

  constructor(dependencies: WorkspaceSourceAdmissionDependencies) {
    this.#dependencies = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async admit(command: SourceAdmissionCommand, ctx: ToolContext): Promise<SourceAdmissionReceipt> {
    const scope = scopeOf(ctx)
    this.#assertEditor(ctx)
    assertSourceAdmissionCommandShape(command)

    // ① Read and verify the source's ownership, current review version and the target draft.
    const source = await this.#dependencies.sources.getSource(scope, command.sourceId, ctx)
    if (source === undefined) throw new SourceAdmissionError('NOT_FOUND', `candidate source ${command.sourceId} is not visible in this scope`)
    if (source.workspaceId !== command.workspaceId) {
      throw new SourceAdmissionError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    }
    if (source.reviewState !== 'approved') {
      throw new SourceAdmissionError('NOT_APPROVED', 'only an approved candidate source may be admitted')
    }
    if (source.retractedAt !== undefined) {
      throw new SourceAdmissionError('SOURCE_RETRACTED', 'the candidate source was retracted and cannot be admitted')
    }
    if (source.revision !== command.expectedSourceRevision) {
      throw new SourceAdmissionError('VERSION_CONFLICT', `candidate source head is ${source.revision}, not the expected ${command.expectedSourceRevision}`)
    }
    const workspace = await this.#dependencies.workspaces.getWorkspace(scope, command.workspaceId, ctx)
    if (workspace === undefined || workspace.state === 'archived') {
      throw new SourceAdmissionError('NOT_FOUND', 'the target workspace is not visible or active')
    }
    if (workspace.headRevision !== command.expectedWorkspaceRevision) {
      throw new SourceAdmissionError('VERSION_CONFLICT', `workspace head is ${workspace.headRevision}, not the expected ${command.expectedWorkspaceRevision}`)
    }
    const draft = await readLatestWorkspaceDraft(this.#dependencies.workspaces, scope, command.workspaceId, ctx)
    if (draft === undefined) throw new SourceAdmissionError('NOT_FOUND', 'the target workspace has no pinned document set')

    // Replay short-circuit: one admission per reviewed source version, recognised by its key.
    const existing = await this.#dependencies.admissions.findAdmissionBySource(scope, command.workspaceId, command.sourceId, ctx)
    if (existing !== undefined && existing.sourceRevision === command.expectedSourceRevision) {
      if (existing.idempotencyKey === command.idempotencyKey) return this.#receipt(existing, true)
      throw new SourceAdmissionError('ALREADY_ADMITTED', `source revision ${command.expectedSourceRevision} was already admitted under another key`)
    }

    // ② Authorized snapshot readback, verifying bytes/digest/format.
    const snapshot = await this.#dependencies.content.readPinned(scope,
      { contentRef: source.contentRef, contentDigest: source.contentDigest }, ctx)
    if (snapshot.bytes.byteLength === 0) throw new SourceAdmissionError('EMPTY_SOURCE', 'the pinned snapshot has no bytes')

    // ③ Build a readable logical document/parse binding (never an arbitrary artifact).
    const binding = await this.#dependencies.parser.bind({
      workspaceId: command.workspaceId,
      sourceId: command.sourceId,
      contentRef: source.contentRef,
      mediaType: snapshot.mediaType,
      byteSize: snapshot.byteSize,
      bytes: snapshot.bytes,
      ...(command.parseOptions === undefined ? {} : { parseOptions: command.parseOptions }),
    }, ctx)
    if (binding.coverage !== 'complete') {
      throw new SourceAdmissionError('PARSE_NOT_COMPLETE', 'the source must parse completely before it can be admitted')
    }
    if (binding.sourceRef.kind !== 'document') {
      throw new SourceAdmissionError('UNSUPPORTED_MEDIA_TYPE', 'a source admission requires a readable document binding')
    }

    // ④ Create a new immutable document set carrying the reviewed tier explicitly.
    const budget = new SourceGroundingBudget(new AbortController().signal)
    const currentSet = await this.#dependencies.documentSets.read(scope, draft.documentSetRef, ctx, budget)
    if (currentSet.workspaceId !== command.workspaceId
      || currentSet.scopeRef.tenantId !== scope.tenantId || currentSet.scopeRef.spaceId !== scope.spaceId) {
      throw new SourceAdmissionError('SCOPE_MISMATCH', 'the workspace document set does not belong to the trusted scope')
    }
    const approval: GroundingSourceApproval = {
      sourceRef: binding.sourceRef,
      state: 'approved',
      kind: binding.kind,
      parserVersion: binding.parserVersion,
      parseId: binding.parseId,
      // Explicit tier: a new write path must never promote an unconfirmed source by default.
      trustTier: source.trustTier,
      ...(binding.tableOptions === undefined ? {} : { tableOptions: binding.tableOptions }),
    }
    const nextSources = [...currentSet.sources.filter((row) => row.sourceRef.id !== binding.sourceRef.id), approval]
    const nextSet = { ...currentSet, sources: nextSources }
    const documentSetRef = await this.#dependencies.writer.publish(scope, nextSet, ctx)

    // ⑤ Append the admission record and the new draft under one control transaction.
    const recordedAt = this.#now()
    const nextDraft = buildAssetDraft(command.workspaceId, nextDraftRevision(workspace.headRevision), {
      documentSetRef,
      candidateRefs: draft.candidateRefs,
      ...(draft.basePackRef === undefined ? {} : { basePackRef: draft.basePackRef }),
      ...(draft.syntheticExampleSetRef === undefined ? {} : { syntheticExampleSetRef: draft.syntheticExampleSetRef }),
      ...(draft.validationRef === undefined ? {} : { validationRef: draft.validationRef }),
    })
    const admission: SourceAdmission = {
      schemaVersion: 'source-admission@1',
      admissionId: this.#newId(),
      workspaceId: command.workspaceId,
      sourceId: command.sourceId,
      sourceRevision: source.revision,
      trustTier: source.trustTier,
      sourceRef: binding.sourceRef,
      parseId: binding.parseId,
      parserVersion: binding.parserVersion,
      kind: binding.kind,
      ...(binding.tableOptions === undefined ? {} : { tableOptions: binding.tableOptions }),
      documentSetRef,
      draftRevision: nextDraft.revision,
      draftDigest: nextDraft.digest,
      admittedBy: ctx.principal.subjectId,
      admittedAt: recordedAt,
      idempotencyKey: command.idempotencyKey,
    }
    const requestDigest = sha256DigestOf(canonicalJson({
      workspaceId: command.workspaceId, sourceId: command.sourceId,
      expectedSourceRevision: command.expectedSourceRevision,
      expectedWorkspaceRevision: command.expectedWorkspaceRevision,
      parseOptions: command.parseOptions ?? null,
    }))
    const outboxJobId = await this.#ensureAnchorJob(scope, ctx, recordedAt)
    const result = await this.#dependencies.admissions.admitSource(scope, {
      admission,
      expectedSourceRevision: command.expectedSourceRevision,
      expectedWorkspaceRevision: command.expectedWorkspaceRevision,
      append: {
        expectedRevision: command.expectedWorkspaceRevision,
        draft: nextDraft,
        idempotencyKey: command.idempotencyKey,
        requestDigest,
        actor: ctx.principal.subjectId,
        recordedAt,
        outbox: this.#outbox(command.workspaceId, source.sourceId, nextDraft.revision, recordedAt),
        outboxJobId,
      },
      requestDigest,
    }, ctx)
    return this.#receipt(result.admission, !result.created)
  }

  async listAdmissions(workspaceId: Uuid, page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext): Promise<{ readonly admissions: readonly SourceAdmission[]; readonly nextCursor?: string }> {
    const scope = scopeOf(ctx)
    if (!isUuid(workspaceId)) throw new SourceAdmissionError('INVALID_REQUEST', 'workspaceId must be a UUID')
    return this.#dependencies.admissions.listAdmissions(scope, workspaceId, page, ctx)
  }

  #receipt(admission: SourceAdmission, replayed: boolean): SourceAdmissionReceipt {
    return {
      admissionId: admission.admissionId,
      workspaceId: admission.workspaceId,
      sourceId: admission.sourceId,
      sourceRevision: admission.sourceRevision,
      trustTier: admission.trustTier,
      documentSetRef: admission.documentSetRef,
      draftRevision: admission.draftRevision,
      draftDigest: admission.draftDigest,
      replayed,
    }
  }

  #assertEditor(ctx: ToolContext): void {
    if (ctx.principal.roles.some((role) => EDITOR_ROLES.includes(role))) return
    throw new SourceAdmissionError('FORBIDDEN', 'admitting a source requires an editor or platform-admin role')
  }

  #outbox(workspaceId: Uuid, sourceId: Uuid, revision: RevisionString, recordedAt: string): NewOutboxMessage {
    return {
      outboxId: this.#newId(),
      topic: 'asset.draft.appended',
      payload: { workspaceId, revision, reason: `source-admission:${sourceId}` },
      idempotencyKey: `source-admission-${sourceId}-${revision}`,
      availableAt: recordedAt,
      createdAt: recordedAt,
    }
  }

  async #ensureAnchorJob(scope: ScopeRef, ctx: ToolContext, createdAt: string): Promise<Uuid> {
    const inputDigest = sha256DigestOf(canonicalJson({
      kind: 'ingestion',
      sourceRef: ADMISSION_ANCHOR_SOURCE_REF,
      documentRef: ADMISSION_ANCHOR_DOCUMENT_REF,
      pipelineVersion: ADMISSION_ANCHOR_PIPELINE_VERSION,
    }))
    const record: NewLogicalJobRecord = {
      jobId: this.#newId(),
      kind: 'ingestion',
      sourceRef: ADMISSION_ANCHOR_SOURCE_REF,
      documentRef: ADMISSION_ANCHOR_DOCUMENT_REF,
      pipelineVersion: ADMISSION_ANCHOR_PIPELINE_VERSION,
      idempotencyKey: ADMISSION_ANCHOR_IDEMPOTENCY_KEY,
      inputDigest,
      counts: EMPTY_JOB_COUNTS,
      createdAt,
      createdBy: ctx.principal.subjectId,
    }
    const result = await this.#dependencies.jobs.insertJob(scope, record, ctx)
    return result.job.jobId
  }
}
