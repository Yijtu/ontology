import {
  CandidateSourceError,
  assertCandidateSourceReviewCommandShape,
  assertSourceRetractionCommandShape,
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
  ToolContext,
  Uuid,
} from '@ontology/contracts'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']

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
    if (this.#sources.reviewSourceCommand === undefined) {
      throw new CandidateSourceError('STORE_FAILED', 'the store does not support append-only review events')
    }
    return this.#sources.reviewSourceCommand(scope, command, ctx)
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
}
