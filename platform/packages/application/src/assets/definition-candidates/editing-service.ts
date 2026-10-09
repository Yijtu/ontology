import {
  assertDefinitionCandidatePayloadShape,
} from '@ontology/contracts'
import type {
  AssetCandidateBatch,
  AssetCandidateBatchCounts,
  AssetCandidateState,
  AssetCandidateStore,
  AssetCandidateVersion,
  AssetDraftVersion,
  DefinitionAffectedDefinition,
  DefinitionCandidateConflict,
  DefinitionCandidatePayload,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionEditingResult,
  DefinitionEditingStore,
  DefinitionRevisionStrategy,
  DefinitionValidationFinding,
  DefinitionValidationReport,
  EditDefinitionCandidateInput,
  IndustryWorkspace,
  IndustryWorkspaceStore,
  KeepDefinitionsSeparateInput,
  MergeDefinitionCandidatesInput,
  ModelRef,
  RejectDefinitionCandidateInput,
  PublishedDefinitionVersionReader,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  SaveUnsupportedRuleInput,
  ScopeRef,
  SemanticDefinitionVersion,
  Sha256Digest,
  SplitDefinitionCandidateInput,
  ToolContext,
  UnsupportedDefinitionRule,
  Uuid,
  VersionRef,
  CandidateSourceSpan,
  ReviewableCandidateReader,
  IndustryPackCatalogue,
  PublishedPackAssetStore,
} from '@ontology/contracts'
import { definitionApprovalPins } from '../publication/publication-pins'
import type { CandidateApprovalReader } from '../publication/publication-pins'
import { DefinitionPredecessorError, resolveDefinitionPredecessor } from '../publication/definition-predecessor'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import { DefinitionCandidateError } from './errors'
import { EMPTY_TERMINOLOGY } from './terminology'
import type { DefinitionTerminologySource } from './terminology'
import {
  computeAffectedDefinitions,
  currentDefinitionProjection,
  diffDefinitionProjection,
  issuesForCandidate,
  validateDefinitionProjection,
  HARD_DEFINITION_ISSUES,
} from './validation'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const MAX_OPERANDS = 64
const DEFAULT_PAGE = 100
const CANDIDATE_PAGE = 250

/** The synthetic "author" recorded for a human edit, so a batch is never confused with a model call. */
export const DEFINITION_EDIT_MODEL_REF: ModelRef = { modelId: 'definition-editor', version: '1.0.0' }

export const DEFINITION_EDIT_RESPONSE_SCHEMA_REF: VersionRef = {
  id: 'ontology.candidate-editing',
  version: '1.1.0',
  digest: sha256DigestOf(
    canonicalJson({
      operations: ['edit', 'merge', 'split', 'keep_separate', 'reject'],
      payload: 'DefinitionCandidatePayload (object|attribute|relation); optional object identityScopeDimensions: at most 16 unique non-empty names',
      adjudication: 'kind + candidateIds + producedCandidateIds + reason + affected + findings',
    }),
  ),
}

export const DEFINITION_EDIT_POLICY_REF: VersionRef = {
  id: 'ontology.candidate-editing.policy',
  version: '1.0.0',
  digest: sha256DigestOf(canonicalJson({ review: 'new immutable revision per content change' })),
}

export interface DefinitionCandidateEditingDependencies {
  readonly publishedPacks?: Pick<PublishedPackAssetStore, 'findByRef'>
  readonly baseCatalogue?: IndustryPackCatalogue
  readonly reviewableCandidates?: ReviewableCandidateReader
  readonly reviews?: CandidateApprovalReader
  readonly workspaces: IndustryWorkspaceStore
  readonly candidates: AssetCandidateStore
  readonly terminology: DefinitionTerminologySource
  readonly editing: DefinitionEditingStore
  /** Published definition versions, used for the compatibility diff (optional in bootstrap). */
  readonly publishedDefinitions?: PublishedDefinitionVersionReader
  readonly now?: () => string
  readonly newId?: () => string
}

interface Prepared {
  readonly scopeRef: ScopeRef
  readonly workspace: IndustryWorkspace
  readonly draft: AssetDraftVersion
  readonly actor: string
}

interface RevisionShell {
  readonly candidateId: Uuid
  readonly batchId: Uuid
  readonly workspaceId: Uuid
  readonly logicalId: string
  readonly kind: AssetCandidateVersion['kind']
  readonly payload: DefinitionCandidatePayload
  readonly inputDraftRef: AssetCandidateVersion['inputDraftRef']
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans: readonly CandidateSourceSpan[]
  readonly replacesCandidateId?: Uuid
  readonly idempotencyKey: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new DefinitionCandidateError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may edit definition candidates',
  )
}

function requireRevision(revision: RevisionString | undefined, action: string): RevisionString {
  if (revision === undefined) {
    throw new DefinitionCandidateError('REVISION_REQUIRED', `an If-Match revision is required to ${action}`)
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new DefinitionCandidateError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function requireReason(reason: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a reason is required')
  }
  return reason
}

function countOf(candidates: readonly AssetCandidateVersion[]): AssetCandidateBatchCounts {
  let produced = 0
  let pendingConfirmation = 0
  let pendingReview = 0
  let failed = 0
  for (const candidate of candidates) {
    switch (candidate.state) {
      case 'produced':
        produced += 1
        break
      case 'pending_confirmation':
        pendingConfirmation += 1
        break
      case 'pending_review':
        pendingReview += 1
        break
      case 'failed':
        failed += 1
        break
      case 'rejected':
        break
    }
  }
  return { total: candidates.length, produced, pendingConfirmation, pendingReview, failed }
}

/**
 * The definition (TBox) editing and disambiguation service (SPEC v0.3a §3.1/§3.3/§4, issue
 * V03-009 / #183; A.US-003, P.US-005, P.FR-6/FR-7).
 *
 * It edits, rejects, merges, splits and keeps-separate definition candidates. Every content
 * change appends a NEW immutable candidate revision with a new `candidateId`, so a review
 * recorded against the previous candidate id can never carry over and no second approve
 * decision table is introduced. Validation findings (duplicate identifiers, dangling
 * endpoints, wrong units, illegal type/cardinality) are persisted and block publication;
 * an unsupported rule is saved as non-executable instead of being deleted.
 */
export class DefinitionCandidateEditingService {
  readonly #reviewableCandidates: ReviewableCandidateReader | undefined
  readonly #reviews: CandidateApprovalReader | undefined
  readonly #workspaces: IndustryWorkspaceStore
  readonly #candidates: AssetCandidateStore
  readonly #terminology: DefinitionTerminologySource
  readonly #editing: DefinitionEditingStore
  readonly #publishedDefinitions: PublishedDefinitionVersionReader | undefined
  readonly #predecessorDependencies: Pick<DefinitionCandidateEditingDependencies, 'publishedPacks' | 'baseCatalogue' | 'publishedDefinitions'>
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: DefinitionCandidateEditingDependencies) {
    this.#reviewableCandidates = dependencies.reviewableCandidates
    this.#reviews = dependencies.reviews
    this.#workspaces = dependencies.workspaces
    this.#candidates = dependencies.candidates
    this.#terminology = dependencies.terminology
    this.#editing = dependencies.editing
    this.#publishedDefinitions = dependencies.publishedDefinitions
    this.#predecessorDependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** Replace a candidate's payload with an edited one; the original revision is preserved. */
  async edit(
    workspaceId: Uuid,
    input: EditDefinitionCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    assertDefinitionCandidatePayloadShape(input.payload)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, actor, ctx, 'edit candidates')
    const original = await this.#requireCandidate(workspaceId, input.candidateId, ctx)
    if (input.payload.kind !== original.kind) {
      throw new DefinitionCandidateError(
        'INVALID_ARGUMENT',
        `an edit cannot change a ${original.kind} candidate into a ${input.payload.kind} candidate`,
      )
    }
    const requestDigest = sha256DigestOf(
      canonicalJson({
        operation: 'edit',
        workspaceId,
        draft: prepared.draft.digest,
        candidateId: input.candidateId,
        payload: input.payload,
        reason: input.reason,
      }),
    )
    const replay = await this.#replay(prepared.scopeRef, key, requestDigest, ctx)
    if (replay !== undefined) return replay

    const contentPayload = input.payload
    const shell = this.#shell({
      prepared,
      payload: contentPayload,
      operationId: key,
      ordinal: 0,
      provenance: { sourceRefs: original.sourceRefs, sourceSpans: original.sourceSpans },
      replacesCandidateId: original.candidateId,
    })
    const result = await this.#commit({
      prepared,
      shells: [shell],
      forcedRejected: new Set<string>(),
      candidateIds: [original.candidateId],
      changedLogicalIds: [original.payload.logicalId, contentPayload.logicalId],
      kind: 'edit',
      reason: input.reason,
      requestDigest,
      key,
      actor,
      ctx,
    })
    return result
  }

  /** Merge synonym candidates into one; the merged-away originals are rejected, never deleted. */
  async merge(
    workspaceId: Uuid,
    input: MergeDefinitionCandidatesInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    assertDefinitionCandidatePayloadShape(input.mergedPayload)
    if (input.candidateIds.length < 2) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a merge needs at least two candidates')
    }
    if (input.candidateIds.length > MAX_OPERANDS) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', `a merge accepts at most ${String(MAX_OPERANDS)} candidates`)
    }
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, actor, ctx, 'merge candidates')
    const originals = await this.#requireCandidates(workspaceId, input.candidateIds, ctx)
    if (originals.some((candidate) => candidate.kind !== input.mergedPayload.kind)) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a merge cannot combine candidates of different kinds')
    }
    const requestDigest = sha256DigestOf(
      canonicalJson({
        operation: 'merge',
        workspaceId,
        draft: prepared.draft.digest,
        candidateIds: [...input.candidateIds].sort(),
        mergedPayload: input.mergedPayload,
        reason: input.reason,
      }),
    )
    const replay = await this.#replay(prepared.scopeRef, key, requestDigest, ctx)
    if (replay !== undefined) return replay

    const primary = originals[0]
    if (primary === undefined) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a merge needs at least two candidates')
    }
    const shell = this.#shell({
      prepared,
      payload: input.mergedPayload,
      operationId: key,
      ordinal: 0,
      provenance: unionProvenance(originals),
      replacesCandidateId: primary.candidateId,
    })
    const forcedRejected = new Set<string>(originals.slice(1).map((candidate) => candidate.candidateId))
    return this.#commit({
      prepared,
      shells: [shell],
      forcedRejected,
      candidateIds: originals.map((candidate) => candidate.candidateId),
      changedLogicalIds: originals.map((candidate) => candidate.payload.logicalId),
      kind: 'merge',
      reason: input.reason,
      requestDigest,
      key,
      actor,
      ctx,
      rejectOriginals: originals.slice(1),
    })
  }

  /** Split one candidate into independent candidates; each part replaces the original. */
  async split(
    workspaceId: Uuid,
    input: SplitDefinitionCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    if (input.parts.length < 2) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a split needs at least two parts')
    }
    if (input.parts.length > MAX_OPERANDS) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', `a split accepts at most ${String(MAX_OPERANDS)} parts`)
    }
    for (const part of input.parts) assertDefinitionCandidatePayloadShape(part)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, actor, ctx, 'split a candidate')
    const original = await this.#requireCandidate(workspaceId, input.candidateId, ctx)
    if (input.parts.some((part) => part.kind !== original.kind)) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a split cannot change the candidate kind')
    }
    const requestDigest = sha256DigestOf(
      canonicalJson({
        operation: 'split',
        workspaceId,
        draft: prepared.draft.digest,
        candidateId: input.candidateId,
        parts: input.parts,
        reason: input.reason,
      }),
    )
    const replay = await this.#replay(prepared.scopeRef, key, requestDigest, ctx)
    if (replay !== undefined) return replay

    const shells = input.parts.map((part, index) =>
      this.#shell({
        prepared,
        payload: part,
        operationId: key,
        ordinal: index,
        provenance: { sourceRefs: original.sourceRefs, sourceSpans: original.sourceSpans },
        replacesCandidateId: original.candidateId,
      }),
    )
    return this.#commit({
      prepared,
      shells,
      forcedRejected: new Set<string>(),
      candidateIds: [original.candidateId],
      changedLogicalIds: [original.payload.logicalId, ...input.parts.map((part) => part.logicalId)],
      kind: 'split',
      reason: input.reason,
      requestDigest,
      key,
      actor,
      ctx,
    })
  }

  /** Keep two same-named, differently-meaning candidates independent; no content change. */
  async keepSeparate(
    workspaceId: Uuid,
    input: KeepDefinitionsSeparateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    if (input.candidateIds.length < 2) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'a keep-separate decision needs at least two candidates')
    }
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, actor, ctx, 'keep candidates separate')
    const originals = await this.#requireCandidates(workspaceId, input.candidateIds, ctx)
    const requestDigest = sha256DigestOf(
      canonicalJson({
        operation: 'keep_separate',
        workspaceId,
        draft: prepared.draft.digest,
        candidateIds: [...input.candidateIds].sort(),
        reason: input.reason,
      }),
    )
    const replay = await this.#replay(prepared.scopeRef, key, requestDigest, ctx)
    if (replay !== undefined) return replay

    const projection = await this.#projection(workspaceId, [], new Set<string>(), ctx)
    const validation = await this.#validate(prepared, projection, undefined, ctx)
    const adjudication = this.#adjudication({
      workspaceId,
      kind: 'keep_separate',
      candidateIds: input.candidateIds,
      producedCandidateIds: [],
      reason: input.reason,
      affected: computeAffectedDefinitions(projection, originals.map((candidate) => candidate.payload.logicalId)),
      findings: [...validation.blockers, ...validation.warnings],
      compatibility: validation.compatibility,
      requestDigest,
      key,
      actor,
    })
    const stored = await this.#editing.appendAdjudication(prepared.scopeRef, adjudication, ctx)
    return { adjudication: stored, candidates: [], created: true }
  }

  /** Reject one candidate; the payload is preserved, only the review state transitions. */
  async reject(
    workspaceId: Uuid,
    input: RejectDefinitionCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, actor, ctx, 'reject a candidate')
    const original = await this.#requireCandidate(workspaceId, input.candidateId, ctx)
    const requestDigest = sha256DigestOf(
      canonicalJson({ operation: 'reject', workspaceId, draft: prepared.draft.digest, candidateId: input.candidateId, reason: input.reason }),
    )
    const replay = await this.#replay(prepared.scopeRef, key, requestDigest, ctx)
    if (replay !== undefined) return replay

    await this.#candidates.transitionCandidate(
      prepared.scopeRef,
      original.candidateId,
      { state: 'rejected', issues: original.issues, transitionedAt: this.#now() },
      ctx,
    )
    const projection = await this.#projection(workspaceId, [], new Set<string>(), ctx)
    const validation = await this.#validate(prepared, projection, undefined, ctx)
    const adjudication = this.#adjudication({
      workspaceId,
      kind: 'reject',
      candidateIds: [input.candidateId],
      producedCandidateIds: [],
      reason: input.reason,
      affected: computeAffectedDefinitions(projection, [original.payload.logicalId]),
      findings: [...validation.blockers, ...validation.warnings],
      compatibility: validation.compatibility,
      requestDigest,
      key,
      actor,
    })
    const stored = await this.#editing.appendAdjudication(prepared.scopeRef, adjudication, ctx)
    return { adjudication: stored, candidates: [], created: true }
  }

  /**
   * Validate the current definition projection for publication. A duplicate identifier, a
   * dangling endpoint, a wrong unit, an illegal type/cardinality, or a breaking change with no
   * explicit revision strategy blocks publication and is returned as a classified blocker.
   */
  async validateForPublication(
    input: { readonly workspaceId: Uuid; readonly revision: RevisionString; readonly strategy?: DefinitionRevisionStrategy },
    ctx: ToolContext,
  ): Promise<DefinitionValidationReport> {
    const workspace = await this.#workspaces.getWorkspace(scopeOf(ctx), input.workspaceId, ctx)
    if (workspace === undefined) {
      throw new DefinitionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${input.workspaceId} is not visible in this scope`)
    }
    const projection = await this.#projection(input.workspaceId, [], new Set<string>(), ctx)
    if (workspace.headRevision !== input.revision) {
      throw new DefinitionCandidateError('VERSION_CONFLICT', 'publication validation requires the current workspace revision')
    }
    const drafts = await this.#workspaces.listDrafts(scopeOf(ctx), input.workspaceId, ctx)
    const draft = drafts.find((entry) => entry.revision === input.revision) ?? drafts[drafts.length - 1]
    if (draft === undefined) {
      throw new DefinitionCandidateError('DRAFT_NOT_FOUND', `workspace ${input.workspaceId} has no draft to validate`)
    }
    const prepared: Prepared = { scopeRef: scopeOf(ctx), workspace, draft, actor: ctx.principal.subjectId }
    const validation = await this.#validate(prepared, projection, input.strategy, ctx, true)
    const approvals = await definitionApprovalPins(projection, scopeOf(ctx), ctx, this.#reviewableCandidates, this.#reviews)
    const blockers = [...validation.blockers, ...approvals.blockers]
    return { ...validation, approvalPins: approvals.pins, blockers, publishable: blockers.length === 0 }
  }

  /** The diff between the current projection and the published definition version. */
  async compatibility(
    workspaceId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<DefinitionCompatibilityReport> {
    const workspace = await this.#workspaces.getWorkspace(scopeOf(ctx), workspaceId, ctx)
    if (workspace === undefined) {
      throw new DefinitionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const drafts = await this.#workspaces.listDrafts(scopeOf(ctx), workspaceId, ctx)
    const draft = drafts.find((entry) => entry.revision === revision) ?? drafts[drafts.length - 1]
    if (draft === undefined) {
      throw new DefinitionCandidateError('DRAFT_NOT_FOUND', `workspace ${workspaceId} has no draft`)
    }
    const projection = await this.#projection(workspaceId, [], new Set<string>(), ctx)
    const published = await this.#published(workspace, draft, ctx)
    return diffDefinitionProjection(projection, published?.version, {
      workspaceId,
      revision,
      ...(published?.ref === undefined ? {} : { publishedRef: published.ref }),
    })
  }

  /** Persist an unsupported rule verbatim as non-executable; it is never deleted or weakened. */
  async recordUnsupportedRule(
    input: SaveUnsupportedRuleInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    if (typeof input.ruleId !== 'string' || input.ruleId.trim().length === 0) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'an unsupported rule needs a non-empty ruleId')
    }
    const workspace = await this.#workspaces.getWorkspace(scopeRef, input.workspaceId, ctx)
    if (workspace === undefined) {
      throw new DefinitionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${input.workspaceId} is not visible in this scope`)
    }
    const rule: UnsupportedDefinitionRule = {
      ruleId: input.ruleId,
      workspaceId: input.workspaceId,
      ...(input.sourceCandidateId === undefined ? {} : { sourceCandidateId: input.sourceCandidateId }),
      reason: input.reason,
      rawForm: input.rawForm,
      executable: false,
      idempotencyKey: input.idempotencyKey,
      actor,
      recordedAt: this.#now(),
    }
    return this.#editing.recordUnsupportedRule(scopeRef, rule, ctx)
  }

  listAdjudications(workspaceId: Uuid, limit: number, ctx: ToolContext): Promise<DefinitionEditAdjudication[]> {
    return this.#editing.listAdjudications(scopeOf(ctx), workspaceId, limit, ctx)
  }

  listUnsupportedRules(workspaceId: Uuid, limit: number, ctx: ToolContext): Promise<UnsupportedDefinitionRule[]> {
    return this.#editing.listUnsupportedRules(scopeOf(ctx), workspaceId, limit, ctx)
  }

  /* ----------------------------------------------------------------------------------- */

  async #prepare(
    workspaceId: Uuid,
    expectedRevision: RevisionString | undefined,
    actor: string,
    ctx: ToolContext,
    action: string,
  ): Promise<Prepared> {
    const scopeRef = scopeOf(ctx)
    const workspace = await this.#workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new DefinitionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const expected = requireRevision(expectedRevision, action)
    if (workspace.headRevision !== expected) {
      throw new DefinitionCandidateError('VERSION_CONFLICT', 'the workspace head moved before this edit', {
        reasons: [`expectedRevision=${expected}`, `currentRevision=${workspace.headRevision}`],
      })
    }
    const drafts = await this.#workspaces.listDrafts(scopeRef, workspaceId, ctx)
    const draft = drafts[drafts.length - 1]
    if (draft === undefined) {
      throw new DefinitionCandidateError('DRAFT_NOT_FOUND', `workspace ${workspaceId} has no draft revision`)
    }
    return { scopeRef, workspace, draft, actor }
  }

  async #replay(
    scopeRef: ScopeRef,
    key: string,
    requestDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<DefinitionEditingResult | undefined> {
    const prior = await this.#editing.findAdjudicationByIdempotencyKey(scopeRef, key, ctx)
    if (prior === undefined) return undefined
    if (prior.requestDigest !== requestDigest) {
      throw new DefinitionCandidateError(
        'IDEMPOTENCY_CONFLICT',
        'the idempotency key was already used with a different edit request',
      )
    }
    const candidates: DefinitionEditingResult['candidates'][number][] = []
    for (const id of prior.producedCandidateIds) {
      const candidate = await this.#candidates.getCandidate(scopeRef, id, ctx)
      if (candidate === undefined) continue
      candidates.push(lean(candidate))
    }
    return { adjudication: prior, candidates, created: false }
  }

  async #requireCandidate(workspaceId: Uuid, candidateId: Uuid, ctx: ToolContext): Promise<AssetCandidateVersion> {
    const candidate = await this.#candidates.getCandidate(scopeOf(ctx), candidateId, ctx)
    if (candidate === undefined || candidate.workspaceId !== workspaceId) {
      throw new DefinitionCandidateError('CANDIDATE_NOT_FOUND', `candidate ${candidateId} is not visible in this workspace`)
    }
    return candidate
  }

  async #requireCandidates(
    workspaceId: Uuid,
    candidateIds: readonly Uuid[],
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    const unique = [...new Set(candidateIds)]
    if (unique.length !== candidateIds.length) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'the same candidate id was supplied more than once')
    }
    const out: AssetCandidateVersion[] = []
    for (const id of candidateIds) out.push(await this.#requireCandidate(workspaceId, id, ctx))
    return out
  }

  #shell(args: {
    readonly prepared: Prepared
    readonly payload: DefinitionCandidatePayload
    readonly operationId: string
    readonly ordinal: number
    readonly provenance: { readonly sourceRefs: readonly ResourceRef[]; readonly sourceSpans: readonly CandidateSourceSpan[] }
    readonly replacesCandidateId?: Uuid
  }): RevisionShell {
    const candidateId = candidateIdFor(
      sha256DigestOf(canonicalJson({ operationId: args.operationId, logicalId: args.payload.logicalId, ordinal: args.ordinal })),
    )
    const batchId = candidateIdFor(
      sha256DigestOf(canonicalJson({ operationId: args.operationId, batch: true })),
    )
    const recordedAt = this.#now()
    const idempotencyKey = sha256DigestOf(
      canonicalJson({ operationId: args.operationId, logicalId: args.payload.logicalId, ordinal: args.ordinal }),
    )
    return {
      candidateId,
      batchId,
      workspaceId: args.prepared.workspace.workspaceId,
      logicalId: args.payload.logicalId,
      kind: args.payload.kind,
      payload: args.payload,
      inputDraftRef: {
        workspaceId: args.prepared.draft.workspaceId,
        revision: args.prepared.draft.revision,
        digest: args.prepared.draft.digest,
      },
      sourceRefs: args.provenance.sourceRefs,
      sourceSpans: args.provenance.sourceSpans,
      ...(args.replacesCandidateId === undefined ? {} : { replacesCandidateId: args.replacesCandidateId }),
      idempotencyKey,
      recordedAt,
    }
  }

  async #commit(args: {
    readonly prepared: Prepared
    readonly shells: readonly RevisionShell[]
    readonly forcedRejected: ReadonlySet<string>
    readonly candidateIds: readonly Uuid[]
    readonly changedLogicalIds: readonly string[]
    readonly kind: DefinitionEditAdjudication['kind']
    readonly reason: string
    readonly requestDigest: Sha256Digest
    readonly key: string
    readonly actor: string
    readonly ctx: ToolContext
    readonly rejectOriginals?: readonly AssetCandidateVersion[]
  }): Promise<DefinitionEditingResult> {
    const all = await this.#candidates.listCandidates(args.prepared.scopeRef, args.prepared.workspace.workspaceId, { limit: CANDIDATE_PAGE }, args.ctx)
    if (all.length === CANDIDATE_PAGE) throw new DefinitionCandidateError('INVALID_ARGUMENT', 'candidate page is incomplete; a complete semantic projection is required')
    const provisional = args.shells.map((shell) => finalize(shell, [], []))
    const projected = projectionOf(all, provisional, args.forcedRejected)
    const validation = await this.#validate(args.prepared, projected, undefined, args.ctx)
    const findings = [...validation.blockers, ...validation.warnings]

    const versions = args.shells.map((shell) =>
      finalize(shell, issuesForCandidate(shell.candidateId, findings), findings),
    )
    const first = versions[0]
    if (first === undefined) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'an edit produced no candidate revision')
    }
    const counts = countOf(versions)
    const batch: AssetCandidateBatch = {
      batchId: first.batchId,
      workspaceId: args.prepared.workspace.workspaceId,
      domain: 'definition',
      inputDraftRef: first.inputDraftRef,
      modelRef: DEFINITION_EDIT_MODEL_REF,
      responseSchemaRef: DEFINITION_EDIT_RESPONSE_SCHEMA_REF,
      documentSetRef: args.prepared.draft.documentSetRef,
      generationPolicyRef: DEFINITION_EDIT_POLICY_REF,
      state: counts.total > 0 && counts.pendingConfirmation === counts.total ? 'pending_confirmation' : 'completed',
      counts,
      idempotencyKey: args.key,
      requestDigest: args.requestDigest,
      createdBy: args.actor,
      recordedAt: first.recordedAt,
    }
    await this.#candidates.insertBatch(args.prepared.scopeRef, batch, versions, args.ctx)

    for (const original of args.rejectOriginals ?? []) {
      await this.#candidates.transitionCandidate(
        args.prepared.scopeRef,
        original.candidateId,
        { state: 'rejected', issues: original.issues, transitionedAt: this.#now() },
        args.ctx,
      )
    }

    const adjudication = this.#adjudication({
      workspaceId: args.prepared.workspace.workspaceId,
      kind: args.kind,
      candidateIds: args.candidateIds,
      producedCandidateIds: versions.map((version) => version.candidateId),
      reason: args.reason,
      affected: computeAffectedDefinitions(projected, args.changedLogicalIds),
      findings,
      compatibility: validation.compatibility,
      requestDigest: args.requestDigest,
      key: args.key,
      actor: args.actor,
    })
    const stored = await this.#editing.appendAdjudication(args.prepared.scopeRef, adjudication, args.ctx)
    return { adjudication: stored, candidates: versions.map(lean), created: true }
  }

  async #projection(
    workspaceId: Uuid,
    extra: readonly AssetCandidateVersion[],
    forcedRejected: ReadonlySet<string>,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    const all = await this.#candidates.listCandidates(scopeOf(ctx), workspaceId, { limit: CANDIDATE_PAGE }, ctx)
    if (all.length === CANDIDATE_PAGE) throw new DefinitionCandidateError('INVALID_ARGUMENT', 'candidate page is incomplete; a complete semantic projection is required')
    return projectionOf(all, extra, forcedRejected)
  }

  async #validate(
    prepared: Prepared,
    projection: readonly AssetCandidateVersion[],
    strategy: DefinitionRevisionStrategy | undefined,
    ctx: ToolContext,
    enforceExplicitly = false,
  ): Promise<DefinitionValidationReport> {
    const terminology =
      (await this.#terminology.getTerminology(prepared.scopeRef, prepared.draft.basePackRef, ctx)) ?? EMPTY_TERMINOLOGY
    const published = await this.#published(prepared.workspace, prepared.draft, ctx)
    const compatibility = diffDefinitionProjection(projection, published?.version, {
      workspaceId: prepared.workspace.workspaceId,
      revision: enforceExplicitly ? prepared.workspace.headRevision : prepared.draft.revision,
      ...(published?.ref === undefined ? {} : { publishedRef: published.ref }),
      ...(strategy === undefined ? {} : { strategy }),
    })
    const unsupportedRules = await this.#editing.listUnsupportedRules(
      prepared.scopeRef,
      prepared.workspace.workspaceId,
      DEFAULT_PAGE,
      ctx,
    )
    return validateDefinitionProjection(projection, {
      workspaceId: prepared.workspace.workspaceId,
      revision: enforceExplicitly ? prepared.workspace.headRevision : prepared.draft.revision,
      terminology,
      compatibility,
      ...(strategy === undefined ? {} : { strategy }),
      unsupportedRules,
      ...(enforceExplicitly ? { enforceRevisionStrategy: true } : {}),
    })
  }

  async #published(
    workspace: IndustryWorkspace,
    draft: AssetDraftVersion,
    ctx: ToolContext,
  ): Promise<{ ref?: VersionRef; version?: SemanticDefinitionVersion } | undefined> {
    try {
      const prior = await resolveDefinitionPredecessor({ ...this.#predecessorDependencies,
        ...(this.#publishedDefinitions === undefined ? {} : { definitions: this.#publishedDefinitions }) }, workspace, draft, scopeOf(ctx), ctx)
      return prior === undefined ? undefined : { ref: prior.definition.ref, version: prior.definition }
    } catch (error) {
      if (error instanceof DefinitionPredecessorError) throw new DefinitionCandidateError('VERSION_CONFLICT', error.message, { cause: error })
      throw error
    }
  }

  #adjudication(args: {
    readonly workspaceId: Uuid
    readonly kind: DefinitionEditAdjudication['kind']
    readonly candidateIds: readonly Uuid[]
    readonly producedCandidateIds: readonly Uuid[]
    readonly reason: string
    readonly affected: readonly DefinitionAffectedDefinition[]
    readonly findings: readonly DefinitionValidationFinding[]
    readonly compatibility: DefinitionCompatibilityReport
    readonly requestDigest: Sha256Digest
    readonly key: string
    readonly actor: string
  }): DefinitionEditAdjudication {
    return {
      adjudicationId: this.#newId(),
      workspaceId: args.workspaceId,
      kind: args.kind,
      candidateIds: args.candidateIds,
      producedCandidateIds: args.producedCandidateIds,
      reason: args.reason,
      affected: args.affected,
      findings: args.findings,
      compatibility: args.compatibility,
      ...(args.compatibility.strategy === undefined ? {} : { strategy: args.compatibility.strategy }),
      requestDigest: args.requestDigest,
      idempotencyKey: args.key,
      actor: args.actor,
      recordedAt: this.#now(),
    }
  }
}

function unionProvenance(candidates: readonly AssetCandidateVersion[]): {
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans: readonly CandidateSourceSpan[]
} {
  const refs = new Map<string, ResourceRef>()
  for (const candidate of candidates) for (const ref of candidate.sourceRefs) refs.set(ref.id, ref)
  const spans: CandidateSourceSpan[] = []
  const seenSpans = new Set<string>()
  for (const candidate of candidates) {
    for (const span of candidate.sourceSpans) {
      const key = JSON.stringify(span)
      if (seenSpans.has(key)) continue
      seenSpans.add(key)
      spans.push(span)
    }
  }
  return { sourceRefs: [...refs.values()], sourceSpans: spans }
}

function projectionOf(
  all: readonly AssetCandidateVersion[],
  extra: readonly AssetCandidateVersion[],
  forcedRejected: ReadonlySet<string>,
): AssetCandidateVersion[] {
  const effective = all.map((candidate) =>
    forcedRejected.has(candidate.candidateId) ? { ...candidate, state: 'rejected' as AssetCandidateState } : candidate,
  )
  return currentDefinitionProjection([...effective, ...extra])
}

function finalize(
  shell: RevisionShell,
  issues: AssetCandidateVersion['issues'],
  findings: readonly DefinitionValidationFinding[],
): AssetCandidateVersion {
  const hard = issues.some((issue) => HARD_DEFINITION_ISSUES.includes(issue.code))
  const state: AssetCandidateState = hard ? 'failed' : shell.sourceRefs.length === 0 ? 'pending_confirmation' : 'produced'
  const conflicts = conflictsFor(shell.candidateId, findings)
  const payload: DefinitionCandidatePayload = { ...shell.payload, conflicts: [...shell.payload.conflicts, ...conflicts] }
  const contentDigest = sha256DigestOf(
    canonicalJson({
      workspaceId: shell.workspaceId,
      logicalId: shell.logicalId,
      kind: shell.kind,
      payload,
      inputDraftRef: shell.inputDraftRef,
      sourceRefs: shell.sourceRefs,
      issues,
    }),
  )
  return {
    candidateId: shell.candidateId,
    batchId: shell.batchId,
    workspaceId: shell.workspaceId,
    logicalId: shell.logicalId,
    domain: 'definition',
    kind: shell.kind,
    payload,
    inputDraftRef: shell.inputDraftRef,
    sourceRefs: shell.sourceRefs,
    sourceSpans: shell.sourceSpans,
    state,
    issues,
    pendingConfirmation: shell.sourceRefs.length === 0,
    ...(shell.replacesCandidateId === undefined ? {} : { replacesCandidateId: shell.replacesCandidateId }),
    contentDigest,
    idempotencyKey: shell.idempotencyKey,
    recordedAt: shell.recordedAt,
  }
}

function conflictsFor(
  candidateId: Uuid,
  findings: readonly DefinitionValidationFinding[],
): readonly DefinitionCandidateConflict[] {
  const conflicts: DefinitionCandidateConflict[] = []
  for (const finding of findings) {
    if (finding.candidateId !== candidateId) continue
    const kind = conflictKind(finding.code)
    if (kind === undefined) continue
    conflicts.push({ kind, message: finding.message, relatedLogicalIds: [finding.logicalId] })
  }
  return conflicts
}

function conflictKind(
  code: DefinitionValidationFinding['code'],
): DefinitionCandidateConflict['kind'] | undefined {
  switch (code) {
    case 'DUPLICATE_IDENTIFIER':
      return 'logical_id_collision'
    case 'DANGLING_ENDPOINT':
      return 'endpoint_unresolved'
    case 'UNIT_MISMATCH':
      return 'unit_conflict'
    case 'DEFINITION_CONFLICT':
      return 'terminology_mismatch'
    case 'INVALID_TYPE_CARDINALITY':
      return 'cardinality_conflict'
    case 'INVALID_IDENTITY':
      return 'identity_conflict'
    case 'REVISION_STRATEGY_REQUIRED':
    case 'REVISION_STRATEGY_INVALID':
    case 'CANDIDATE_NOT_APPROVED':
      return undefined
  }
}

function lean(candidate: AssetCandidateVersion): DefinitionEditingResult['candidates'][number] {
  return {
    candidateId: candidate.candidateId,
    workspaceId: candidate.workspaceId,
    logicalId: candidate.logicalId,
    kind: candidate.kind,
    state: candidate.state,
    payload: candidate.payload,
    ...(candidate.replacesCandidateId === undefined ? {} : { replacesCandidateId: candidate.replacesCandidateId }),
    contentDigest: candidate.contentDigest,
  }
}
