import {
  CandidateCommitError,
  SubmitCandidatesError,
  assetCandidateCommitPin,
  assertSubmitCandidatesCommandShape,
  isToolContext,
  isUuid,
  sourceTrustTierGroundsPublication,
} from '@ontology/contracts'
import type {
  ActionCandidateVersion,
  AssetCandidateBatch,
  AssetCandidateBatchCounts,
  AssetCandidateInsertGuard,
  AssetCandidateInsertResult,
  AssetCandidateStore,
  AssetCandidateVersion,
  BudgetLedgerPort,
  CandidateCommitPort,
  CandidateCommitTransaction,
  CandidateDispatchFence,
  CandidateRunBinding,
  CandidateRunBindingPort,
  CandidateSubmission,
  CandidateSubmissionPort,
  CandidateSubmissionRecord,
  CandidateSubmissionStore,
  DefinitionCandidatePayload,
  DefinitionCandidateProposal,
  IndustryWorkspaceBoundary,
  IndustryWorkspaceStore,
  ResolvedCandidateEvidence,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RuleCandidateVersion,
  ScopeRef,
  SourceGroundingPort,
  SubmitCandidatesReceipt,
  SubmitCandidatesRequest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import { readLatestWorkspaceDraft } from '../workspace-draft'
import { buildDefinitionCandidate, knownObjectsOf } from '../definition-candidates/build'
import type { DefinitionTerminologySource } from '../definition-candidates/terminology'
import { EMPTY_TERMINOLOGY } from '../definition-candidates/terminology'
import { candidateHeads } from '../definition-candidates/rebase'
import type { DraftDefinitionCandidate } from '../definition-candidates/model-output'
import { groundingFragments } from '../definition-candidates/grounding'
import { SourceGroundingBudget } from '../source-grounding/budget'
import type { CandidateEvidencePort } from '@ontology/contracts'
import type { RuleActionCandidateService, SaveActionCandidateInput, SaveRuleCandidateInput } from '../rule-action-candidates/service'
import type { ArchivedWebSnapshotInput, CandidateSourceIngestionService } from '../candidate-sources/ingestion-service'

const RESEARCHER_ROLES: readonly string[] = ['researcher']
const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const MAX_DEFINITION_HISTORY = 2000
const DEFAULT_MAX_CANDIDATES = 500
const DEFAULT_MAX_LINKS = 32

/** The synthetic producer recorded on a candidate-submission batch (never a model call). */
export const CANDIDATE_SUBMISSION_MODEL_REF = { modelId: 'candidate-submission', version: '1.0.0' } as const

export const CANDIDATE_SUBMISSION_SCHEMA_REF: VersionRef = {
  id: 'ontology.candidate-submission',
  version: '1.0.0',
  digest: sha256DigestOf(canonicalJson({ operation: 'submit_candidates@1', controlled: true })),
}

/** The cancel/revoke fence the service re-checks before every transaction (design §7 ④). */
export interface CandidateSubmissionFence {
  isCancelled(runId: Uuid, ctx: ToolContext): Promise<boolean>
}

export interface CandidateSubmissionDependencies {
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace' | 'getDraft' | 'listDrafts' | 'getLatestDraft'>
  readonly definitionCandidates: AssetCandidateStore
  readonly terminology: DefinitionTerminologySource
  readonly evidence: CandidateEvidencePort
  readonly receipts: CandidateSubmissionStore
  /** Reuses the rule/action validation + persistence (support report, capability binding). */
  readonly ruleActions?: RuleActionCandidateService
  /** Reuses the source-proposal validation + persistence (server-fixed kind/tier/state). */
  readonly sourceIngestion?: CandidateSourceIngestionService
  /** The approved grounding reader used only by re-grounding after a source review. */
  readonly sourceGrounding?: SourceGroundingPort
  readonly fence?: CandidateSubmissionFence
  /**
   * The run's frozen binding (design §7, S08). When mounted with `commit`, the submit path resolves
   * the target workspace and the pinned draft from the run's admission — never from the model's
   * `command.workspaceId` and never from "the latest draft" — and refuses a command whose workspace
   * or draft no longer matches the binding.
   */
  readonly runBinding?: CandidateRunBindingPort
  /**
   * The narrow atomic commit boundary (design §7, S08). When mounted, the candidate, its links and
   * its receipt are written in one fence-checked PostgreSQL transaction, so a cancel/lost-lease race
   * or a crash between the candidate and the receipt can never leave an orphan candidate.
   */
  readonly commit?: CandidateCommitPort
  /**
   * The run's one shared budget ledger (design §8, S06). When mounted, each submission
   * reserves its candidate units on that ledger before writing, so `candidateLimit` is
   * enforced atomically across separate commands and concurrent runs instead of only
   * bounding one batch.
   */
  readonly budget?: BudgetLedgerPort
  /** The ledger a run's candidates must charge, derived from the run id. Required with `budget`. */
  readonly ledgerIdFor?: (runId: Uuid) => Uuid
  readonly maxCandidates?: number
  readonly maxLinksPerCandidate?: number
  readonly now?: () => string
  readonly newId?: () => string
}

interface PreparedCandidate {
  readonly submissionIndex: number
  readonly submission: CandidateSubmission
}

/**
 * The persistence surface the domain build writes through. The legacy path writes to the standalone
 * stores; the atomic path writes to the same stores on the commit transaction's own connection, so
 * the build logic is identical and only the transaction boundary differs (design §7, S08).
 */
interface CandidateWriter {
  insertDefinitions(
    batch: AssetCandidateBatch,
    candidates: readonly AssetCandidateVersion[],
    guard: AssetCandidateInsertGuard,
  ): Promise<AssetCandidateInsertResult>
  ingestSource(input: ArchivedWebSnapshotInput): Promise<{ readonly sourceId: Uuid; readonly reviewState: string }>
  saveRule(workspaceId: Uuid, input: SaveRuleCandidateInput): Promise<RuleCandidateVersion>
  saveAction(workspaceId: Uuid, input: SaveActionCandidateInput): Promise<ActionCandidateVersion>
}

type ReceiptEntry = SubmitCandidatesReceipt['accepted'][number]
type Rejection = SubmitCandidatesReceipt['rejected'][number]
type Draft = NonNullable<Awaited<ReturnType<typeof readLatestWorkspaceDraft>>>

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new SubmitCandidatesError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function bound(key: string, suffix: string): string {
  const base = `${key}${suffix}`
  return base.length <= 256 ? base : sha256DigestOf(base)
}

function countOf(candidates: readonly AssetCandidateVersion[]): AssetCandidateBatchCounts {
  let produced = 0
  let pendingConfirmation = 0
  let pendingReview = 0
  let failed = 0
  for (const candidate of candidates) {
    switch (candidate.state) {
      case 'produced': produced += 1; break
      case 'pending_confirmation': pendingConfirmation += 1; break
      case 'pending_review': pendingReview += 1; break
      case 'failed': failed += 1; break
      case 'rejected': break
    }
  }
  return { total: candidates.length, produced, pendingConfirmation, pendingReview, failed }
}

function pinsOf(candidates: readonly AssetCandidateVersion[]): AssetCandidateInsertGuard['currentCandidatePins'] {
  return candidateHeads(candidates).map(assetCandidateCommitPin)
}

function toDraft(payload: DefinitionCandidateProposal | DefinitionCandidatePayload): DraftDefinitionCandidate {
  const common = { logicalId: payload.logicalId, displayName: payload.displayName, businessMeaning: payload.businessMeaning, suggestedReason: payload.suggestedReason }
  if (payload.kind === 'object') {
    return { kind: 'object', ...common, identityAttributeIds: payload.identityAttributeIds,
      ...(payload.identityScopeDimensions === undefined ? {} : { identityScopeDimensions: payload.identityScopeDimensions }) }
  }
  if (payload.kind === 'attribute') {
    return { kind: 'attribute', ...common, objectLogicalId: payload.objectLogicalId, valueType: payload.valueType,
      ...(payload.unitCode === undefined ? {} : { unitCode: payload.unitCode }), ...(payload.dimension === undefined ? {} : { dimension: payload.dimension }),
      ...(payload.enumValues === undefined ? {} : { enumValues: payload.enumValues }),
      ...(payload.referencesObjectLogicalId === undefined ? {} : { referencesObjectLogicalId: payload.referencesObjectLogicalId }),
      minCardinality: payload.minCardinality, maxCardinality: payload.maxCardinality }
  }
  return { kind: 'relation', ...common, fromObjectLogicalId: payload.fromObjectLogicalId, toObjectLogicalId: payload.toObjectLogicalId,
    minCardinality: payload.minCardinality, maxCardinality: payload.maxCardinality }
}

/**
 * The controlled candidate-submission service (design §5/§7).
 *
 * `submit_candidates` is a workspace **write command**, not a data tool. The model supplies only a
 * proposal plus references to evidence it already obtained; the service owns every trusted
 * attribute. It runs the fixed order:
 *
 * ① run/operator/workspace/command permission, ② evidence authorization and digest, ③ candidate
 * schema/terminology/rule-dependency/action-binding/limit, ④ the workspace revision and the
 * cancel/revoke fence, ⑤ one transaction that writes the candidates, the candidate↔source links and
 * the idempotent receipt.
 *
 * Invariants enforced here, not by the model: a candidate with no resolvable evidence is rejected;
 * a new source is fixed to `kind=web_fetch / trustTier=agent_researched / reviewState=proposed`; a
 * candidate that cites a not-yet-confirmed source keeps `pending_confirmation` + `SOURCE_TRUST_BLOCKED`;
 * and the host idempotency key replays the stored receipt instead of writing a second candidate.
 */
export class CandidateSubmissionService implements CandidateSubmissionPort {
  readonly #deps: CandidateSubmissionDependencies
  readonly #maxCandidates: number
  readonly #maxLinks: number
  readonly #now: () => string
  readonly #newId: () => string
  readonly #budget: BudgetLedgerPort | undefined
  readonly #ledgerIdFor: ((runId: Uuid) => Uuid) | undefined
  readonly #runBinding: CandidateRunBindingPort | undefined
  readonly #commit: CandidateCommitPort | undefined

  constructor(dependencies: CandidateSubmissionDependencies) {
    this.#deps = dependencies
    this.#maxCandidates = dependencies.maxCandidates ?? DEFAULT_MAX_CANDIDATES
    this.#maxLinks = dependencies.maxLinksPerCandidate ?? DEFAULT_MAX_LINKS
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#budget = dependencies.budget
    this.#ledgerIdFor = dependencies.ledgerIdFor
    this.#runBinding = dependencies.runBinding
    this.#commit = dependencies.commit
    if (this.#budget !== undefined && this.#ledgerIdFor === undefined) {
      throw new SubmitCandidatesError('INVALID_COMMAND', 'a candidate budget needs a ledger-id resolver')
    }
    if (this.#commit !== undefined && this.#runBinding === undefined) {
      throw new SubmitCandidatesError('INVALID_COMMAND', 'the atomic commit port needs the run binding port')
    }
  }

  async findReceipt(scopeRef: ScopeRef, runId: Uuid, idempotencyKey: string, ctx: ToolContext): Promise<SubmitCandidatesReceipt | undefined> {
    const scope = scopeOf(ctx)
    assertScope(scope, scopeRef)
    const record = await this.#deps.receipts.findByKey(scope, { runId, idempotencyKey }, ctx)
    return record?.receipt
  }

  async submit(
    scopeRef: ScopeRef,
    request: SubmitCandidatesRequest,
    ctx: ToolContext,
    options: { readonly fence?: CandidateDispatchFence } = {},
  ): Promise<SubmitCandidatesReceipt> {
    const scope = scopeOf(ctx)
    assertScope(scope, scopeRef)
    const command = request.command
    assertSubmitCandidatesCommandShape(command)
    if (!isUuid(request.runId) || typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
      throw new SubmitCandidatesError('INVALID_COMMAND', 'a host run id and idempotency key are required')
    }
    if (command.candidates.length > this.#maxCandidates) {
      throw new SubmitCandidatesError('CANDIDATE_LIMIT_EXCEEDED', `a submission carries at most ${String(this.#maxCandidates)} candidates`)
    }

    const commandDigest = sha256DigestOf(canonicalJson(command))
    const existing = await this.#deps.receipts.findByKey(scope, { runId: request.runId, idempotencyKey: request.idempotencyKey }, ctx)
    if (existing !== undefined) {
      if (existing.commandDigest !== commandDigest) {
        throw new SubmitCandidatesError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused for a different submission')
      }
      return { ...structuredClone(existing.receipt), replayed: true }
    }

    // ① Resolve the run's frozen binding (design §7, S08). When the atomic commit port is mounted the
    // target workspace and the pinned draft come from the run — never from the model's command and
    // never from "the latest draft". A command aimed at another workspace, or a moved draft, is
    // refused rather than retargeted.
    const binding = await this.#resolveBinding(scope, request, ctx)
    const workspaceId = binding?.workspaceId ?? command.workspaceId
    if (binding !== undefined && command.workspaceId !== binding.workspaceId) {
      throw new SubmitCandidatesError('SCOPE_MISMATCH', 'a candidate command must target the run-bound workspace')
    }
    const workspace = await this.#deps.workspaces.getWorkspace(scope, workspaceId, ctx)
    if (workspace === undefined) throw new SubmitCandidatesError('SCOPE_MISMATCH', `workspace ${workspaceId} is not visible in this scope`)
    if (workspace.state === 'archived') throw new SubmitCandidatesError('SCOPE_MISMATCH', 'an archived workspace cannot receive candidates')
    await this.#assertFence(request.runId, ctx)

    const roles = ctx.principal.roles
    const rejected: Rejection[] = []
    const prepared: PreparedCandidate[] = []
    command.candidates.forEach((submission, submissionIndex) => {
      const denial = permissionDenial(submission, roles)
      if (denial !== undefined) rejected.push({ submissionIndex, code: 'PERMISSION_DENIED', message: denial })
      else prepared.push({ submissionIndex, submission })
    })

    // ② Evidence authorization + digest, resolved against this run's staged material only.
    const resolvedByIndex = new Map<number, readonly ResolvedCandidateEvidence[]>()
    for (const candidate of prepared) {
      try {
        const evidence = await this.#deps.evidence.resolve(
          { workspaceId, runId: request.runId, evidence: candidate.submission.evidence },
          ctx,
        )
        resolvedByIndex.set(candidate.submissionIndex, evidence)
      } catch (error) {
        rejected.push({
          submissionIndex: candidate.submissionIndex,
          code: error instanceof SubmitCandidatesError ? error.code : 'EVIDENCE_NOT_AUTHORIZED',
          message: error instanceof Error ? error.message : 'the evidence could not be authorized',
        })
      }
    }

    // ② continued: the fixed draft the run was admitted against (or, on the legacy path, the latest
    // draft). The build below never re-reads a newer draft to replace the run input.
    const draft = await this.#resolveDraft(scope, workspaceId, binding, ctx)
    const recordedAt = this.#now()

    // Reserve this submission's candidate units on the run's one ledger before any write. The
    // reservation is keyed by the host idempotency key, so a replay reuses it and two separate
    // submissions cannot jointly exceed `candidateLimit`.
    const candidateReservationId = await this.#reserveCandidates(request, command.candidates.length, ctx)

    const build = async (writer: CandidateWriter): Promise<{ accepted: ReceiptEntry[]; links: CandidateSubmissionRecord['links'][number][] }> => {
      const accepted: ReceiptEntry[] = []
      const links: CandidateSubmissionRecord['links'][number][] = []
      const definitionEntries = prepared.filter((candidate) => candidate.submission.kind === 'definition' && resolvedByIndex.has(candidate.submissionIndex))
      if (definitionEntries.length > 0) {
        const built = await this.#submitDefinitions(writer, workspace, draft, definitionEntries, resolvedByIndex, request, recordedAt, ctx)
        accepted.push(...built.accepted)
        links.push(...built.links)
      }
      for (const candidate of prepared) {
        const evidence = resolvedByIndex.get(candidate.submissionIndex)
        if (evidence === undefined || candidate.submission.kind === 'definition') continue
        try {
          const result = await this.#submitNonDefinition(writer, candidate, evidence, workspace, draft, request, recordedAt)
          accepted.push(result.entry)
          links.push(...result.links)
        } catch (error) {
          rejected.push({
            submissionIndex: candidate.submissionIndex,
            code: error instanceof SubmitCandidatesError ? error.code : 'STORE_FAILED',
            message: error instanceof Error ? error.message : 'the candidate could not be written',
          })
        }
      }
      return { accepted, links }
    }

    // ⑤ Atomic path: one fence-checked transaction writes the candidates, their links and the
    // receipt, so a cancel/lease race or a crash between them can never leave an orphan candidate.
    if (this.#commit !== undefined && binding !== undefined) {
      const ledgerId = this.#ledgerIdFor?.(request.runId)
      const commitRequest = {
        runId: request.runId,
        idempotencyKey: request.idempotencyKey,
        commandDigest,
        binding,
        ...(options.fence === undefined ? {} : { fence: options.fence }),
        ...(ledgerId === undefined || candidateReservationId === undefined ? {} : { ledgerId, reservationId: candidateReservationId }),
      }
      try {
        const stored = await this.#commit.commit(scope, commitRequest, ctx, async (tx) => {
          const { accepted, links } = await build(this.#commitWriter(tx, ctx))
          const record: CandidateSubmissionRecord = {
            schemaVersion: 'candidate-submission-record@1',
            runId: request.runId,
            workspaceId: binding.workspaceId,
            idempotencyKey: request.idempotencyKey,
            commandDigest,
            receipt: {
              schemaVersion: 'submit-candidates-receipt@1', runId: request.runId, workspaceId: binding.workspaceId,
              commandDigest, accepted, rejected: [...rejected], replayed: false, recordedAt,
            },
            links,
            createdBy: ctx.principal.subjectId,
            recordedAt,
          }
          await tx.record(record)
          return record
        })
        await this.#settleCandidates(request.runId, candidateReservationId, stored.record.receipt.accepted, ctx)
        return stored.replayed ? { ...structuredClone(stored.record.receipt), replayed: true } : stored.record.receipt
      } catch (error) {
        // The transaction rolled back, so no candidate was left behind; release the reservation
        // instead of leaking it, then surface the classified reason.
        await this.#settleCandidates(request.runId, candidateReservationId, [], ctx, { release: true })
        if (error instanceof CandidateCommitError) {
          throw new SubmitCandidatesError(commitDenialCode(error.code), error.message, { cause: error })
        }
        throw error
      }
    }

    await this.#assertFence(request.runId, ctx)
    const { accepted, links } = await build(this.#legacyWriter(scope, ctx))
    const receipt: SubmitCandidatesReceipt = {
      schemaVersion: 'submit-candidates-receipt@1',
      runId: request.runId,
      workspaceId,
      commandDigest,
      accepted,
      rejected,
      replayed: false,
      recordedAt,
    }
    const record: CandidateSubmissionRecord = {
      schemaVersion: 'candidate-submission-record@1',
      runId: request.runId,
      workspaceId,
      idempotencyKey: request.idempotencyKey,
      commandDigest,
      receipt,
      links,
      createdBy: ctx.principal.subjectId,
      recordedAt,
    }
    const stored = await this.#deps.receipts.record(scope, { record }, ctx)
    await this.#settleCandidates(request.runId, candidateReservationId, accepted, ctx)
    return stored.replayed ? { ...structuredClone(stored.record.receipt), replayed: true } : receipt
  }

  /** Resolve the run's frozen binding, refusing a run that is not an admitted research run. */
  async #resolveBinding(scope: ScopeRef, request: SubmitCandidatesRequest, ctx: ToolContext): Promise<CandidateRunBinding | undefined> {
    if (this.#runBinding === undefined) return undefined
    const binding = await this.#runBinding.resolve(scope, request.runId, ctx)
    if (binding === undefined || binding.runId !== request.runId) {
      throw new SubmitCandidatesError('SCOPE_MISMATCH', 'the run has no frozen research binding and cannot author candidates')
    }
    return binding
  }

  /** The fixed draft the run was admitted against; on the legacy path, the latest draft. */
  async #resolveDraft(scope: ScopeRef, workspaceId: Uuid, binding: CandidateRunBinding | undefined, ctx: ToolContext): Promise<Draft> {
    if (binding === undefined) {
      const latest = await readLatestWorkspaceDraft(this.#deps.workspaces, scope, workspaceId, ctx)
      if (latest === undefined) throw new SubmitCandidatesError('SCOPE_MISMATCH', 'the workspace has no pinned document set')
      return latest
    }
    const pinned = await this.#deps.workspaces.getDraft(scope, workspaceId, binding.draftRevision, ctx)
    if (pinned === undefined || pinned.digest !== binding.draftDigest) {
      throw new SubmitCandidatesError('FENCE_STALE', 'the run draft moved since the run was admitted; reopen the run instead of submitting again')
    }
    return pinned
  }

  #legacyWriter(scope: ScopeRef, ctx: ToolContext): CandidateWriter {
    const deps = this.#deps
    return {
      insertDefinitions: (batch, candidates, guard) => deps.definitionCandidates.insertBatch(scope, batch, candidates, ctx, guard),
      ingestSource: async (input) => {
        if (deps.sourceIngestion === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'source proposal is not configured')
        const source = await deps.sourceIngestion.ingestArchivedWebSnapshot(input, ctx)
        return { sourceId: source.sourceId, reviewState: source.reviewState }
      },
      saveRule: async (workspaceId, input) => {
        if (deps.ruleActions === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'rule/action submission is not configured')
        return deps.ruleActions.saveRuleCandidate(workspaceId, input, ctx.principal.subjectId, ctx)
      },
      saveAction: async (workspaceId, input) => {
        if (deps.ruleActions === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'rule/action submission is not configured')
        return deps.ruleActions.saveActionCandidate(workspaceId, input, ctx.principal.subjectId, ctx)
      },
    }
  }

  #commitWriter(tx: CandidateCommitTransaction, ctx: ToolContext): CandidateWriter {
    const deps = this.#deps
    return {
      insertDefinitions: (batch, candidates, guard) => tx.insertDefinitionBatch(batch, candidates, guard),
      ingestSource: async (input) => {
        if (deps.sourceIngestion === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'source proposal is not configured')
        const source = deps.sourceIngestion.prepareArchivedWebSnapshot(input, ctx)
        const stored = await tx.putSource({ source, idempotencyKey: input.idempotencyKey })
        return { sourceId: stored.sourceId, reviewState: stored.reviewState }
      },
      saveRule: async (workspaceId, input) => {
        if (deps.ruleActions === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'rule/action submission is not configured')
        const version = await deps.ruleActions.prepareRuleCandidate(workspaceId, input, ctx.principal.subjectId, ctx)
        return tx.insertRuleCandidate(version)
      },
      saveAction: async (workspaceId, input) => {
        if (deps.ruleActions === undefined) throw new SubmitCandidatesError('STORE_FAILED', 'rule/action submission is not configured')
        const version = await deps.ruleActions.prepareActionCandidate(workspaceId, input, ctx.principal.subjectId, ctx)
        return tx.insertActionCandidate(version)
      },
    }
  }

  /**
   * Reserve the submission's candidate units on the run ledger. `candidateLimit` is a hard
   * ceiling on the *same* ledger as every other research dimension, so paging/retriage/resume
   * cannot bypass it and two concurrent submissions for the last units resolve to one winner.
   */
  async #reserveCandidates(request: SubmitCandidatesRequest, candidates: number, ctx: ToolContext): Promise<Uuid | undefined> {
    if (this.#budget === undefined || this.#ledgerIdFor === undefined) return undefined
    const ledgerId = this.#ledgerIdFor(request.runId)
    const outcome = await this.#budget.reserve({
      ledgerId,
      idempotencyKey: `research-candidates:${request.runId}:${sha256DigestOf(request.idempotencyKey)}`,
      toolCalls: 0,
      candidates,
    }, ctx)
    if (!outcome.granted || outcome.reservation === undefined) {
      throw new SubmitCandidatesError(
        'CANDIDATE_LIMIT_EXCEEDED',
        outcome.denial?.message ?? 'the run candidate budget is exhausted',
      )
    }
    return outcome.reservation.reservationId
  }

  /**
   * Close the candidate reservation with the real evidence of what was written.
   *
   * The measured amount is the number of candidates the receipt actually **accepted**, not the
   * number submitted: a submission whose candidate was rejected (permission, evidence, schema)
   * wrote nothing, and charging it would permanently burn `candidateLimit` for a candidate that
   * does not exist. Count dimensions are monotonic, so this is the only point where the real
   * amount can be established.
   */
  async #settleCandidates(
    runId: Uuid,
    reservationId: Uuid | undefined,
    accepted: readonly ReceiptEntry[],
    ctx: ToolContext,
    outcome: { readonly release: boolean } = { release: false },
  ): Promise<void> {
    if (this.#budget === undefined || this.#ledgerIdFor === undefined || reservationId === undefined) return
    const ledgerId = this.#ledgerIdFor(runId)
    const refs = [...new Map(accepted.flatMap((entry) => entry.sourceRefs).map((ref) => [ref.id, ref])).values()]
    if (outcome.release) {
      // The commit rolled back: no candidate, link or receipt was written, so give the whole
      // reservation back instead of charging quota for a write that never happened.
      await this.#budget.settle({
        ledgerId,
        reservationId,
        status: 'cancelled',
        usage: { durationMs: 0 },
        evidenceRefs: [],
        release: true,
      }, ctx).catch(() => undefined)
      return
    }
    await this.#budget.settle({
      ledgerId,
      reservationId,
      // `completed` needs at least one persisted evidence reference; a candidate that wrote no
      // source link (or none at all) is settled as failed, and the measured count still tells the
      // truth about how many candidates this command actually created.
      status: refs.length === 0 ? 'failed' : 'completed',
      usage: { durationMs: 0 },
      measured: { candidates: accepted.length },
      // This service knows exactly how many candidates it wrote, so units it reserved for rejected
      // submissions are returned instead of permanently burning `candidateLimit`.
      refundUnused: true,
      evidenceRefs: refs,
    }, ctx).catch(() => undefined)
  }

  /**
   * Re-ground a definition candidate after its source was reviewed + admitted (design §7). The
   * candidate keeps its content; the service re-reads the now-approved source, appends a **new**
   * candidate version and drops the block. It never edits the earlier candidate, so the old block is
   * not washed away in place, and a review that did not actually admit the source cannot pass.
   */
  async reground(workspaceId: Uuid, candidateId: Uuid, expectedContentDigest: string, idempotencyKey: string, ctx: ToolContext): Promise<{ readonly candidateId: Uuid; readonly newCandidateId: Uuid; readonly sourceRefs: readonly ResourceRef[]; readonly replayed: boolean }> {
    const scope = scopeOf(ctx)
    if (!isUuid(workspaceId) || !isUuid(candidateId)) throw new SubmitCandidatesError('INVALID_COMMAND', 're-grounding requires a workspace and candidate id')
    const original = await this.#deps.definitionCandidates.getCandidate(scope, candidateId, ctx)
    if (original === undefined || original.workspaceId !== workspaceId) throw new SubmitCandidatesError('SCOPE_MISMATCH', 'the candidate is not visible in this workspace')
    if (original.contentDigest !== expectedContentDigest) throw new SubmitCandidatesError('FENCE_STALE', 'the candidate moved before re-grounding')
    const storedLinks = await this.#deps.receipts.listLinksForCandidate(scope, candidateId, ctx)
    if (storedLinks.length === 0) throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', 'the candidate has no source link to re-ground')
    const grounding = this.#deps.sourceGrounding
    if (grounding === undefined) throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', 'source grounding is not configured for re-grounding')
    const draft = await readLatestWorkspaceDraft(this.#deps.workspaces, scope, workspaceId, ctx)
    if (draft === undefined) throw new SubmitCandidatesError('SCOPE_MISMATCH', 'the workspace has no pinned document set')
    // Deduplicate by identity so a source cited by several evidence items is not sent to grounding
    // twice (grounding requires unique references) while keeping every distinct cited source.
    const sourceRefs = [...new Map(storedLinks.map((link) => [link.sourceRef.id, link.sourceRef])).values()]
    const read = await grounding.read({ workspaceId, sourceRefs,
      inputDraftRef: { workspaceId: draft.workspaceId, revision: draft.revision, digest: draft.digest } }, ctx, new SourceGroundingBudget(new AbortController().signal))
    const fragments = groundingFragments(read.sources)
    if (fragments.length === 0) throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', 'no approved source fragment is available to re-ground the candidate')
    // Every cited source must now be reviewed, admitted and grounding. Checking that all linked
    // sources produced a fragment (not merely that the fragments that exist are fine) is what stops
    // a partially-reviewed candidate from being unblocked: approving one of two sources is not enough.
    const groundedRefIds = new Set(fragments.map((fragment) => fragment.sourceRef.id))
    const missing = sourceRefs.filter((sourceRef) => !groundedRefIds.has(sourceRef.id))
    if (missing.length > 0) {
      throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', `every cited source must be reviewed and admitted before re-grounding (${String(missing.length)} still unresolved)`)
    }
    if (fragments.some((fragment) => !sourceTrustTierGroundsPublication(fragment.trustTier))) {
      throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', 'the source is still not approved for publication')
    }
    const rebuilt = buildDefinitionCandidate({
      workspaceId,
      batchId: this.#newId(),
      recordedAt: this.#now(),
      inputDraftRef: { workspaceId: draft.workspaceId, revision: draft.revision, digest: draft.digest, ...(original.inputDraftRef.contextDigest === undefined ? {} : { contextDigest: original.inputDraftRef.contextDigest }) },
      terminology: EMPTY_TERMINOLOGY,
      knownObjectIds: new Set(),
      logicalIdCounts: new Map([[original.logicalId, 1]]),
      kindAllowed: true,
      draft: toDraft(original.payload),
      evidence: { sourceRefs: fragments.map((fragment) => fragment.sourceRef), sourceSpans: fragments.map((fragment) => fragment.sourceSpan), provenanceMissing: false, trustBlocked: false },
      idempotencyNamespace: bound(idempotencyKey, '#reground'),
      ordinal: 0,
    })
    const next: AssetCandidateVersion = { ...rebuilt, candidateId: candidateIdFor(rebuilt.idempotencyKey), replacesCandidateId: original.candidateId,
      state: 'pending_review', pendingConfirmation: false,
      issues: original.issues.filter((issue) => issue.code !== 'SOURCE_TRUST_BLOCKED' && issue.code !== 'MISSING_PROVENANCE') }
    const history = await this.#deps.definitionCandidates.listCandidates(scope, workspaceId, { limit: MAX_DEFINITION_HISTORY + 1 }, ctx)
    const guard: AssetCandidateInsertGuard = { expectedWorkspaceRevision: draft.revision, currentCandidatePins: pinsOf(history) }
    const batch: AssetCandidateBatch = {
      batchId: next.batchId, workspaceId, domain: 'definition', inputDraftRef: next.inputDraftRef,
      modelRef: CANDIDATE_SUBMISSION_MODEL_REF, responseSchemaRef: CANDIDATE_SUBMISSION_SCHEMA_REF,
      schemaDigest: CANDIDATE_SUBMISSION_SCHEMA_REF.digest, documentSetRef: draft.documentSetRef,
      generationPolicyRef: CANDIDATE_SUBMISSION_SCHEMA_REF, state: 'completed', counts: countOf([next]),
      idempotencyKey: bound(idempotencyKey, '#reground-batch'), requestDigest: next.contentDigest,
      createdBy: ctx.principal.subjectId, recordedAt: this.#now(),
    }
    const inserted = await this.#deps.definitionCandidates.insertBatch(scope, batch, [next], ctx, guard)
    return { candidateId, newCandidateId: next.candidateId, sourceRefs: next.sourceRefs, replayed: !inserted.created }
  }

  async #submitDefinitions(
    writer: CandidateWriter,
    workspace: { readonly workspaceId: Uuid; readonly boundary: IndustryWorkspaceBoundary; readonly latestPublishedPackRef?: VersionRef },
    draft: Draft,
    entries: readonly PreparedCandidate[],
    resolvedByIndex: ReadonlyMap<number, readonly ResolvedCandidateEvidence[]>,
    request: SubmitCandidatesRequest,
    recordedAt: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<{ accepted: ReceiptEntry[]; links: CandidateSubmissionRecord['links'][number][] }> {
    const scope = scopeOf(ctx)
    const proposals = entries.map((entry) => toDraft((entry.submission as { payload: DefinitionCandidateProposal }).payload))
    const terminology = (await this.#deps.terminology.getTerminology(scope, workspace.latestPublishedPackRef ?? draft.basePackRef, ctx)) ?? EMPTY_TERMINOLOGY
    const history = await this.#deps.definitionCandidates.listCandidates(scope, workspace.workspaceId, { limit: MAX_DEFINITION_HISTORY + 1 }, ctx)
    if (history.length > MAX_DEFINITION_HISTORY) throw new SubmitCandidatesError('CANDIDATE_LIMIT_EXCEEDED', 'definition rebase history exceeds its bound')
    const knownObjectIds = knownObjectsOf(terminology, proposals)
    for (const candidate of candidateHeads(history)) if (candidate.kind === 'object' && candidate.state !== 'failed' && candidate.state !== 'rejected') knownObjectIds.add(candidate.logicalId)
    const logicalIdCounts = new Map<string, number>()
    for (const proposal of proposals) logicalIdCounts.set(proposal.logicalId, (logicalIdCounts.get(proposal.logicalId) ?? 0) + 1)
    const contextDigest = sha256DigestOf(canonicalJson({ operation: 'submit_candidates', boundary: workspace.boundary, mountedRef: workspace.latestPublishedPackRef ?? draft.basePackRef, documentSetRef: draft.documentSetRef }))
    const inputDraftRef = { workspaceId: workspace.workspaceId, revision: draft.revision, digest: draft.digest, contextDigest }
    const batchId = this.#newId()
    const built = entries.map((entry, ordinal) => {
      const evidence = resolvedByIndex.get(entry.submissionIndex) ?? []
      const trustBlocked = evidence.some((item) => !sourceTrustTierGroundsPublication(item.trustTier))
      const proposal = proposals[ordinal]
      if (proposal === undefined) throw new SubmitCandidatesError('INVALID_COMMAND', 'a definition proposal is missing')
      return buildDefinitionCandidate({
        workspaceId: workspace.workspaceId, batchId, recordedAt, inputDraftRef, terminology, knownObjectIds, logicalIdCounts,
        kindAllowed: true, draft: proposal,
        evidence: { sourceRefs: evidence.map((item) => item.sourceRef), sourceSpans: evidence.flatMap((item) => (item.sourceSpan === undefined ? [] : [item.sourceSpan])), provenanceMissing: false, trustBlocked },
        idempotencyNamespace: bound(request.idempotencyKey, '#definitions'), ordinal,
      })
    })
    const counts = countOf(built)
    const batch: AssetCandidateBatch = {
      batchId, workspaceId: workspace.workspaceId, domain: 'definition', inputDraftRef,
      modelRef: CANDIDATE_SUBMISSION_MODEL_REF, responseSchemaRef: CANDIDATE_SUBMISSION_SCHEMA_REF,
      schemaDigest: CANDIDATE_SUBMISSION_SCHEMA_REF.digest, documentSetRef: draft.documentSetRef,
      generationPolicyRef: CANDIDATE_SUBMISSION_SCHEMA_REF,
      state: counts.total > 0 && counts.pendingConfirmation === counts.total ? 'pending_confirmation' : 'completed',
      counts, idempotencyKey: bound(request.idempotencyKey, '#definitions'),
      requestDigest: sha256DigestOf(canonicalJson({ operation: 'submit_candidates_definitions', workspaceId: workspace.workspaceId, digests: built.map((candidate) => candidate.contentDigest) })),
      createdBy: ctx.principal.subjectId, recordedAt,
    }
    const guard: AssetCandidateInsertGuard = { expectedWorkspaceRevision: draft.revision, currentCandidatePins: pinsOf(history) }
    const inserted = await writer.insertDefinitions(batch, built, guard)
    const accepted = built.map((candidate, ordinal) => ({
      submissionIndex: entries[ordinal]?.submissionIndex ?? ordinal,
      candidateId: candidate.candidateId,
      kind: 'definition' as const,
      state: candidate.state,
      pendingConfirmation: candidate.pendingConfirmation,
      issues: candidate.issues,
      sourceRefs: candidate.sourceRefs,
    }))
    const links = this.#linksFor(inserted.candidates, entries, resolvedByIndex, recordedAt)
    return { accepted, links }
  }

  async #submitNonDefinition(
    writer: CandidateWriter,
    candidate: PreparedCandidate,
    evidence: readonly ResolvedCandidateEvidence[],
    workspace: { readonly workspaceId: Uuid },
    draft: Draft,
    request: SubmitCandidatesRequest,
    recordedAt: Rfc3339UtcTimestamp,
  ): Promise<{ entry: ReceiptEntry; links: CandidateSubmissionRecord['links'][number][] }> {
    const submission = candidate.submission
    if (submission.kind === 'source') {
      const page = evidence.find((item) => item.url !== undefined)
      if (page === undefined || page.url === undefined) throw new SubmitCandidatesError('EVIDENCE_NOT_AUTHORIZED', 'a source candidate requires an archived web page evidence')
      const source = await writer.ingestSource({
        workspaceId: workspace.workspaceId,
        url: page.url,
        ...(submission.title === undefined ? {} : { title: submission.title }),
        ...(submission.origin.publisher === undefined ? {} : { publisher: submission.origin.publisher }),
        ...(submission.origin.standardRef === undefined ? {} : { standardRef: submission.origin.standardRef }),
        fetchedAt: submission.origin.fetchedAt ?? recordedAt,
        retrievedAt: recordedAt,
        contentRef: page.sourceRef,
        contentDigest: page.contentDigest,
        idempotencyKey: bound(request.idempotencyKey, `#source:${String(candidate.submissionIndex)}`),
      })
      return {
        entry: { submissionIndex: candidate.submissionIndex, candidateId: source.sourceId, kind: 'source', state: source.reviewState, pendingConfirmation: true, issues: [], sourceRefs: evidence.map((item) => item.sourceRef) },
        links: this.#links(source.sourceId, 'source', candidate.submissionIndex, evidence, recordedAt),
      }
    }
    if (evidence.some((item) => !sourceTrustTierGroundsPublication(item.trustTier))) {
      throw new SubmitCandidatesError('SOURCE_TRUST_BLOCKED', 'a rule/action candidate requires every source to be approved before it can be proposed')
    }
    const sourceRefs = evidence.map((item) => item.sourceRef)
    const sourceSpans = evidence.flatMap((item) => (item.sourceSpan === undefined ? [] : [item.sourceSpan]))
    if (submission.kind === 'rule') {
      const version = await writer.saveRule(workspace.workspaceId, {
        displayName: submission.payload.ruleId, businessMeaning: submission.reason, suggestedReason: submission.reason,
        ruleId: submission.payload.ruleId, applicability: submission.payload.applicability,
        condition: submission.payload.condition, exceptions: submission.payload.exceptions,
        ...(submission.payload.conclusion === undefined ? {} : { conclusion: submission.payload.conclusion }),
        ruleDependencies: submission.payload.ruleDependencies,
        ...(submission.payload.dependencyRefs === undefined ? {} : { dependencyRefs: submission.payload.dependencyRefs }),
        sourceRefs, sourceSpans, expectedRevision: draft.revision,
        idempotencyKey: bound(request.idempotencyKey, `#rule:${String(candidate.submissionIndex)}`),
      })
      return {
        entry: { submissionIndex: candidate.submissionIndex, candidateId: version.candidateId, kind: 'rule', state: version.lifecycle, pendingConfirmation: false, issues: [], sourceRefs },
        links: this.#links(version.candidateId, 'rule', candidate.submissionIndex, evidence, recordedAt),
      }
    }
    if (submission.kind !== 'action') throw new SubmitCandidatesError('INVALID_COMMAND', 'the submission is not an action candidate')
    const version = await writer.saveAction(workspace.workspaceId, {
      declaration: submission.declaration, sourceRefs, sourceSpans, expectedRevision: draft.revision,
      idempotencyKey: bound(request.idempotencyKey, `#action:${String(candidate.submissionIndex)}`),
    })
    return {
      entry: { submissionIndex: candidate.submissionIndex, candidateId: version.candidateId, kind: 'action', state: version.lifecycle, pendingConfirmation: false, issues: [], sourceRefs },
      links: this.#links(version.candidateId, 'action', candidate.submissionIndex, evidence, recordedAt),
    }
  }

  #linksFor(
    candidates: readonly AssetCandidateVersion[],
    entries: readonly PreparedCandidate[],
    resolvedByIndex: ReadonlyMap<number, readonly ResolvedCandidateEvidence[]>,
    recordedAt: Rfc3339UtcTimestamp,
  ): CandidateSubmissionRecord['links'][number][] {
    const links: CandidateSubmissionRecord['links'][number][] = []
    candidates.forEach((candidate, ordinal) => {
      const entry = entries[ordinal]
      if (entry === undefined) return
      links.push(...this.#links(candidate.candidateId, 'definition', entry.submissionIndex, resolvedByIndex.get(entry.submissionIndex) ?? [], recordedAt))
    })
    return links
  }

  #links(
    candidateId: Uuid,
    candidateKind: CandidateSubmission['kind'],
    submissionIndex: number,
    evidence: readonly ResolvedCandidateEvidence[],
    recordedAt: Rfc3339UtcTimestamp,
  ): CandidateSubmissionRecord['links'][number][] {
    return evidence.slice(0, this.#maxLinks).map((item) => ({
      candidateId, candidateKind, submissionIndex, evidenceIndex: item.index, sourceRef: item.sourceRef,
      ...(item.sourceSpan === undefined ? {} : { sourceSpan: item.sourceSpan }),
      trustTier: item.trustTier, parserVersion: item.parserVersion,
      pendingConfirmation: !sourceTrustTierGroundsPublication(item.trustTier) || !item.reReadVerified,
      recordedAt,
    }))
  }

  async #assertFence(runId: Uuid, ctx: ToolContext): Promise<void> {
    if (this.#deps.fence === undefined) return
    if (await this.#deps.fence.isCancelled(runId, ctx)) {
      throw new SubmitCandidatesError('FENCE_STALE', 'the run was cancelled or its authorization revoked')
    }
  }
}

function permissionDenial(submission: CandidateSubmission, roles: readonly string[]): string | undefined {
  if (submission.kind === 'source') {
    return roles.some((role) => RESEARCHER_ROLES.includes(role) || EDITOR_ROLES.includes(role))
      ? undefined
      : 'proposing a source requires a researcher or editor role'
  }
  return roles.some((role) => EDITOR_ROLES.includes(role))
    ? undefined
    : `proposing a ${submission.kind} candidate requires an editor or platform-admin role`
}

/** Project an atomic-commit fence denial onto the command's stable rejection code. */
function commitDenialCode(code: CandidateCommitError['code']): SubmitCandidatesError['code'] {
  switch (code) {
    case 'RUN_CANCELLED':
    case 'LEASE_LOST':
    case 'AUTHORIZATION_REVOKED':
    case 'DRAFT_CHANGED':
      return 'FENCE_STALE'
    case 'BUDGET_EXHAUSTED':
      return 'CANDIDATE_LIMIT_EXCEEDED'
    case 'SCOPE_MISMATCH':
      return 'SCOPE_MISMATCH'
    case 'STORE_FAILED':
      return 'STORE_FAILED'
  }
}

function assertScope(scope: ScopeRef, scopeRef: ScopeRef): void {
  if (scope.tenantId !== scopeRef.tenantId || scope.spaceId !== scopeRef.spaceId) {
    throw new SubmitCandidatesError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}
