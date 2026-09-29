import { randomUUID } from 'node:crypto'
import { answerDraftContentHash, inputManifestDigest } from '@ontology/application'
import { DraftVerificationService } from '@ontology/application'
import type { DecisionStateRefProvider, VerificationArtifactStore } from '@ontology/application'
import { sha256DigestOf } from '@ontology/core'
import type {
  AnswerDraft,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  DraftClaim,
  EvidenceEnvelope,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  ResourceRef,
  SemanticReviewDisposition,
  ScopeRef,
  ToolContext,
  VerificationPolicy,
  WorkflowInputEntry,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { DEFAULT_VERIFICATION_POLICY } from '@ontology/contracts'
import { semanticOptionSetHash } from '@ontology/application'
import type { Rate } from './metrics'
import { rate } from './metrics'

/**
 * Verification false-pass evaluation (V6, D7.4, US-021).
 *
 * The `DraftVerificationService` under test is the real service. The evidence archive, the
 * artifact reader and the immutable artifact writer are injected real adapters; only the
 * decision model is a clearly-marked controlled double (`ControlledSemanticDecision`), because
 * the harness must never consume a paid model. Each case declares the verdict the gold says
 * is correct; the false-pass rate is (drafts that should fail but passed) / (drafts that
 * should fail), and the false-reject rate is its complement.
 */

/** A controlled decision double: it always selects one configured option and never calls out. */
export class ControlledSemanticDecision implements DecisionPort {
  readonly calls: DecisionRequest[] = []

  constructor(
    private readonly optionId: 'supported' | 'unsupported',
    private readonly probability = 0.99,
  ) {}

  decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request)
    const question = request.questions[0]
    if (question === undefined) throw new Error('the decision request carried no question')
    return Promise.resolve({
      questionId: question.questionId,
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: semanticOptionSetHash(),
      selectedOptionId: this.optionId,
      distribution: {
        optionSetHash: semanticOptionSetHash(),
        entries: [{ optionId: this.optionId, probability: this.probability }],
      },
      confidence: this.probability,
    })
  }
}

export interface VerificationQualityDependencies {
  readonly evidence: EvidenceStorePort
  readonly artifacts: VerificationArtifactStore
  readonly writer: ImmutableArtifactWriter
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly now: () => string
  readonly policy?: VerificationPolicy
}

interface RegisteredResult {
  readonly ref: ResourceRef
  readonly resultDigest: string
}

const PAYLOAD = { subject: 'site-load-a', value: 12.5, unit: 'kWh', time: '2026-09-20T00:00:00Z' }

function envelopeFor(input: {
  readonly scopeRef: ScopeRef
  readonly runId: string
  readonly payloadRef: ResourceRef
  readonly resultDigest: string
  readonly now: string
  readonly validTo?: string
}): EvidenceEnvelope {
  const body = {
    evidenceId: randomUUID(),
    kind: 'observation' as const,
    scopeRef: input.scopeRef,
    producedBy: {
      componentRef: { id: 'tool-gateway', version: '1.0.0', digest: sha256DigestOf('gateway') },
      runId: input.runId,
    },
    observedAt: input.now,
    ...(input.validTo === undefined
      ? {}
      : { validity: { validFrom: '2026-09-01T00:00:00Z', validTo: input.validTo } }),
    sourceSnapshots: [
      {
        sourceRef: { namespace: 'load-harness', sourceId: 'warehouse' },
        schemaVersion: '2026-09-01',
        readAt: input.now,
        consistency: 'repeatable_read' as const,
        resultDigest: input.resultDigest,
      },
    ],
    resultDigest: input.resultDigest,
    dependencies: [],
    dataMode: 'observed' as const,
    payloadRef: input.payloadRef,
  }
  return {
    ...body,
    integrity: { algorithm: 'sha256', digest: sha256DigestOf(JSON.stringify(body)), verifiedAt: input.now },
  }
}

function claimFor(input: {
  readonly ref: ResourceRef
  readonly resultDigest: string
  readonly value?: number
  readonly unit?: string
  readonly subject?: string
  readonly asOf?: string
  readonly references?: DraftClaim['references']
}): DraftClaim {
  return {
    claimId: randomUUID(),
    subject: input.subject ?? PAYLOAD.subject,
    predicate: 'forecast_energy',
    value: { value: input.value ?? PAYLOAD.value, unit: input.unit ?? PAYLOAD.unit },
    time: { asOf: input.asOf ?? PAYLOAD.time },
    kind: 'observation',
    references:
      input.references ?? [
        {
          evidenceRef: input.ref,
          resultDigest: input.resultDigest,
          valuePointer: '/value',
          unitPointer: '/unit',
          subjectPointer: '/subject',
          timePointer: '/time',
        },
      ],
  }
}

function manifestFor(runId: string, refs: readonly ResourceRef[], now: string): WorkflowInputManifest {
  const entries: WorkflowInputEntry[] = [
    {
      entryId: randomUUID(),
      kind: 'confirmed_context',
      label: 'question',
      addedInPhase: 'preflight',
      recordedAt: now,
      readAt: now,
    },
    ...refs.map((ref) => ({
      entryId: randomUUID(),
      kind: 'evidence' as const,
      label: `evidence:${ref.id}`,
      ref,
      addedInPhase: 'collecting' as const,
      recordedAt: now,
      readAt: now,
    })),
  ]
  return {
    manifestId: randomUUID(),
    runId,
    revision: '1',
    entries,
    digest: inputManifestDigest(runId, entries),
  }
}

function draftFor(input: {
  readonly runId: string
  readonly manifestDigest: string
  readonly claims: readonly DraftClaim[]
}): AnswerDraft {
  const blocks = [{ kind: 'summary' }]
  return {
    draftId: randomUUID(),
    runId: input.runId,
    blocks,
    claims: input.claims,
    evidenceManifestHash: input.manifestDigest,
    contentHash: answerDraftContentHash(input.runId, blocks, input.manifestDigest, input.claims),
    limitations: [],
    producedInPhase: 'drafting',
    createdAt: '2026-09-21T00:00:00Z',
  }
}

export interface VerificationQualityRun {
  readonly falsePass: Rate
  readonly falseReject: Rate
  readonly cases: readonly {
    readonly caseId: string
    readonly expectedVerdict: 'pass' | 'fail'
    readonly observedVerdict: 'pass' | 'fail'
    readonly failedChecks: readonly string[]
    readonly semanticReview: SemanticReviewDisposition | undefined
  }[]
  /** Read-back audit of the state the unsupported decision actually received. */
  readonly semanticProbe: {
    readonly decisionCalls: number
    readonly archivedState?: {
      readonly question?: unknown
      readonly claims: readonly {
        readonly claimId?: unknown
        readonly subject?: unknown
        readonly predicate?: unknown
        readonly value?: unknown
        readonly evidenceRefIds: readonly string[]
      }[]
      readonly evidence: readonly {
        readonly refId?: unknown
        readonly availability?: unknown
        readonly payload?: unknown
      }[]
      readonly evidenceCoverageComplete?: unknown
    }
  }
}

export async function runVerificationQuality(
  dependencies: VerificationQualityDependencies,
): Promise<VerificationQualityRun> {
  const { evidence, artifacts, writer, scopeRef, ctx } = dependencies
  const now = dependencies.now()
  const runId = ctx.runId
  const policy = dependencies.policy ?? DEFAULT_VERIFICATION_POLICY
  const semanticQuestion = 'Does the published observation support this claim about site-load-a?'

  const decisionStateRefProvider: DecisionStateRefProvider = {
    archive: async (input, archiveCtx) => {
      const stored = await writer.putBytes(
        {
          scopeRef,
          content: new TextEncoder().encode(JSON.stringify(input.state)),
          mediaType: 'application/json',
        },
        archiveCtx,
      )
      return stored.blobRef
    },
  }

  const register = async (validTo?: string): Promise<RegisteredResult> => {
    const bytes = new TextEncoder().encode(JSON.stringify(PAYLOAD))
    const stored = await writer.putBytes(
      { scopeRef, content: bytes, mediaType: 'application/json' },
      ctx,
    )
    const resultDigest = stored.blobRef.digest
    const envelope = envelopeFor({
      scopeRef,
      runId,
      payloadRef: stored.blobRef,
      resultDigest,
      now,
      ...(validTo === undefined ? {} : { validTo }),
    })
    const record = await evidence.record(scopeRef, envelope, ctx)
    return { ref: record.evidenceRef, resultDigest }
  }

  const supportedDecision = new ControlledSemanticDecision('supported')
  const unsupportedDecision = new ControlledSemanticDecision('unsupported')
  const service = new DraftVerificationService({
    evidence,
    artifacts,
    policy,
    modelRef: { modelId: 'controlled-verification-double', version: '1.0.0' },
    decision: supportedDecision,
    decisionStateRefProvider,
    now: () => now,
  })
  const unsupportedService = new DraftVerificationService({
    evidence,
    artifacts,
    policy,
    modelRef: { modelId: 'controlled-verification-double', version: '1.0.0' },
    decision: unsupportedDecision,
    decisionStateRefProvider,
    now: () => now,
  })

  const results: VerificationQualityRun['cases'][number][] = []
  const record = (
    caseId: string,
    expectedVerdict: 'pass' | 'fail',
    observedVerdict: 'pass' | 'fail',
    failedChecks: readonly string[],
    semanticReview: SemanticReviewDisposition | undefined,
  ): void => {
    results.push({ caseId, expectedVerdict, observedVerdict, failedChecks, semanticReview })
  }

  const runCase = async (
    caseId: string,
    expectedVerdict: 'pass' | 'fail',
    verifier: DraftVerificationService,
    draft: AnswerDraft,
    manifest: WorkflowInputManifest,
  ): Promise<void> => {
    const verdict = await verifier.verify(
      { runId, question: semanticQuestion, draft, inputManifest: manifest },
      ctx,
    )
    record(caseId, expectedVerdict, verdict.verdict, verdict.failedChecks, verdict.semanticReview)
  }

  const correct = await register()
  const correctManifest = manifestFor(runId, [correct.ref], now)
  await runCase(
    'correct-claim-passes',
    'pass',
    service,
    draftFor({ runId, manifestDigest: correctManifest.digest, claims: [claimFor(correct)] }),
    correctManifest,
  )

  const wrongValue = await register()
  const wrongValueManifest = manifestFor(runId, [wrongValue.ref], now)
  await runCase(
    'wrong-value-fails',
    'fail',
    service,
    draftFor({
      runId,
      manifestDigest: wrongValueManifest.digest,
      claims: [claimFor({ ...wrongValue, value: 99 })],
    }),
    wrongValueManifest,
  )

  const wrongUnit = await register()
  const wrongUnitManifest = manifestFor(runId, [wrongUnit.ref], now)
  await runCase(
    'wrong-unit-fails',
    'fail',
    service,
    draftFor({
      runId,
      manifestDigest: wrongUnitManifest.digest,
      claims: [claimFor({ ...wrongUnit, unit: 'MWh' })],
    }),
    wrongUnitManifest,
  )

  const stale = await register('2026-01-01T00:00:00Z')
  const staleManifest = manifestFor(runId, [stale.ref], now)
  await runCase(
    'stale-source-fails',
    'fail',
    service,
    draftFor({ runId, manifestDigest: staleManifest.digest, claims: [claimFor(stale)] }),
    staleManifest,
  )

  const orphanRef: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: sha256DigestOf('orphan'),
    kind: 'evidence',
  }
  const orphanManifest = manifestFor(runId, [], now)
  await runCase(
    'evidence-not-in-manifest-fails',
    'fail',
    service,
    draftFor({
      runId,
      manifestDigest: orphanManifest.digest,
      claims: [claimFor({ ref: orphanRef, resultDigest: sha256DigestOf('orphan-result') })],
    }),
    orphanManifest,
  )

  const semantic = await register()
  const semanticManifest = manifestFor(runId, [semantic.ref], now)
  const semanticClaim = claimFor(semantic)
  const semanticDraft = draftFor({ runId, manifestDigest: semanticManifest.digest, claims: [semanticClaim] })
  await runCase(
    'semantic-unsupported-fails',
    'fail',
    unsupportedService,
    semanticDraft,
    semanticManifest,
  )

  const unsupportedRequest = unsupportedDecision.calls[0]
  const archivedSemanticState = unsupportedRequest === undefined
    ? undefined
    : JSON.parse(
        new TextDecoder().decode(
          await artifacts.readAuthorized({ scopeRef, blobRef: unsupportedRequest.stateRef }, ctx),
        ),
      ) as Record<string, unknown>
  const stateClaims = Array.isArray(archivedSemanticState?.['claims'])
    ? archivedSemanticState['claims'] as Record<string, unknown>[]
    : []
  const stateEvidence = Array.isArray(archivedSemanticState?.['evidence'])
    ? archivedSemanticState['evidence'] as Record<string, unknown>[]
    : []
  const semanticProbe: VerificationQualityRun['semanticProbe'] = {
    decisionCalls: unsupportedDecision.calls.length,
    ...(archivedSemanticState === undefined ? {} : {
      archivedState: {
        question: archivedSemanticState['question'],
        claims: stateClaims.map((claim) => {
          const references = Array.isArray(claim['references'])
            ? claim['references'] as Record<string, unknown>[]
            : []
          return {
            claimId: claim['claimId'],
            subject: claim['subject'],
            predicate: claim['predicate'],
            value: claim['value'],
            evidenceRefIds: references.flatMap((reference) => {
              const evidenceRef = reference['evidenceRef']
              if (typeof evidenceRef !== 'object' || evidenceRef === null || !('id' in evidenceRef)) return []
              const id = (evidenceRef as { readonly id?: unknown }).id
              return typeof id === 'string' ? [id] : []
            }),
          }
        }),
        evidence: stateEvidence.map((entry) => {
          const ref = entry['ref']
          return {
            refId: typeof ref === 'object' && ref !== null && 'id' in ref
              ? (ref as { readonly id?: unknown }).id
              : undefined,
            availability: entry['availability'],
            payload: entry['payload'],
          }
        }),
        evidenceCoverageComplete:
          typeof archivedSemanticState['evidenceCoverage'] === 'object' &&
          archivedSemanticState['evidenceCoverage'] !== null
            ? (archivedSemanticState['evidenceCoverage'] as Record<string, unknown>)['complete']
            : undefined,
      },
    }),
  }

  const shouldFail = results.filter((entry) => entry.expectedVerdict === 'fail')
  const shouldPass = results.filter((entry) => entry.expectedVerdict === 'pass')
  const falsePasses = shouldFail.filter((entry) => entry.observedVerdict === 'pass').length
  const falseRejects = shouldPass.filter((entry) => entry.observedVerdict === 'fail').length
  return {
    falsePass: rate(falsePasses, shouldFail.length),
    falseReject: rate(falseRejects, shouldPass.length),
    cases: results,
    semanticProbe,
  }
}
