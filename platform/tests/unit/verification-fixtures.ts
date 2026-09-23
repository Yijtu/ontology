import { randomUUID } from 'node:crypto'
import { BudgetService, InMemoryBudgetLedgerStore, sha256DigestOf } from '@ontology/core'
import { answerDraftContentHash, inputManifestDigest } from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import {
  DEFAULT_VERIFICATION_POLICY,
  type AnswerDraft,
  type BlobGetAuthorizedRequest,
  type BlobGetAuthorizedResponse,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResult,
  type DraftClaim,
  type EvidenceEnvelope,
  type EvidenceRecord,
  type EvidenceStorePort,
  type ResourceRef,
  type ScopeRef,
  type Sha256Digest,
  type ToolContext,
  type Uuid,
  type VerificationPolicy,
  type WorkflowInputEntry,
  type WorkflowInputManifest,
} from '@ontology/contracts'
import { semanticOptionSetHash } from '@ontology/application'
import { RecordingControlRepository } from './component-registry-fixtures'
import { SCOPE_A, fixedClock, toolContext } from './profile-resolver-fixtures'

export { SCOPE_A, fixedClock, toolContext }
export const NOW = '2026-09-21T00:00:00Z'
export const RUN_ID = '33333333-3333-4333-8333-333333333333'
export const LEDGER_ID = '88888888-8888-4888-8888-888888888888'
export const EVIDENCE_ID = 'e1111111-1111-4111-8111-111111111111'
export const BLOB_ID = 'b1111111-1111-4111-8111-111111111111'

export function ownerContext(): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_ID)
}

export function verificationPolicy(overrides?: Partial<VerificationPolicy>): VerificationPolicy {
  return { ...DEFAULT_VERIFICATION_POLICY, ...overrides }
}

/** One archived tool result payload with the fields a claim binds to. */
export interface ResultPayload {
  readonly subject: string
  readonly value: number
  readonly unit: string
  readonly time: string
}

export const RESULT_PAYLOAD: ResultPayload = {
  subject: 'site-demo-a',
  value: 12.5,
  unit: 'kWh',
  time: '2026-09-20T00:00:00Z',
}

/** A deterministic artifact store implementing the verifier's narrow read capability. */
export class InMemoryVerificationArtifacts implements VerificationArtifactStore {
  readonly #payloads = new Map<string, Uint8Array>()

  put(blobId: string, payload: unknown): ResourceRef {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    this.#payloads.set(blobId, bytes)
    return { id: blobId, version: '1.0.0', digest: sha256DigestOf(new TextDecoder().decode(bytes)), kind: 'artifact' }
  }

  getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    const bytes = this.#payloads.get(request.blobRef.id)
    if (bytes === undefined) return Promise.reject(new Error('blob not found'))
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest: request.blobRef.digest,
      mediaType: 'application/json',
      byteSize: bytes.byteLength,
      integrityVerified: true,
    })
  }

  readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const bytes = this.#payloads.get(request.blobRef.id)
    return bytes === undefined ? Promise.reject(new Error('blob not found')) : Promise.resolve(bytes)
  }
}

/** A tenant/space-scoped evidence archive double that keeps the recorded envelopes. */
export class InMemoryVerificationEvidence implements EvidenceStorePort {
  readonly records: EvidenceRecord[] = []

  record(scopeRef: ScopeRef, envelope: EvidenceEnvelope): Promise<EvidenceRecord> {
    void scopeRef
    const record: EvidenceRecord = {
      evidenceRef: {
        id: envelope.evidenceId,
        version: '1.0.0',
        digest: envelope.integrity.digest,
        kind: 'evidence',
      },
      envelope,
      envelopeDigest: envelope.integrity.digest,
      revision: String(this.records.length + 1),
      recordedAt: envelope.observedAt,
    }
    this.records.push(record)
    return Promise.resolve(record)
  }

  get(scopeRef: ScopeRef, evidenceId: Uuid): Promise<EvidenceRecord | undefined> {
    return Promise.resolve(
      this.records.find(
        (record) =>
          record.evidenceRef.id === evidenceId &&
          record.envelope.scopeRef.tenantId === scopeRef.tenantId &&
          record.envelope.scopeRef.spaceId === scopeRef.spaceId,
      ),
    )
  }

  listByRun(scopeRef: ScopeRef, runId: Uuid): Promise<EvidenceRecord[]> {
    return Promise.resolve(
      this.records.filter(
        (record) =>
          record.envelope.producedBy.runId === runId &&
          record.envelope.scopeRef.tenantId === scopeRef.tenantId &&
          record.envelope.scopeRef.spaceId === scopeRef.spaceId,
      ),
    )
  }
}

export function buildEvidence(input: {
  readonly evidenceId?: Uuid
  readonly payloadRef: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly observedAt?: string
  readonly validTo?: string
}): EvidenceEnvelope {
  const body = {
    evidenceId: input.evidenceId ?? EVIDENCE_ID,
    kind: 'observation' as const,
    scopeRef: SCOPE_A,
    producedBy: { componentRef: { id: 'tool-gateway', version: '1.0.0', digest: sha256DigestOf('gateway') }, runId: RUN_ID },
    observedAt: input.observedAt ?? NOW,
    ...(input.validTo === undefined
      ? {}
      : { validity: { validFrom: '2026-09-01T00:00:00Z', validTo: input.validTo } }),
    sourceSnapshots: [
      {
        sourceRef: { namespace: 'ha-anker', sourceId: 'warehouse' },
        schemaVersion: '2026-09-01',
        readAt: input.observedAt ?? NOW,
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
    integrity: { algorithm: 'sha256', digest: sha256DigestOf(JSON.stringify(body)), verifiedAt: NOW },
  }
}

export function buildClaim(overrides?: {
  readonly claimId?: Uuid
  readonly subject?: string
  readonly value?: number
  readonly unit?: string
  readonly asOf?: string
  readonly evidenceRef?: ResourceRef
  readonly resultDigest?: Sha256Digest
  readonly valuePointer?: string
  readonly unitPointer?: string
  readonly subjectPointer?: string
  readonly timePointer?: string
  readonly references?: DraftClaim['references']
}): DraftClaim {
  const evidenceRef: ResourceRef =
    overrides?.evidenceRef ?? { id: EVIDENCE_ID, version: '1.0.0', digest: sha256DigestOf('evidence'), kind: 'evidence' }
  return {
    claimId: overrides?.claimId ?? randomUUID(),
    subject: overrides?.subject ?? RESULT_PAYLOAD.subject,
    predicate: 'forecast_energy',
    value: { value: overrides?.value ?? RESULT_PAYLOAD.value, unit: overrides?.unit ?? RESULT_PAYLOAD.unit },
    time: { asOf: overrides?.asOf ?? RESULT_PAYLOAD.time },
    kind: 'observation',
    references:
      overrides?.references ??
      [
        {
          evidenceRef,
          resultDigest: overrides?.resultDigest ?? sha256DigestOf('result'),
          valuePointer: overrides?.valuePointer ?? '/value',
          unitPointer: overrides?.unitPointer ?? '/unit',
          subjectPointer: overrides?.subjectPointer ?? '/subject',
          timePointer: overrides?.timePointer ?? '/time',
        },
      ],
  }
}

export function buildDraft(input: {
  readonly evidenceManifestHash: Sha256Digest
  readonly claims: readonly DraftClaim[]
  readonly draftId?: Uuid
  readonly blocks?: readonly unknown[]
}): AnswerDraft {
  const blocks = input.blocks ?? input.claims.map((claim) => ({ kind: 'claim', claimId: claim.claimId }))
  return {
    draftId: input.draftId ?? randomUUID(),
    runId: RUN_ID,
    blocks,
    claims: input.claims,
    evidenceManifestHash: input.evidenceManifestHash,
    contentHash: answerDraftContentHash(RUN_ID, blocks, input.evidenceManifestHash, input.claims),
    limitations: [],
    producedInPhase: 'drafting',
    createdAt: NOW,
  }
}

export function buildInputManifest(evidenceRefs: readonly ResourceRef[]): WorkflowInputManifest {
  const entries: WorkflowInputEntry[] = [
    {
      entryId: randomUUID(),
      kind: 'confirmed_context',
      label: 'question',
      addedInPhase: 'preflight',
      recordedAt: NOW,
      readAt: NOW,
    },
    ...evidenceRefs.map((ref) => ({
      entryId: randomUUID(),
      kind: 'evidence' as const,
      label: `evidence:${ref.id}`,
      ref,
      addedInPhase: 'collecting' as const,
      recordedAt: NOW,
      readAt: NOW,
    })),
  ]
  return {
    manifestId: randomUUID(),
    runId: RUN_ID,
    revision: '1',
    entries,
    digest: inputManifestDigest(RUN_ID, entries),
  }
}

/** A fixed-shape decision double that returns one option with a high probability. */
export class FixedSemanticDecision implements DecisionPort {
  readonly calls: DecisionRequest[] = []

  constructor(
    private readonly optionId: string,
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

/**
 * A misbehaving decision double: it returns a valid `DecisionResult` but also carries a
 * free-text `note` property (a class instance with an extra field is still assignable to the
 * interface, so no cast is needed). The verifier must never let that text reach a finding or
 * an explanation.
 */
export class ChattySemanticDecision implements DecisionPort {
  constructor(
    private readonly optionId: string,
    private readonly note: string,
  ) {}

  decide(request: DecisionRequest): Promise<DecisionResult> {
    const question = request.questions[0]
    if (question === undefined) throw new Error('the decision request carried no question')
    const chatty: DecisionResult & { readonly note: string } = {
      questionId: question.questionId,
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: semanticOptionSetHash(),
      selectedOptionId: this.optionId,
      note: this.note,
    }
    return Promise.resolve(chatty)
  }
}

/** A decision double that reports the provider's explicit fallback (JEV unavailable). */
export class FallbackDecision implements DecisionPort {
  decide(request: DecisionRequest): Promise<DecisionResult> {
    const question = request.questions[0]
    if (question === undefined) throw new Error('the decision request carried no question')
    return Promise.resolve({
      questionId: question.questionId,
      questionType: 'choice',
      definitionVersion: '1.0.0',
      optionSetHash: semanticOptionSetHash(),
      fallback: {
        fallback: 'deterministic',
        fallbackReason: 'provider unavailable',
        originalFailure: {
          code: 'MODEL_UNAVAILABLE',
          message: 'provider unavailable',
          retryable: true,
          traceId: 'trace-fallback',
        },
      },
    })
  }
}

export interface BudgetHarness {
  readonly service: BudgetService
  readonly store: InMemoryBudgetLedgerStore
  readonly ledgerId: Uuid
}

export function buildBudget(): BudgetHarness {
  const store = new InMemoryBudgetLedgerStore()
  const service = new BudgetService({
    store,
    control: new RecordingControlRepository(),
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  return { service, store, ledgerId: LEDGER_ID }
}

export async function openRunLedger(harness: BudgetHarness, ctx: ToolContext): Promise<void> {
  await harness.service.openLedger(
    { ledgerId: harness.ledgerId, kind: 'run', runId: RUN_ID },
    ctx,
  )
}

export function modelRef(): { modelId: string; version: string } {
  return { modelId: 'jev-semantic', version: '1.0.0' }
}
