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

function manyRowQueryPayload(rowCount = 251): Record<string, unknown> {
  return {
    resultKind: 'table',
    table: {
      tableId: 'query-result-251',
      columns: [
        { name: 'record_id', type: 'string', semanticFieldRef: 'record_id' },
        { name: 'sources_json', type: 'string', semanticFieldRef: 'sources_json' },
        { name: 'subject_entity_id', type: 'string', semanticFieldRef: 'subject_entity_id' },
        { name: 'state', type: 'string', semanticFieldRef: 'state' },
      ],
      rows: Array.from({ length: rowCount }, (_, index) => [
        `record-${String(index + 1)}`,
        `source-${String(index + 1)}`,
        `entity-${String(index + 1)}`,
        'active',
      ]),
      coverage: { returned: rowCount, truncated: false },
    },
  }
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

  it('renders a legacy rule artifact but refuses verification without archived actual premises', async () => {
    const h = harness()
    await h.put('rule_derivation', { schemaVersion: 'rule-derivation-support-payload@1', artifact: ruleArtifact() })
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions?.[0]).toMatchObject({ kind: 'rule_judgement', value: 'true' })
    const verification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest }, ownerContext())
    expect(verification.verdict).toBe('fail')
    expect(verification.failedChecks).toContain('rule_premise_missing')
  })

  it('retains approximate premise precision as a factual limitation on a rule draft', async () => {
    const h = harness()
    await h.put('rule_derivation', { schemaVersion: 'rule-derivation-support-payload@1', artifact: ruleArtifact(), premiseRefs: [], sourceEvidenceMappings: [{ sourceSpan: { precision: 'approximate' } }] })
    const result = await h.writer().writeDraft(request(h.manifest()), ownerContext())
    expect(result.draft.limitations).toContain('limited_factual_result')
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

  it('keeps a structured projection limited and refuses a forged exact citation at an approximate locator', async () => {
    const h = harness()
    const projectionRef: ResourceRef = { id: 'd3333333-3333-4333-8333-333333333333', version: '1.0.0', digest: DIGEST, kind: 'artifact' }
    await h.put('document_span', { ...CITATION_PAYLOAD, locator: { kind: 'approximate_locator', startOffset: 0, endOffset: 42 }, spanKind: 'approximate', sourceOrigin: { precision: 'approximate', projectionRef } })
    const manifest = h.manifest()
    const result = await h.writer().writeDraft(request(manifest), ownerContext())
    expect(result.draft.assertions?.[0]).toMatchObject({ kind: 'artifact_summary', artifactRef: projectionRef })
    expect(result.draft.limitations).toContain('limited_factual_result')
    const limitedVerification = await h.verifier().verify({ runId: RUN_ID, draft: result.draft, inputManifest: manifest, trustedLimitations: result.limitations ?? [] }, ownerContext())
    expect(limitedVerification, JSON.stringify(limitedVerification.findings)).toMatchObject({ verdict: 'pass' })

    const precise = harness()
    await precise.put('document_span', CITATION_PAYLOAD)
    const exactManifest = precise.manifest()
    const written = await precise.writer().writeDraft(request(exactManifest), ownerContext())
    const assertion = written.draft.assertions?.[0]
    if (assertion?.kind !== 'document_quote') throw new Error('the exact fixture did not render a citation')
    const forged = { ...written.draft, assertions: [{ ...assertion, locator: { kind: 'approximate_locator' as const, page: 4 }, precision: 'exact' as const }] }
    forged.contentHash = answerDraftContentHash(RUN_ID, forged.blocks, forged.evidenceManifestHash, forged.claims ?? [], forged.assertions, { schemaVersion: 'answer-draft@2', limitations: forged.limitations })
    const verification = await precise.verifier().verify({ runId: RUN_ID, draft: forged, inputManifest: exactManifest }, ownerContext())
    expect(verification.verdict).toBe('fail')
    expect(verification.findings?.some((finding) => finding.code === 'document_quote_mismatch')).toBe(true)
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

  it('bounds only the inline preview for one exact complete formal table and omits reserved columns', async () => {
    const h = harness()
    const payload = manyRowQueryPayload()
    const evidenceRef = await h.put('observation', payload)
    const record = await h.evidence.get(SCOPE_A, evidenceRef.id)
    if (record === undefined) throw new Error('the complete query evidence was not archived')

    const executionBindingRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
    const finalizationReceiptRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }
    const outputSchemaRef = { id: 'schema.query', version: '1.0.0', digest: DIGEST }
    const table = {
      schemaVersion: 'table-artifact-manifest@1' as const,
      tableId: 'query-result-251',
      outputSchemaRef,
      columns: [
        { columnRef: 'subject_entity_id', semanticPredicate: 'subject_entity_id', valueType: 'string' as const, schemaPointer: '/subject_entity_id' },
        { columnRef: 'state', semanticPredicate: 'state', valueType: 'string' as const, schemaPointer: '/state' },
      ],
      totalRows: 251,
      rowKeyOrder: 'ascending' as const,
      pages: [
        { pageIndex: 0, artifactRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' as const }, artifactDigest: DIGEST, rowCount: 250, firstRowKey: 'entity-001', lastRowKey: 'entity-250', pageCoverageDigest: DIGEST_B },
        { pageIndex: 1, artifactRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' as const }, artifactDigest: DIGEST_B, rowCount: 1, firstRowKey: 'entity-251', lastRowKey: 'entity-251', pageCoverageDigest: DIGEST },
      ],
      coverage: { returned: 251, truncated: false },
      complete: true,
    }
    const resultManifest: TypedResultManifest = {
      schemaVersion: 'typed-result-manifest@1',
      executionBindingRef,
      taskBindingRef: { id: 'task.query', version: '1.0.0', digest: DIGEST },
      resultKind: 'structured_query',
      outputSchemaRef,
      inputSnapshotRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' },
      outputDigest: sha256DigestOf(`[{"ref":{"digest":"${evidenceRef.digest}","id":"${evidenceRef.id}","kind":"evidence","version":"${evidenceRef.version}"},"resultDigest":"${record.envelope.resultDigest}"}]`),
      tables: [table],
      limitations: [],
      coverage: { returned: 251, truncated: false },
      domainStatus: 'known',
      dataMode: 'synthetic',
    }
    const resultManifestDigest = typedResultManifestContentDigest(resultManifest)
    const context = typedResultContextFor({
      executionBindingRef,
      resultManifest,
      resultManifestRef: { id: randomUUID(), version: '1.0.0', digest: resultManifestDigest, kind: 'artifact' },
      finalizationReceiptRef,
      finalizationReceiptDigest: finalizationReceiptRef.digest,
    })
    const result = await h.writer(context).writeDraft(request(h.manifest()), ownerContext())

    expect((result.draft.claims?.length ?? 0) + (result.draft.assertions?.length ?? 0)).toBe(128)
    expect(result.draft.assertions?.every((item) => !['record_id', 'sources_json'].includes(item.predicate))).toBe(true)
    expect(result.draft.claims?.every((item) => !['record_id', 'sources_json'].includes(item.predicate))).toBe(true)
    expect(result.draft.blocks).toHaveLength(128)
    expect(table.totalRows).toBe(251)
    expect(table.pages.reduce((total, page) => total + page.rowCount, 0)).toBe(251)
    expect(result.draft.finalizationReceiptRef).toEqual(finalizationReceiptRef)

    const mismatchedManifest = { ...resultManifest, outputDigest: DIGEST }
    const mismatchedManifestContext = {
      ...context,
      resultManifest: mismatchedManifest,
    }
    const mismatchedHash = await h.writer(mismatchedManifestContext).writeDraft(request(h.manifest()), ownerContext())
    expect(mismatchedHash.draft.assertions).toHaveLength(502)

    const wrongEvidenceManifest = { ...resultManifest, outputDigest: DIGEST_B }
    const wrongEvidenceDigest = typedResultManifestContentDigest(wrongEvidenceManifest)
    const wrongEvidenceContext = typedResultContextFor({
      executionBindingRef,
      resultManifest: wrongEvidenceManifest,
      resultManifestRef: { ...context.resultManifestRef, digest: wrongEvidenceDigest },
      finalizationReceiptRef,
      finalizationReceiptDigest: finalizationReceiptRef.digest,
    })
    const wrongEvidence = await h.writer(wrongEvidenceContext).writeDraft(request(h.manifest()), ownerContext())
    expect(wrongEvidence.draft.assertions).toHaveLength(502)

    const truncatedManifest: TypedResultManifest = {
      ...resultManifest,
      coverage: { returned: 251, truncated: true },
      domainStatus: 'unknown',
    }
    const truncatedDigest = typedResultManifestContentDigest(truncatedManifest)
    const truncatedContext = typedResultContextFor({
      executionBindingRef,
      resultManifest: truncatedManifest,
      resultManifestRef: { ...context.resultManifestRef, digest: truncatedDigest },
      finalizationReceiptRef,
      finalizationReceiptDigest: finalizationReceiptRef.digest,
    })
    const truncated = await h.writer(truncatedContext).writeDraft(request(h.manifest()), ownerContext())
    expect(truncated.draft.assertions).toHaveLength(502)
  })

  it('keeps the legacy inline table complete instead of silently cropping it', async () => {
    const h = harness()
    await h.put('observation', manyRowQueryPayload())
    const result = await h.writer().writeDraft(request(h.manifest()), ownerContext())
    expect(result.draft.assertions).toHaveLength(502)
    expect(result.draft.assertions?.some((item) => ['record_id', 'sources_json'].includes(item.predicate))).toBe(false)
  })

  it('keeps record_id as row identity when it is the only available subject column', async () => {
    const h = harness()
    await h.put('observation', {
      resultKind: 'table',
      table: {
        columns: [
          { name: 'record_id', type: 'string', semanticFieldRef: 'record_id' },
          { name: 'state', type: 'string', semanticFieldRef: 'state' },
        ],
        rows: [['row-1', 'active']],
      },
    })
    const result = await h.writer().writeDraft(request(h.manifest()), ownerContext())
    expect(result.draft.assertions).toHaveLength(1)
    expect(result.draft.assertions?.[0]).toMatchObject({ subject: 'row-1', predicate: 'state', value: 'active' })
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
    resultManifest: {
      schemaVersion: 'typed-result-manifest@1',
      executionBindingRef,
      taskBindingRef: { id: 'task.demo', version: '1.0.0', digest: DIGEST },
      resultKind: 'structured_query',
      outputSchemaRef: { id: 'schema.demo', version: '1.0.0', digest: DIGEST },
      inputSnapshotRef: resultManifestRef,
      outputDigest: DIGEST,
      tables: [],
      limitations: [],
      coverage: { returned: 1, truncated: false },
      domainStatus: 'known',
      dataMode: 'synthetic',
    },
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
