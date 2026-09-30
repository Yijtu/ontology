import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresEvidenceStore, PostgresMaterializationStore } from '@ontology/adapter-control-postgres'
import { DocumentSpanReader, PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { createBlobArtifactWriter } from '@ontology/app-api'
import {
  compilePublishedRuleInstances,
  IncrementalMaterializer,
  MaterializedRuleDerivationEvidenceProducer,
  MaterializedRuleSupportReader,
  projectPublishedAttributeFacts,
  sha256DigestOf,
  SupportEvidenceDependencySource,
} from '@ontology/semantic-engine'
import type {
  DocumentParseRecord,
  EvidenceEnvelope,
  PublishedRuleVersion,
  PublishedStatement,
  ResourceRef,
  SourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type {
  MaterializationPublishedSource,
  PublishedSemanticData,
  PublishedSemanticReadView,
  RuleFact,
  SupportRule,
} from '@ontology/semantic-engine'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * Real-PostgreSQL acceptance for the rule conclusion/premise/specification-span evidence chain
 * (issue V03-029 / #200, A.US-009.AC-01/AC-02, A.FR-15).
 *
 * A real `IncrementalMaterializer` writes the exact entity-qualified computation artifact,
 * including the reviewed policy `sourceSpans`, into the append-only Postgres slice store. The
 * producer then resolves those specification spans through the real scoped parse record and the
 * real `DocumentSpanReader`, archives the immutable text and binding artifacts in the blob store,
 * and records a `document_span` evidence envelope. Retracting one of two OR alternatives keeps
 * the conclusion through the surviving support; the pre-retraction evidence still resolves its
 * then-support at its own recorded sequence.
 */

const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const VALID_AT = '2026-09-21T12:00:00Z'
const PREDICATE = 'transport_facility.flag'
const SUBJECT_ID = '88888888-8888-4888-8888-888888888888'
const FACT_TEXT = 'Facility T-RULE-01 inspection is due.'
const POLICY_TEXT = 'Policy: a due inspection means the facility is flagged.'
const ORIGINAL_TEXT = `${FACT_TEXT}${POLICY_TEXT}`
const POLICY_LOCATOR = { kind: 'offset' as const, startOffset: FACT_TEXT.length, endOffset: ORIGINAL_TEXT.length }
const POLICY_CHUNK_ID = '66666666-6666-4666-8666-666666666667'
const PARSE_ID = '55555555-5555-4555-8555-555555555555'
const LOGICAL_DOCUMENT_ID = '44444444-4444-4444-8444-444444444444'
const ORIGINAL_MEDIA_TYPE = 'text/plain'
const COMPONENT_REF: VersionRef = { id: 'core-rule-derivation', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const ALTERNATIVE_A = '11111111-1111-4111-8111-111111111111'
const ALTERNATIVE_B = '22222222-2222-4222-8222-222222222222'

function digestOfText(text: string): string {
  return `sha256:${createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')}`
}

const POLICY_SPAN = {
  parseId: PARSE_ID,
  chunkId: POLICY_CHUNK_ID,
  locator: POLICY_LOCATOR,
  spanKind: 'verbatim' as const,
  precision: 'exact' as const,
  quoteDigest: digestOfText(POLICY_TEXT),
}

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let materialization: PostgresMaterializationStore
let evidence: PostgresEvidenceStore
let parseStore: PostgresDocumentParseStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let artifacts: ReturnType<typeof createBlobArtifactWriter>
let spanReader: DocumentSpanReader
let objectDirectory = ''
let originalRef: ResourceRef
const definitionRef: VersionRef = { id: 'transport.core', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` }

/** The dependency source never consults the mutable published view; immutable slices are the source. */
class EmptyPublishedView implements PublishedSemanticReadView {
  async latestReadRevision(): Promise<string> { return '0' }
  async getPublication(): Promise<undefined> { return undefined }
  async listStatements(): Promise<never[]> { return [] }
  async listRuleVersions(): Promise<never[]> { return [] }
}

class FixturePublishedSource implements MaterializationPublishedSource {
  #data: PublishedSemanticData
  constructor(data: PublishedSemanticData) {
    this.#data = data
  }
  setFacts(facts: readonly RuleFact[]): void {
    this.#data = { ...this.#data, facts }
  }
  async load(): Promise<PublishedSemanticData> {
    return this.#data
  }
}

function flagStatement(statementId: string, sourceRef: ResourceRef): PublishedStatement {
  return {
    statementId,
    propositionKey: `transport_facility.${statementId}`,
    kind: 'entity',
    objectId: 'transport_facility',
    subjectEntityId: SUBJECT_ID,
    predicate: 'transport_facility',
    value: { attributes: [{ attributeId: PREDICATE, value: true }] },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: VALIDITY.validFrom,
    sourceCandidateId: randomUUID(),
    sourceRefs: [sourceRef],
    publicationId: randomUUID(),
    version: '1',
    status: 'active',
  }
}

function retractFact(logicalAssertionId: string, recordedSeq: string, sourceRef: SourceRef): RuleFact {
  return {
    assertionId: `${logicalAssertionId}-retract`,
    logicalAssertionId,
    recordedSeq,
    op: 'retract',
    subject: SUBJECT_ID,
    predicate: PREDICATE,
    objectId: 'transport_facility',
    attributeId: PREDICATE,
    schemaRef: definitionRef,
    validity: VALIDITY,
    sourceRef,
  }
}

function observationEvidence(evidenceId: string): { readonly envelope: EvidenceEnvelope; readonly ref: ResourceRef } {
  const body: Omit<EvidenceEnvelope, 'integrity'> = {
    evidenceId,
    kind: 'observation',
    scopeRef: scope.scopeRef,
    producedBy: { componentRef: COMPONENT_REF },
    observedAt: VALID_AT,
    sourceSnapshots: [],
    resultDigest: `sha256:${'e'.repeat(64)}`,
    dependencies: [],
    dataMode: 'observed',
  }
  const digest = sha256DigestOf(body)
  return {
    envelope: { ...body, integrity: { algorithm: 'sha256', digest, verifiedAt: VALID_AT } },
    ref: { id: evidenceId, version: '1.0.0', digest, kind: 'evidence' },
  }
}

function publishedRule(): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId: 'flag-policy',
    version: '1',
    objectId: 'transport_facility',
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: PREDICATE, operator: 'eq', value: true, spans: [POLICY_SPAN] },
    exceptions: [],
    recordedAt: VALIDITY.validFrom,
    sourceCandidateId: randomUUID(),
    publicationId: randomUUID(),
  }
}

function producer(): MaterializedRuleDerivationEvidenceProducer {
  return new MaterializedRuleDerivationEvidenceProducer({
    materialization,
    evidence,
    artifacts,
    documentParses: parseStore,
    documentSpans: spanReader,
    componentRef: COMPONENT_REF,
  })
}

function reader(): MaterializedRuleSupportReader {
  return new MaterializedRuleSupportReader({
    materialization,
    evidence,
    payloadMetadataReader: blobStore,
    payloadReader: blobStore,
  })
}

async function artifactAt(ruleRef: VersionRef, asOfRecordedSeq: string) {
  const slices = await materialization.readSlices(scope.scopeRef, { validAt: VALID_AT, asOfRecordedSeq, limit: 100 }, ctx)
  return slices
    .flatMap((slice) => slice.conclusion.ruleArtifacts ?? [])
    .find((candidate) => candidate.ruleRef.id === ruleRef.id && candidate.subjectEntityId === SUBJECT_ID)
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'rule-derivation-provenance')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'], 'rule-derivation-provenance')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  materialization = new PostgresMaterializationStore(database)
  evidence = new PostgresEvidenceStore(database)
  parseStore = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 3 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 3 })
  objectDirectory = await mkdtemp(join(tmpdir(), 'rule-derivation-provenance-'))

  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  artifacts = createBlobArtifactWriter(blobStore)
  spanReader = new DocumentSpanReader({ blobs: blobStore, store: parseStore })

  const originalBytes = new TextEncoder().encode(ORIGINAL_TEXT)
  const staged = await blobStore.stage(originalBytes, { scopeRef: scope.scopeRef }, ctx)
  const published = await blobStore.publish({
    scopeRef: scope.scopeRef,
    contentDigest: staged.contentDigest,
    byteSize: staged.byteSize,
    mediaType: ORIGINAL_MEDIA_TYPE,
    purpose: 'document',
  }, ctx)
  if (published.blobRef.kind !== 'document') throw new Error('original document blob was not registered as a document')
  originalRef = published.blobRef

  const parseRecord: DocumentParseRecord = {
    parseId: PARSE_ID,
    scopeRef: scope.scopeRef,
    mediaKind: 'text',
    originalMediaType: ORIGINAL_MEDIA_TYPE,
    originalRef,
    normalizedMediaType: ORIGINAL_MEDIA_TYPE,
    normalizedByteSize: originalBytes.byteLength,
    normalizedRef: { id: randomUUID(), version: '1.0.0', digest: originalRef.digest, kind: 'artifact' },
    spanMapMediaType: 'application/json',
    spanMapRef: { id: randomUUID(), version: '1.0.0', digest: originalRef.digest, kind: 'artifact' },
    parserId: 'text-parser',
    parserVersion: '1.0.0',
    offsetUnit: 'byte',
    coverage: { status: 'complete', completeness: 'complete', totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] },
    pages: [],
    documentVersionRef: { id: LOGICAL_DOCUMENT_ID, version: '1.0.0', digest: originalRef.digest, kind: 'document' },
    createdAt: VALIDITY.validFrom,
  }
  await parseStore.recordParse(parseRecord, [], ctx)
  if (originalRef.id === LOGICAL_DOCUMENT_ID) throw new Error('fixture must keep the logical document id distinct from the physical original id')
}, 300_000)

afterAll(async () => {
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await harness?.stop()
})

describe('rule specification-span evidence chain against real PostgreSQL (V03-029)', () => {
  it('locates the reviewed policy text through the real parse/span chain and keeps history across a retraction', async () => {
    const recordA = observationEvidence(randomUUID())
    const recordB = observationEvidence(randomUUID())
    await evidence.record(scope.scopeRef, recordA.envelope, ctx)
    await evidence.record(scope.scopeRef, recordB.envelope, ctx)

    const projection = projectPublishedAttributeFacts(
      [flagStatement(ALTERNATIVE_A, recordA.ref), flagStatement(ALTERNATIVE_B, recordB.ref)],
      { schemaRef: definitionRef },
    )
    expect(projection.issues).toEqual([])
    const facts: readonly RuleFact[] = projection.facts
    expect(facts).toHaveLength(2)
    const rule = publishedRule()
    const compiled = compilePublishedRuleInstances([rule], facts, {
      scopeRef: scope.scopeRef,
      definitionRef,
      subjects: [{ subjectEntityId: SUBJECT_ID, objectId: 'transport_facility' }],
    })
    expect(compiled.instances).toHaveLength(1)
    const supportRule: SupportRule | undefined = compiled.instances[0]?.supportRule
    if (supportRule === undefined) throw new Error('compiler produced no support rule')
    const source = new FixturePublishedSource({
      facts,
      rules: [supportRule],
      entityBindings: [],
      definitionRef,
      complete: true,
      historicalAsOfSupported: true,
    })
    const materializer = new IncrementalMaterializer({ publishedSource: source, materialization })
    const ruleRef: VersionRef = { id: rule.ruleVersionId, version: '1.0.0', digest: sha256DigestOf(rule) }

    await materializer.applyChange({
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq: '1',
      recordedAt: VALIDITY.validFrom,
      kind: 'assertion_published',
      logicalAssertionId: ALTERNATIVE_A,
      predicate: PREDICATE,
      validity: VALIDITY,
    }, ctx)

    const artifact1 = await artifactAt(ruleRef, '1')
    if (artifact1 === undefined) throw new Error('real materializer did not persist the artifact')
    expect(artifact1.sourceSpans).toEqual([POLICY_SPAN])
    expect(artifact1.applicability).toMatchObject({ state: 'applicable', positiveSupport: true })

    const root1 = await producer().record({
      scopeRef: scope.scopeRef,
      ruleRef,
      definitionRef,
      objectId: artifact1.objectId,
      subjectEntityId: artifact1.subjectEntityId,
      validAt: artifact1.validAt ?? VALID_AT,
      asOfRecordedSeq: '1',
      observedAt: VALID_AT,
      sourceSnapshots: [],
      dataMode: 'observed',
    }, ctx)
    expect(root1.envelope.kind).toBe('rule_derivation')
    expect(root1.envelope.limitations ?? []).not.toContain(
      'one or more raw premise refs could not be resolved to authorized archived source evidence; the support graph remains incomplete',
    )
    const payloadRef1 = root1.envelope.payloadRef
    if (payloadRef1 === undefined) throw new Error('root evidence has no support payload')

    const resolved1 = await reader().readCandidates(scope.scopeRef, {
      ruleRef,
      validAt: artifact1.validAt ?? VALID_AT,
      asOfRecordedSeq: '1',
      evidenceRef: root1.evidenceRef,
      payloadRef: payloadRef1,
    }, ctx)
    expect(resolved1.complete).toBe(true)
    const instance1 = resolved1.candidates[0]
    if (instance1 === undefined) throw new Error('reader resolved no instance at recorded sequence 1')
    expect(instance1.coverage?.policy).toEqual({ complete: true })
    expect(instance1.policySpans).toHaveLength(1)
    expect(instance1.policySpans?.[0]).toMatchObject({
      locator: POLICY_LOCATOR,
      quoteDigest: POLICY_SPAN.quoteDigest,
      documentRef: { id: originalRef.id },
    })
    const policyEvidenceRef = instance1.policySpans?.[0]?.evidenceRef
    if (policyEvidenceRef === undefined) throw new Error('reader resolved no policy evidence ref')
    const policyEvidence = await evidence.get(scope.scopeRef, policyEvidenceRef.id, ctx)
    expect(policyEvidence?.envelope.kind).toBe('document_span')
    expect(policyEvidence?.envelope.resultDigest).toBe(POLICY_SPAN.quoteDigest)
    const archivedSpan = policyEvidence?.envelope.sourceSnapshots[0]?.archivedResultRef
    if (archivedSpan === undefined) throw new Error('policy evidence archived no span text')
    const spanBytes = await blobStore.readAuthorized({ scopeRef: scope.scopeRef, blobRef: archivedSpan }, ctx)
    expect(new TextDecoder().decode(spanBytes)).toBe(POLICY_TEXT)

    const dependencies = new SupportEvidenceDependencySource({ published: new EmptyPublishedView(), supportReader: reader() })
    const detailed1 = await dependencies.dependenciesWithResolutionOf(scope.scopeRef, root1, ctx)
    expect(detailed1.supportResolution.state).toBe('resolved')
    if (detailed1.supportResolution.state !== 'resolved') throw new Error('expected resolved support at sequence 1')
    expect(detailed1.supportResolution.policy).toEqual({ complete: true })
    expect(detailed1.supportResolution.policySpans?.[0]?.quoteDigest).toBe(POLICY_SPAN.quoteDigest)
    expect(detailed1.supportResolution.premiseGroups
      .flatMap((group) => group.facts.map((entry) => entry.sourceStatementId)).sort())
      .toEqual([ALTERNATIVE_A, ALTERNATIVE_B].sort())

    // Retract one OR alternative. The surviving alternative keeps the conclusion; the current
    // support shows only the still-valid fact while the earlier evidence still resolves its
    // then-support at recorded sequence 1.
    const logicalAssertionA = facts.find((entry) => entry.sourceStatementId === ALTERNATIVE_A)?.logicalAssertionId
    if (logicalAssertionA === undefined) throw new Error('projection produced no fact for alternative A')
    source.setFacts([...facts, retractFact(logicalAssertionA, '2', { namespace: 'test.evidence', sourceId: ALTERNATIVE_A })])
    await materializer.applyChange({
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq: '2',
      recordedAt: VALIDITY.validFrom,
      kind: 'assertion_retracted',
      logicalAssertionId: ALTERNATIVE_A,
      predicate: PREDICATE,
      validity: VALIDITY,
    }, ctx)

    const artifact2 = await artifactAt(ruleRef, '2')
    if (artifact2 === undefined) throw new Error('post-retraction materializer did not persist the artifact')
    expect(artifact2.applicability).toMatchObject({ state: 'applicable', positiveSupport: true })

    const root2 = await producer().record({
      scopeRef: scope.scopeRef,
      ruleRef,
      definitionRef,
      objectId: artifact2.objectId,
      subjectEntityId: artifact2.subjectEntityId,
      validAt: artifact2.validAt ?? VALID_AT,
      asOfRecordedSeq: '2',
      observedAt: VALID_AT,
      sourceSnapshots: [],
      dataMode: 'observed',
    }, ctx)
    const payloadRef2 = root2.envelope.payloadRef
    if (payloadRef2 === undefined) throw new Error('second root evidence has no support payload')
    const resolved2 = await reader().readCandidates(scope.scopeRef, {
      ruleRef,
      validAt: artifact2.validAt ?? VALID_AT,
      asOfRecordedSeq: '2',
      evidenceRef: root2.evidenceRef,
      payloadRef: payloadRef2,
    }, ctx)
    expect(resolved2.complete).toBe(true)
    const instance2 = resolved2.candidates[0]
    if (instance2 === undefined) throw new Error('reader resolved no instance at recorded sequence 2')
    expect(instance2.premiseGroups.flatMap((group) => group.facts.map((entry) => entry.sourceStatementId)).sort())
      .toEqual([ALTERNATIVE_B])
    expect(instance2.coverage?.policy).toEqual({ complete: true })

    const resolved1Again = await reader().readCandidates(scope.scopeRef, {
      ruleRef,
      validAt: artifact1.validAt ?? VALID_AT,
      asOfRecordedSeq: '1',
      evidenceRef: root1.evidenceRef,
      payloadRef: payloadRef1,
    }, ctx)
    expect(resolved1Again.candidates[0]?.premiseGroups
      .flatMap((group) => group.facts.map((entry) => entry.sourceStatementId)).sort())
      .toEqual([ALTERNATIVE_A, ALTERNATIVE_B].sort())

    const state = await materialization.getProjectionState(scope.scopeRef, ctx)
    expect(state?.dirty).toBe(false)
    expect(await materialization.listOpenFences(scope.scopeRef, ctx)).toHaveLength(0)
  }, 180_000)
})
