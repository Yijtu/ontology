import type {
  AssetCandidateVersion, DefinitionApprovalPin, DefinitionValidationFinding,
  IndustryValidationReport, ReviewableCandidateReader, RuleActionCandidateVersion,
  RuleActionPublicationPin, ScopeRef, SemanticPublicationStore, ToolContext,
  AssetCandidateStore, RuleActionCandidateStore, IndustryWorkspaceStore, CommitApprovedPackInput,
  PublishedRuleDeclaration,
} from '@ontology/contracts'
import { PublishedPackAssetStoreError, assetDraftContent, publishedPackContent } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { currentDefinitionProjection } from '../definition-candidates/validation'

export type CandidateApprovalReader = Pick<SemanticPublicationStore, 'latestReviewRevision' | 'getReview'>

/** The ledger is the only approval truth. A produced lifecycle alone never approves content. */
export async function definitionApprovalPins(
  projection: readonly AssetCandidateVersion[],
  scope: ScopeRef,
  ctx: ToolContext,
  reader: ReviewableCandidateReader | undefined,
  reviews: CandidateApprovalReader | undefined,
): Promise<{ pins: DefinitionApprovalPin[]; blockers: DefinitionValidationFinding[] }> {
  const pins: DefinitionApprovalPin[] = []
  const blockers: DefinitionValidationFinding[] = []
  for (const candidate of projection) {
    const view = await reader?.readCandidate(scope, candidate.candidateId, ctx)
    const revision = await reviews?.latestReviewRevision(scope, candidate.candidateId, ctx)
    const review = revision === undefined ? undefined : await reviews?.getReview(scope, candidate.candidateId, revision, ctx)
    if (candidate.state === 'failed' || candidate.state === 'rejected' || candidate.pendingConfirmation ||
        candidate.state === 'pending_confirmation' || view?.domain !== 'definition' ||
        view.candidateId !== candidate.candidateId || view.contentDigest !== candidate.contentDigest || view.state !== candidate.state ||
        review?.decision !== 'approve' || review.candidateId !== candidate.candidateId || review.revision !== revision || review.contentDigest !== candidate.contentDigest) {
      blockers.push({ code: 'CANDIDATE_NOT_APPROVED', severity: 'blocker', candidateId: candidate.candidateId,
        logicalId: candidate.logicalId, path: 'approval', message: `candidate ${candidate.candidateId} needs a current content-pinned approval and a publishable state` })
    } else {
      pins.push({ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, reviewRevision: review.revision })
    }
  }
  return { pins, blockers }
}

/** Select the latest revision BEFORE filtering its lifecycle; a draft replacement disables its ancestor. */
export function currentRuleActionProjection(candidates: readonly RuleActionCandidateVersion[]): RuleActionCandidateVersion[] {
  const replaced = new Set(candidates.flatMap((candidate) => candidate.replacesCandidateId === undefined ? [] : [candidate.replacesCandidateId]))
  const latest = new Map<string, RuleActionCandidateVersion>()
  for (const candidate of candidates) {
    if (replaced.has(candidate.candidateId)) continue
    const previous = latest.get(candidate.logicalId)
    const timeDifference = previous === undefined ? 1 : Date.parse(candidate.recordedAt) - Date.parse(previous.recordedAt)
    if (previous === undefined || timeDifference > 0 || (timeDifference === 0 && previous.candidateId < candidate.candidateId)) latest.set(candidate.logicalId, candidate)
  }
  return [...latest.values()].sort((a, b) => a.logicalId.localeCompare(b.logicalId))
}

export function ruleActionPublicationPins(candidates: readonly RuleActionCandidateVersion[]): RuleActionPublicationPin[] {
  return candidates.flatMap((candidate) => candidate.lifecycle === 'enabled' && candidate.enabledAt !== undefined
    ? [{ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, enabledAt: candidate.enabledAt }]
    : [])
}

export async function ruleApprovalPins(candidates: readonly RuleActionCandidateVersion[], scope: ScopeRef, ctx: ToolContext,
  reader: ReviewableCandidateReader | undefined, reviews: CandidateApprovalReader | undefined): Promise<DefinitionApprovalPin[]> {
  const pins: DefinitionApprovalPin[] = []
  for (const candidate of candidates.filter((row) => row.kind === 'rule')) {
    const view = await reader?.readCandidate(scope, candidate.candidateId, ctx)
    const revision = await reviews?.latestReviewRevision(scope, candidate.candidateId, ctx)
    const review = revision === undefined ? undefined : await reviews?.getReview(scope, candidate.candidateId, revision, ctx)
    if (candidate.lifecycle !== 'enabled' || candidate.enabledAt === undefined || view?.domain !== 'definition' || view.kind !== 'rule' ||
      view.state !== 'enabled' || view.contentDigest !== candidate.contentDigest || review?.decision !== 'approve' || review.contentDigest !== candidate.contentDigest) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', `enabled rule ${candidate.logicalId} needs its current content-pinned ledger approval`)
    }
    pins.push({ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, reviewRevision: review.revision })
  }
  return pins.sort((a, b) => a.candidateId.localeCompare(b.candidateId))
}

export function publishedRuleDeclarationsOf(candidates: readonly RuleActionCandidateVersion[], pins: readonly DefinitionApprovalPin[]): PublishedRuleDeclaration[] {
  return candidates.flatMap((candidate): PublishedRuleDeclaration[] => {
    if (candidate.kind !== 'rule' || candidate.payload.kind !== 'rule' || candidate.lifecycle !== 'enabled') return []
    const pin = pins.find((item) => item.candidateId === candidate.candidateId && item.contentDigest === candidate.contentDigest)
    if (candidate.enabledAt === undefined || pin === undefined) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'published rule snapshot requires an exact reviewed enabled candidate')
    return [{ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, enabledAt: candidate.enabledAt, reviewRevision: pin.reviewRevision,
      payload: candidate.payload, sourceRefs: candidate.sourceRefs, sourceSpans: candidate.sourceSpans,
      ...(candidate.generationContext === undefined ? {} : { generationContext: candidate.generationContext }),
      ...(candidate.generationCallRef === undefined ? {} : { generationCallRef: candidate.generationCallRef }) }]
  }).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
}

/** Bind the full validation, including definition diff, strategy and candidate pins, into its evidence digest. */
export function industryValidationDigest(report: Omit<IndustryValidationReport, 'contentDigest'> & { readonly contentDigest?: string }): string {
  const { validationId, idempotencyKey, actor, recordedAt, contentDigest, ...evidence } = report
  void validationId; void idempotencyKey; void actor; void recordedAt; void contentDigest
  return sha256DigestOf(canonicalJson(evidence))
}

/** Injectable guard for in-memory composition; PostgreSQL rechecks the same pins in its transaction. */
export function createPackPublicationGuard(deps: {
  readonly workspaces: IndustryWorkspaceStore
  readonly definitionCandidates: AssetCandidateStore
  readonly ruleActions: RuleActionCandidateStore
  readonly reviewableCandidates: ReviewableCandidateReader
  readonly reviews: CandidateApprovalReader
}): (scope: ScopeRef, input: CommitApprovedPackInput, ctx: ToolContext) => Promise<void> {
  return async (scope, input, ctx) => {
    const workspace = await deps.workspaces.getWorkspace(scope, input.pack.workspaceId, ctx)
    if (input.sourceDraft !== undefined) {
      const source = await deps.workspaces.getDraft(scope, input.pack.workspaceId, input.expectedRevision, ctx)
      if (source === undefined || canonicalJson(source) !== canonicalJson(input.sourceDraft) || sha256DigestOf(canonicalJson(assetDraftContent(source))) !== source.digest || sha256DigestOf(canonicalJson(publishedPackContent(input.pack))) !== input.pack.contentDigest || input.pack.packRef.digest !== input.pack.contentDigest ||
        canonicalJson(input.pack.sourceDraftRef) !== canonicalJson({ workspaceId: source.workspaceId, revision: source.revision, digest: source.digest })) {
        throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'the exact publication source draft changed before commit')
      }
    } else if (input.pack.sourceDraftRef !== undefined) throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'a publication source receipt requires its actual draft')
    const definitions = await deps.definitionCandidates.listCandidates(scope, input.pack.workspaceId, { limit: 250 }, ctx)
    const actions = await deps.ruleActions.list(scope, input.pack.workspaceId, { limit: 250 }, ctx)
    const approved = await definitionApprovalPins(currentDefinitionProjection(definitions), scope, ctx, deps.reviewableCandidates, deps.reviews)
    const rulePins = await ruleApprovalPins(currentRuleActionProjection(actions).filter((candidate) => candidate.lifecycle === 'enabled'), scope, ctx, deps.reviewableCandidates, deps.reviews)
    if (workspace?.headRevision !== input.expectedRevision || definitions.length === 250 || actions.length === 250 ||
        canonicalJson(input.pack.approvalPins ?? []) !== canonicalJson(input.approvalPins ?? []) ||
        canonicalJson(input.pack.ruleActionPins ?? []) !== canonicalJson(input.ruleActionPins ?? []) ||
        approved.blockers.length > 0 || canonicalJson(approved.pins) !== canonicalJson(input.approvalPins ?? []) ||
        canonicalJson(ruleActionPublicationPins(currentRuleActionProjection(actions))) !== canonicalJson(input.ruleActionPins ?? []) ||
        canonicalJson(publishedRuleDeclarationsOf(currentRuleActionProjection(actions), rulePins)) !== canonicalJson(input.pack.ruleDeclarations ?? []) ||
        canonicalJson(rulePins) !== canonicalJson(input.ruleReviewPins ?? []) || canonicalJson(input.pack.ruleReviewPins ?? []) !== canonicalJson(rulePins)) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'publication pins changed before commit')
    }
  }
}
