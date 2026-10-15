import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DraftVerificationService } from '@ontology/application'
import type { DraftVerificationDependencies } from '@ontology/application'
import type {
  AnswerDraft,
  DecisionPort,
  EvidenceEnvelope,
  ResourceRef,
  Sha256Digest,
  VerifiedAssertion,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  FixedSemanticDecision,
  InMemoryVerificationArtifacts,
  InMemoryVerificationEvidence,
  NOW,
  RUN_ID,
  SCOPE_A,
  buildClaim,
  buildDraft,
  buildEvidence,
  buildInputManifest,
  modelRef,
  ownerContext,
  verificationPolicy,
} from './verification-fixtures'

const RULE_REF: VersionRef = { id: 'rule.maintenance', version: '1.0.0', digest: sha256DigestOf('rule-maintenance') }
const COMPUTATION_DIGEST = sha256DigestOf('computation')
const DEFINITION_REF: VersionRef = { id: 'def.transport', version: '2.0.0', digest: sha256DigestOf('def-transport') }
const DOCUMENT: ResourceRef = { id: 'd1111111-1111-4111-8111-111111111111', version: '1.0.0', digest: sha256DigestOf('document'), kind: 'artifact' }
const DOCUMENT_VERSION: ResourceRef = { id: 'd2222222-2222-4222-8222-222222222222', version: '3.0.0', digest: sha256DigestOf('document-version'), kind: 'artifact' }

type EvidenceType = EvidenceEnvelope['kind']

interface TypedHarness {
  readonly evidence: InMemoryVerificationEvidence
  readonly artifacts: InMemoryVerificationArtifacts
  readonly put: (
    kind: EvidenceType,
    payload: unknown,
    evidenceId?: string,
  ) => Promise<{ readonly ref: ResourceRef; readonly resultDigest: Sha256Digest }>
  readonly manifest: () => ReturnType<typeof buildInputManifest>
  readonly service: (decision?: DecisionPort) => DraftVerificationService
}

function harness(): TypedHarness {
  const evidence = new InMemoryVerificationEvidence()
  const artifacts = new InMemoryVerificationArtifacts()
  const refs: ResourceRef[] = []
  return {
    evidence,
    artifacts,
    async put(kind, payload, evidenceId = randomUUID()) {
      const payloadRef = artifacts.put(evidenceId, payload)
      const envelope = buildEvidence({ evidenceId, payloadRef, resultDigest: payloadRef.digest, kind })
      const record = await evidence.record(SCOPE_A, envelope)
      refs.push(record.evidenceRef)
      return { ref: record.evidenceRef, resultDigest: payloadRef.digest }
    },
    manifest: () => buildInputManifest([...refs]),
    service(decision?: DecisionPort) {
      const dependencies: DraftVerificationDependencies = {
        evidence,
        artifacts,
        policy: verificationPolicy({ semanticReview: decision === undefined ? 'disabled' : 'required' }),
        now: () => NOW,
        ...(decision === undefined ? {} : { decision, modelRef: modelRef() }),
        ...(decision === undefined
          ? {}
          : {
              decisionStateRefProvider: {
                archive: (input: { readonly runId: string; readonly resolvedProfileHash: string; readonly state: unknown }) =>
                  Promise.resolve({
                    id: randomUUID(),
                    version: '1.0.0',
                    digest: sha256DigestOf(JSON.stringify(input.state) ?? ''),
                    kind: 'artifact' as const,
                  }),
              },
            }),
      }
      return new DraftVerificationService(dependencies)
    },
  }
}

function assertionDraft(
  evidenceManifestHash: Sha256Digest,
  assertions: readonly VerifiedAssertion[],
  claims: AnswerDraft['claims'] = [],
): AnswerDraft {
  return buildDraft({
    evidenceManifestHash,
    claims,
    assertions,
    schemaVersion: 'answer-draft@2',
    blocks: [
      ...(claims ?? []).map((claim) => ({ kind: 'claim' as const, claimId: claim.claimId })),
      ...assertions.map((assertion) => ({ kind: 'assertion' as const, assertionId: assertion.assertionId })),
    ],
  })
}

function ruleArtifact(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'rule-computation-artifact@1',
    scopeRef: SCOPE_A,
    definitionRef: DEFINITION_REF,
    ruleRef: RULE_REF,
    ruleId: 'rule.maintenance',
    ruleVersionId: randomUUID(),
    publishedRevision: '4',
    instanceKey: 'I-04',
    objectId: 'transport_facility',
    subjectEntityId: 'I-04',
    predicate: 'maintenance_applicability',
    applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true },
    factRefs: [],
    sourceStatementIds: [],
    inputDigest: sha256DigestOf('input'),
    computationDigest: COMPUTATION_DIGEST,
    sourceSpans: [],
    complete: true,
    ...overrides,
  }
}

function ruleSupportPayload(artifact: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 'rule-derivation-support-payload@1',
    artifact,
    sourceEvidenceMappings: [],
    policySourceEvidenceMappings: [],
  }
}

function ruleAssertion(
  reference: { readonly ref: ResourceRef; readonly resultDigest: Sha256Digest },
  overrides: Partial<Extract<VerifiedAssertion, { readonly kind: 'rule_judgement' }>> = {},
): VerifiedAssertion {
  return {
    assertionId: randomUUID(),
    kind: 'rule_judgement',
    subject: 'I-04',
    predicate: 'maintenance_applicability',
    value: 'true',
    ruleRef: RULE_REF,
    premiseRefs: [],
    judgementAxis: 'applicability',
    references: [{
      evidenceRef: reference.ref,
      resultDigest: reference.resultDigest,
      valuePointer: '/artifact',
      subjectPointer: '/artifact/subjectEntityId',
      rulePointer: '/artifact',
    }],
    ...overrides,
  }
}

describe('typed evidence verifier verifies rule judgements from the archived computation', () => {
  it('refuses an applicability archive without an independent actual-premise replay port', async () => {
    const h = harness()
    const rule = await h.put('rule_derivation', ruleSupportPayload(ruleArtifact()))
    const manifest = h.manifest()
    const assertion = ruleAssertion(rule)
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_premise_missing')
    expect(result.supportedAssertionIds).toEqual([])
  })

  it('blocks a wrong rule verdict even when the semantic review returns supported with probability 0.999', async () => {
    const h = harness()
    const rule = await h.put('rule_derivation', ruleSupportPayload(ruleArtifact()))
    const observation = await h.put('observation', { subject: 'I-04', value: 12.5, unit: 'kWh', time: NOW })
    const manifest = h.manifest()
    const claim = buildClaim({
      evidenceRef: observation.ref,
      resultDigest: observation.resultDigest,
      valuePointer: '/value',
      unitPointer: '/unit',
      subjectPointer: '/subject',
      timePointer: '/time',
    })
    const assertion = ruleAssertion(rule, { value: 'false' })
    const decision = new FixedSemanticDecision('supported', 0.999)
    const result = await h.service(decision).verify({
      runId: RUN_ID,
      question: 'Is maintenance applicable?',
      draft: assertionDraft(manifest.digest, [assertion], [claim]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_judgement_mismatch')
    expect(result.supportedAssertionIds).toEqual([])
    expect(decision.calls).toHaveLength(1)
  })

  it('blocks an incomplete computation and a missing premise instead of inventing a verdict', async () => {
    const h = harness()
    const incomplete = await h.put('rule_derivation', ruleSupportPayload(ruleArtifact({ complete: false })))
    const manifest = h.manifest()
    const assertion = ruleAssertion(incomplete, {
      premiseRefs: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', version: '1.0.0', digest: sha256DigestOf('missing'), kind: 'evidence' }],
    })
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_premise_missing')
  })

  it('blocks an applicability verdict that contradicts a fired exception', async () => {
    const h = harness()
    const inconsistent = ruleArtifact({
      applicability: {
        state: 'applicable',
        conditionState: 'true',
        exceptionStates: [{ exceptionId: 'exc-1', state: 'true', factRefs: [] }],
        positiveSupport: true,
      },
    })
    const rule = await h.put('rule_derivation', ruleSupportPayload(inconsistent))
    const manifest = h.manifest()
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [ruleAssertion(rule)]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_judgement_mismatch')
  })

  it('blocks a judgement whose artifact is a different rule version', async () => {
    const h = harness()
    const other = ruleArtifact({ ruleRef: { id: 'rule.other', version: '1.0.0', digest: sha256DigestOf('rule-other') } })
    const rule = await h.put('rule_derivation', ruleSupportPayload(other))
    const manifest = h.manifest()
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [ruleAssertion(rule)]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_judgement_mismatch')
  })

  it('verifies the business-proposition axis separately and requires a reviewed conclusion', async () => {
    const h = harness()
    const artifact = ruleArtifact({ applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true } })
    const rule = await h.put('rule_derivation', ruleSupportPayload(artifact))
    const manifest = h.manifest()
    const noConclusion = ruleAssertion(rule, { judgementAxis: 'business_proposition', value: 'true' })
    const blocked = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [noConclusion]),
      inputManifest: manifest,
    }, ownerContext())
    expect(blocked.verdict).toBe('fail')
    expect(blocked.failedChecks).toContain('rule_judgement_mismatch')

    const h2 = harness()
    const withConclusion = ruleArtifact({ businessConclusion: { predicate: 'maintenance_required', value: true } })
    const rule2 = await h2.put('rule_derivation', ruleSupportPayload(withConclusion))
    const manifest2 = h2.manifest()
    const assertion = ruleAssertion(rule2, { judgementAxis: 'business_proposition', value: 'true' })
    const passed = await h2.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest2.digest, [assertion]),
      inputManifest: manifest2,
    }, ownerContext())
    expect(passed.verdict).toBe('fail')
    expect(passed.failedChecks).toContain('rule_premise_missing')
  })
})

describe('typed evidence verifier verifies relation navigation edges', () => {
  const hop = {
    statementId: 'stmt-1',
    statementVersion: '4',
    relationId: 'feeds',
    definitionRef: DEFINITION_REF,
    fromEntityId: 'E-A',
    toEntityId: 'E-B',
    fromCandidateId: 'c-a',
    toCandidateId: 'c-b',
    sourceRefs: [],
  }

  function relationAssertion(
    reference: { readonly ref: ResourceRef; readonly resultDigest: Sha256Digest },
    value: { type: string; from: ResourceRef; to: ResourceRef },
    overrides: Partial<Extract<VerifiedAssertion, { readonly kind: 'relation_ref' }>> = {},
  ): Extract<VerifiedAssertion, { readonly kind: 'relation_ref' }> {
    return {
      assertionId: randomUUID(),
      kind: 'relation_ref',
      subject: 'E-A',
      predicate: 'feeds',
      value,
      statementId: 'stmt-1',
      definitionRef: DEFINITION_REF,
      references: [{
        evidenceRef: reference.ref,
        resultDigest: reference.resultDigest,
        valuePointer: '/edges/0',
        subjectPointer: '/edges/0/fromEntityId',
        relationPointer: '/edges/0',
      }],
      ...overrides,
    }
  }

  const ref = (id: string): ResourceRef => ({ id, version: '1.0.0', digest: sha256DigestOf(id), kind: 'artifact' })
  const wrap = (): Record<string, unknown> => ({ resultKind: 'relations', edges: [hop] })

  it('passes a relation whose endpoints match the real published edge', async () => {
    const h = harness()
    const evidence = await h.put('observation', wrap())
    const manifest = h.manifest()
    const assertion = relationAssertion(evidence, { type: 'feeds', from: ref('E-A'), to: ref('E-B') })
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())
    expect(result.verdict).toBe('pass')
  })

  it('blocks a swapped endpoint', async () => {
    const h = harness()
    const evidence = await h.put('observation', wrap())
    const manifest = h.manifest()
    const assertion = relationAssertion(evidence, { type: 'feeds', from: ref('E-B'), to: ref('E-A') })
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('relation_endpoint_mismatch')
  })

  it('blocks a drifted definition/statement version', async () => {
    const h = harness()
    const evidence = await h.put('observation', wrap())
    const manifest = h.manifest()
    const drifted = relationAssertion(
      evidence,
      { type: 'feeds', from: ref('E-A'), to: ref('E-B') },
      { definitionRef: { id: 'def.other', version: '9.9.9', digest: sha256DigestOf('other') }, statementId: 'stmt-2' },
    )
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [drifted]),
      inputManifest: manifest,
    }, ownerContext())
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('relation_version_mismatch')
  })
})

describe('typed evidence verifier verifies document citations', () => {
  const quote = 'the inspection interval is 90 days'
  const locator = { kind: 'page' as const, page: 4 }
  const textDigest = sha256DigestOf('full-document-text')
  const payload = {
    subject: 'entity.device-17',
    quote,
    quoteDigest: sha256DigestOf(quote),
    textDigest,
    locator,
    documentRef: DOCUMENT,
    documentVersionRef: DOCUMENT_VERSION,
  }

  function citationAssertion(
    reference: { readonly ref: ResourceRef; readonly resultDigest: Sha256Digest },
    overrides: Partial<Extract<VerifiedAssertion, { readonly kind: 'document_quote' }>> = {},
  ): VerifiedAssertion {
    return {
      assertionId: randomUUID(),
      kind: 'document_quote',
      subject: 'entity.device-17',
      predicate: 'inspection_note',
      quote,
      documentRef: DOCUMENT,
      documentVersionRef: DOCUMENT_VERSION,
      locator,
      quoteDigest: payload.quoteDigest,
      textDigest,
      precision: 'exact',
      references: [{
        evidenceRef: reference.ref,
        resultDigest: reference.resultDigest,
        valuePointer: '/quote',
        subjectPointer: '/subject',
        documentPointer: '/documentRef',
        documentVersionPointer: '/documentVersionRef',
        locatorPointer: '/locator',
        quoteDigestPointer: '/quoteDigest',
        textDigestPointer: '/textDigest',
      }],
      ...overrides,
    }
  }

  it('passes an exact quote whose locator, document and digests all resolve', async () => {
    const h = harness()
    const evidence = await h.put('document_span', payload)
    const manifest = h.manifest()
    const assertion = citationAssertion(evidence)
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())
    expect(result.verdict).toBe('pass')
  })

  it('blocks a quote whose archived text differs', async () => {
    const h = harness()
    const evidence = await h.put('document_span', payload)
    const manifest = h.manifest()
    const assertion = citationAssertion(evidence, { quote: 'the inspection interval is 30 days' })
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('document_quote_mismatch')
  })

  it('blocks a citation whose locator or document is wrong even when the quote matches', async () => {
    const h = harness()
    const evidence = await h.put('document_span', payload)
    const manifest = h.manifest()
    const wrongLocator = citationAssertion(evidence, { locator: { kind: 'page', page: 5 } })
    const blocked1 = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [wrongLocator]),
      inputManifest: manifest,
    }, ownerContext())
    expect(blocked1.failedChecks).toContain('citation_locator_mismatch')

    const otherDocument: ResourceRef = { id: DOCUMENT.id, version: DOCUMENT.version, digest: sha256DigestOf('another-document'), kind: 'artifact' }
    const wrongDocument = citationAssertion(evidence, { documentRef: otherDocument })
    const blocked2 = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [wrongDocument]),
      inputManifest: manifest,
    }, ownerContext())
    expect(blocked2.failedChecks).toContain('citation_locator_mismatch')
  })
})

describe('document Q&A depends on retrieved evidence and reports missing citations', () => {
  it('reports a missing citation as missing evidence instead of inventing a quote', async () => {
    const h = harness()
    const registered = await h.put('document_span', { subject: 'entity.device-17', quote: 'x' })
    const manifest = h.manifest()
    const absentRef: ResourceRef = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', version: '1.0.0', digest: sha256DigestOf('absent'), kind: 'evidence' }
    const assertion: VerifiedAssertion = {
      assertionId: randomUUID(),
      kind: 'document_quote',
      subject: 'entity.device-17',
      predicate: 'inspection_note',
      quote: 'the inspection interval is 90 days',
      documentRef: DOCUMENT,
      locator: { kind: 'page', page: 4 },
      quoteDigest: sha256DigestOf('the inspection interval is 90 days'),
      textDigest: sha256DigestOf('full-document-text'),
      precision: 'exact',
      references: [{
        evidenceRef: absentRef,
        resultDigest: absentRef.digest,
        valuePointer: '/quote',
        subjectPointer: '/subject',
        documentPointer: '/documentRef',
        locatorPointer: '/locator',
        quoteDigestPointer: '/quoteDigest',
        textDigestPointer: '/textDigest',
      }],
    }
    void registered
    const result = await h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())

    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('evidence_not_found')
    expect(result.missingEvidence).toContain(absentRef.id)
    expect(result.supportedAssertionIds).toEqual([])
  })
})

describe('typed evidence verifier verifies structured-query row bindings', () => {
  const table = {
    resultKind: 'table',
    table: {
      columns: [
        { name: 'inspection_due', type: 'boolean', semanticFieldRef: 'inspection_due' },
        { name: 'facility_id', type: 'string', semanticFieldRef: 'facility_id' },
      ],
      rows: [[true, 'T-01'], [false, 'T-02']],
    },
  }

  async function verifyCell(valuePointer: string, subjectPointer: string): Promise<Awaited<ReturnType<DraftVerificationService['verify']>>> {
    const h = harness()
    const evidence = await h.put('observation', table)
    const manifest = h.manifest()
    const assertion: VerifiedAssertion = {
      assertionId: randomUUID(),
      kind: 'boolean',
      subject: 'T-01',
      predicate: 'inspection_due',
      value: true,
      references: [{
        evidenceRef: evidence.ref,
        resultDigest: evidence.resultDigest,
        valuePointer,
        subjectPointer,
        fieldRefPointer: '/table/columns/0',
      }],
    }
    return h.service().verify({
      runId: RUN_ID,
      draft: assertionDraft(manifest.digest, [assertion]),
      inputManifest: manifest,
    }, ownerContext())
  }

  it('passes a correctly bound cell', async () => {
    const result = await verifyCell('/table/rows/0/0', '/table/rows/0/1')
    expect(result.verdict).toBe('pass')
  })

  it('blocks a value lifted from a different row than its subject', async () => {
    const result = await verifyCell('/table/rows/0/0', '/table/rows/1/1')
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('row_binding_mismatch')
  })
})
