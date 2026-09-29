import type {
  AnswerDraft,
  LimitedAnswerPort,
  LimitedAnswerRequest,
  LimitedAnswerResult,
  ToolContext,
} from '@ontology/contracts'
import { answerDraftContentHash } from './canonical'

/**
 * A bounded, deterministic limited-answer composer (D7.3/D7.4). When the shared repair budget
 * is exhausted the controller must not publish unverified prose; it may instead publish a
 * limited factual result that keeps only the claims which already passed every hard check and
 * states the remaining gaps explicitly.
 *
 * It never calls a model, never invents a claim and never starts an agent: the supported set
 * comes from the recorded verdict, so a dropped claim becomes a visible gap rather than a
 * silently weakened answer.
 */
export class RestrictedLimitedAnswerComposer implements LimitedAnswerPort {
  readonly #now: () => string
  readonly #newId: () => string

  constructor(options?: { readonly now?: () => string; readonly newId?: () => string }) {
    this.#now = options?.now ?? (() => new Date().toISOString())
    this.#newId = options?.newId ?? (() => globalThis.crypto.randomUUID())
  }

  compose(request: LimitedAnswerRequest, ctx: ToolContext): Promise<LimitedAnswerResult> {
    void ctx
    const supported = new Set(request.failedVerification?.supportedClaimIds ?? [])
    const supportedAssertions = new Set(request.failedVerification?.supportedAssertionIds ?? [])
    const supportedClaims = (request.previousDraft?.claims ?? []).filter((claim) =>
      supported.has(claim.claimId),
    )
    const supportedAssertionValues = (request.previousDraft?.assertions ?? []).filter((assertion) =>
      supportedAssertions.has(assertion.assertionId),
    )

    const gaps = [
      ...new Set([
        ...(request.failedVerification?.failedChecks ?? ['verification_never_passed']),
        ...(request.failedVerification?.missingEvidence ?? []).map(
          (id) => `missing_evidence:${id}`,
        ),
        ...(supportedClaims.length + supportedAssertionValues.length === 0 ? ['no_supported_statements'] : []),
      ]),
    ].sort()

    const schemaVersion: 'answer-draft@2' | undefined = request.previousDraft?.schemaVersion === 'answer-draft@2' ? 'answer-draft@2' : undefined
    const blocks: readonly unknown[] = [
      ...supportedClaims.map((claim) => ({ kind: 'claim', claimId: claim.claimId })),
      ...supportedAssertionValues.map((assertion) => ({ kind: 'assertion', assertionId: assertion.assertionId })),
    ]
    const evidenceManifestHash = request.inputManifest.digest
    const limitations = ['limited_factual_result', ...gaps]
    const draft: AnswerDraft = {
      draftId: this.#newId(),
      runId: request.runId,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      blocks,
      claims: supportedClaims,
      assertions: supportedAssertionValues,
      evidenceManifestHash,
      contentHash: answerDraftContentHash(
        request.runId,
        blocks,
        evidenceManifestHash,
        supportedClaims,
        supportedAssertionValues,
        ...(schemaVersion === undefined ? [] : [{ schemaVersion, limitations }]),
      ),
      limitations,
      producedInPhase: 'drafting',
      createdAt: this.#now(),
    }
    return Promise.resolve({
      draft,
      gaps,
      usage: { durationMs: 0, calls: 0, modelTokens: 0 },
    })
  }
}
