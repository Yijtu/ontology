import {
  IndustryAssetPublicationError,
  PublishedPackAssetStoreError,
  findIndustryPackViolations,
} from '@ontology/contracts'
import type {
  ApprovedCompetencyQuestionReader,
  AssetCandidateStore,
  IndustryValidationReport,
  IndustryValidationReportStore,
  IndustryWorkspaceStore,
  NewOutboxMessage,
  PublishedPackAsset,
  PublishedPackAssetStore,
  PublishIndustryPackInput,
  ResourceRef,
  RuleActionCandidateStore,
  ScopeRef,
  SemanticDefinitionAudit,
  SemanticDefinitionRecord,
  SemanticDefinitionStore,
  SyntheticExampleSetStore,
  ToolContext,
  Uuid,
  VersionRef,
  ReviewableCandidateReader,
  IndustryWorkspace,
  IndustryPackCatalogue,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { currentDefinitionProjection } from '../definition-candidates/validation'
import { readLatestWorkspaceDraft } from '../workspace-draft'
import { assemblePack } from './pack-assembly'
import { DefinitionPredecessorError, resolveDefinitionPredecessor } from './definition-predecessor'
import type { DefinitionPredecessor } from './definition-predecessor'
import { currentRuleActionProjection, definitionApprovalPins, industryValidationDigest, ruleActionPublicationPins, ruleApprovalPins } from './publication-pins'
import type { CandidateApprovalReader } from './publication-pins'
import { definitionRevisionStrategyProblem, diffDefinitionProjection } from '../definition-candidates/validation'

/**
 * Industry asset publication (SPEC v0.3a §3.1/§4.2/§6.1, V03-015 / #187; A.US-005,
 * P.US-005/006/011, P.FR-14/15/17).
 *
 * The service turns a human-reviewed draft plus its industry validation report into an immutable,
 * versioned pack and commits it atomically through `PublishedPackAssetStore`. Publication is
 * gated on validation:
 *
 *  - the definition/rule/action semantics must pass the semantic surface; a pack that fails it is
 *    refused with `VALIDATION_BLOCKED` and the exact blockers;
 *  - the deployment surface is reported separately; unbound actions are published as declarations
 *    with `not_executable` pins, and only a caller that demands full executability is blocked;
 *  - a stale validation (its revision no longer matches the workspace head) is refused instead of
 *    publishing an unconfirmed draft.
 *
 * The committed asset contains declarations, an authorized/redacted source index, the capability
 * state and the diff against the previous published version; it never contains a customer
 * instance, a real price table, an identity decision or a credential (INV-03/ADR-03).
 */

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const DEFAULT_PAGE = 100
const CANDIDATE_PAGE = 250
export const PACK_PUBLISHED_TOPIC = 'asset.pack.published'

export interface IndustryAssetPublicationDependencies {
  readonly requireCompetencyQuestions?: boolean
  readonly competencyQuestions?: ApprovedCompetencyQuestionReader
  readonly baseCatalogue?: IndustryPackCatalogue
  readonly reviewableCandidates?: ReviewableCandidateReader
  readonly reviews?: CandidateApprovalReader
  readonly workspaces: IndustryWorkspaceStore
  readonly validations: IndustryValidationReportStore
  readonly definitionCandidates: AssetCandidateStore
  readonly ruleActions: RuleActionCandidateStore
  readonly syntheticSets: SyntheticExampleSetStore
  readonly definitions: SemanticDefinitionStore
  readonly store: PublishedPackAssetStore
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new IndustryAssetPublicationError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may publish an industry pack',
  )
}

function requireRevision(revision: string | undefined): string {
  if (revision === undefined) {
    throw new IndustryAssetPublicationError('VERSION_CONFLICT', 'an If-Match revision is required to publish a pack')
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new IndustryAssetPublicationError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function publicationAudit(
  definition: SemanticDefinitionRecord,
  actor: string,
  occurredAt: string,
  idempotencyKey: string,
): SemanticDefinitionAudit {
  const payload = canonicalJson({
    namespace: definition.namespace,
    definitionId: definition.ref.id,
    version: definition.ref.version,
    digest: definition.ref.digest,
    layer: definition.layer,
    publishedAt: occurredAt,
    actor,
  })
  return {
    digest: definition.ref.digest,
    payloadDigest: sha256DigestOf(payload),
    idempotencyKey,
    occurredAt,
    actor,
  }
}

export class IndustryAssetPublicationService {
  readonly #deps: IndustryAssetPublicationDependencies
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: IndustryAssetPublicationDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async publish(
    workspaceId: Uuid,
    input: PublishIndustryPackInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const expected = requireRevision(input.expectedRevision)
    const scopeRef = scopeOf(ctx)

    const workspace = await this.#deps.workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new IndustryAssetPublicationError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }

    const replay = await this.#deps.store.findByIdempotencyKey(scopeRef, key, ctx)
    if (replay !== undefined) return replay

    if (workspace.headRevision !== expected) {
      throw new IndustryAssetPublicationError(
        'VERSION_CONFLICT',
        `workspace head is ${workspace.headRevision}, not the expected ${expected}`,
      )
    }

    const report = await this.#deps.validations.get(scopeRef, workspaceId, input.validationId, ctx)
    if (report === undefined) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_NOT_FOUND',
        `validation ${input.validationId} is not visible in this workspace`,
      )
    }
    if (report.revision !== workspace.headRevision) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_STALE',
        `validation ${input.validationId} was recorded at revision ${report.revision}, not the current head ${workspace.headRevision}`,
      )
    }
    if (!report.semanticPublished.passed) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_BLOCKED',
        `the draft for workspace ${workspaceId} failed semantic validation and was not published`,
        { reasons: report.semanticPublished.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`) },
      )
    }
    if (input.requireDeploymentExecutable === true && !report.deploymentExecutable.passed) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_BLOCKED',
        `the draft for workspace ${workspaceId} is not fully deployment-executable`,
        { reasons: report.deploymentExecutable.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`) },
      )
    }
    if (this.#deps.requireCompetencyQuestions === true && (report.competencyRequired !== true || report.competency === undefined && report.deploymentExecutable.passed)) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'a fresh required competency validation must precede this publication')
    }
    if (report.competency !== undefined && await this.#deps.competencyQuestions?.readApproved(scopeRef, report.competency.questionSetRef, ctx) === undefined) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'the pinned competency declaration is no longer approved')
    }
    if (report.competency !== undefined && canonicalJson(report.competency.validationTarget) !== canonicalJson({ workspaceId, revision: report.revision,
      definitionApprovalPins: report.definition?.approvalPins ?? [], ruleActionPins: report.ruleActionPins ?? [] })) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'competency results must bind the same reviewed definition and rule draft')
    }

    const candidates = await this.#deps.definitionCandidates.listCandidates(scopeRef, workspaceId, { limit: CANDIDATE_PAGE }, ctx)
    if (candidates.length === CANDIDATE_PAGE) throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'candidate page is incomplete')
    const projection = currentDefinitionProjection(candidates)
    const approvals = await definitionApprovalPins(projection, scopeRef, ctx, this.#deps.reviewableCandidates, this.#deps.reviews)
    if (approvals.blockers.length > 0) throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'the current definition projection is not approved', { reasons: approvals.blockers.map((finding) => finding.message) })
    if (report.definition?.approvalPins === undefined || report.ruleActionPins === undefined ||
        canonicalJson(report.definition.approvalPins) !== canonicalJson(approvals.pins) ||
        report.contentDigest !== industryValidationDigest(report) ||
        canonicalJson(input.strategy) !== canonicalJson(report.strategy)) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'validation must pin the current approvals, full evidence and revision strategy')
    }
    if (!report.definition.publishable || report.definition.blockers.length > 0) {
      throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'definition validation still has publication blockers')
    }
    if (projection.length === 0) {
      throw new IndustryAssetPublicationError('DRAFT_NOT_FOUND', `workspace ${workspaceId} has no definition candidate to publish`)
    }

    const ruleActionRows = await this.#deps.ruleActions.list(scopeRef, workspaceId, { limit: CANDIDATE_PAGE }, ctx)
    if (ruleActionRows.length === CANDIDATE_PAGE) throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'rule/action candidate page is incomplete')
    const ruleActionCandidates = currentRuleActionProjection(ruleActionRows).filter((candidate) => candidate.lifecycle === 'enabled' && candidate.enabledAt !== undefined)
    const currentDraft = await readLatestWorkspaceDraft(this.#deps.workspaces, scopeRef, workspaceId, ctx)
    if (ruleActionCandidates.some((candidate) => candidate.generationContext !== undefined &&
      (candidate.generationContext.issues.length > 0 || candidate.sourceSpans.length === 0 || currentDraft === undefined ||
        candidate.generationContext.inputDraftRef.workspaceId !== workspaceId || candidate.generationContext.inputDraftRef.revision !== currentDraft.revision || candidate.generationContext.inputDraftRef.digest !== currentDraft.digest))) {
      throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'generated rules/actions require complete source confirmation')
    }
    const ruleActionPins = ruleActionPublicationPins(ruleActionCandidates)
    const ruleReviewPins = await ruleApprovalPins(ruleActionCandidates, scopeRef, ctx, this.#deps.reviewableCandidates, this.#deps.reviews)
    if (canonicalJson(ruleActionPins) !== canonicalJson(report.ruleActionPins)) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'validation no longer pins the enabled rule/action revisions')
    }
    if (ruleActionCandidates.some((candidate) => {
      const result = candidate.kind === 'rule' ? report.rules.find((entry) => entry.candidateId === candidate.candidateId)
        : report.actions.find((entry) => entry.candidateId === candidate.candidateId)
      return result?.semanticPublished !== true
    })) throw new IndustryAssetPublicationError('VALIDATION_STALE', 'every enabled rule/action must have a semantic validation result for its pinned revision')

    const syntheticExampleRef = await this.#syntheticRef(report, scopeRef, workspaceId, ctx)
    const previous = await this.#previousPublished(scopeRef, workspace, ctx)
    const compatibility = diffDefinitionProjection(projection, previous?.definition, {
      workspaceId, revision: expected, ...(previous === undefined ? {} : { publishedRef: previous.definition.ref }),
      ...(report.strategy === undefined ? {} : { strategy: report.strategy }),
    })
    if (canonicalJson(compatibility) !== canonicalJson(report.definition.compatibility)) {
      throw new IndustryAssetPublicationError('VALIDATION_STALE', 'the complete semantic diff changed after validation')
    }
    const strategy = report.strategy
    if ((compatibility.requiresRevisionStrategy && strategy === undefined) || definitionRevisionStrategyProblem(strategy, previous?.definition.ref) !== undefined) {
      throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'a breaking publication requires a valid revision strategy')
    }
    if (strategy !== undefined && previous !== undefined &&
        ((strategy.kind === 'new_version' && input.version === previous.packRef.version) ||
         (strategy.kind === 'keep_independent' && `${workspace.namespace}.${input.packId}` === previous.packRef.id) ||
         (strategy.kind === 'retire_previous' && canonicalJson(strategy.supersedesRef) !== canonicalJson(previous.definition.ref)) ||
         (strategy.supersedesRef !== undefined && canonicalJson(strategy.supersedesRef) !== canonicalJson(previous.definition.ref)))) {
      throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', 'revision strategy does not match the predecessor or the new publication identity')
    }
    const publishedAt = this.#now()

    const { definition, asset } = assemblePack({
      workspace,
      scopeRef,
      packId: input.packId,
      version: input.version,
      definitionId: `${workspace.namespace}.${input.packId}`,
      projection,
      ruleActions: ruleActionCandidates,
      ruleReviewPins,
      report,
      ...(syntheticExampleRef === undefined ? {} : { syntheticExampleRef }),
      ...(previous === undefined ? {} : { previous }),
      publishedAt,
      idempotencyKey: key,
      actor,
    })

    const violations = findIndustryPackViolations(asset.packAsset)
    if (violations.length > 0) {
      throw new IndustryAssetPublicationError(
        'EXPORT_LEAK_DETECTED',
        `published pack ${asset.packRef.id}@${asset.packRef.version} would leak ${violations.length} non-declaration value(s)`,
        { reasons: violations.map((violation) => `${violation.path} (${violation.code})`) },
      )
    }

    await this.#guardExisting(scopeRef, asset.namespace, asset.packRef, ctx)

    const outboxId = this.#newId()
    const outboxJobId = this.#newId()
    const outbox: NewOutboxMessage = {
      outboxId,
      topic: PACK_PUBLISHED_TOPIC,
      payload: {
        packRef: asset.packRef,
        packId: asset.packRef.id,
        version: asset.packRef.version,
        namespace: asset.namespace,
        workspaceId,
      },
      idempotencyKey: `pack-publish:${asset.namespace}:${asset.packRef.id}:${asset.packRef.version}`,
      availableAt: publishedAt,
      createdAt: publishedAt,
    }

    try {
      const result = await this.#deps.store.commitApprovedPack(
        scopeRef,
        {
          expectedRevision: expected,
          approvalPins: approvals.pins,
          ruleActionPins,
          ruleReviewPins,
          definition,
          definitionAudit: publicationAudit(
            definition,
            actor,
            publishedAt,
            `definition-publish:${definition.namespace}:${definition.ref.id}:${definition.ref.version}`,
          ),
          pack: asset,
          idempotencyKey: key,
          requestDigest: sha256DigestOf(
            canonicalJson({
              workspaceId,
              packId: input.packId,
              version: input.version,
              validationId: input.validationId,
              head: expected,
              contentDigest: asset.contentDigest,
            }),
          ),
          actor,
          recordedAt: publishedAt,
          outbox,
          outboxJobId,
        },
        ctx,
      )
      return result.asset
    } catch (error) {
      throw mapStoreError(error, asset.packRef)
    }
  }

  async getPublished(
    scopeRef: ScopeRef,
    packId: string,
    version: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    return this.#deps.store.findPack(scopeRef, packId, version, ctx)
  }

  async listPublished(
    scopeRef: ScopeRef,
    namespace: string | undefined,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset[]> {
    return this.#deps.store.listPacks(scopeRef, namespace === undefined ? {} : { namespace }, ctx)
  }

  async #syntheticRef(
    report: IndustryValidationReport,
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<ResourceRef | undefined> {
    const set = await this.#deps.syntheticSets.get(scopeRef, workspaceId, report.exampleSetId, ctx)
    if (set === undefined) return undefined
    return { id: set.exampleSetId, version: '1.0.0', digest: set.contentDigest, kind: 'dataset' }
  }

  async #previousPublished(scopeRef: ScopeRef, workspace: IndustryWorkspace, ctx: ToolContext): Promise<DefinitionPredecessor | undefined> {
    const drafts = workspace.latestPublishedPackRef === undefined
      ? await this.#deps.workspaces.listDrafts(scopeRef, workspace.workspaceId, ctx) : []
    const draft = drafts.find((entry) => entry.revision === workspace.headRevision) ?? drafts.at(-1)
    try {
      return await resolveDefinitionPredecessor({ definitions: this.#deps.definitions, publishedPacks: this.#deps.store,
        ...(this.#deps.baseCatalogue === undefined ? {} : { baseCatalogue: this.#deps.baseCatalogue }) }, workspace, draft, scopeRef, ctx)
    } catch (error) {
      if (error instanceof DefinitionPredecessorError) throw new IndustryAssetPublicationError('VALIDATION_STALE', error.message, { cause: error })
      throw error
    }
  }

  async #guardExisting(
    scopeRef: ScopeRef,
    namespace: string,
    packRef: VersionRef,
    ctx: ToolContext,
  ): Promise<void> {
    const samePack = await this.#deps.store.findPack(scopeRef, packRef.id, packRef.version, ctx)
    if (samePack !== undefined && samePack.packRef.digest !== packRef.digest) {
      throw new IndustryAssetPublicationError(
        'PACK_VERSION_EXISTS',
        `pack ${packRef.id}@${packRef.version} is already published with a different digest`,
      )
    }
    const peers = await this.#deps.store.listPacks(scopeRef, { namespace, limit: DEFAULT_PAGE }, ctx)
    const conflict = peers.find(
      (asset) => asset.packRef.version === packRef.version && asset.packRef.digest !== packRef.digest,
    )
    if (conflict !== undefined) {
      throw new IndustryAssetPublicationError(
        'NAMESPACE_CONFLICT',
        `namespace ${namespace} already publishes version ${packRef.version} with a different digest`,
      )
    }
  }
}

function mapStoreError(error: unknown, packRef: VersionRef): IndustryAssetPublicationError {
  if (error instanceof PublishedPackAssetStoreError) {
    switch (error.code) {
      case 'SCOPE_MISMATCH':
        return new IndustryAssetPublicationError('SCOPE_MISMATCH', error.message, { cause: error })
      case 'VERSION_CONFLICT':
        return new IndustryAssetPublicationError('VERSION_CONFLICT', error.message, { cause: error })
      case 'IDEMPOTENCY_CONFLICT':
        return new IndustryAssetPublicationError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
      case 'PACK_VERSION_EXISTS':
      case 'DEFINITION_VERSION_EXISTS':
        return new IndustryAssetPublicationError('PACK_VERSION_EXISTS', error.message, { cause: error })
      case 'NAMESPACE_CONFLICT':
        return new IndustryAssetPublicationError('NAMESPACE_CONFLICT', error.message, { cause: error })
      case 'WORKSPACE_NOT_FOUND':
        return new IndustryAssetPublicationError('WORKSPACE_NOT_FOUND', error.message, { cause: error })
      default:
        return new IndustryAssetPublicationError(
          'STORE_FAILED',
          `publishing ${packRef.id}@${packRef.version} failed`,
          { cause: error },
        )
    }
  }
  if (error instanceof IndustryAssetPublicationError) return error
  return new IndustryAssetPublicationError(
    'STORE_FAILED',
    `publishing ${packRef.id}@${packRef.version} failed`,
    { cause: error },
  )
}
