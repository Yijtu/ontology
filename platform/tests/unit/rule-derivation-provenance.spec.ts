import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compilePublishedRuleInstances,
  InMemoryMaterializationStore,
  IncrementalMaterializer,
  MaterializedRuleDerivationEvidenceProducer,
  MaterializedRuleSupportReader,
  projectPublishedAttributeFacts,
  sha256DigestOf,
  SupportEvidenceDependencySource,
} from '@ontology/semantic-engine'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  BlobPutImmutableResponse,
  CandidateRecord,
  CandidateStore,
  DocumentParseRecord,
  DocumentParseStore,
  DocumentSpanReaderPort,
  EvidenceEnvelope,
  EvidenceRecord,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  PublishedRuleVersion,
  PublishedStatement,
  ResourceRef,
  RuleComputationArtifact,
  ScopeRef,
  SourceSnapshot,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { ProvenanceReadService } from '@ontology/provenance'
import type { EvidenceDependencySource } from '@ontology/provenance'
import type {
  MaterializationPublishedSource,
  PublishedSemanticData,
  RuleDerivationSupportPayload,
  RuleSupportPayloadMetadataReader,
  RuleSupportPayloadReader,
} from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const CTX: ToolContext = toolContext(TENANT, SPACE, ['rule-derivation-producer'], 'producer', RUN_ID)
const VALID_AT = '2026-09-21T00:00:00Z'
const END_AT = '2026-09-22T00:00:00Z'
const PARSE_ID = '55555555-5555-4555-8555-555555555555'
const FACT_CHUNK_ID = '66666666-6666-4666-8666-666666666666'
const POLICY_CHUNK_ID = '66666666-6666-4666-8666-666666666667'
const CANDIDATE_ID = '77777777-7777-4777-8777-777777777777'
const SUBJECT_ID = '88888888-8888-4888-8888-888888888888'
const LOGICAL_DOCUMENT_ID = '44444444-4444-4444-8444-444444444444'
const ORIGINAL_DOCUMENT_ID = '99999999-1111-4111-8111-111111111111'
const DIGEST = `sha256:${'a'.repeat(64)}`
const FACT_TEXT = 'Facility T-RULE-01 inspection is due.'
const POLICY_TEXT = 'Policy: inspection_due=true means inspection is due.'
const FACT_TEXT_DIGEST = `sha256:${createHash('sha256').update(new TextEncoder().encode(FACT_TEXT)).digest('hex')}`
const POLICY_TEXT_DIGEST = `sha256:${createHash('sha256').update(new TextEncoder().encode(POLICY_TEXT)).digest('hex')}`
const DEFINITION: VersionRef = { id: 'transport.core', version: '1.0.0', digest: DIGEST }
const LOGICAL_DOCUMENT: ResourceRef = { id: LOGICAL_DOCUMENT_ID, version: '1.0.0', digest: DIGEST, kind: 'document' }
const ORIGINAL_DOCUMENT: ResourceRef = { id: ORIGINAL_DOCUMENT_ID, version: '1.0.0', digest: DIGEST, kind: 'document' }
const FACT_LOCATOR = { kind: 'offset' as const, startOffset: 0, endOffset: FACT_TEXT.length }
const POLICY_LOCATOR = { kind: 'offset' as const, startOffset: FACT_TEXT.length, endOffset: FACT_TEXT.length + POLICY_TEXT.length }
const FACT_SPAN = {
  kind: 'text' as const,
  parseId: PARSE_ID,
  chunkId: FACT_CHUNK_ID,
  locator: FACT_LOCATOR,
  spanKind: 'verbatim' as const,
  precision: 'exact' as const,
  quoteDigest: FACT_TEXT_DIGEST,
  textDigest: FACT_TEXT_DIGEST,
}
const POLICY_SPAN = {
  parseId: PARSE_ID,
  chunkId: POLICY_CHUNK_ID,
  locator: POLICY_LOCATOR,
  spanKind: 'verbatim' as const,
  precision: 'exact' as const,
  quoteDigest: POLICY_TEXT_DIGEST,
}
const FACT_CHUNK_REF: ResourceRef = { id: FACT_CHUNK_ID, version: '1.0.0', digest: FACT_TEXT_DIGEST, kind: 'chunk' }
const READ_SPANS = new Map<string, string>([
  [JSON.stringify(FACT_LOCATOR), FACT_TEXT],
  [JSON.stringify(POLICY_LOCATOR), POLICY_TEXT],
])

function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function rule(): PublishedRuleVersion {
  return {
    ruleVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ruleId: 'inspection-due-policy',
    version: '1',
    objectId: 'transport_facility',
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: 'transport_facility.inspection_due', operator: 'eq', value: true, spans: [POLICY_SPAN] },
    exceptions: [],
    recordedAt: VALID_AT,
    sourceCandidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    publicationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }
}

function factStatement(): PublishedStatement {
  return {
    statementId: CANDIDATE_ID,
    propositionKey: 'inspection-due',
    kind: 'entity',
    objectId: 'transport_facility',
    subjectEntityId: SUBJECT_ID,
    predicate: 'transport_facility',
    value: { attributes: [{ attributeId: 'transport_facility.inspection_due', value: true }] },
    validFrom: VALID_AT,
    validTo: END_AT,
    recordedAt: VALID_AT,
    sourceCandidateId: CANDIDATE_ID,
    sourceRefs: [FACT_CHUNK_REF],
    publicationId: '99999999-9999-4999-8999-999999999999',
    version: '1',
    status: 'active',
  }
}

function entityCandidate(): CandidateRecord {
  return {
    kind: 'entity',
    candidateId: CANDIDATE_ID,
    jobId: 'aaaaaaaa-1111-4111-8111-111111111111',
    sourceSpans: [FACT_SPAN],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: DEFINITION,
      parseId: PARSE_ID,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
      documentVersionRef: LOGICAL_DOCUMENT,
    },
    idempotencyKey: DIGEST,
    recordedAt: VALID_AT,
    objectId: 'transport_facility',
    attributes: [{ attributeId: 'transport_facility.inspection_due', value: true }],
  }
}

function parsedDocument(): DocumentParseRecord {
  return {
    parseId: PARSE_ID,
    scopeRef: SCOPE,
    mediaKind: 'text',
    originalMediaType: 'text/plain',
    originalRef: ORIGINAL_DOCUMENT,
    normalizedMediaType: 'text/plain',
    normalizedByteSize: FACT_TEXT.length + POLICY_TEXT.length,
    normalizedRef: { id: 'normalized-text', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    spanMapMediaType: 'application/json',
    spanMapRef: { id: 'span-map', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    parserId: 'text-parser',
    parserVersion: '1.0.0',
    offsetUnit: 'byte',
    coverage: { status: 'complete', completeness: 'complete', totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] },
    pages: [],
    documentVersionRef: LOGICAL_DOCUMENT,
    createdAt: VALID_AT,
  }
}

class EvidenceMemory implements EvidenceStorePort {
  readonly records = new Map<string, EvidenceRecord>()

  async record(scopeRef: ScopeRef, envelope: EvidenceEnvelope): Promise<EvidenceRecord> {
    const evidenceRef: ResourceRef = {
      id: envelope.evidenceId,
      version: '1.0.0',
      digest: envelope.integrity.digest,
      kind: 'evidence',
    }
    const record: EvidenceRecord = {
      evidenceRef,
      envelope,
      envelopeDigest: envelope.integrity.digest,
      revision: String(this.records.size + 1),
      recordedAt: envelope.observedAt,
    }
    if (scopeRef.tenantId !== envelope.scopeRef.tenantId || scopeRef.spaceId !== envelope.scopeRef.spaceId) {
      throw new Error('scope mismatch')
    }
    this.records.set(envelope.evidenceId, record)
    return record
  }

  async get(scopeRef: ScopeRef, id: string): Promise<EvidenceRecord | undefined> {
    const record = this.records.get(id)
    if (record === undefined || record.envelope.scopeRef.tenantId !== scopeRef.tenantId ||
        record.envelope.scopeRef.spaceId !== scopeRef.spaceId) return undefined
    return record
  }

  async listByRun(): Promise<EvidenceRecord[]> { return [] }
}

class ArtifactMemory implements ImmutableArtifactWriter, RuleSupportPayloadMetadataReader, RuleSupportPayloadReader {
  readonly objects = new Map<string, { readonly ref: ResourceRef; readonly bytes: Uint8Array; readonly mediaType: string }>()

  async putBytes(request: { readonly scopeRef: ScopeRef; readonly content: Uint8Array; readonly mediaType: string }) {
    const digest = bytesDigest(request.content)
    const ref: ResourceRef = { id: `artifact-${digest.slice(7)}`, version: '1.0.0', digest, kind: 'artifact' }
    this.objects.set(ref.id, { ref, bytes: request.content.slice(), mediaType: request.mediaType })
    return { blobRef: ref, contentDigest: digest, integrity: { algorithm: 'sha256' as const, digest } }
  }

  async getAuthorizedMetadata(request: BlobGetAuthorizedRequest) {
    const object = this.objects.get(request.blobRef.id)
    if (object === undefined || object.ref.id !== request.blobRef.id || object.ref.version !== request.blobRef.version ||
        object.ref.digest !== request.blobRef.digest || object.ref.kind !== request.blobRef.kind) throw new Error('not found')
    return { blobRef: object.ref, contentDigest: object.ref.digest, mediaType: object.mediaType, byteSize: object.bytes.byteLength }
  }

  async readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const object = this.objects.get(request.blobRef.id)
    if (object === undefined) throw new Error('not found')
    return object.bytes.slice()
  }
}

interface Fixture {
  readonly materialization: InMemoryMaterializationStore
  readonly evidence: EvidenceMemory
  readonly ruleRef: VersionRef
  readonly materialize: () => Promise<void>
  readonly exactArtifact: () => Promise<RuleComputationArtifact>
}

function fixture(): Fixture {
  const materialization = new InMemoryMaterializationStore()
  const evidence = new EvidenceMemory()
  const publishedRule = rule()
  const ruleRef: VersionRef = {
    id: publishedRule.ruleVersionId,
    version: '1.0.0',
    digest: sha256DigestOf(publishedRule),
  }
  const statement = factStatement()
  const projection = projectPublishedAttributeFacts([statement], { schemaRef: DEFINITION })
  const compiled = compilePublishedRuleInstances([publishedRule], projection.facts, {
    scopeRef: SCOPE,
    definitionRef: DEFINITION,
    subjects: [{ subjectEntityId: SUBJECT_ID, objectId: 'transport_facility' }],
  })
  const published: PublishedSemanticData = {
    facts: projection.facts,
    rules: compiled.instances.map((instance) => instance.supportRule),
    entityBindings: projection.facts.map((fact) => ({
      entityId: fact.subject,
      logicalAssertionId: fact.logicalAssertionId,
      predicate: fact.predicate,
      ...(fact.sourceStatementId === undefined ? {} : { sourceStatementId: fact.sourceStatementId }),
    })),
    definitionRef: DEFINITION,
    complete: true,
  }
  const materializer = new IncrementalMaterializer({
    publishedSource: { load: async () => published } satisfies MaterializationPublishedSource,
    materialization,
  })
  return {
    materialization,
    evidence,
    ruleRef,
    async materialize() {
      await materializer.applyChange({
        changeId: randomUUID(),
        scopeRef: SCOPE,
        recordedSeq: '3',
        recordedAt: VALID_AT,
        kind: 'assertion_published',
        logicalAssertionId: statement.statementId,
        predicate: 'transport_facility.inspection_due',
        validity: { validFrom: VALID_AT, validTo: END_AT },
      }, CTX)
    },
    async exactArtifact(): Promise<RuleComputationArtifact> {
      const slices = await materialization.readSlices(SCOPE, { validAt: VALID_AT, asOfRecordedSeq: '3', limit: 20 }, CTX)
      const artifact = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).find((entry) =>
        entry.subjectEntityId === SUBJECT_ID && entry.ruleRef.id === ruleRef.id,
      )
      if (artifact === undefined) throw new Error('materializer did not write the expected artifact')
      return artifact
    },
  }
}

function sourceSnapshot(): SourceSnapshot {
  return {
    sourceRef: { namespace: 'test.source', sourceId: 'transport-import' },
    schemaVersion: '1.0.0',
    readAt: VALID_AT,
    consistency: 'immutable',
    resultDigest: DIGEST,
  }
}

function documentSpans(reads: string[]): DocumentSpanReaderPort {
  return {
    readSpan: async (request) => {
      const text = READ_SPANS.get(JSON.stringify(request.locator))
      if (text === undefined) throw new Error('unknown locator')
      reads.push(request.documentRef.id)
      return {
        documentRef: request.documentRef,
        text,
        textDigest: `sha256:${createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')}`,
        snapshot: {
          sourceRef: { namespace: 'test.document', sourceId: request.documentRef.id },
          schemaVersion: '1.0.0',
          readAt: VALID_AT,
          consistency: 'immutable',
          resultDigest: DIGEST,
        },
      }
    },
  }
}

function candidates(): Pick<CandidateStore, 'getCandidate'> {
  const candidate = entityCandidate()
  return {
    getCandidate: async (scopeRef, candidateId) =>
      scopeRef.tenantId === SCOPE.tenantId && scopeRef.spaceId === SCOPE.spaceId && candidateId === CANDIDATE_ID
        ? candidate
        : undefined,
  }
}

function documentParses(options?: { readonly missingPolicyParse?: boolean }): Pick<DocumentParseStore, 'findParseByDigest' | 'getParse'> {
  const parse = parsedDocument()
  const missingPolicyParse = options?.missingPolicyParse ?? false
  return {
    findParseByDigest: async (scopeRef, digest, parserVersion) =>
      scopeRef.tenantId === SCOPE.tenantId && scopeRef.spaceId === SCOPE.spaceId &&
      digest === LOGICAL_DOCUMENT.digest && parserVersion === '1.0.0' ? parse : undefined,
    getParse: async (scopeRef, parseId) => {
      if (missingPolicyParse || scopeRef.tenantId !== SCOPE.tenantId || scopeRef.spaceId !== SCOPE.spaceId ||
          parseId !== PARSE_ID) return undefined
      return parse
    },
  }
}

async function produce(data: Fixture, options?: { readonly missingPolicyParse?: boolean }): Promise<{
  readonly record: EvidenceRecord
  readonly artifacts: ArtifactMemory
}> {
  const artifacts = new ArtifactMemory()
  const producer = new MaterializedRuleDerivationEvidenceProducer({
    materialization: data.materialization,
    evidence: data.evidence,
    artifacts,
    candidates: candidates(),
    documentParses: documentParses(options),
    documentSpans: documentSpans([]),
    componentRef: { id: 'rule-derivation', version: '1.0.0', digest: DIGEST },
    newId: randomUUID,
  })
  const record = await producer.record({
    scopeRef: SCOPE,
    ruleRef: data.ruleRef,
    definitionRef: DEFINITION,
    objectId: 'transport_facility',
    subjectEntityId: SUBJECT_ID,
    validAt: VALID_AT,
    asOfRecordedSeq: '3',
    observedAt: VALID_AT,
    sourceSnapshots: [sourceSnapshot()],
    dataMode: 'observed',
  }, CTX)
  return { record, artifacts }
}

function supportReader(data: Fixture, artifacts: ArtifactMemory): MaterializedRuleSupportReader {
  return new MaterializedRuleSupportReader({
    materialization: data.materialization,
    evidence: data.evidence,
    payloadMetadataReader: artifacts,
    payloadReader: artifacts,
  })
}

describe('rule conclusion, premise and specification-span evidence chain (V03-029)', () => {
  it('bridges an instance premise chunk and the reviewed policy text through real parse/span evidence on separate axes', async () => {
    const data = fixture()
    await data.materialize()
    const { record, artifacts } = await produce(data)

    expect(record.envelope.kind).toBe('rule_derivation')
    expect(record.envelope.limitations).toBeUndefined()
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) throw new Error('producer did not archive the support payload')
    const payloadObject = artifacts.objects.get(payloadRef.id)
    if (payloadObject === undefined) throw new Error('rule payload was not archived')
    const payload = JSON.parse(new TextDecoder().decode(payloadObject.bytes)) as RuleDerivationSupportPayload

    expect(payload.artifact.sourceSpans).toEqual([POLICY_SPAN])
    expect(payload.sourceEvidenceMappings).toHaveLength(1)
    expect(payload.policySourceEvidenceMappings).toHaveLength(1)
    expect(payload.sourceEvidenceMappings[0]).toMatchObject({
      sourceRef: FACT_CHUNK_REF,
      documentRef: ORIGINAL_DOCUMENT,
      documentVersionRef: LOGICAL_DOCUMENT,
      sourceSpan: FACT_SPAN,
    })
    expect(payload.policySourceEvidenceMappings[0]).toMatchObject({
      span: POLICY_SPAN,
      documentRef: ORIGINAL_DOCUMENT,
      documentVersionRef: LOGICAL_DOCUMENT,
    })

    const factEvidenceRef = payload.sourceEvidenceMappings[0]?.evidenceRef
    const policyEvidenceRef = payload.policySourceEvidenceMappings[0]?.evidenceRef
    if (factEvidenceRef === undefined || policyEvidenceRef === undefined) throw new Error('producer omitted a source evidence ref')
    const factEvidence = await data.evidence.get(SCOPE, factEvidenceRef.id)
    const policyEvidence = await data.evidence.get(SCOPE, policyEvidenceRef.id)
    expect(factEvidence?.envelope.kind).toBe('document_span')
    expect(policyEvidence?.envelope.kind).toBe('document_span')
    expect(factEvidence?.envelope.resultDigest).toBe(FACT_TEXT_DIGEST)
    expect(policyEvidence?.envelope.resultDigest).toBe(POLICY_TEXT_DIGEST)
    // The locator lives on the archived binding payload; the quoted bytes are digest-verified.
    const policyBindingRef = policyEvidence?.envelope.payloadRef
    if (policyBindingRef === undefined) throw new Error('policy evidence has no binding payload')
    const bindingBytes = await artifacts.readAuthorized({ scopeRef: SCOPE, blobRef: policyBindingRef })
    const binding = JSON.parse(new TextDecoder().decode(bindingBytes)) as { schemaVersion: string; span: typeof POLICY_SPAN }
    expect(binding.schemaVersion).toBe('rule-policy-span-binding@1')
    expect(binding.span.locator).toEqual(POLICY_LOCATOR)
    expect(binding.span.quoteDigest).toBe(POLICY_TEXT_DIGEST)

    const reader = supportReader(data, artifacts)
    const result = await reader.readCandidates(SCOPE, {
      ruleRef: data.ruleRef,
      validAt: VALID_AT,
      asOfRecordedSeq: '3',
      evidenceRef: record.evidenceRef,
      payloadRef,
    }, CTX)
    expect(result.complete).toBe(true)
    expect(result.candidates).toHaveLength(1)
    const instance = result.candidates[0]
    if (instance === undefined) throw new Error('reader returned no candidate')
    expect(instance.premiseGroups[0]?.facts[0]?.sourceRefs).toEqual([factEvidenceRef])
    expect(instance.coverage?.facts.complete).toBe(true)
    expect(instance.coverage?.policy).toEqual({ complete: true })
    expect(instance.policySpans).toHaveLength(1)
    expect(instance.policySpans?.[0]).toMatchObject({
      locator: POLICY_LOCATOR,
      quoteDigest: POLICY_TEXT_DIGEST,
      evidenceRef: policyEvidenceRef,
      documentRef: ORIGINAL_DOCUMENT,
      documentVersionRef: LOGICAL_DOCUMENT,
    })

    const dependencies = new SupportEvidenceDependencySource({
      published: new InMemoryPublicationView(),
      supportReader: reader,
    })
    const detailed = await dependencies.dependenciesWithResolutionOf(SCOPE, record, CTX)
    expect(detailed.supportResolution.state).toBe('resolved')
    if (detailed.supportResolution.state !== 'resolved') throw new Error('expected resolved support')
    expect(detailed.supportResolution.policy).toEqual({ complete: true })
    expect(detailed.supportResolution.policySpans?.[0]?.quoteDigest).toBe(POLICY_TEXT_DIGEST)
    expect(detailed.edges.some((edge) => edge.origin === 'support' && edge.toEvidenceId === factEvidenceRef.id)).toBe(true)
  })

  it('fails closed when the specification span cannot be located instead of claiming the policy text was verified', async () => {
    const data = fixture()
    await data.materialize()
    const { record, artifacts } = await produce(data, { missingPolicyParse: true })

    expect(record.envelope.limitations).toContain(
      `specification span ${POLICY_CHUNK_ID} has no scoped parse that resolves its document version`,
    )
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) throw new Error('producer did not archive the support payload')
    const payloadObject = artifacts.objects.get(payloadRef.id)
    if (payloadObject === undefined) throw new Error('rule payload was not archived')
    const payload = JSON.parse(new TextDecoder().decode(payloadObject.bytes)) as RuleDerivationSupportPayload
    expect(payload.policySourceEvidenceMappings).toEqual([])

    const reader = supportReader(data, artifacts)
    const result = await reader.readCandidates(SCOPE, {
      ruleRef: data.ruleRef,
      validAt: VALID_AT,
      asOfRecordedSeq: '3',
      evidenceRef: record.evidenceRef,
      payloadRef,
    }, CTX)
    expect(result.complete).toBe(true)
    const instance = result.candidates[0]
    expect(instance?.policySpans).toEqual([])
    expect(instance?.coverage?.policy.complete).toBe(false)
    expect(instance?.coverage?.policy.reason).toContain('no archived evidence mapping')
  })
})

const PUBLICATION_DIGEST = `sha256:${'c'.repeat(64)}`

/** Minimal published read view; the dependency source never consults it (immutable slices only). */
class InMemoryPublicationView {
  async latestReadRevision(): Promise<string> { return '0' }
  async getPublication(): Promise<undefined> { return undefined }
  async listStatements(): Promise<never[]> { return [] }
  async listRuleVersions(): Promise<never[]> { return [] }
}

describe('provenance read surfaces fact and specification coverage separately', () => {
  it('reports the fact axis and the specification axis from the rule support resolution', async () => {
    const evidenceId = 'e0000000-0000-4000-8000-000000000029'
    const policyEvidenceRef: ResourceRef = { id: 'e0000000-0000-4000-8000-0000000000aa', version: '1.0.0', digest: PUBLICATION_DIGEST, kind: 'evidence' }
    const payloadRef: ResourceRef = { id: 'b0000000-0000-4000-8000-000000000029', version: '1.0.0', digest: PUBLICATION_DIGEST, kind: 'artifact' }
    const envelope: EvidenceEnvelope = {
      evidenceId,
      kind: 'rule_derivation',
      scopeRef: SCOPE,
      producedBy: { componentRef: { id: 'component', version: '1.0.0', digest: DIGEST }, runId: RUN_ID, ruleRef: { id: 'rule', version: '1', digest: DIGEST } },
      observedAt: VALID_AT,
      recordedSeq: '3',
      sourceSnapshots: [],
      resultDigest: DIGEST,
      integrity: { algorithm: 'sha256', digest: DIGEST },
      dependencies: [],
      dataMode: 'observed',
      payloadRef,
    }
    const record: EvidenceRecord = { evidenceRef: { id: evidenceId, version: '1.0.0', digest: DIGEST, kind: 'evidence' }, envelope, envelopeDigest: DIGEST, revision: '1', recordedAt: VALID_AT }
    const dependencies: EvidenceDependencySource = {
      dependenciesOf: async () => [],
      dependenciesWithResolutionOf: async () => ({
        edges: [],
        supportResolution: {
          state: 'resolved',
          complete: true,
          policy: { complete: false, reason: 'specification span not located' },
          policySpans: [{
            parseId: PARSE_ID,
            chunkId: POLICY_CHUNK_ID,
            locator: POLICY_LOCATOR,
            spanKind: 'verbatim',
            precision: 'exact',
            quoteDigest: POLICY_TEXT_DIGEST,
            documentRef: ORIGINAL_DOCUMENT,
            documentVersionRef: LOGICAL_DOCUMENT,
            parserVersion: '1.0.0',
            evidenceRef: policyEvidenceRef,
          }],
        },
      }),
    }
    const service = new ProvenanceReadService({
      evidence: { record: async () => record, get: async () => record, listByRun: async () => [] },
      blobs: new VerifiedBlobPort(new Set([payloadRef.id])),
      dependencies,
    })
    const view = await service.getEvidence(evidenceId, {}, CTX)
    expect(view.factSupport).toEqual({ complete: true })
    expect(view.specification?.coverage).toEqual({ complete: false, reason: 'specification span not located' })
    expect(view.specification?.spans[0]?.quoteDigest).toBe(POLICY_TEXT_DIGEST)
    expect(view.specification?.spans[0]?.evidenceRef).toEqual(policyEvidenceRef)
  })
})

class VerifiedBlobPort implements BlobPort {
  readonly #present: ReadonlySet<string>
  constructor(present: ReadonlySet<string>) {
    this.#present = present
  }

  putImmutable(): Promise<BlobPutImmutableResponse> {
    throw new Error('putImmutable is not exercised here')
  }

  getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    if (!this.#present.has(request.blobRef.id)) return Promise.reject(new Error('not found'))
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest: request.blobRef.digest,
      mediaType: 'application/json',
      byteSize: 1,
      integrityVerified: true,
    })
  }
}
