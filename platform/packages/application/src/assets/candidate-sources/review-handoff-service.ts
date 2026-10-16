import { ReviewHandoffError, isToolContext, sourceLinkBlockReason, sourceTrustTierGroundsPublication } from '@ontology/contracts'
import type {
  AssetCandidateState,
  AssetCandidateStore,
  AssetCandidateVersion,
  CandidateReviewHandoff,
  CandidateSourceLink,
  CandidateSourceRecord,
  CandidateSourceReviewState,
  CandidateSubmissionRecord,
  CandidateSubmissionStore,
  CandidateSourceStore,
  ScopeRef,
  SourceAdmissionStore,
  SourceReviewHandoffLink,
  SourceReviewHandoffState,
  ToolContext,
  Uuid,
  WorkspaceReviewHandoff,
  WorkspaceReviewHandoffReader,
} from '@ontology/contracts'

const MAX_SOURCE_SCAN = 2000
const MAX_HISTORY = 2000

export interface CandidateReviewHandoffDependencies {
  readonly receipts: CandidateSubmissionStore
  readonly sources: CandidateSourceStore
  /** Present only when the deployment persists source admissions (needed to read 纳入状态). */
  readonly admissions?: Pick<SourceAdmissionStore, 'findAdmissionBySource'>
  /** Present only when definition candidates are persisted; used to read the re-grounding chain. */
  readonly definitionCandidates?: Pick<AssetCandidateStore, 'getCandidate' | 'listCandidates'>
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ReviewHandoffError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function isCandidateState(value: string): value is AssetCandidateState | 'proposed' | 'approved' | 'rejected' {
  return ['produced', 'pending_review', 'pending_confirmation', 'failed', 'rejected', 'proposed', 'approved'].includes(value)
}

/**
 * The read-only source→asset review hand-off projection (design §3/§4/§7).
 *
 * For every candidate an agent submitted whose sources are not all confirmed yet, it lists **each**
 * source separately with its own review state, admission state and grounding tier, and reports
 * whether the candidate is ready for formal asset review, still waiting on sources, or waiting on a
 * re-grounding. It never writes and never becomes a second approval truth; it only projects the
 * persisted sources, admissions, candidate versions and submit receipts in the trusted scope.
 *
 * Crucially, `allSourcesConfirmed` requires **every** related source to be approved + admitted + a
 * publication-grounding tier; a candidate that still has a pending source stays blocked, and one
 * whose sources are all approved but that has not been re-grounded stays `regrounding_required`.
 */
export class CandidateReviewHandoffService implements WorkspaceReviewHandoffReader {
  readonly #deps: CandidateReviewHandoffDependencies
  readonly #now: () => string

  constructor(dependencies: CandidateReviewHandoffDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async readHandoff(workspaceId: Uuid, ctx: ToolContext): Promise<WorkspaceReviewHandoff> {
    const scope = scopeOf(ctx)
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new ReviewHandoffError('INVALID_REQUEST', 'a workspace id is required to read the review hand-off')
    }
    const records = await this.#listOpenRecords(scope, workspaceId, ctx)
    const sourcesById = await this.#sourcesByContentRef(scope, workspaceId, ctx)
    const admissions = new Map<string, boolean>()
    if (this.#deps.admissions !== undefined) {
      for (const source of sourcesById.values()) {
        const admission = await this.#deps.admissions.findAdmissionBySource(scope, workspaceId, source.sourceId, ctx)
        admissions.set(source.sourceId, admission !== undefined)
      }
    }
    const candidates: CandidateReviewHandoff[] = []
    const seen = new Set<string>()
    for (const record of records) {
      for (const entry of record.receipt.accepted) {
        if (seen.has(entry.candidateId)) continue
        seen.add(entry.candidateId)
        const links = record.links.filter((link) => link.candidateId === entry.candidateId)
        if (links.length === 0) continue
        candidates.push(await this.#project(scope, workspaceId, entry.candidateId, entry.kind, entry.state, links, sourcesById, admissions, ctx))
      }
    }
    return { schemaVersion: 'review-handoff@1', scopeRef: scope, workspaceId, candidates, asOf: this.#now() }
  }

  async #listOpenRecords(scope: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<readonly CandidateSubmissionRecord[]> {
    if (this.#deps.receipts.listUnconfirmedByWorkspace === undefined) {
      throw new ReviewHandoffError('STORE_FAILED', 'the submission store cannot list unconfirmed candidates')
    }
    return this.#deps.receipts.listUnconfirmedByWorkspace(scope, workspaceId, ctx)
  }

  async #sourcesByContentRef(scope: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<Map<string, CandidateSourceRecord>> {
    const sources = await this.#deps.sources.listSources(scope, workspaceId, { limit: MAX_SOURCE_SCAN }, ctx)
    const out = new Map<string, CandidateSourceRecord>()
    for (const source of sources) out.set(source.contentRef.id, source)
    return out
  }

  async #project(
    scope: ScopeRef,
    workspaceId: Uuid,
    candidateId: Uuid,
    candidateKind: CandidateSubmissionRecord['receipt']['accepted'][number]['kind'],
    persistedState: string,
    links: readonly CandidateSourceLink[],
    sourcesById: ReadonlyMap<string, CandidateSourceRecord>,
    admissions: ReadonlyMap<string, boolean>,
    ctx: ToolContext,
  ): Promise<CandidateReviewHandoff> {
    const projected: SourceReviewHandoffLink[] = links
      .map((link) => this.#link(link, sourcesById, admissions))
      .sort((left, right) => left.index - right.index)
    const blockReasons = projected.map((link) => sourceLinkBlockReason(link)).filter((reason): reason is string => reason !== undefined)
    const allSourcesConfirmed = projected.length > 0 && blockReasons.length === 0
    const successor = allSourcesConfirmed && candidateKind === 'definition'
      ? await this.#regroundedSuccessor(scope, workspaceId, candidateId, ctx)
      : undefined
    const regrounded = successor !== undefined
    const readiness = allSourcesConfirmed
      ? (regrounded ? 'ready_for_review' as const : 'regrounding_required' as const)
      : 'pending_sources' as const
    const pendingConfirmation = !allSourcesConfirmed
    const blockCodes = allSourcesConfirmed
      ? (regrounded ? [] : ['REGROUNDING_REQUIRED'])
      : [...new Set(blockReasons)]
    return {
      candidateId,
      candidateKind,
      state: isCandidateState(persistedState) ? persistedState : 'pending_confirmation',
      blocked: !(allSourcesConfirmed && regrounded),
      blockCodes,
      pendingConfirmation,
      readiness,
      ...(successor === undefined ? {} : { regroundedCandidateId: successor.candidateId }),
      links: projected,
      allSourcesConfirmed,
    }
  }

  #link(link: CandidateSourceLink, sourcesById: ReadonlyMap<string, CandidateSourceRecord>, admissions: ReadonlyMap<string, boolean>): SourceReviewHandoffLink {
    const source = sourcesById.get(link.sourceRef.id)
    const common = {
      index: link.evidenceIndex,
      sourceRef: link.sourceRef,
      ...(link.sourceSpan === undefined ? {} : { sourceSpan: link.sourceSpan }),
    }
    if (source === undefined) {
      // Not a reviewed candidate source (e.g. an already-authorized document). The recorded link
      // flag is the truth; a non-blocking link reads as an approved, admitted source.
      const trustTier = link.trustTier
      const groundsPublication = sourceTrustTierGroundsPublication(trustTier)
      const blocked = link.pendingConfirmation || !groundsPublication
      const reviewState: SourceReviewHandoffState = blocked ? 'unknown' : 'approved'
      return {
        ...common, reviewState, trustTier,
        admitted: !blocked, groundsPublication,
        pendingConfirmation: blocked,
        ...(blocked ? { blockReason: 'SOURCE_TRUST_BLOCKED' } : {}),
      }
    }
    const reviewState = source.reviewState as CandidateSourceReviewState
    const admitted = admissions.get(source.sourceId) === true
    const groundsPublication = sourceTrustTierGroundsPublication(source.trustTier)
    const pendingConfirmation = reviewState !== 'approved' || !admitted || !groundsPublication
    const blockReason = sourceLinkBlockReason({ ...common, reviewState, trustTier: source.trustTier, admitted, groundsPublication, pendingConfirmation })
    return {
      ...common, reviewState, trustTier: source.trustTier, admitted, groundsPublication,
      pendingConfirmation: blockReason !== undefined,
      ...(blockReason === undefined ? {} : { blockReason }),
    }
  }

  /**
   * Find the head of the re-grounding chain that descends from a candidate. Re-grounding appends a
   * **new** version that points at the original via `replacesCandidateId`; finding it proves the
   * candidate was re-grounded without re-reading the (now approved) sources.
   */
  async #regroundedSuccessor(scope: ScopeRef, workspaceId: Uuid, candidateId: Uuid, ctx: ToolContext): Promise<AssetCandidateVersion | undefined> {
    const store = this.#deps.definitionCandidates
    if (store === undefined) return undefined
    const history = await store.listCandidates(scope, workspaceId, { limit: MAX_HISTORY + 1 }, ctx)
    if (history.length > MAX_HISTORY) throw new ReviewHandoffError('STORE_FAILED', 'the candidate history exceeds its explicit bound')
    const byPredecessor = new Map<string, AssetCandidateVersion>()
    for (const candidate of history) {
      if (candidate.replacesCandidateId !== undefined) byPredecessor.set(candidate.replacesCandidateId, candidate)
    }
    let current: AssetCandidateVersion | undefined = byPredecessor.get(candidateId)
    const visited = new Set<string>()
    while (current !== undefined && !visited.has(current.candidateId)) {
      visited.add(current.candidateId)
      if (current.pendingConfirmation === false) return current
      current = byPredecessor.get(current.candidateId)
    }
    return undefined
  }
}
