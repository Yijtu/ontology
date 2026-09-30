import { isToolContext } from '@ontology/contracts'
import type {
  AnswerVerifierPort,
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  DecisionPort,
  DraftClaim,
  VerifiedAssertion,
  EvidenceRecord,
  EvidenceStorePort,
  ModelRef,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  SemanticReviewDisposition,
  ToolContext,
  Uuid,
  VerificationFinding,
  VerificationPolicy,
  VerificationResult,
  VerifierRequest,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { answerDraftContentHash } from '../workflow/canonical'
import { buildSemanticDecisionState, buildSemanticQuestion, interpretSemanticResult } from './decision-review'
import { DraftVerificationError } from './errors'
import { checkClaims, sortFindings } from './hard-checks'
import type { ResolvedEvidence } from './hard-checks'
import { checkVerifiedAssertions } from './assertions'
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
 * Host-owned writer for the exact semantic-review state. The implementation archives a
 * canonical immutable artifact and registers its complete ref against this run/profile
 * before returning. The verifier never derives a ResourceRef from a draft hash.
 */
export interface DecisionStateRefProvider {
  archive(
    input: {
      readonly runId: Uuid
      readonly resolvedProfileHash: Sha256Digest
      readonly state: unknown
    },
    ctx: ToolContext,
  ): Promise<ResourceRef>
}

export interface DraftVerificationDependencies {
  readonly evidence: EvidenceStorePort
  readonly artifacts: VerificationArtifactStore
  readonly policy: VerificationPolicy
  readonly decision?: DecisionPort
  readonly modelRef?: ModelRef
  readonly decisionStateRefProvider?: DecisionStateRefProvider
  readonly templates?: RestrictedExplanationTemplates
  readonly now?: () => string
  readonly newId?: () => Uuid
}

const VERIFIED_LIMITATION_CODES = new Set<string>([
  'limited_factual_result',
  'no_supported_statements',
  'verification_never_passed',
  'unclassified_evidence_gap',
  'draft_hash_mismatch',
  'evidence_manifest_mismatch',
  'missing_claims',
  'claim_limit_exceeded',
  'unbound_claim',
  'evidence_not_found',
  'result_digest_mismatch',
  'result_unreadable',
  'number_mismatch',
  'unit_mismatch',
  'subject_mismatch',
  'predicate_mismatch',
  'time_mismatch',
  'source_not_yet_valid',
  'stale_source',
  'semantic_unsupported',
  'semantic_insufficient',
  'semantic_unavailable',
  'evidence_reference_mismatch',
  'visible_statement_unbound',
  'assertion_mismatch',
  'document_quote_mismatch',
  'unverified_limitation',
  'rule_judgement_mismatch',
  'rule_premise_missing',
  'relation_endpoint_mismatch',
  'relation_version_mismatch',
  'row_binding_mismatch',
  'citation_locator_mismatch',
])

function verifiedLimitationCode(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (VERIFIED_LIMITATION_CODES.has(value)) return true
  return /^missing_evidence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}

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
  readonly #decisionStateRefProvider: DecisionStateRefProvider | undefined
  readonly #templates: RestrictedExplanationTemplates
  readonly #now: () => string
  readonly #newId: () => Uuid

  constructor(dependencies: DraftVerificationDependencies) {
    this.#evidence = dependencies.evidence
    this.#artifacts = dependencies.artifacts
    this.#policy = dependencies.policy
    this.#decision = dependencies.decision
    this.#modelRef = dependencies.modelRef
    this.#decisionStateRefProvider = dependencies.decisionStateRefProvider
    this.#templates = dependencies.templates ?? new RestrictedExplanationTemplates()
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async verify(request: VerifierRequest, ctx: ToolContext): Promise<VerificationResult> {
    const scopeRef = scopeOf(ctx)
    const now = this.#now()
    const draft = request.draft
    const claims = draft.claims ?? []
    const assertions = draft.assertions ?? []

    const findings: VerificationFinding[] = []

    // V1 did not hash typed assertions. Preserve old assertion-free drafts, but never
    // verify or publish a newly attached unbound V1 assertion under the legacy hash.
    if (draft.schemaVersion !== 'answer-draft@2' && assertions.length > 0) {
      findings.push({ code: 'draft_hash_mismatch', axis: 'hard', field: 'assertions' })
    }

    // V2 answer blocks are only references to deterministically rendered typed content. Any
    // prose, hidden text field, unknown ID, or extra block property would be visible content
    // that was not checked against evidence.
    if (draft.schemaVersion === 'answer-draft@2') {
      const claimIds = new Set(claims.map((claim) => claim.claimId))
      const assertionIds = new Set(assertions.map((assertion) => assertion.assertionId))
      if (draft.blocks.length === 0) findings.push({ code: 'visible_statement_unbound', axis: 'hard', field: 'blocks' })
      for (const [index, block] of draft.blocks.entries()) {
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          findings.push({ code: 'visible_statement_unbound', axis: 'hard', field: 'blocks', pointer: `/blocks/${String(index)}` })
          continue
        }
        const row = block as Record<string, unknown>
        const claimBlock = row.kind === 'claim' && typeof row.claimId === 'string' && claimIds.has(row.claimId)
        const assertionBlock = row.kind === 'assertion' && typeof row.assertionId === 'string' && assertionIds.has(row.assertionId)
        const expectedKeys = claimBlock ? ['claimId', 'kind'] : assertionBlock ? ['assertionId', 'kind'] : []
        if (expectedKeys.length === 0 || Object.keys(row).sort().join('\u0000') !== expectedKeys.join('\u0000')) {
          findings.push({ code: 'visible_statement_unbound', axis: 'hard', field: 'blocks', pointer: `/blocks/${String(index)}` })
        }
      }
    }

    const recomputed = answerDraftContentHash(
      request.runId,
      draft.blocks,
      draft.evidenceManifestHash,
      claims,
      assertions,
      ...(draft.schemaVersion === 'answer-draft@2' ? [{ schemaVersion: 'answer-draft@2' as const, limitations: draft.limitations }] : []),
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
    let supportedAssertionIds: Uuid[] = []
    let resolvedEvidence: ReadonlyMap<string, ResolvedEvidence> = new Map()
    if (claims.length + assertions.length === 0) {
      findings.push({ code: 'missing_claims', axis: 'hard', field: 'claims' })
    } else if (claims.length + assertions.length > this.#policy.maxClaims) {
      findings.push({
        code: 'claim_limit_exceeded',
        axis: 'policy',
        field: 'claims',
        expected: String(this.#policy.maxClaims),
        actual: String(claims.length + assertions.length),
      })
    } else {
      resolvedEvidence = await this.#loadEvidence(claims, assertions, request.inputManifest, scopeRef, ctx)
      if (claims.length > 0) {
        const outcome = checkClaims(claims, resolvedEvidence, now, draft.schemaVersion === 'answer-draft@2')
        hardFindings = outcome.findings
        supportedClaimIds = [...outcome.supportedClaimIds]
        findings.push(...hardFindings)
      }
      const assertionOutcome = checkVerifiedAssertions(assertions, resolvedEvidence, ctx, now, draft.schemaVersion === 'answer-draft@2')
      supportedAssertionIds = [...assertionOutcome.supportedAssertionIds]
      findings.push(...assertionOutcome.findings)
    }

    const semantic = await this.#reviewSemantics({
      runId: request.runId,
      question: request.question,
      draftHash: draft.contentHash,
      inputManifest: request.inputManifest,
      claims,
      assertions,
      evidence: resolvedEvidence,
      ctx,
    })
    findings.push(...semantic.findings)

    if (draft.schemaVersion === 'answer-draft@2') {
      const supportedCodes = new Set<string>(findings.map((finding) => finding.code))
      const trustedCodes = new Set(request.trustedLimitations ?? [])
      const missingEvidenceIds = new Set(findings
        .filter((finding) => finding.code === 'evidence_not_found')
        .map((finding) => finding.evidenceRef?.id)
        .filter((id): id is Uuid => id !== undefined))
      for (const [index, limitation] of draft.limitations.entries()) {
        const match = typeof limitation === 'string' ? /^missing_evidence:([0-9a-f-]{36})$/iu.exec(limitation) : null
        const hasEvidenceGap = match?.[1] !== undefined && missingEvidenceIds.has(match[1])
        if (!verifiedLimitationCode(limitation) || (!supportedCodes.has(limitation) && !trustedCodes.has(limitation) && !hasEvidenceGap)) {
          findings.push({ code: 'unverified_limitation', axis: 'hard', field: 'limitations', pointer: `/limitations/${String(index)}` })
        }
      }
    }

    const sorted = sortFindings(findings)
    const hardFailed = sorted.some((finding) => finding.axis === 'hard')
    const policyFailed = sorted.some((finding) => finding.axis === 'policy')
    const semanticFailed = sorted.some((finding) => finding.axis === 'semantic')
    const semanticBlocks = this.#policy.semanticReview === 'required'
    const clarificationRequired = sorted.some((finding) => finding.code === 'semantic_unavailable')
    const verdict: VerificationResult['verdict'] =
      hardFailed || policyFailed || clarificationRequired || (semanticBlocks && semanticFailed) ? 'fail' : 'pass'

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
      supportedAssertionIds: supportedAssertionIds.sort(),
      missingEvidence,
      findings: sorted,
      explanations,
      semanticReview: semantic.disposition,
    }
  }

  /**
   * Resolve every claim binding against the run's evidence manifest and archive. A binding
   * that is not in the manifest, or whose record/payload cannot be read, is left unresolved so
   * the hard checks report it as a located `evidence_not_found`/`result_unreadable` finding.
   */
  async #loadEvidence(
    claims: readonly DraftClaim[],
    assertions: readonly VerifiedAssertion[],
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
    for (const assertion of assertions) {
      for (const binding of assertion.references) {
        if (manifestEvidenceIds.has(binding.evidenceRef.id)) uniqueRefs.set(binding.evidenceRef.id, binding.evidenceRef)
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

  async #reviewSemantics(input: {
    readonly runId: Uuid
    readonly question: string | undefined
    readonly draftHash: Sha256Digest
    readonly inputManifest: WorkflowInputManifest
    readonly claims: readonly DraftClaim[]
    readonly assertions: readonly VerifiedAssertion[]
    readonly evidence: ReadonlyMap<string, ResolvedEvidence>
    readonly ctx: ToolContext
  }): Promise<{ readonly findings: readonly VerificationFinding[]; readonly disposition: SemanticReviewDisposition }> {
    if (this.#policy.semanticReview === 'disabled') {
      return { findings: [], disposition: { status: 'not_run', reason: 'disabled' } }
    }
    if (input.claims.length === 0) {
      return { findings: [], disposition: { status: 'not_run', reason: 'no_claims' } }
    }
    if (
      this.#decision === undefined ||
      this.#modelRef === undefined ||
      this.#decisionStateRefProvider === undefined ||
      input.question === undefined ||
      input.question.trim().length === 0
    ) {
      return this.#notRun('not_configured', [])
    }

    const state = buildSemanticDecisionState({
      runId: input.runId,
      resolvedProfileHash: input.ctx.resolvedProfileHash,
      question: input.question,
      draftHash: input.draftHash,
      inputManifest: input.inputManifest,
      claims: input.claims,
      assertions: input.assertions,
      evidence: input.evidence,
    })
    const stateRef = await this.#decisionStateRefProvider.archive(
      { runId: input.runId, resolvedProfileHash: input.ctx.resolvedProfileHash, state },
      input.ctx,
    )
    if (!isSemanticStateRef(stateRef)) {
      throw new DraftVerificationError('INVALID_DRAFT', 'the semantic state provider returned an invalid ref')
    }

    const findings: VerificationFinding[] = []
    for (const claim of input.claims) {
      // Each claim gets its own fixed-shape JEV request, while every request names the
      // same immutable, host-authorized state snapshot for this exact draft.
      const question = buildSemanticQuestion(claim, this.#policy, this.#newId)
      const result = await this.#decision.decide(
        { stateRef, questions: [question], modelRef: this.#modelRef },
        input.ctx,
      )
      const outcome = interpretSemanticResult(result, claim.claimId)
      if (outcome.kind === 'finding') findings.push(outcome.finding)
      if (outcome.kind === 'unavailable') return this.#notRun('provider_fallback', findings)
    }
    return { findings, disposition: { status: 'completed' } }
  }

  #notRun(
    reason: 'not_configured' | 'provider_fallback',
    findings: readonly VerificationFinding[],
  ): { readonly findings: readonly VerificationFinding[]; readonly disposition: SemanticReviewDisposition } {
    return {
      findings: this.#policy.onJevUnavailable === 'clarify'
        ? [...findings, { code: 'semantic_unavailable', axis: 'semantic' }]
        : findings,
      disposition: { status: 'not_run', reason },
    }
  }
}

function isSemanticStateRef(ref: ResourceRef): boolean {
  return (
    typeof ref === 'object' &&
    ref !== null &&
    typeof ref.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ref.id) &&
    typeof ref.version === 'string' &&
    ref.version.length > 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
    ref.kind === 'artifact'
  )
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
