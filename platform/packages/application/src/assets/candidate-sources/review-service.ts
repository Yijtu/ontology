import {
  CandidateSourceError,
  assertCandidateSourceReviewCommandShape,
  assertSourceRetractionCommandShape,
  assertSourceTierPromotionCommandShape,
  isToolContext,
  SourceAdmissionError,
} from '@ontology/contracts'
import type {
  CandidateSourceReviewCommand,
  CandidateSourceReviewEvent,
  CandidateSourceReviewReceipt,
  CandidateSourceRetractionStore,
  CandidateSourceStore,
  ScopeRef,
  SourceRetraction,
  SourceRetractionCommand,
  SourceRetractionReceipt,
  SourceTierPromotionCommand,
  SourceTierPromotionReceipt,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const PROMOTION_ROLES: readonly string[] = ['platform-admin']

export interface CandidateSourceReviewServiceDependencies {
  readonly sources: CandidateSourceStore
  /** Present only when the deployment persists retraction events. */
  readonly retractions?: CandidateSourceRetractionStore
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new CandidateSourceError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * The source-review surface (design §2.2). A review is a compare-and-swap against the revision the
 * reviewer read, appends an auditable event and returns an idempotent receipt; the current source row
 * is only the latest projection of those events. The reviewer identity comes from the trusted
 * context, and a source that belongs to another workspace is rejected before any write.
 */
export class CandidateSourceReviewService {
  readonly #sources: CandidateSourceStore
  readonly #retractions: CandidateSourceRetractionStore | undefined

  constructor(dependencies: CandidateSourceReviewServiceDependencies) {
    this.#sources = dependencies.sources
    this.#retractions = dependencies.retractions
  }

  async review(command: CandidateSourceReviewCommand, ctx: ToolContext): Promise<CandidateSourceReviewReceipt> {
    const scope = scopeOf(ctx)
    this.#assertEditor(ctx)
    assertCandidateSourceReviewCommandShape(command)
    if (command.reviewedBy !== ctx.principal.subjectId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'the reviewedBy must be the trusted subject')
    }
    const source = await this.#sources.getSource(scope, command.sourceId, ctx)
    if (source === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${command.sourceId} is not visible in this scope`)
    if (source.workspaceId !== command.workspaceId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    }
    // Accepting/rejecting a source never changes its provenance tier (design §7): a review only
    // records the review state. Raising `agent_researched` to a publishable tier is a separate,
    // permissioned promotion (`promoteTier`), so review and promotion cannot be conflated.
    if (command.trustTier !== undefined && command.trustTier !== source.trustTier) {
      throw new CandidateSourceError('FORBIDDEN', 'changing a source trust tier is a separate promotion operation, not a review')
    }
    if (this.#sources.reviewSourceCommand === undefined) {
      throw new CandidateSourceError('STORE_FAILED', 'the store does not support append-only review events')
    }
    return this.#sources.reviewSourceCommand(scope, command, ctx)
  }

  /**
   * Promote a source's provenance tier (design §7). This is deliberately separate from a review and
   * requires a `platform-admin` role: accepting a source for modelling never by itself promotes an
   * agent-researched proposal to `public_standard`/`customer_authoritative`. The promotion appends
   * an auditable review event that keeps the review state and records the tier change, so the review
   * history still shows exactly when (and by whom) the tier moved.
   */
  async promoteTier(command: SourceTierPromotionCommand, ctx: ToolContext): Promise<SourceTierPromotionReceipt> {
    const scope = scopeOf(ctx)
    this.#assertPromoter(ctx)
    assertSourceTierPromotionCommandShape(command)
    if (command.promotedBy !== ctx.principal.subjectId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'the promotedBy must be the trusted subject')
    }
    const source = await this.#sources.getSource(scope, command.sourceId, ctx)
    if (source === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${command.sourceId} is not visible in this scope`)
    if (source.workspaceId !== command.workspaceId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    }
    if (source.trustTier === command.nextTrustTier) {
      throw new CandidateSourceError('INVALID_SOURCE', 'the promotion does not change the source trust tier')
    }
    if (this.#sources.reviewSourceCommand === undefined) {
      throw new CandidateSourceError('STORE_FAILED', 'the store does not support append-only review events')
    }
    const receipt = await this.#sources.reviewSourceCommand(scope, {
      schemaVersion: 'candidate-source-review@1',
      sourceId: command.sourceId,
      workspaceId: command.workspaceId,
      reviewState: source.reviewState,
      trustTier: command.nextTrustTier,
      reviewedBy: command.promotedBy,
      reason: command.reason,
      expectedRevision: command.expectedRevision,
      basisRefs: command.basisRefs,
      idempotencyKey: command.idempotencyKey,
    }, ctx)
    return {
      sourceId: receipt.sourceId,
      revision: receipt.revision,
      reviewState: receipt.reviewState,
      trustTier: receipt.trustTier,
      eventId: receipt.eventId,
      replayed: receipt.replayed,
    }
  }

  async listReviewEvents(workspaceId: Uuid, sourceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext): Promise<{ readonly events: readonly CandidateSourceReviewEvent[]; readonly nextCursor?: string }> {
    const scope = scopeOf(ctx)
    if (this.#sources.listReviewEvents === undefined) {
      throw new CandidateSourceError('STORE_FAILED', 'the store does not support append-only review events')
    }
    const source = await this.#sources.getSource(scope, sourceId, ctx)
    if (source === undefined) throw new CandidateSourceError('NOT_FOUND', `candidate source ${sourceId} is not visible in this scope`)
    if (source.workspaceId !== workspaceId) throw new CandidateSourceError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    return this.#sources.listReviewEvents(scope, sourceId, page, ctx)
  }

  /**
   * Retract a previously reviewed source: append an event and raise the visibility fence while the
   * original snapshot and review history stay readable. The current row keeps a new revision with
   * `retractedAt` set; it never deletes or rewrites the earlier events.
   */
  async retract(command: SourceRetractionCommand, ctx: ToolContext): Promise<SourceRetractionReceipt> {
    const scope = scopeOf(ctx)
    this.#assertEditor(ctx)
    assertSourceRetractionCommandShape(command)
    if (this.#retractions === undefined) {
      throw new SourceAdmissionError('STORE_FAILED', 'the deployment does not persist source retractions')
    }
    const source = await this.#sources.getSource(scope, command.sourceId, ctx)
    if (source === undefined) throw new SourceAdmissionError('NOT_FOUND', `candidate source ${command.sourceId} is not visible in this scope`)
    if (source.workspaceId !== command.workspaceId) {
      throw new SourceAdmissionError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    }
    return this.#retractions.retractSource(scope, {
      workspaceId: command.workspaceId,
      sourceId: command.sourceId,
      expectedRevision: command.expectedRevision,
      reason: command.reason,
      actor: ctx.principal.subjectId,
      idempotencyKey: command.idempotencyKey,
    }, ctx)
  }

  async listRetractions(workspaceId: Uuid, sourceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext): Promise<{ readonly retractions: readonly SourceRetraction[]; readonly nextCursor?: string }> {
    const scope = scopeOf(ctx)
    if (this.#retractions === undefined) {
      throw new SourceAdmissionError('STORE_FAILED', 'the deployment does not persist source retractions')
    }
    const source = await this.#sources.getSource(scope, sourceId, ctx)
    if (source === undefined) throw new SourceAdmissionError('NOT_FOUND', `candidate source ${sourceId} is not visible in this scope`)
    if (source.workspaceId !== workspaceId) throw new SourceAdmissionError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
    return this.#retractions.listRetractions(scope, sourceId, page, ctx)
  }

  #assertEditor(ctx: ToolContext): void {
    if (ctx.principal.roles.some((role) => EDITOR_ROLES.includes(role))) return
    throw new CandidateSourceError('FORBIDDEN', 'a source review requires an editor or platform-admin role')
  }

  #assertPromoter(ctx: ToolContext): void {
    if (ctx.principal.roles.some((role) => PROMOTION_ROLES.includes(role))) return
    throw new CandidateSourceError('FORBIDDEN', 'promoting a source trust tier requires a platform-admin role')
  }
}
