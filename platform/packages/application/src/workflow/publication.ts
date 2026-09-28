import { isToolContext } from '@ontology/contracts'
import { AnswerStoreError } from '@ontology/contracts'
import type {
  AnswerPublisherPort,
  AnswerStorePort,
  PublishedAnswer,
  PublicationKind,
  PublicationValidityPort,
  PublishRequest,
  ResourceRef,
  RunStore,
  ScopeRef,
  ToolContext,
  Uuid,
  VerificationStorePort,
  WorkflowInputEntry,
  WorkflowInputManifest,
  WorkflowManifestStore,
} from '@ontology/contracts'
import { answerDraftContentHash, scenarioManifestHash } from './canonical'
import { PublicationRejectedError, WorkflowControllerError } from './errors'

export interface AnswerPublicationDependencies {
  /** Run records: the atomic cancellation check is a read of the run row. */
  readonly runs: RunStore
  /** Durable, append-only published answers. */
  readonly answers: AnswerStorePort
  /** Recorded verifications; the publisher re-reads the verdict, never trusts the request. */
  readonly verifications: VerificationStorePort
  /** The one run manifest and the shared input manifest, for the scenario binding. */
  readonly manifests: WorkflowManifestStore
  /** Post-verification permission/validity/fence re-check (D7.4). */
  readonly validity: PublicationValidityPort
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/**
 * The real answer publication gate (SPEC D7.4, C6, ADR-14, INV-09, US-021/US-022).
 *
 * It is the only writer of an answer version, and it accepts only a controller-minted grant.
 * Before it writes anything it re-derives every binding:
 *
 *  - the draft content hash is recomputed from the body (including claims) and must equal
 *    both the draft and the grant;
 *  - the evidence manifest hash must be consistent across the draft, the verdict and the grant;
 *  - the recorded verification must exist and pass for this exact draft;
 *  - the run must still be `verifying` at the grant's revision, so a cancellation between
 *    verification and publication blocks it;
 *  - the scenario manifest is recomputed from the persisted run/input manifests and must match
 *    the grant, so an answer id is bound to the exact scenario version;
 *  - the injected validity port re-checks permission, evidence and freshness after
 *    verification. A retracted basis, a revoked permission or a cancelled run blocks
 *    publication outright; only a stale-but-still-supported result may be published, and then
 *    it is marked `history_limited` with an explicit `asOf`.
 *
 * A framework/SDK "final" has no path here: it can neither mint a grant nor fabricate a
 * recorded passing verification, so it can never create a published answer.
 */
export class AnswerPublicationService implements AnswerPublisherPort {
  readonly #runs: RunStore
  readonly #answers: AnswerStorePort
  readonly #verifications: VerificationStorePort
  readonly #manifests: WorkflowManifestStore
  readonly #validity: PublicationValidityPort
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: AnswerPublicationDependencies) {
    this.#runs = dependencies.runs
    this.#answers = dependencies.answers
    this.#verifications = dependencies.verifications
    this.#manifests = dependencies.manifests
    this.#validity = dependencies.validity
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async publish(request: PublishRequest, ctx: ToolContext): Promise<PublishedAnswer> {
    const scopeRef = scopeOf(ctx)
    const { grant, draft, verification } = request

    if (grant.issuedBy !== 'workflow-controller') {
      throw new PublicationRejectedError(
        'grant_not_issued_by_controller',
        'only the workflow controller may issue a publication grant',
      )
    }
    if (grant.draftId !== draft.draftId || grant.draftHash !== draft.contentHash) {
      throw new PublicationRejectedError(
        'draft_mismatch',
        'the publication grant does not match the draft being published',
      )
    }
    if (draft.schemaVersion !== 'answer-draft@2' && (draft.assertions?.length ?? 0) > 0) {
      throw new PublicationRejectedError('draft_hash_mismatch', 'legacy answer drafts cannot carry unhashed typed assertions')
    }
    const recomputed = answerDraftContentHash(
      draft.runId,
      draft.blocks,
      draft.evidenceManifestHash,
      draft.claims ?? [],
      draft.assertions ?? [],
      ...(draft.schemaVersion === 'answer-draft@2' ? [{ schemaVersion: 'answer-draft@2' as const, limitations: draft.limitations }] : []),
    )
    if (recomputed !== draft.contentHash) {
      throw new PublicationRejectedError(
        'draft_hash_mismatch',
        'the draft content hash does not recompute from its body',
      )
    }
    if (
      grant.evidenceManifestHash !== draft.evidenceManifestHash ||
      verification.evidenceManifestHash !== draft.evidenceManifestHash
    ) {
      throw new PublicationRejectedError(
        'evidence_manifest_mismatch',
        'the draft, verdict and grant do not agree on the evidence manifest',
      )
    }
    if (
      grant.verificationId !== verification.verificationId ||
      verification.draftHash !== draft.contentHash ||
      verification.verdict !== 'pass'
    ) {
      throw new PublicationRejectedError(
        'verification_mismatch',
        'the publication grant does not match a passing verification of this draft',
      )
    }

    const recorded = await this.#verifications.find(verification.verificationId, ctx)
    if (
      recorded === undefined ||
      recorded.verification.verdict !== 'pass' ||
      recorded.verification.draftHash !== draft.contentHash ||
      recorded.verification.evidenceManifestHash !== draft.evidenceManifestHash
    ) {
      throw new PublicationRejectedError(
        'verification_not_recorded',
        'no recorded passing verification for this exact draft and evidence manifest',
      )
    }

    const manifest = await this.#manifests.getRunManifest(grant.runId, ctx)
    if (manifest === undefined) {
      throw new PublicationRejectedError('manifest_not_found', 'the run has no locked manifest')
    }
    const inputManifest = await this.#manifests.getInputManifest(manifest.inputManifestId, ctx)
    if (inputManifest === undefined) {
      throw new PublicationRejectedError('manifest_not_found', 'the shared input manifest is missing')
    }
    const scenario = scenarioManifestHash(manifest, inputManifest)
    if (scenario !== grant.scenarioManifestHash) {
      throw new PublicationRejectedError(
        'scenario_manifest_mismatch',
        'the publication grant does not match the locked scenario version manifest',
      )
    }

    const run = await this.#runs.getRun(scopeRef, grant.runId, ctx)
    if (run === undefined) {
      throw new PublicationRejectedError('run_not_found', 'the run is not visible in this scope')
    }
    if (run.state !== 'verifying' || run.revision !== grant.expectedRunRevision) {
      throw new PublicationRejectedError(
        'run_not_publishable',
        `run ${grant.runId} is ${run.state} at revision ${run.revision} and is not publishable`,
      )
    }

    const validity = await this.#validity.check(
      {
        runId: grant.runId,
        runRevision: run.revision,
        verificationId: verification.verificationId,
        evidenceManifestHash: draft.evidenceManifestHash,
        evidenceRefs: evidenceRefsOf(inputManifest),
        verifiedAt: recorded.verification.verifiedAt,
      },
      ctx,
    )
    const publicationKind: PublicationKind = validity.publishable
      ? 'verified'
      : validity.historyLimited
        ? 'history_limited'
        : 'verified'
    if (!validity.publishable && !validity.historyLimited) {
      throw new PublicationRejectedError(
        'publication_blocked',
        `publication of run ${grant.runId} is blocked: ${validity.blockedReasons.join(', ')}`,
      )
    }
    if (publicationKind === 'history_limited' && validity.asOf === undefined) {
      throw new PublicationRejectedError(
        'history_limit_missing',
        'a history-limited publication requires an explicit as-of point',
      )
    }

    // The publication metadata carries an explicit history `asOf`; changing the verified
    // limitations here would create a body that no longer matches the draft hash.
    const limitations = [...draft.limitations]
    const answer: PublishedAnswer = {
      answerId: this.#newId(),
      runId: grant.runId,
      draftId: draft.draftId,
      verificationId: verification.verificationId,
      contentHash: draft.contentHash,
      evidenceManifestHash: draft.evidenceManifestHash,
      scenarioManifestHash: scenario,
      publicationKind,
      ...(publicationKind === 'history_limited' ? { asOf: validity.asOf } : {}),
      limitations,
      ...(verification.semanticReview === undefined ? {} : { semanticReview: verification.semanticReview }),
      body: {
        schemaVersion: draft.schemaVersion ?? 'answer-draft@1',
        blocks: structuredClone(draft.blocks),
        claims: structuredClone(draft.claims ?? []),
        assertions: structuredClone(draft.assertions ?? []),
      },
      publishedAt: this.#now(),
    }

    // The insert re-reads the run state/revision in the same transaction, so a cancellation
    // that lands between the check above and the write still cannot persist an answer.
    try {
      return await this.#answers.record(
        {
          answer,
          expectedRunState: 'verifying',
          expectedRunRevision: grant.expectedRunRevision,
          ...(grant.workflowDispatchFence === undefined
            ? {}
            : { workflowDispatchFence: grant.workflowDispatchFence }),
        },
        ctx,
      )
    } catch (error) {
      if (error instanceof AnswerStoreError) {
        if (error.code === 'RUN_NOT_PUBLISHABLE') {
          throw new PublicationRejectedError('run_not_publishable', error.message)
        }
        if (error.code === 'SCOPE_MISMATCH') {
          throw new WorkflowControllerError('SCOPE_MISMATCH', error.message)
        }
        throw new PublicationRejectedError('answer_persist_failed', error.message)
      }
      throw error
    }
  }

  findAnswer(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    return this.#answers.findByRun(runId, ctx)
  }
}

function evidenceRefsOf(inputManifest: WorkflowInputManifest): ResourceRef[] {
  return inputManifest.entries
    .filter(
      (entry): entry is WorkflowInputEntry & { ref: ResourceRef } =>
        entry.kind === 'evidence' && entry.ref !== undefined,
    )
    .map((entry) => entry.ref)
}
