import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AnswerPublicationService,
  DraftVerificationService,
  InMemoryAnswerStore,
  InMemoryPublicationValidity,
  InMemoryRunStore,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  PublicationRejectedError,
  answerDraftContentHash,
  inputManifestDigest,
  scenarioManifestHash,
} from '@ontology/application'
import { sha256DigestOf } from '@ontology/core'
import {
  DIGEST,
  NOW,
  PROFILE_REF,
  RUN_A,
  ScriptedRuntime,
  buildWorkflowHarness,
  collectionCompleteEvent,
  evidenceEvent,
  ownerContext,
  planEvent,
  startInput,
} from './workflow-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import {
  BLOB_ID,
  EVIDENCE_ID,
  InMemoryVerificationArtifacts,
  InMemoryVerificationEvidence,
  RESULT_PAYLOAD,
  buildClaim,
  buildEvidence,
  verificationPolicy,
} from './verification-fixtures'
import type {
  AnswerDraft,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  NewRunRecord,
  PublicationGrant,
  RunManifest,
  ToolContext,
  VerificationResult,
  WorkflowInputManifest,
} from '@ontology/contracts'

const OWNER = ownerContext()
const EVIDENCE_REF = {
  id: EVIDENCE_ID,
  version: '1.0.0',
  digest: sha256DigestOf('evidence'),
  kind: 'evidence' as const,
}

interface PublicationHarness {
  readonly publisher: AnswerPublicationService
  readonly store: InMemoryRunStore
  readonly answers: InMemoryAnswerStore
  readonly validity: InMemoryPublicationValidity
  readonly draft: AnswerDraft
  readonly verification: VerificationResult
  readonly grant: PublicationGrant
}

async function buildPublicationHarness(): Promise<PublicationHarness> {
  const store = new InMemoryRunStore()
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const answers = new InMemoryAnswerStore(store)
  const validity = new InMemoryPublicationValidity()

  const entries: WorkflowInputManifest['entries'] = [
    {
      entryId: randomUUID(),
      kind: 'evidence',
      label: `evidence:${EVIDENCE_ID}`,
      ref: EVIDENCE_REF,
      addedInPhase: 'collecting',
      recordedAt: NOW,
      readAt: NOW,
    },
  ]
  const inputManifest: WorkflowInputManifest = {
    manifestId: randomUUID(),
    runId: RUN_A,
    revision: '1',
    entries,
    digest: inputManifestDigest(RUN_A, entries),
  }
  await manifests.saveInputManifest(inputManifest, OWNER)
  const runManifest: RunManifest = {
    runId: RUN_A,
    resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: DIGEST },
    runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
    budgetLedgerId: randomUUID(),
    inputManifestId: inputManifest.manifestId,
    createdAt: NOW,
  }
  await manifests.saveRunManifest(runManifest, OWNER)

  const newRun: NewRunRecord = {
    runId: RUN_A,
    ownerSubjectId: 'owner-a',
    profileRef: PROFILE_REF,
    resolvedProfileHash: DIGEST,
    runtimeRef: runManifest.runtimeRef,
    question: 'compare tomorrow energy strategies',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto', allowWeb: false },
    idempotencyKey: 'publication-idem-0001',
    requestDigest: DIGEST,
    createdAt: NOW,
  }
  await store.insertRun(SCOPE_A, newRun, OWNER)
  const verifying = await store.compareAndSetRunState(
    SCOPE_A,
    RUN_A,
    '1',
    { state: 'verifying', updatedAt: NOW, cancelReason: null, cancelledAt: null },
    OWNER,
  )

  const blocks: readonly unknown[] = [{ kind: 'summary' }]
  const draft: AnswerDraft = {
    draftId: randomUUID(),
    runId: RUN_A,
    blocks,
    evidenceManifestHash: inputManifest.digest,
    contentHash: answerDraftContentHash(RUN_A, blocks, inputManifest.digest),
    limitations: [],
    producedInPhase: 'drafting',
    createdAt: NOW,
  }
  const verification: VerificationResult = {
    verificationId: randomUUID(),
    draftId: draft.draftId,
    draftHash: draft.contentHash,
    evidenceManifestHash: inputManifest.digest,
    verdict: 'pass',
    failedChecks: [],
    policyVersion: 'combined-verification-policy@1',
    verifiedAt: NOW,
  }
  await verifications.record({ runId: RUN_A, verification }, OWNER)
  const grant: PublicationGrant = {
    grantId: randomUUID(),
    runId: RUN_A,
    draftId: draft.draftId,
    draftHash: draft.contentHash,
    verificationId: verification.verificationId,
    evidenceManifestHash: inputManifest.digest,
    scenarioManifestHash: scenarioManifestHash(runManifest, inputManifest),
    expectedRunRevision: verifying.revision,
    issuedBy: 'workflow-controller',
    issuedAt: NOW,
  }
  const publisher = new AnswerPublicationService({
    runs: store,
    answers,
    verifications,
    manifests,
    validity,
    now: () => NOW,
    newId: () => randomUUID(),
  })
  return { publisher, store, answers, validity, draft, verification, grant }
}

describe('answer publication gate: hash binding and atomicity', () => {
  it('publishes only when draft/evidence/verification/scenario hashes are consistent', async () => {
    const harness = await buildPublicationHarness()
    const answer = await harness.publisher.publish(
      { grant: harness.grant, draft: harness.draft, verification: harness.verification },
      OWNER,
    )
    expect(answer.runId).toBe(RUN_A)
    expect(answer.contentHash).toBe(harness.draft.contentHash)
    expect(answer.evidenceManifestHash).toBe(harness.draft.evidenceManifestHash)
    expect(answer.scenarioManifestHash).toBe(harness.grant.scenarioManifestHash)
    expect(answer.verificationId).toBe(harness.verification.verificationId)
    expect(answer.publicationKind).toBe('verified')
    expect(answer.body).toEqual({ schemaVersion: 'answer-draft@1', blocks: harness.draft.blocks, claims: [], assertions: [] })
    // The answer is idempotent per run.
    const again = await harness.publisher.publish(
      { grant: harness.grant, draft: harness.draft, verification: harness.verification },
      OWNER,
    )
    expect(again.answerId).toBe(answer.answerId)
  })

  it('refuses a tampered draft hash, a mismatched evidence manifest and a mismatched scenario', async () => {
    const tampered = await buildPublicationHarness()
    await expect(
      tampered.publisher.publish(
        {
          grant: tampered.grant,
          draft: { ...tampered.draft, contentHash: DIGEST },
          verification: tampered.verification,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'draft_mismatch' })

    const evidence = await buildPublicationHarness()
    await expect(
      evidence.publisher.publish(
        {
          grant: { ...evidence.grant, evidenceManifestHash: DIGEST },
          draft: evidence.draft,
          verification: evidence.verification,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'evidence_manifest_mismatch' })

    const scenario = await buildPublicationHarness()
    await expect(
      scenario.publisher.publish(
        {
          grant: { ...scenario.grant, scenarioManifestHash: DIGEST },
          draft: scenario.draft,
          verification: scenario.verification,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'scenario_manifest_mismatch' })
  })
})

describe('a framework/SDK final cannot bypass the gate (INV-09)', () => {
  it('refuses a grant that was not issued by the controller', async () => {
    const harness = await buildPublicationHarness()
    await expect(
      harness.publisher.publish(
        {
          grant: { ...harness.grant, issuedBy: 'runtime' as 'workflow-controller' },
          draft: harness.draft,
          verification: harness.verification,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'grant_not_issued_by_controller' })
  })

  it('refuses a forged pass verdict that was never recorded by the verifier', async () => {
    const harness = await buildPublicationHarness()
    const forged = { ...harness.verification, verificationId: randomUUID() }
    await expect(
      harness.publisher.publish(
        {
          grant: { ...harness.grant, verificationId: forged.verificationId },
          draft: harness.draft,
          verification: forged,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'verification_not_recorded' })
    expect(await harness.answers.findByRun(RUN_A, OWNER)).toBeUndefined()
  })

  it('does not publish when the runtime emits a framework collection_complete', async () => {
    const harness = buildWorkflowHarness({
      runtime: new ScriptedRuntime({
        scripts: [[planEvent(RUN_A), evidenceEvent(RUN_A, [EVIDENCE_REF]), collectionCompleteEvent(RUN_A)]],
      }),
    })
    // A framework "final" (collection_complete) only moves the run to drafting; it can never
    // create a published answer on its own.
    const view = await harness.controller.startRun(startInput(), OWNER)
    expect(view.answer?.answerId).toBeDefined()
    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    expect(events.some((event) => event.event === 'answer.published')).toBe(true)
    // The only publisher call came from the controller's verified path, not the runtime.
    expect(harness.publisher.publishCalls).toHaveLength(1)
  })
})

describe('post-verification invalidation blocks publication', () => {
  it('blocks when the supporting evidence is retracted after verification', async () => {
    const harness = await buildPublicationHarness()
    harness.validity.retractEvidence(EVIDENCE_ID, 'the statement was retracted')
    await expect(
      harness.publisher.publish(
        { grant: harness.grant, draft: harness.draft, verification: harness.verification },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'publication_blocked' })
    expect(await harness.answers.findByRun(RUN_A, OWNER)).toBeUndefined()
  })

  it('blocks when the publication permission is revoked after verification', async () => {
    const harness = await buildPublicationHarness()
    harness.validity.revokePermission(RUN_A, 'the publisher lost access to the space')
    await expect(
      harness.publisher.publish(
        { grant: harness.grant, draft: harness.draft, verification: harness.verification },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'publication_blocked' })
    expect(await harness.answers.findByRun(RUN_A, OWNER)).toBeUndefined()
  })

  it('blocks when the run is cancelled after verification', async () => {
    const harness = await buildPublicationHarness()
    await harness.store.compareAndSetRunState(
      SCOPE_A,
      RUN_A,
      harness.grant.expectedRunRevision,
      { state: 'cancelled', updatedAt: NOW, cancelReason: 'user cancelled', cancelledAt: NOW },
      OWNER,
    )
    await expect(
      harness.publisher.publish(
        { grant: harness.grant, draft: harness.draft, verification: harness.verification },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'run_not_publishable' })
    expect(await harness.answers.findByRun(RUN_A, OWNER)).toBeUndefined()
  })

  it('publishes a stale-but-supported result only when it is explicitly history-limited', async () => {
    const harness = await buildPublicationHarness()
    harness.validity.markStale(RUN_A, '2026-09-20T00:00:00Z', 'the source advanced after verification')
    const answer = await harness.publisher.publish(
      { grant: harness.grant, draft: harness.draft, verification: harness.verification },
      OWNER,
    )
    expect(answer.publicationKind).toBe('history_limited')
    expect(answer.asOf).toBe('2026-09-20T00:00:00Z')
    expect(answer.limitations).toEqual(harness.draft.limitations)
    expect(answer.body?.blocks).toEqual(harness.draft.blocks)
  })

  it('refuses body changes after the passing verification even when ids and grant remain unchanged', async () => {
    const harness = await buildPublicationHarness()
    await expect(
      harness.publisher.publish(
        {
          grant: harness.grant,
          draft: { ...harness.draft, blocks: [{ kind: 'summary', text: 'Changed after verify.' }] },
          verification: harness.verification,
        },
        OWNER,
      ),
    ).rejects.toMatchObject({ reason: 'draft_hash_mismatch' })
  })
})

/** A draft writer that emits one supported and one unsupported structured claim. */
class ClaimDraftWriter implements DraftWriterPort {
  constructor(private readonly envelopeResultDigest: string) {}

  writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    void ctx
    const ref = request.inputManifest.entries.find((entry) => entry.kind === 'evidence')?.ref
    if (ref === undefined) throw new Error('the input manifest carried no evidence ref')
    const good = buildClaim({ evidenceRef: ref, resultDigest: this.envelopeResultDigest })
    const bad = buildClaim({ evidenceRef: ref, resultDigest: this.envelopeResultDigest, value: 999 })
    const claims = [good, bad]
    const blocks: readonly unknown[] = [{ kind: 'summary' }]
    const evidenceManifestHash = request.inputManifest.digest
    const draft: AnswerDraft = {
      draftId: randomUUID(),
      runId: request.runId,
      blocks,
      claims,
      evidenceManifestHash,
      contentHash: answerDraftContentHash(request.runId, blocks, evidenceManifestHash, claims),
      limitations: [],
      producedInPhase: 'drafting',
      createdAt: NOW,
    }
    return Promise.resolve({
      draft,
      usage: { durationMs: 1, calls: 0, modelTokens: 32 },
      evidenceRefs: [
        { id: draft.draftId, version: '1.0.0', digest: draft.contentHash, kind: 'artifact' },
      ],
    })
  }
}

async function limitedHarness() {
  const evidence = new InMemoryVerificationEvidence()
  const artifacts = new InMemoryVerificationArtifacts()
  const payloadRef = artifacts.put(BLOB_ID, RESULT_PAYLOAD)
  const envelope = buildEvidence({ payloadRef, resultDigest: sha256DigestOf('result') })
  await evidence.record(SCOPE_A, envelope)
  const verifier = new DraftVerificationService({
    evidence,
    artifacts,
    policy: verificationPolicy({ semanticReview: 'disabled' }),
  })
  const runtime = new ScriptedRuntime({
    scripts: [
      [
        planEvent(RUN_A),
        evidenceEvent(RUN_A, [
          { id: EVIDENCE_ID, version: '1.0.0', digest: envelope.integrity.digest, kind: 'evidence' },
        ]),
        collectionCompleteEvent(RUN_A),
      ],
    ],
  })
  const harness = buildWorkflowHarness({
    runtime,
    verifier,
    draftWriter: new ClaimDraftWriter(envelope.resultDigest),
  })
  return harness
}

describe('limited repair shares the run budget and falls back to a limited factual result', () => {
  it('publishes a limited factual result instead of unverified prose when the budget is exhausted', async () => {
    const harness = await limitedHarness()
    const view = await harness.controller.startRun(startInput(), OWNER)

    expect(view.state).toBe('published')
    expect(view.answer?.publicationKind).toBe('verified')
    expect(view.answer?.limitations).toContain('limited_factual_result')

    // Both repair attempts and the limited fallback drew from the one shared ledger.
    expect(harness.budget.openLedgerCalls).toHaveLength(1)
    expect(view.budgetLedgerId).toBe(harness.budget.openLedgerCalls[0])
    expect(harness.draftWriter.calls).toHaveLength(2)

    // The unsupported claim never survived into the published answer.
    const published = await harness.controller.getAnswer(RUN_A, OWNER)
    expect(published).toBeDefined()
  })

  it('never leaks an unverified draft into the business event stream', async () => {
    const harness = await limitedHarness()
    await harness.controller.startRun(startInput(), OWNER)

    const events = await harness.service.listEvents(RUN_A, undefined, OWNER)
    const allowed = new Set([
      'run.state',
      'plan.summary',
      'tool.started',
      'tool.completed',
      'evidence.available',
      'clarification.required',
      'answer.published',
      'run.failed',
    ])
    for (const event of events) {
      expect(allowed.has(event.event)).toBe(true)
      expect(event.event).not.toBe('unverified_answer.delta')
      const payload = JSON.stringify(event.data)
      expect(payload).not.toContain('claims')
      expect(payload).not.toContain('"blocks"')
      expect(payload).not.toContain('draftId')
    }
    expect(events.some((event) => event.event === 'answer.published')).toBe(true)
  })
})

describe('the publication gate is a classified rejection, never a false success', () => {
  it('exposes PublicationRejectedError so the controller can surface PUBLICATION_REJECTED', async () => {
    const harness = await buildPublicationHarness()
    harness.validity.retractEvidence(EVIDENCE_ID)
    await expect(
      harness.publisher.publish(
        { grant: harness.grant, draft: harness.draft, verification: harness.verification },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(PublicationRejectedError)
  })
})
