import { isToolContext } from '@ontology/contracts'
import type {
  AnswerVerifierPort,
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BudgetLedgerPort,
  BudgetReservationRecord,
  DecisionPort,
  DraftClaim,
  EvidenceRecord,
  EvidenceStorePort,
  ModelRef,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VerificationFinding,
  VerificationPolicy,
  VerificationResult,
  VerifierRequest,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { answerDraftContentHash } from '../workflow/canonical'
import { buildSemanticQuestion, interpretSemanticResult } from './decision-review'
import { DraftVerificationError } from './errors'
import { checkClaims, sortFindings } from './hard-checks'
import type { ResolvedEvidence } from './hard-checks'
import { RestrictedExplanationTemplates } from './templates'

/**
 * The narrow authorized byte-read capability the verifier needs. `blob-local` implements it
 * alongside `BlobPort`; the verifier receives it by injection and never imports an adapter.
 */
export interface VerificationArtifactStore {
  getAuthorized(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse>
  readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
}

/**
 * The run's single shared budget ledger (ADR-14). The verifier only ever reserves against the
 * ledger id it is given; it has no `openLedger` capability, so a repair can never reset the
 * budget it draws from.
 */
export interface VerificationBudgetBinding {
  readonly ledger: BudgetLedgerPort
  readonly ledgerId: Uuid
}

export interface DraftVerificationDependencies {
  readonly evidence: EvidenceStorePort
  readonly artifacts: VerificationArtifactStore
  readonly policy: VerificationPolicy
  readonly decision?: DecisionPort
  readonly modelRef?: ModelRef
  readonly budget?: VerificationBudgetBinding
  readonly templates?: RestrictedExplanationTemplates
  readonly now?: () => string
  readonly newId?: () => Uuid
}

/** A flat, conservative token estimate for one semantic review pass. */
const SEMANTIC_REVIEW_TOKEN_ESTIMATE = 64

/**
 * Combined answer-draft verification (SPEC D7.4, C2/C4, ADR-14, INV-09, US-021).
 *
 * It recomputes the draft hash, runs the programmatic hard checks against the real evidence
 * archive and the draft's structured claim bindings, then runs the policy-driven JEV semantic
 * review through the injected `DecisionPort`. The verdict binds `draftHash`,
 * `evidenceManifestHash` and `policyVersion`; a hard failure blocks regardless of a high
 * semantic score, and the explanations are always produced by the restricted template
 * registry, never by JEV.
 *
 * This service never publishes: it returns a verdict the controller consumes, and it exposes
 * no answer id, publication or stream.
 */
export class DraftVerificationService implements AnswerVerifierPort {
  readonly #evidence: EvidenceStorePort
  readonly #artifacts: VerificationArtifactStore
  readonly #policy: VerificationPolicy
  readonly #decision: DecisionPort | undefined
  readonly #modelRef: ModelRef | undefined
  readonly #budget: VerificationBudgetBinding | undefined
  readonly #templates: RestrictedExplanationTemplates
  readonly #now: () => string
  readonly #newId: () => Uuid

  constructor(dependencies: DraftVerificationDependencies) {
    this.#evidence = dependencies.evidence
    this.#artifacts = dependencies.artifacts
    this.#policy = dependencies.policy
    this.#decision = dependencies.decision
    this.#modelRef = dependencies.modelRef
    this.#budget = dependencies.budget
    this.#templates = dependencies.templates ?? new RestrictedExplanationTemplates()
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async verify(request: VerifierRequest, ctx: ToolContext): Promise<VerificationResult> {
    const scopeRef = scopeOf(ctx)
    const now = this.#now()
    const draft = request.draft
    const claims = draft.claims ?? []

    const findings: VerificationFinding[] = []

    // The UI only renders claim blocks. Free text is not a verifiable business assertion:
    // accepting it beside a valid claim would reintroduce the R06 contradiction path.
    const claimIds = new Set(claims.map((claim) => claim.claimId))
    for (const [index, block] of draft.blocks.entries()) {
      if (typeof block !== 'object' || block === null || !('kind' in block) || block.kind !== 'claim' || !('claimId' in block) || typeof block.claimId !== 'string' || !claimIds.has(block.claimId)) {
        findings.push({ code: 'visible_statement_unbound', axis: 'hard', field: 'blocks', pointer: `/blocks/${String(index)}` })
      }
    }

    const recomputed = answerDraftContentHash(
      request.runId,
      draft.blocks,
      draft.evidenceManifestHash,
      claims,
    )
    if (recomputed !== draft.contentHash) {
      findings.push({ code: 'draft_hash_mismatch', axis: 'hard', field: 'contentHash' })
    }
    if (draft.evidenceManifestHash !== request.inputManifest.digest) {
      findings.push({
        code: 'evidence_manifest_mismatch',
        axis: 'hard',
        field: 'evidenceManifestHash',
        expected: request.inputManifest.digest,
        actual: draft.evidenceManifestHash,
      })
    }

    let hardFindings: readonly VerificationFinding[] = []
    let supportedClaimIds: Uuid[] = []
    if (claims.length === 0) {
      findings.push({ code: 'missing_claims', axis: 'hard', field: 'claims' })
    } else if (claims.length > this.#policy.maxClaims) {
      findings.push({
        code: 'claim_limit_exceeded',
        axis: 'policy',
        field: 'claims',
        expected: String(this.#policy.maxClaims),
        actual: String(claims.length),
      })
    } else {
      const resolved = await this.#loadEvidence(claims, request.inputManifest, scopeRef, ctx)
      const outcome = checkClaims(claims, resolved, now)
      hardFindings = outcome.findings
      supportedClaimIds = [...outcome.supportedClaimIds]
      findings.push(...hardFindings)
    }

    const semantic = await this.#reviewSemantics(claims, draft.contentHash, ctx)
    findings.push(...semantic)

    const sorted = sortFindings(findings)
    const hardFailed = sorted.some((finding) => finding.axis === 'hard')
    const policyFailed = sorted.some((finding) => finding.axis === 'policy')
    const semanticFailed = sorted.some((finding) => finding.axis === 'semantic')
    const semanticBlocks = this.#policy.semanticReview === 'required'
    const verdict: VerificationResult['verdict'] =
      hardFailed || policyFailed || (semanticBlocks && semanticFailed) ? 'fail' : 'pass'

    const semanticFailedClaimIds = new Set(
      sorted
        .filter((finding) => finding.axis === 'semantic' && finding.claimId !== undefined)
        .map((finding) => finding.claimId),
    )
    const missingEvidence = [
      ...new Set(
        sorted
          .filter((finding) => finding.code === 'evidence_not_found')
          .map((finding) => finding.evidenceRef?.id)
          .filter((id): id is Uuid => id !== undefined),
      ),
    ].sort()

    const explanations = sorted.map((finding) => this.#templates.explain(finding))
    const failedChecks = [...new Set(sorted.map((finding) => finding.code))].sort()

    return {
      verificationId: this.#newId(),
      draftId: draft.draftId,
      draftHash: draft.contentHash,
      evidenceManifestHash: draft.evidenceManifestHash,
      verdict,
      failedChecks,
      policyVersion: this.#policy.policyVersion,
      verifiedAt: now,
      supportedClaimIds: supportedClaimIds.filter((id) => !semanticFailedClaimIds.has(id)).sort(),
      missingEvidence,
      findings: sorted,
      explanations,
    }
  }

  /**
   * Resolve every claim binding against the run's evidence manifest and archive. A binding
   * that is not in the manifest, or whose record/payload cannot be read, is left unresolved so
   * the hard checks report it as a located `evidence_not_found`/`result_unreadable` finding.
   */
  async #loadEvidence(
    claims: readonly DraftClaim[],
    manifest: WorkflowInputManifest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Map<string, ResolvedEvidence>> {
    const manifestEvidenceIds = new Set(
      manifest.entries
        .filter((entry) => entry.kind === 'evidence' && entry.ref !== undefined)
        .map((entry) => entry.ref?.id)
        .filter((id): id is Uuid => id !== undefined),
    )
    const uniqueRefs = new Map<string, ResourceRef>()
    for (const claim of claims) {
      for (const binding of claim.references) {
        if (manifestEvidenceIds.has(binding.evidenceRef.id)) {
          uniqueRefs.set(binding.evidenceRef.id, binding.evidenceRef)
        }
      }
    }

    const resolved = new Map<string, ResolvedEvidence>()
    for (const ref of uniqueRefs.values()) {
      const record = await this.#evidence.get(scopeRef, ref.id, ctx)
      if (record === undefined) continue
      resolved.set(ref.id, await this.#readEvidence(scopeRef, record, ctx))
    }
    return resolved
  }

  async #readEvidence(
    scopeRef: ScopeRef,
    record: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<ResolvedEvidence> {
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) return { record, unreadable: true }
    try {
      const authorized = await this.#artifacts.getAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      if (!authorized.integrityVerified) return { record, unreadable: true }
      const bytes = await this.#artifacts.readAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return { record, payload, unreadable: false }
    } catch {
      // A missing/corrupt artifact and a parse failure both mean the value cannot be checked;
      // they are never treated as if the result held the claimed value.
      return { record, unreadable: true }
    }
  }

  async #reviewSemantics(
    claims: readonly DraftClaim[],
    draftHash: Sha256Digest,
    ctx: ToolContext,
  ): Promise<readonly VerificationFinding[]> {
    if (this.#policy.semanticReview === 'disabled') return []
    if (this.#decision === undefined || this.#modelRef === undefined || claims.length === 0) {
      return this.#unavailableFindings()
    }

    const reservation = await this.#reserve(draftHash, ctx)
    if (this.#budget !== undefined && reservation === undefined) {
      return this.#unavailableFindings()
    }

    const startedAt = Date.now()
    const findings: VerificationFinding[] = []
    let unavailable = false
    try {
      for (const claim of claims) {
        // The port returns one result per call, so each claim gets exactly one fixed-shape
        // question; no question is silently dropped to fit a batch.
        const question = buildSemanticQuestion(claim, this.#policy, this.#newId)
        const result = await this.#decision.decide(
          {
            stateRef: {
              id: draftHash,
              version: this.#policy.policyVersion,
              digest: draftHash,
              kind: 'artifact',
            },
            questions: [question],
            modelRef: this.#modelRef,
          },
          ctx,
        )
        const outcome = interpretSemanticResult(result, claim.claimId)
        if (outcome.kind === 'finding') findings.push(outcome.finding)
        if (outcome.kind === 'unavailable') unavailable = true
      }
      await this.#settle(reservation, 'completed', startedAt, ctx)
    } catch {
      await this.#settle(reservation, 'failed', startedAt, ctx)
      return [...findings, ...this.#unavailableFindings()]
    }
    return unavailable ? [...findings, ...this.#unavailableFindings()] : findings
  }

  #unavailableFindings(): readonly VerificationFinding[] {
    if (this.#policy.onJevUnavailable === 'clarify') {
      return [{ code: 'semantic_unavailable', axis: 'semantic' }]
    }
    return []
  }

  async #reserve(
    draftHash: string,
    ctx: ToolContext,
  ): Promise<BudgetReservationRecord | undefined> {
    if (this.#budget === undefined) return undefined
    const outcome = await this.#budget.ledger.reserve(
      {
        ledgerId: this.#budget.ledgerId,
        idempotencyKey: `verify-semantic:${draftHash}`,
        modelTokens: SEMANTIC_REVIEW_TOKEN_ESTIMATE,
        requiresIntent: false,
      },
      ctx,
    )
    return outcome.granted ? outcome.reservation : undefined
  }

  async #settle(
    reservation: BudgetReservationRecord | undefined,
    status: 'completed' | 'failed',
    startedAt: number,
    ctx: ToolContext,
  ): Promise<void> {
    if (this.#budget === undefined || reservation === undefined) return
    await this.#budget.ledger
      .settle(
        {
          ledgerId: this.#budget.ledgerId,
          reservationId: reservation.reservationId,
          status,
          usage: {
            durationMs: Date.now() - startedAt,
            modelTokens: SEMANTIC_REVIEW_TOKEN_ESTIMATE,
            calls: 0,
          },
          evidenceRefs: [],
        },
        ctx,
      )
      .catch(() => undefined)
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DraftVerificationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new DraftVerificationError(
      'SCOPE_MISMATCH',
      'the trusted context carries inconsistent tenant scope',
    )
  }
  return { tenantId, spaceId }
}
