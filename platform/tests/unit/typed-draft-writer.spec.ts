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
  TypedDraftWriterError,
  TypedEvidenceDraftWriter,
  answerDraftContentHash,
  scenarioManifestHash,
  typedResultContextFor,
  typedResultManifestContentDigest,
} from '@ontology/application'
import type { TypedResultContext } from '@ontology/application'
import { sha256DigestOf } from '@ontology/core'
import type {
  DraftWriterRequest,
  EvidenceEnvelope,
  NewRunRecord,
  PublicationGrant,
  ResourceRef,
  TypedResultManifest,
  WorkflowInputManifest,
} from '@ontology/contracts'
import {
  InMemoryVerificationArtifacts,
  InMemoryVerificationEvidence,
  NOW,
  RUN_ID,
  SCOPE_A,
  buildEvidence,
  buildInputManifest,
  ownerContext,
  verificationPolicy,
} from './verification-fixtures'
import { DIGEST, PROFILE_REF } from './workflow-fixtures'

const DIGEST_B = sha256DigestOf('digest-b')

interface Harness {
  readonly evidence: InMemoryVerificationEvidence
  readonly artifacts: InMemoryVerificationArtifacts
  readonly put: (kind: EvidenceEnvelope['kind'], payload: unknown) => Promise<ResourceRef>
  readonly manifest: () => WorkflowInputManifest
  readonly writer: (typedResult?: TypedResultContext) => TypedEvidenceDraftWriter
  readonly verifier: () => DraftVerificationService
}

function harness(): Harness {
  const evidence = new InMemoryVerificationEvidence()
  const artifacts = new InMemoryVerificationArtifacts()
  const refs: ResourceRef[] = []
  return {
    evidence,
    artifacts,
    async put(kind, payload) {
      const evidenceId = randomUUID()
      const payloadRef = artifacts.put(evidenceId, payload)
      const envelope = buildEvidence({ evidenceId, payloadRef, resultDigest: payloadRef.digest, kind })
      const record = await evidence.record(SCOPE_A, envelope)
      refs.push(record.evidenceRef)
      return record.evidenceRef
    },
    manifest: () => buildInputManifest([...refs]),
    writer(typedResult) {
      return new TypedEvidenceDraftWriter({
        evidence,
        artifacts,
        now: () => NOW,
        ...(typedResult === undefined
          ? {}
          : { typedResult: { resolve: () => Promise.resolve(typedResult) } }),
      })
    },
    verifier: () =>
      new DraftVerificationService({
        evidence,
        artifacts,
        policy: verificationPolicy({ semanticReview: 'disabled' }),
        now: () => NOW,
      }),
  }
}

function request(manifest: WorkflowInputManifest): DraftWriterRequest {
  return {
    runId: RUN_ID,
    question: '列出结果',
    inputManifest: manifest,
    deficits: [],
    remainingBudget: {
      deadline: '2030-01-01T00:00:00.000Z',
      toolCallsRemaining: 100,
      repairAttemptsRemaining: 4,
      parallelToolLimit: 4,
      tokensRemaining: 1000,
    },
    attempt: 1,
  }
}

const FACT_PAGE = {
  definitionVersion: { id: 'demo.schema', version: '1.0.0', digest: DIGEST },
  gaps: [],
  autoPublished: false,
  items: [
    {
      kind: 'fact',
      ref: { id: 'stmt-energy', version: '1.0.0', digest: DIGEST },
      conceptRef: { namespace: 'demo', conceptId: 'energy', definitionVersion: '1.0.0' },
      payload: {
        subjectEntityId: 'E-1',
        objectId: 'site',
        attributeId: 'energy',
        value: { amount: '12.5', unit: 'kWh' },
        unitCode: 'kWh',
        schemaRef: { id: 'demo.schema', version: '1.0.0', digest: DIGEST },
        validity: { validFrom: NOW },
        recordedSeq: '1',
        assertionId: 'stmt-energy',
        logicalAssertionId: 'stmt-energy',
        sourceStatementId: 'stmt-energy',
        sourceRefs: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
      },
    },
    {
      kind: 'fact',
      ref: { id: 'stmt-active', version: '1.0.0', digest: DIGEST },
      conceptRef: { namespace: 'demo', conceptId: 'active', definitionVersion: '1.0.0' },
      payload: {
        subjectEntityId: 'E-1',
        objectId: 'site',
        attributeId: 'active',
        value: true,
        schemaRef: { id: 'demo.schema', version: '1.0.0', digest: DIGEST },
        validity: { validFrom: NOW },
        recordedSeq: '2',
        assertionId: 'stmt-active',
        logicalAssertionId: 'stmt-active',
        sourceStatementId: 'stmt-active',
        sourceRefs: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
      },
    },
  ],
}

const RELATION_PAGE = {
  resultKind: 'relations',
  edges: [{
    statementId: 'stmt-feeds',
    statementVersion: '4',
    relationId: 'feeds',
    definitionRef: { id: 'def.feeds', version: '2.0.0', digest: DIGEST_B },
    fromEntityId: 'E-A',
    toEntityId: 'E-B',
    fromCandidateId: 'c-a',
    toCandidateId: 'c-b',
    sourceRefs: [],
  }],
}

function ruleArtifact(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'rule-computation-artifact@1',
    definitionRef: { id: 'def.maintenance', version: '1.0.0', digest: DIGEST },
    ruleRef: { id: 'rule.maintenance', version: '1.0.0', digest: DIGEST_B },
    subjectEntityId: 'E-1',
    predicate: 'maintenance_applicability',
    applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true },
    computationDigest: sha256DigestOf('computation'),
    complete: true,
    ...overrides,
  }
}

const CITATION_PAYLOAD = {
  subject: 'entity.device-17',
  quote: 'the inspection interval is 90 days',
  quoteDigest: sha256DigestOf('the inspection interval is 90 days'),
  textDigest: sha256DigestOf('full-document-text'),
  locator: { kind: 'page', page: 4 },
  documentRef: { id: 'd1111111-1111-4111-8111-111111111111', version: '1.0.0', digest: DIGEST, kind: 'document' },
  documentVersionRef: { id: 'd2222222-2222-4222-8222-222222222222', version: '3.0.0', digest: DIGEST_B, kind: 'artifact' },
}

const TABLE_PAYLOAD = {
  resultKind: 'table',
  table: {
    columns: [
      { name: 'inspection_due', type: 'boolean', semanticFieldRef: 'inspection_due' },
      { name: 'facility_id', type: 'string', semanticFieldRef: 'facility_id' },
    ],
    rows: [[true, 'T-01'], [false, 'T-02']],
  },
}

const COMPUTE_PAYLOAD = {
  resultKind: 'computation',
  table: {
    columns: [
      { name: 'subject', type: 'string' },
      { name: 'demand', type: 'quantity', unit: 'kWh' },
    ],
    rows: [['E-1', 3.5]],
  },
}

/** The exact shape a registered operation emits: `computation.metrics` with no inline table. */
const REGISTERED_COMPUTE_PAYLOAD = {
  resultKind: 'computation',
  computation: {
    operationRef: { id: 'example.compute.aggregate', version: '1' },
    resultRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    algorithmVersion: { id: 'example.aggregate', version: '1.0.0', digest: DIGEST },
    metrics: {
      record_count: 2,
      total_quantity: { amount: '12.5', unit: 'each' },
      total_cost: { amount: '3.5', currency: 'CNY' },
    },
    domainStatus: 'known',
  },
}

describe('typed draft writer renders every result family into verifiable typed statements', () => {
  it('renders published facts as a quantity claim and a boolean assertion', async () => {
    const h = harness()
    await h.put('observation', FACT_PAGE)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.schemaVersion).toBe('answer-draft@2')
    expect(result.draft.claims).toHaveLength(1)
    expect(result.draft.assertions).toHaveLength(1)
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('renders an entity relation as a relation_ref assertion', async () => {
    const h = harness()
    await h.put('observation', RELATION_PAGE)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions?.[0]).toMatchObject({ kind: 'relation_ref', subject: 'E-A', predicate: 'feeds' })
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('renders a rule derivation as a rule_judgement assertion', async () => {
    const h = harness()
    await h.put('rule_derivation', { schemaVersion: 'rule-derivation-support-payload@1', artifact: ruleArtifact() })
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions?.[0]).toMatchObject({ kind: 'rule_judgement', value: 'true' })
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('renders a document span as an exact document_quote assertion', async () => {
    const h = harness()
    await h.put('document_span', CITATION_PAYLOAD)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions?.[0]).toMatchObject({ kind: 'document_quote', quote: CITATION_PAYLOAD.quote })
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('renders structured-query cells as row-bound typed assertions', async () => {
    const h = harness()
    await h.put('observation', TABLE_PAYLOAD)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions).toHaveLength(4)
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('renders presentable compute output as a quantity claim', async () => {
    const h = harness()
    await h.put('computation', COMPUTE_PAYLOAD)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.claims?.[0]).toMatchObject({ predicate: 'demand', value: { value: 3.5, unit: 'kWh' } })
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('projects a registered operation\'s computation.metrics into unit- and currency-bound claims', async () => {
    const h = harness()
    await h.put('computation', REGISTERED_COMPUTE_PAYLOAD)
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.claims).toHaveLength(2)
    const byPredicate = new Map(result.draft.claims?.map((claim) => [claim.predicate, claim]))
    expect(byPredicate.get('total_quantity')).toMatchObject({
      subject: 'example.compute.aggregate',
      value: { value: '12.5', unit: 'each' },
      kind: 'computation',
    })
    expect(byPredicate.get('total_cost')).toMatchObject({ value: { value: '3.5', unit: 'CNY' } })
    // A bare scalar metric with no unit axis is declared, never fabricated into a quantity.
    expect(result.draft.limitations).toContain('numeric_cell_no_unit')
    const verification = await h.verifier().verify(
      {
        runId: RUN_ID,
        draft: result.draft,
        inputManifest: manifest,
        ...(result.limitations === undefined ? {} : { trustedLimitations: result.limitations }),
      },
      ownerContext(),
    )
    expect(verification.verdict).toBe('pass')
  })

  it('refuses a compute result whose only metric has no unit instead of inventing a quantity', async () => {
    const h = harness()
    await h.put('computation', {
      resultKind: 'computation',
      computation: {
        operationRef: { id: 'example.compute.aggregate', version: '1' },
        metrics: { record_count: 3 },
        domainStatus: 'known',
      },
    })
    const manifest = h.manifest()
    await expect(h.writer().writeDraft(request(manifest), ownerContext())).rejects.toMatchObject({ code: 'INSUFFICIENT_DATA' })
  })
})

describe('typed draft writer refuses incomplete results and never fabricates a statement', () => {
  it('refuses an incomplete facts page instead of drafting a partial answer', async () => {
    const h = harness()
    await h.put('observation', { ...FACT_PAGE, gaps: ['facts_uncovered:result_page_truncated'] })
    const manifest = h.manifest()
    await expect(h.writer().writeDraft(request(manifest), ownerContext())).rejects.toMatchObject({ code: 'INCOMPLETE_RESULT' })
  })

  it('fails closed when no result family can be rendered', async () => {
    const h = harness()
    await h.put('model_output', { note: 'free text is not a result' })
    const manifest = h.manifest()
    await expect(h.writer().writeDraft(request(manifest), ownerContext())).rejects.toBeInstanceOf(TypedDraftWriterError)
  })

  it('declares a truncated result as a limitation instead of claiming completeness', async () => {
    const h = harness()
    await h.put('observation', { ...TABLE_PAYLOAD, table: { ...TABLE_PAYLOAD.table, coverage: { returned: 2, truncated: true } } })
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.limitations).toContain('result_truncated')
    expect(result.limitations).toContain('result_truncated')
    const verification = await h.verifier().verify(
      {
        runId: RUN_ID,
        draft: result.draft,
        inputManifest: manifest,
        ...(result.limitations === undefined ? {} : { trustedLimitations: result.limitations }),
      },
      ownerContext(),
    )
    expect(verification.verdict).toBe('pass')
  })
})

describe('typed draft writer pins the verified version for an answer-draft@3 publication', () => {
  const executionBindingRef: ResourceRef = { id: 'e0000000-0000-4000-8000-000000000001', version: '1.0.0', digest: DIGEST, kind: 'artifact' }
  const resultManifestRef: ResourceRef = { id: 'e0000000-0000-4000-8000-000000000002', version: '1.0.0', digest: DIGEST, kind: 'artifact' }
  const finalizationReceiptRef: ResourceRef = { id: 'e0000000-0000-4000-8000-000000000003', version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }
  const typedResult: TypedResultContext = {
    executionBindingRef,
    resultManifestRef,
    resultManifestDigest: resultManifestRef.digest,
    finalizationReceiptRef,
    finalizationReceiptDigest: finalizationReceiptRef.digest,
  }

  it('emits a @3 body whose hash binds the manifest, receipt and execution binding', async () => {
    const h = harness()
    await h.put('observation', FACT_PAGE)
    const manifest = h.manifest()
    const result = await h.writer(typedResult).writeDraft(request(manifest), ownerContext())
    expect(result.draft.schemaVersion).toBe('answer-draft@3')
    expect(result.draft.contentHash).toBe(answerDraftContentHash(
      RUN_ID,
      result.draft.blocks,
      manifest.digest,
      result.draft.claims ?? [],
      result.draft.assertions ?? [],
      {
        schemaVersion: 'answer-draft@3',
        limitations: result.draft.limitations,
        resultManifestRef,
        resultManifestDigest: resultManifestRef.digest,
        finalizationReceiptRef,
        finalizationReceiptDigest: finalizationReceiptRef.digest,
        executionBindingRef,
      },
    ))
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('pass')
  })

  it('refuses to verify a @3 draft that drops one binding, and never publishes it', async () => {
    const h = harness()
    await h.put('observation', FACT_PAGE)
    const manifest = h.manifest()
    const result = await h.writer(typedResult).writeDraft(request(manifest), ownerContext())
    const { finalizationReceiptDigest: _dropped, ...stripped } = result.draft
    void _dropped
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: stripped, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('fail')
    expect(verification.failedChecks).toContain('draft_hash_mismatch')
  })

  it('requires re-verification after any body edit (the old verified hash no longer holds)', async () => {
    const h = harness()
    await h.put('observation', FACT_PAGE)
    const manifest = h.manifest()
    const result = await h.writer(typedResult).writeDraft(request(manifest), ownerContext())
    const original = result.draft.claims?.[0]
    expect(original).toBeDefined()
    const edited = {
      ...result.draft,
      claims: [{ ...original, value: { value: '999', unit: 'kWh' } } as NonNullable<typeof original>],
    }
    // The edited body cannot reuse the verified content hash: the verifier recomputes it.
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: edited, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('fail')
    expect(verification.failedChecks).toContain('draft_hash_mismatch')
  })

  it('pins the manifest digest from the manifest body and refuses a mismatched ref', () => {
    const manifest: TypedResultManifest = {
      schemaVersion: 'typed-result-manifest@1',
      executionBindingRef: typedResult.executionBindingRef,
      taskBindingRef: { id: 'task.demo', version: '1.0.0', digest: DIGEST },
      resultKind: 'compute',
      outputSchemaRef: { id: 'schema.demo', version: '1.0.0', digest: DIGEST },
      inputSnapshotRef: typedResult.resultManifestRef,
      outputDigest: DIGEST,
      tables: [],
      limitations: [],
      coverage: { returned: 1, truncated: false },
      domainStatus: 'known',
      dataMode: 'synthetic',
    }
    const ref: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: typedResultManifestContentDigest(manifest), kind: 'artifact' }
    const resolved = typedResultContextFor({
      executionBindingRef: typedResult.executionBindingRef,
      resultManifest: manifest,
      resultManifestRef: ref,
      finalizationReceiptRef: typedResult.finalizationReceiptRef,
      finalizationReceiptDigest: typedResult.finalizationReceiptDigest,
    })
    expect(resolved.resultManifestDigest).toBe(ref.digest)
    expect(() => typedResultContextFor({
      executionBindingRef: typedResult.executionBindingRef,
      resultManifest: manifest,
      resultManifestRef: { ...ref, digest: DIGEST },
      finalizationReceiptRef: typedResult.finalizationReceiptRef,
      finalizationReceiptDigest: typedResult.finalizationReceiptDigest,
    })).toThrow(TypedDraftWriterError)
  })

  it('publishes the exact verified @3 version and reads the same version back', async () => {
    const store = new InMemoryRunStore()
    const manifests = new InMemoryWorkflowStore()
    const verifications = new InMemoryVerificationStore()
    const answers = new InMemoryAnswerStore(store)
    const validity = new InMemoryPublicationValidity()
    const ctx = ownerContext()

    const h = harness()
    await h.put('observation', FACT_PAGE)
    const manifest = h.manifest()
    await manifests.saveInputManifest(manifest, ctx)
    const runManifest = {
      runId: RUN_ID,
      resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: DIGEST },
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
      budgetLedgerId: randomUUID(),
      inputManifestId: manifest.manifestId,
      createdAt: NOW,
    }
    await manifests.saveRunManifest(runManifest, ctx)

    const newRun: NewRunRecord = {
      runId: RUN_ID,
      ownerSubjectId: 'owner-a',
      profileRef: PROFILE_REF,
      resolvedProfileHash: DIGEST,
      runtimeRef: runManifest.runtimeRef,
      question: '列出结果',
      context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
      preferences: { route: 'auto', allowWeb: false },
      idempotencyKey: 'typed-draft-v3-0001',
      requestDigest: DIGEST,
      createdAt: NOW,
    }
    await store.insertRun(SCOPE_A, newRun, ctx)
    const verifying = await store.compareAndSetRunState(
      SCOPE_A,
      RUN_ID,
      '1',
      { state: 'verifying', updatedAt: NOW, cancelReason: null, cancelledAt: null },
      ctx,
    )

    const written = await h.writer(typedResult).writeDraft(request(manifest), ctx)
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: written.draft, inputManifest: manifest }, ctx)
    expect(verification.verdict).toBe('pass')
    await verifications.record({ runId: RUN_ID, verification }, ctx)

    const grant: PublicationGrant = {
      grantId: randomUUID(),
      runId: RUN_ID,
      draftId: written.draft.draftId,
      draftHash: written.draft.contentHash,
      verificationId: verification.verificationId,
      evidenceManifestHash: written.draft.evidenceManifestHash,
      scenarioManifestHash: scenarioManifestHash(runManifest, manifest),
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
    const published = await publisher.publish({ grant, draft: written.draft, verification }, ctx)
    expect(published.contentHash).toBe(written.draft.contentHash)
    expect(published.v3Body?.schemaVersion).toBe('answer-draft@3')
    expect(published.v3Body?.resultManifestRef).toEqual(resultManifestRef)

    const reread = await publisher.findAnswer(RUN_ID, ctx)
    expect(reread?.contentHash).toBe(published.contentHash)
    expect(reread?.draftId).toBe(published.draftId)
    expect(reread?.v3Body).toEqual(published.v3Body)
  })
})
