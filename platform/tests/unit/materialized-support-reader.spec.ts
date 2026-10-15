import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compilePublishedRuleInstances,
  InMemoryMaterializationStore,
  IncrementalMaterializer,
  MaterializedRuleSupportReader,
  projectPublishedAttributeFacts,
  sha256DigestOf,
} from '@ontology/semantic-engine'
import type {
  BlobGetAuthorizedRequest,
  EvidenceEnvelope,
  EvidenceRecord,
  PublishedRuleVersion,
  PublishedStatement,
  ResourceRef,
  RevisionString,
  RuleComputationArtifact,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type {
  MaterializationPublishedSource,
  PublishedSemanticData,
  RuleSupportPayloadMetadataReader,
  RuleSupportPayloadReader,
} from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const CTX: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'reader', RUN_ID)
const DEFINITION: VersionRef = { id: 'home-energy.core', version: '1.0.0', digest: DIGEST }
const VALID_FROM = '2026-09-21T00:00:00Z'
const VALID_TO = '2026-09-22T00:00:00Z'
const ATTRIBUTE_ID = 'device.battery_present'

function resource(id: Uuid, kind: ResourceRef['kind'] = 'evidence', digest = DIGEST): ResourceRef {
  return { id, version: '1.0.0', digest, kind }
}

function statement(input: {
  readonly subject: string
  readonly statementId: Uuid
  readonly sourceRefs: readonly ResourceRef[]
  readonly value?: boolean
  readonly validFrom?: string
  readonly validTo?: string
}): PublishedStatement {
  return {
    statementId: input.statementId,
    propositionKey: `${input.subject}.battery`,
    kind: 'entity',
    objectId: 'device',
    subjectEntityId: input.subject,
    predicate: 'device',
    value: { attributes: [{ attributeId: ATTRIBUTE_ID, value: input.value ?? true }] },
    validFrom: input.validFrom ?? VALID_FROM,
    ...(input.validTo === undefined ? { validTo: VALID_TO } : { validTo: input.validTo }),
    recordedAt: VALID_FROM,
    sourceCandidateId: randomUUID(),
    sourceRefs: [...input.sourceRefs],
    publicationId: randomUUID(),
    version: '1',
    status: 'active',
  }
}

function publishedRule(): PublishedRuleVersion {
  return {
    ruleVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ruleId: 'rule.battery-present',
    version: '1',
    objectId: 'device',
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: ATTRIBUTE_ID, operator: 'eq', value: true, spans: [] },
    exceptions: [],
    recordedAt: VALID_FROM,
    sourceCandidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    publicationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }
}

function evidenceRecord(ref: ResourceRef): EvidenceRecord {
  const envelope: EvidenceEnvelope = {
    evidenceId: ref.id,
    kind: 'observation',
    scopeRef: SCOPE,
    producedBy: { componentRef: { id: 'fixture', version: '1.0.0', digest: DIGEST }, runId: RUN_ID },
    observedAt: VALID_FROM,
    recordedSeq: '1',
    sourceSnapshots: [],
    resultDigest: DIGEST,
    integrity: { algorithm: 'sha256', digest: DIGEST },
    dependencies: [],
    dataMode: 'observed',
  }
  return { evidenceRef: ref, envelope, envelopeDigest: DIGEST, revision: '1', recordedAt: VALID_FROM }
}

class EvidenceLookup {
  readonly records = new Map<string, EvidenceRecord>()

  add(ref: ResourceRef): void {
    this.records.set(ref.id, evidenceRecord(ref))
  }

  async get(_scope: ScopeRef, id: Uuid): Promise<EvidenceRecord | undefined> {
    return this.records.get(id)
  }
}

class PayloadBytes implements RuleSupportPayloadMetadataReader, RuleSupportPayloadReader {
  readonly #objects = new Map<string, { readonly ref: ResourceRef; readonly bytes: Uint8Array; readonly mediaType: string; readonly reportedSize?: number }>()
  readCount = 0

  put(ref: ResourceRef, bytes: Uint8Array, mediaType = 'application/json', reportedSize?: number): void {
    this.#objects.set(ref.id, { ref, bytes, mediaType, ...(reportedSize === undefined ? {} : { reportedSize }) })
  }

  async getAuthorizedMetadata(request: BlobGetAuthorizedRequest) {
    const object = this.#objects.get(request.blobRef.id)
    if (object === undefined || object.ref.id !== request.blobRef.id || object.ref.version !== request.blobRef.version ||
        object.ref.digest !== request.blobRef.digest || object.ref.kind !== request.blobRef.kind) throw new Error('missing payload')
    return {
      blobRef: object.ref,
      contentDigest: object.ref.digest,
      mediaType: object.mediaType,
      byteSize: object.reportedSize ?? object.bytes.byteLength,
    }
  }

  async readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    this.readCount += 1
    const object = this.#objects.get(request.blobRef.id)
    if (object === undefined) throw new Error('missing payload')
    return object.bytes
  }
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

interface Fixture {
  readonly materialization: InMemoryMaterializationStore
  readonly evidence: EvidenceLookup
  readonly ruleRef: VersionRef
  readonly rule: PublishedRuleVersion
  readonly artifactsAt: (validAt: string, asOf: RevisionString) => Promise<readonly RuleComputationArtifact[]>
  readonly apply: (statements: readonly PublishedStatement[], seq: RevisionString) => Promise<void>
}

function fixture(): Fixture {
  const materialization = new InMemoryMaterializationStore()
  const evidence = new EvidenceLookup()
  const rule = publishedRule()
  const ruleRef: VersionRef = { id: rule.ruleVersionId, version: '1.0.0', digest: sha256DigestOf(rule) }
  let published: PublishedSemanticData = { facts: [], rules: [], entityBindings: [], definitionRef: DEFINITION, complete: true }
  const source: MaterializationPublishedSource = { load: async () => published }
  const materializer = new IncrementalMaterializer({ publishedSource: source, materialization })

  const apply = async (statements: readonly PublishedStatement[], seq: RevisionString): Promise<void> => {
    const refs = statements.flatMap((entry) => entry.sourceRefs)
    for (const ref of refs) {
      if (ref.kind === 'evidence') evidence.add(ref)
    }
    const projection = projectPublishedAttributeFacts(statements, { schemaRef: DEFINITION })
    const compiled = compilePublishedRuleInstances([rule], projection.facts, {
      scopeRef: SCOPE,
      definitionRef: DEFINITION,
      subjects: [...new Map(projection.facts.map((fact) => [fact.subject, { subjectEntityId: fact.subject, objectId: 'device' }])).values()],
    })
    published = {
      facts: projection.facts,
      rules: compiled.instances.map((instance) => instance.supportRule),
      entityBindings: projection.facts.flatMap((fact) => fact.sourceStatementId === undefined ? [] : [{
        entityId: fact.subject,
        logicalAssertionId: fact.logicalAssertionId,
        sourceStatementId: fact.sourceStatementId,
        predicate: fact.predicate,
      }]),
      definitionRef: DEFINITION,
      complete: true,
    }
    const parent = statements[0]
    if (parent === undefined) throw new Error('fixture requires a published attribute parent')
    await materializer.applyChange({
      changeId: randomUUID(),
      scopeRef: SCOPE,
      recordedSeq: seq,
      recordedAt: parent.recordedAt,
      kind: 'assertion_published',
      // A broad source notification on this predicate affects every compiled entity instance.
      logicalAssertionId: `fixture-change:${randomUUID()}`,
      predicate: ATTRIBUTE_ID,
      validity: { validFrom: parent.validFrom ?? parent.recordedAt, ...(parent.validTo === undefined ? {} : { validTo: parent.validTo }) },
    }, CTX)
  }

  const artifactsAt = async (validAt: string, asOf: RevisionString): Promise<readonly RuleComputationArtifact[]> => {
    const slices = await materialization.readSlices(SCOPE, { validAt, asOfRecordedSeq: asOf, limit: 100 }, CTX)
    return slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).filter((artifact) =>
      artifact.ruleRef.id === ruleRef.id && artifact.ruleRef.digest === ruleRef.digest &&
      artifact.validAt === validAt && artifact.asOfRecordedSeq === asOf,
    )
  }
  return { materialization, evidence, ruleRef, rule, artifactsAt, apply }
}

function supportReader(input: {
  readonly materialization: InMemoryMaterializationStore
  readonly evidence: EvidenceLookup
  readonly payloads?: PayloadBytes
}): MaterializedRuleSupportReader {
  return new MaterializedRuleSupportReader({
    materialization: input.materialization,
    evidence: input.evidence,
    ...(input.payloads === undefined ? {} : { payloadMetadataReader: input.payloads, payloadReader: input.payloads }),
  })
}

function evidenceRequest(ruleRef: VersionRef, validAt: string, asOf: RevisionString, payloadRef?: ResourceRef) {
  return {
    ruleRef,
    validAt,
    asOfRecordedSeq: asOf,
    evidenceRef: resource('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    ...(payloadRef === undefined ? {} : { payloadRef }),
  }
}

describe('MaterializedRuleSupportReader', () => {
  it('pins an authorized payload before evaluating unrelated same-rule entities with different recorded points, while refusing a forged target', async () => {
    const older = fixture(), target = fixture()
    await older.apply([statement({ subject: 'entity-a', statementId: 'older-parent', sourceRefs: [resource('12121212-1212-4212-8212-121212121212')] })], '1')
    await target.apply([statement({ subject: 'entity-b', statementId: 'target-parent', sourceRefs: [resource('34343434-3434-4434-8434-343434343434')] })], '2')
    const selected = (await target.artifactsAt(VALID_FROM, '2'))[0]
    if (selected === undefined) throw new Error('actual materializer produced no target')
    const slices = [...await older.materialization.readSlices(SCOPE, { validAt: VALID_FROM, asOfRecordedSeq: '2' }, CTX), ...await target.materialization.readSlices(SCOPE, { validAt: VALID_FROM, asOfRecordedSeq: '2' }, CTX)]
    const payloads = new PayloadBytes()
    const bytes = new TextEncoder().encode(JSON.stringify(selected))
    const payloadRef = resource('target-payload', 'artifact', rawDigest(bytes))
    payloads.put(payloadRef, bytes)
    const reader = new MaterializedRuleSupportReader({ materialization: { readSlices: async () => slices }, evidence: target.evidence, payloadMetadataReader: payloads, payloadReader: payloads })
    const read = await reader.readCandidates(SCOPE, evidenceRequest(target.ruleRef, VALID_FROM, '2', payloadRef), CTX)
    expect(read.complete).toBe(true)
    expect(read.candidates.map((candidate) => candidate.subjectEntityId)).toEqual(['entity-b'])
    const forgedBytes = new TextEncoder().encode(JSON.stringify({ ...selected, subjectEntityId: 'invented-target' }))
    const forged = resource('forged-target', 'artifact', rawDigest(forgedBytes))
    payloads.put(forged, forgedBytes)
    expect(await reader.readCandidates(SCOPE, evidenceRequest(target.ruleRef, VALID_FROM, '2', forged), CTX)).toEqual({ complete: false, candidates: [] })
    const targetKey = slices.find((slice) => slice.conclusion.ruleArtifacts?.some((artifact) => artifact.instanceKey === selected.instanceKey))?.propositionKey
    const corrupted = new MaterializedRuleSupportReader({ materialization: { readSlices: async () => slices.map((slice) => slice.propositionKey !== targetKey ? slice : { ...slice, conclusion: { ...slice.conclusion, ruleArtifacts: [] } }) }, evidence: target.evidence, payloadMetadataReader: payloads, payloadReader: payloads })
    expect(await corrupted.readCandidates(SCOPE, evidenceRequest(target.ruleRef, VALID_FROM, '2', payloadRef), CTX)).toEqual({ complete: false, candidates: [] })
  })
  it('reads actual materializer slices and preserves child-to-parent OR supports', async () => {
    const data = fixture()
    const evidenceA = resource('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    const evidenceB = resource('ffffffff-ffff-4fff-8fff-ffffffffffff')
    const parentA = '11111111-1111-4111-8111-111111111111'
    const parentB = '22222222-2222-4222-8222-222222222222'
    await data.apply([
      statement({ subject: 'entity-a', statementId: parentA, sourceRefs: [evidenceA] }),
      statement({ subject: 'entity-a', statementId: parentB, sourceRefs: [evidenceB] }),
    ], '1')

    const result = await supportReader(data).readCandidates(SCOPE, evidenceRequest(data.ruleRef, VALID_FROM, '1'), CTX)
    expect(result.complete).toBe(true)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.applicability).toMatchObject({ state: 'applicable', positiveSupport: true })
    expect(result.candidates[0]?.premiseGroups[0]?.facts.map((fact) => fact.sourceStatementId)).toEqual([parentA, parentB])
    expect(result.candidates[0]?.premiseGroups[0]?.facts.flatMap((fact) => fact.sourceRefs.map((ref) => ref.id)).sort())
      .toEqual([evidenceA.id, evidenceB.id].sort())
  })

  it('keeps same-rule entities ambiguous unless a verified archived artifact selects one exact instance', async () => {
    const data = fixture()
    const evidenceA = resource('33333333-3333-4333-8333-333333333333')
    const evidenceB = resource('44444444-4444-4444-8444-444444444444')
    await data.apply([
      statement({ subject: 'entity-a', statementId: 'parent-a', sourceRefs: [evidenceA] }),
      statement({ subject: 'entity-b', statementId: 'parent-b', sourceRefs: [evidenceB] }),
    ], '2')
    const artifacts = await data.artifactsAt(VALID_FROM, '2')
    expect(artifacts.map((artifact) => artifact.subjectEntityId).sort()).toEqual(['entity-a', 'entity-b'])

    const payloadArtifact = artifacts.find((artifact) => artifact.subjectEntityId === 'entity-b')
    if (payloadArtifact === undefined) throw new Error('materializer did not produce the selected entity artifact')
    const bytes = new TextEncoder().encode(JSON.stringify(payloadArtifact))
    const payloadRef: ResourceRef = { id: 'payload-b', version: '1.0.0', digest: rawDigest(bytes), kind: 'artifact' }
    const payloads = new PayloadBytes()
    payloads.put(payloadRef, bytes)
    const reader = supportReader({ ...data, payloads })

    const unpinned = await reader.readCandidates(SCOPE, evidenceRequest(data.ruleRef, VALID_FROM, '2'), CTX)
    expect(unpinned.complete).toBe(true)
    expect(unpinned.candidates.map((candidate) => candidate.subjectEntityId).sort()).toEqual(['entity-a', 'entity-b'])

    const selected = await reader.readCandidates(SCOPE, evidenceRequest(data.ruleRef, VALID_FROM, '2', payloadRef), CTX)
    expect(selected.complete).toBe(true)
    expect(selected.candidates.map((candidate) => candidate.subjectEntityId)).toEqual(['entity-b'])
  })

  it('uses exact valid-time and recorded-time slices instead of current projection heads', async () => {
    const data = fixture()
    const earlyEvidence = resource('55555555-5555-4555-8555-555555555555')
    const lateEvidence = resource('66666666-6666-4666-8666-666666666666')
    const split = '2026-09-21T12:00:00Z'
    const end = VALID_TO
    await data.apply([
      statement({ subject: 'entity-a', statementId: 'parent-early', sourceRefs: [earlyEvidence], validFrom: VALID_FROM, validTo: split }),
    ], '3')
    await data.apply([
      statement({ subject: 'entity-a', statementId: 'parent-late', sourceRefs: [lateEvidence], validFrom: split, validTo: end }),
    ], '4')

    const early = await supportReader(data).readCandidates(SCOPE, evidenceRequest(data.ruleRef, VALID_FROM, '3'), CTX)
    const late = await supportReader(data).readCandidates(SCOPE, evidenceRequest(data.ruleRef, split, '4'), CTX)
    expect(early.complete).toBe(true)
    expect(early.candidates[0]?.premiseGroups[0]?.facts.map((fact) => fact.sourceStatementId)).toContain('parent-early')
    expect(late.complete).toBe(true)
    expect(late.candidates[0]?.validAt).toBe(split)
    expect(late.candidates[0]?.asOfRecordedSeq).toBe('4')
    expect(late.candidates[0]?.premiseGroups[0]?.facts.map((fact) => fact.sourceStatementId)).toContain('parent-late')
  })

  it('compares mixed-precision UTC boundaries as instants and keeps the end half-open', async () => {
    const roundedData = fixture()
    const roundedEvidence = resource('12121212-1212-4212-8212-121212121212')
    await roundedData.apply([statement({
      subject: 'entity-a',
      statementId: 'parent-rounded-time',
      sourceRefs: [roundedEvidence],
      validFrom: '2026-09-21T00:00:00.000Z',
      validTo: '2026-09-22T00:00:00.000Z',
    })], '8')
    const rounded = await supportReader(roundedData).readCandidates(
      SCOPE,
      evidenceRequest(roundedData.ruleRef, VALID_FROM, '8'),
      CTX,
    )
    expect(rounded.complete).toBe(true)
    expect(rounded.candidates[0]?.validAt).toBe('2026-09-21T00:00:00.000Z')

    const data = fixture()
    const sourceEvidence = resource('77777777-7777-4777-8777-777777777777')
    await data.apply([statement({ subject: 'entity-a', statementId: 'parent-time', sourceRefs: [sourceEvidence] })], '8')
    const persisted = await data.materialization.readSlices(SCOPE, { asOfRecordedSeq: '8', limit: 100 }, CTX)
    const fractionalEnd = '2026-09-21T00:00:00.999Z'
    const mixedPrecisionMaterialization = {
      readSlices: async () => persisted.map((slice) => ({
        ...slice,
        validity: { validFrom: VALID_FROM, validTo: fractionalEnd },
      })),
    }
    const reader = new MaterializedRuleSupportReader({ materialization: mixedPrecisionMaterialization, evidence: data.evidence })

    const atStart = await reader.readCandidates(SCOPE, evidenceRequest(data.ruleRef, VALID_FROM, '8'), CTX)
    expect(atStart.complete).toBe(true)
    expect(atStart.candidates).toHaveLength(1)
    const atEnd = await reader.readCandidates(SCOPE, evidenceRequest(data.ruleRef, fractionalEnd, '8'), CTX)
    expect(atEnd.complete).toBe(true)
    expect(atEnd.candidates).toEqual([])
  })

  it('fails closed for missing evidence envelopes, raw chunk sources, corrupt artifacts, and oversized payloads', async () => {
    const missingData = fixture()
    const expectedRef = resource('77777777-7777-4777-8777-777777777777')
    await missingData.apply([statement({ subject: 'entity-a', statementId: 'parent-missing', sourceRefs: [expectedRef] })], '5')
    // Same id is insufficient: the archived evidence row must match kind, version, and digest too.
    missingData.evidence.records.set(expectedRef.id, evidenceRecord({ ...expectedRef, digest: DIGEST === expectedRef.digest ? `sha256:${'b'.repeat(64)}` : DIGEST }))
    const missing = await supportReader(missingData).readCandidates(SCOPE, evidenceRequest(missingData.ruleRef, VALID_FROM, '5'), CTX)
    expect(missing.complete).toBe(false)
    expect(missing.candidates).toEqual([])

    const wrongVersionRef = { ...expectedRef, version: '2.0.0' }
    missingData.evidence.records.set(expectedRef.id, evidenceRecord(wrongVersionRef))
    const wrongVersion = await supportReader(missingData).readCandidates(SCOPE, evidenceRequest(missingData.ruleRef, VALID_FROM, '5'), CTX)
    expect(wrongVersion.complete).toBe(false)
    expect(wrongVersion.candidates).toEqual([])

    const rawData = fixture()
    await rawData.apply([statement({ subject: 'entity-a', statementId: 'parent-raw', sourceRefs: [resource('raw-chunk', 'chunk')] })], '6')
    const raw = await supportReader(rawData).readCandidates(SCOPE, evidenceRequest(rawData.ruleRef, VALID_FROM, '6'), CTX)
    expect(raw.complete).toBe(false)
    expect(raw.candidates).toEqual([])

    const payloadData = fixture()
    const evidenceRef = resource('88888888-8888-4888-8888-888888888888')
    const otherEvidenceRef = resource('99999999-9999-4999-8999-999999999999')
    await payloadData.apply([
      statement({ subject: 'entity-a', statementId: 'parent-payload-a', sourceRefs: [evidenceRef] }),
      statement({ subject: 'entity-b', statementId: 'parent-payload-b', sourceRefs: [otherEvidenceRef] }),
    ], '7')
    const artifact = (await payloadData.artifactsAt(VALID_FROM, '7'))[0]
    if (artifact === undefined) throw new Error('materializer did not produce a test artifact')
    const tampered = { ...artifact, computationDigest: `sha256:${'0'.repeat(64)}` }
    const tamperedBytes = new TextEncoder().encode(JSON.stringify(tampered))
    const tamperedRef: ResourceRef = { id: 'tampered', version: '1.0.0', digest: rawDigest(tamperedBytes), kind: 'artifact' }
    const payloads = new PayloadBytes()
    payloads.put(tamperedRef, tamperedBytes)
    const tamperedResult = await supportReader({ ...payloadData, payloads }).readCandidates(
      SCOPE,
      evidenceRequest(payloadData.ruleRef, VALID_FROM, '7', tamperedRef),
      CTX,
    )
    expect(tamperedResult.complete).toBe(false)
    expect(tamperedResult.candidates).toEqual([])

    const oversizedBytes = new TextEncoder().encode(JSON.stringify(artifact))
    const oversizedRef: ResourceRef = { id: 'oversized', version: '1.0.0', digest: rawDigest(oversizedBytes), kind: 'artifact' }
    const oversizedPayloads = new PayloadBytes()
    oversizedPayloads.put(oversizedRef, oversizedBytes, 'application/json', 1_048_577)
    const oversized = await supportReader({ ...payloadData, payloads: oversizedPayloads }).readCandidates(
      SCOPE,
      evidenceRequest(payloadData.ruleRef, VALID_FROM, '7', oversizedRef),
      CTX,
    )
    expect(oversized.complete).toBe(true)
    expect(oversized.candidates).toHaveLength(2)
    expect(oversizedPayloads.readCount).toBe(0)
  })
})
