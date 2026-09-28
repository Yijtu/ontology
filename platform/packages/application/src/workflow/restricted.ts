import { isToolContext } from '@ontology/contracts'
import type {
  AnswerDraft,
  AnswerPublisherPort,
  AnswerVerifierPort,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  InputValidityPort,
  PublishRequest,
  PublishedAnswer,
  ResourceRef,
  RunStore,
  ScopeRef,
  ToolContext,
  Uuid,
  VerificationRecord,
  VerificationResult,
  VerificationStorePort,
  WorkflowInputEntry,
  WorkflowInputManifest,
  WorkflowInputValidityReport,
} from '@ontology/contracts'
import { answerDraftContentHash } from './canonical'
import { PublicationRejectedError, WorkflowControllerError } from './errors'

/**
 * Restricted stand-ins for the domain services LOCAL-035 (draft verification) and
 * LOCAL-036 (answer publication) will replace. They implement the real invariants the
 * controller depends on — a draft must be bounded and hash-consistent, a verification must
 * have been produced and recorded, and only a verified draft of a live run can be
 * published — without a model, a policy engine or a database. They are deliberately not
 * permissive fakes: a bypass attempt is rejected by contract.
 */

const RESTRICTED_POLICY_VERSION = 'restricted-policy-v1'

/** A bounded draft writer: it summarises the shared input manifest, it starts no agent. */
export class RestrictedDraftWriter implements DraftWriterPort {
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options?: { readonly now?: () => string; readonly newId?: () => string }) {
    this.#now = options?.now ?? (() => new Date().toISOString())
    this.#newId = options?.newId ?? (() => globalThis.crypto.randomUUID())
  }

  writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    void ctx
    const draftId = this.#newId()
    const createdAt = this.#now()
    const blocks: readonly unknown[] = [
      {
        kind: 'summary',
        question: request.question,
        evidenceCount: request.inputManifest.entries.filter((entry) => entry.kind === 'evidence').length,
        deficits: [...request.deficits],
        limitations: request.deficits.length > 0 ? ['incomplete-evidence'] : [],
      },
    ]
    const draft: AnswerDraft = {
      draftId,
      runId: request.runId,
      blocks,
      evidenceManifestHash: request.inputManifest.digest,
      contentHash: answerDraftContentHash(request.runId, blocks, request.inputManifest.digest),
      limitations: request.deficits.length > 0 ? ['incomplete-evidence'] : [],
      producedInPhase: 'drafting',
      createdAt,
    }
    const draftRef: ResourceRef = {
      id: draftId,
      version: '1.0.0',
      digest: draft.contentHash,
      kind: 'artifact',
    }
    return Promise.resolve({
      draft,
      usage: { durationMs: 1, calls: 0, modelTokens: 32 },
      evidenceRefs: [draftRef],
    })
  }
}

/**
 * A bounded verifier. It performs the hard checks the controller can rely on: the draft
 * hash must recompute from the body, the evidence manifest hash must match the shared input
 * manifest, and there must be at least one supporting evidence entry. The real verifier
 * adds policy/JEV checks; it never replaces these hard checks.
 */
export class RestrictedAnswerVerifier implements AnswerVerifierPort {
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options?: { readonly now?: () => string; readonly newId?: () => string }) {
    this.#now = options?.now ?? (() => new Date().toISOString())
    this.#newId = options?.newId ?? (() => globalThis.crypto.randomUUID())
  }

  verify(
    request: { readonly runId: Uuid; readonly draft: AnswerDraft; readonly inputManifest: WorkflowInputManifest },
    ctx: ToolContext,
  ): Promise<VerificationResult> {
    void ctx
    const failedChecks: string[] = []
    const recomputed = answerDraftContentHash(
      request.runId,
      request.draft.blocks,
      request.draft.evidenceManifestHash,
    )
    if (recomputed !== request.draft.contentHash) failedChecks.push('draft_hash_mismatch')
    if (request.draft.evidenceManifestHash !== request.inputManifest.digest) {
      failedChecks.push('evidence_manifest_mismatch')
    }
    const evidenceCount = request.inputManifest.entries.filter(
      (entry) => entry.kind === 'evidence',
    ).length
    if (evidenceCount === 0) failedChecks.push('no_supporting_evidence')
    const result: VerificationResult = {
      verificationId: this.#newId(),
      draftHash: request.draft.contentHash,
      evidenceManifestHash: request.inputManifest.digest,
      verdict: failedChecks.length === 0 ? 'pass' : 'fail',
      failedChecks,
      policyVersion: RESTRICTED_POLICY_VERSION,
      verifiedAt: this.#now(),
    }
    return Promise.resolve(result)
  }
}

/** Records verifications and re-reads them for the publication gate. */
export class InMemoryVerificationStore implements VerificationStorePort {
  readonly #records = new Map<string, VerificationRecord>()

  record(record: VerificationRecord, ctx: ToolContext): Promise<void> {
    void ctx
    if (!this.#records.has(record.verification.verificationId)) {
      this.#records.set(record.verification.verificationId, structuredClone(record))
    }
    return Promise.resolve()
  }

  find(verificationId: Uuid, ctx: ToolContext): Promise<VerificationRecord | undefined> {
    void ctx
    const found = this.#records.get(verificationId)
    return Promise.resolve(found === undefined ? undefined : structuredClone(found))
  }
}

/**
 * The restricted publication service. It is the only place an answer version is written,
 * and it accepts only a controller-minted grant whose recorded verification actually passed
 * for this exact draft and evidence manifest. A draft, a framework event or a forged
 * `pass` verdict is rejected (INV-09, D2.1).
 */
export class RestrictedAnswerPublisher implements AnswerPublisherPort {
  readonly #store: RunStore
  readonly #verifications: VerificationStorePort
  readonly #now: () => string
  readonly #newId: () => string
  readonly #answers = new Map<string, PublishedAnswer>()

  constructor(options: {
    readonly store: RunStore
    readonly verifications: VerificationStorePort
    readonly now?: () => string
    readonly newId?: () => string
  }) {
    this.#store = options.store
    this.#verifications = options.verifications
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async publish(request: PublishRequest, ctx: ToolContext): Promise<PublishedAnswer> {
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
      throw new PublicationRejectedError('draft_hash_mismatch', 'draft body changed after verification')
    }
    if (
      grant.verificationId !== verification.verificationId ||
      grant.evidenceManifestHash !== verification.evidenceManifestHash ||
      verification.draftHash !== draft.contentHash
    ) {
      throw new PublicationRejectedError(
        'verification_mismatch',
        'the publication grant does not match the verification',
      )
    }
    if (verification.verdict !== 'pass') {
      throw new PublicationRejectedError(
        'verification_not_passed',
        'an unverified or failed draft cannot be published',
      )
    }
    const recorded = await this.#verifications.find(verification.verificationId, ctx)
    if (recorded === undefined) {
      throw new PublicationRejectedError(
        'verification_not_recorded',
        'the verification was never recorded and cannot gate publication',
      )
    }
    if (
      recorded.verification.verdict !== 'pass' ||
      recorded.verification.draftHash !== draft.contentHash
    ) {
      throw new PublicationRejectedError(
        'verification_not_passed',
        'the recorded verification does not pass for this draft',
      )
    }
    const run = await this.#store.getRun(scopeOf(ctx), grant.runId, ctx)
    if (run === undefined) {
      throw new PublicationRejectedError('run_not_found', 'the run is not visible in this scope')
    }
    if (run.state !== 'verifying' || run.revision !== grant.expectedRunRevision) {
      throw new PublicationRejectedError(
        'run_not_publishable',
        `run ${grant.runId} is ${run.state} at revision ${run.revision} and is not publishable`,
      )
    }

    const answer: PublishedAnswer = {
      answerId: this.#newId(),
      runId: grant.runId,
      draftId: draft.draftId,
      verificationId: verification.verificationId,
      contentHash: draft.contentHash,
      evidenceManifestHash: draft.evidenceManifestHash,
      scenarioManifestHash: grant.scenarioManifestHash,
      publicationKind: 'verified',
      limitations: [...draft.limitations],
      body: {
        schemaVersion: draft.schemaVersion ?? 'answer-draft@1',
        blocks: structuredClone(draft.blocks),
        claims: structuredClone(draft.claims ?? []),
        assertions: structuredClone(draft.assertions ?? []),
      },
      publishedAt: this.#now(),
    }
    this.#answers.set(`${scopeOf(ctx)}\u0000${grant.runId}`, answer)
    return answer
  }

  findAnswer(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    const found = this.#answers.get(`${scopeOf(ctx)}\u0000${runId}`)
    return Promise.resolve(found === undefined ? undefined : structuredClone(found))
  }
}

/** Deterministic validity double: the listed entries are reported stale. */
export class StaticInputValidity implements InputValidityPort {
  readonly #stale = new Map<Uuid, string>()

  markStale(entryId: Uuid, reason = 'the referenced data is stale'): this {
    this.#stale.set(entryId, reason)
    return this
  }

  validate(entries: readonly WorkflowInputEntry[], ctx: ToolContext): Promise<WorkflowInputValidityReport> {
    void ctx
    const staleEntries = entries
      .filter((entry) => this.#stale.has(entry.entryId))
      .map((entry) => ({
        entryId: entry.entryId,
        reason: this.#stale.get(entry.entryId) ?? 'the referenced data is stale',
      }))
    return Promise.resolve({ valid: staleEntries.length === 0, staleEntries })
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
