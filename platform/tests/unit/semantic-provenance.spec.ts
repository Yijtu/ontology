import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HistoryReadService,
  InMemorySemanticPublicationStore,
  projectPublishedAttributeFacts,
  SupportEvidenceDependencySource,
} from '@ontology/semantic-engine'
import type {
  EvidenceEnvelope,
  EvidenceRecord,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`
const DEFINITION: VersionRef = { id: 'home-energy.core', version: '1.0.0', digest: DIGEST }
const RULE_REF: VersionRef = { id: 'published-rule-version', version: '1.0.0', digest: DIGEST }
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const CTX: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'reader', RUN_ID)
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
type SupportReader = NonNullable<ConstructorParameters<typeof SupportEvidenceDependencySource>[0]['supportReader']>
type SupportInstance = Awaited<ReturnType<SupportReader['readCandidates']>>['candidates'][number]
type SupportRequest = Parameters<SupportReader['readCandidates']>[1]

function evidenceRef(id: Uuid): PublishedStatement['sourceRefs'][number] {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'evidence' }
}

function immutableSupportInstance(overrides: Partial<SupportInstance> = {}): SupportInstance {
  return {
    scopeRef: SCOPE,
    definitionRef: DEFINITION,
    ruleRef: RULE_REF,
    instanceKey: 'rule-instance:entity-a',
    objectId: 'device.battery',
    subjectEntityId: 'entity-a',
    validAt: '2026-09-21T06:00:00Z',
    asOfRecordedSeq: '1',
    applicability: { state: 'applicable', positiveSupport: true },
    complete: true,
    premiseGroups: [{
      groupId: 'condition:device.battery_present',
      facts: [{
        kind: 'entity_attribute',
        assertionId: 'parent-statement-id#device.battery_present',
        logicalAssertionId: 'parent-statement-id#device.battery_present',
        sourceStatementId: 'parent-statement-id',
        subjectEntityId: 'entity-a',
        objectId: 'device.battery',
        schemaRef: DEFINITION,
        sourceRefs: [evidenceRef(randomUUID())],
      }],
    }],
    ...overrides,
  }
}

function supportReader(candidates: readonly SupportInstance[], complete = true): SupportReader {
  return {
    readCandidates: async () => ({ complete, candidates }),
  }
}

async function publish(
  store: InMemorySemanticPublicationStore,
  statements: readonly Omit<PublishedStatement, 'publicationId'>[],
  rules: readonly Omit<PublishedRuleVersion, 'publicationId'>[],
): Promise<void> {
  const publicationId = randomUUID()
  const input: PublishSemanticPublicationInput = {
    expectedRevision: await store.latestPublicationRevision(SCOPE, CTX),
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: statements.map((statement) => ({ ...statement, publicationId })),
      ruleVersions: rules.map((rule) => ({ ...rule, publicationId })),
      outboxId: randomUUID(),
      publishedAt: '2026-09-21T00:00:00Z',
      actor: 'tester',
    },
    idempotencyKey: `publish-${publicationId}`,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: {
      outboxId: randomUUID(),
      topic: 'semantic.publication.published',
      payload: { publicationId },
      idempotencyKey: `outbox-${publicationId}`,
      availableAt: '2026-09-21T00:00:00Z',
      createdAt: '2026-09-21T00:00:00Z',
    },
    outboxJobId: randomUUID(),
  }
  await store.publish(SCOPE, input, CTX)
}

function statement(
  overrides: Partial<PublishedStatement> & Pick<PublishedStatement, 'statementId' | 'sourceRefs'>,
): Omit<PublishedStatement, 'publicationId'> {
  return {
    propositionKey: 'device.battery_present',
    kind: 'entity',
    objectId: 'device.battery',
    predicate: 'device.battery_present',
    value: { value: true },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: randomUUID(),
    version: '1',
    status: 'active',
    ...overrides,
  }
}

function ruleVersion(
  overrides: Partial<PublishedRuleVersion> & Pick<PublishedRuleVersion, 'ruleId'>,
): Omit<PublishedRuleVersion, 'publicationId'> {
  return {
    ruleVersionId: randomUUID(),
    version: '1',
    objectId: 'device.battery_ready',
    severity: 'soft',
    impact: 'low',
    expression: {
      op: 'compare',
      attributeId: 'device.battery_present',
      operator: 'eq',
      value: true,
      spans: [],
    },
    exceptions: [],
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: randomUUID(),
    ...overrides,
  }
}

function evidenceRecord(
  evidenceId: Uuid,
  ruleRef: VersionRef | undefined,
  includeRecordedSeq = true,
): EvidenceRecord {
  const envelope: EvidenceEnvelope = {
    evidenceId,
    kind: 'rule_derivation',
    scopeRef: SCOPE,
    producedBy: {
      componentRef: { id: 'component', version: '1.0.0', digest: DIGEST },
      runId: RUN_ID,
      ...(ruleRef === undefined ? {} : { ruleRef }),
    },
    observedAt: '2026-09-21T06:00:00Z',
    ...(includeRecordedSeq ? { recordedSeq: '1' } : {}),
    sourceSnapshots: [],
    resultDigest: DIGEST,
    integrity: { algorithm: 'sha256', digest: DIGEST },
    dependencies: [],
    dataMode: 'observed',
  }
  return {
    evidenceRef: { id: evidenceId, version: '1.0.0', digest: DIGEST, kind: 'evidence' },
    envelope,
    envelopeDigest: DIGEST,
    revision: '1',
    recordedAt: '2026-09-21T06:00:00Z',
  }
}

describe('SupportEvidenceDependencySource', () => {
  it('resolves one immutable rule instance and follows an attribute child to its parent evidence', async () => {
    const store = new InMemorySemanticPublicationStore()
    const factEvidence = randomUUID()
    const secondFactEvidence = randomUUID()
    const parentStatementId = randomUUID()
    const secondParentStatementId = randomUUID()
    const publishedFacts = [
      statement({
        statementId: parentStatementId,
        subjectEntityId: 'entity-a',
        predicate: 'device.battery',
        value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
        sourceRefs: [evidenceRef(factEvidence)],
      }),
      statement({
        statementId: secondParentStatementId,
        subjectEntityId: 'entity-a',
        predicate: 'device.battery',
        value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
        sourceRefs: [evidenceRef(secondFactEvidence)],
      }),
    ]
    await publish(
      store,
      publishedFacts,
      [],
    )

    const projectedFacts = projectPublishedAttributeFacts(publishedFacts.map((fact) => ({ ...fact, publicationId: randomUUID() })), {
      schemaRef: DEFINITION,
    }).facts
    const parentFacts = projectedFacts.map((fact) => {
      if (fact.sourceStatementId === undefined || fact.objectId === undefined || fact.schemaRef === undefined) {
        throw new Error('fixture must preserve the published parent, object, and definition refs')
      }
      return {
        kind: 'entity_attribute' as const,
        assertionId: fact.assertionId,
        logicalAssertionId: fact.logicalAssertionId,
        sourceStatementId: fact.sourceStatementId,
        subjectEntityId: fact.subject,
        objectId: fact.objectId,
        schemaRef: fact.schemaRef,
        sourceRefs: fact.sourceRefs ?? [],
      }
    })
    const support = immutableSupportInstance({
      premiseGroups: [{
        groupId: 'condition:device.battery_present',
        facts: parentFacts,
      }],
    })
    const payloadRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' } as const
    let receivedRequest: SupportRequest | undefined
    const source = new SupportEvidenceDependencySource({
      published: store,
      supportReader: {
        readCandidates: async (_scope, request) => {
          receivedRequest = request
          return { complete: true, candidates: [support] }
        },
      },
    })
    const evidenceId = randomUUID()
    const baseEvidence = evidenceRecord(evidenceId, RULE_REF)
    const evidence: EvidenceRecord = {
      ...baseEvidence,
      envelope: { ...baseEvidence.envelope, payloadRef },
    }
    const edges = await source.dependenciesOf(
      SCOPE,
      evidence,
      CTX,
    )

    expect(edges).toHaveLength(2)
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromEvidenceId: evidenceId,
        toEvidenceId: factEvidence,
        relation: 'derives_from',
        origin: 'support',
        premiseGroup: 'condition:device.battery_present',
      }),
      expect.objectContaining({
        fromEvidenceId: evidenceId,
        toEvidenceId: secondFactEvidence,
        relation: 'derives_from',
        origin: 'support',
        premiseGroup: 'condition:device.battery_present',
      }),
    ]))
    expect(receivedRequest).toEqual({
      ruleRef: RULE_REF,
      validAt: '2026-09-21T06:00:00Z',
      asOfRecordedSeq: '1',
      evidenceRef: evidence.evidenceRef,
      payloadRef,
    })
    const detailed = await source.dependenciesWithResolutionOf(
      SCOPE,
      evidence,
      CTX,
    )
    expect(detailed.supportResolution).toMatchObject({
      state: 'resolved',
      instanceKey: 'rule-instance:entity-a',
      objectId: 'device.battery',
      subjectEntityId: 'entity-a',
    })
    if (detailed.supportResolution.state !== 'resolved') throw new Error('expected unique immutable support')
    expect(detailed.supportResolution.premiseGroups[0]?.facts.map((fact) => [fact.assertionId, fact.sourceStatementId]))
      .toEqual(parentFacts.map((fact) => [fact.assertionId, fact.sourceStatementId]))
  })

  it('does not use the current published heads as a fallback when no immutable reader exists', async () => {
    const store = new InMemorySemanticPublicationStore()
    const factEvidence = randomUUID()
    await publish(
      store,
      [statement({ statementId: randomUUID(), sourceRefs: [evidenceRef(factEvidence)] })],
      [ruleVersion({ ruleId: RULE_REF.id, objectId: 'device.battery' })],
    )
    const record = evidenceRecord(randomUUID(), RULE_REF)
    const parentEvidence = randomUUID()
    const withLineage: EvidenceRecord = {
      ...record,
      envelope: {
        ...record.envelope,
        dependencies: [{
          evidenceRef: { id: parentEvidence, version: '1.0.0', digest: DIGEST, kind: 'evidence' },
          relation: 'same_source',
          direction: 'outbound',
        }],
      },
    }
    const source = new SupportEvidenceDependencySource({ published: store })

    const result = await source.dependenciesWithResolutionOf(SCOPE, withLineage, CTX)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ toEvidenceId: parentEvidence, origin: 'lineage' })
    expect(result.supportResolution).toMatchObject({ state: 'unavailable' })
  })

  it('fails closed when two entity instances match the same root rule and bitemporal point', async () => {
    const source = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([
        immutableSupportInstance(),
        immutableSupportInstance({
          instanceKey: 'rule-instance:entity-b',
          subjectEntityId: 'entity-b',
          premiseGroups: [{
            groupId: 'condition:device.battery_present',
            facts: [{
              kind: 'entity_attribute',
              assertionId: 'statement-b#device.battery_present',
              logicalAssertionId: 'statement-b#device.battery_present',
              sourceStatementId: 'statement-b',
              subjectEntityId: 'entity-b',
              objectId: 'device.battery',
              schemaRef: DEFINITION,
              sourceRefs: [evidenceRef(randomUUID())],
            }],
          }],
        }),
      ]),
    })

    const result = await source.dependenciesWithResolutionOf(SCOPE, evidenceRecord(randomUUID(), RULE_REF), CTX)
    expect(result.edges).toEqual([])
    expect(result.supportResolution).toMatchObject({ state: 'ambiguous' })
  })

  it('rejects incomplete, cross-scope, and non-applicable support results', async () => {
    const evidence = evidenceRecord(randomUUID(), RULE_REF)
    const incompleteReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([immutableSupportInstance()], false),
    })
    const incomplete = await incompleteReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
    expect(incomplete.edges).toEqual([])
    expect(incomplete.supportResolution).toMatchObject({ state: 'incomplete' })

    const wrongScopeReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([immutableSupportInstance({ scopeRef: { ...SCOPE, tenantId: randomUUID() } })]),
    })
    const wrongScope = await wrongScopeReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
    expect(wrongScope.edges).toEqual([])
    expect(wrongScope.supportResolution).toMatchObject({ state: 'unavailable' })

    const nonApplicableReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([immutableSupportInstance({
        applicability: { state: 'not_applicable', positiveSupport: false },
      })]),
    })
    const nonApplicable = await nonApplicableReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
    expect(nonApplicable.edges).toEqual([])
    expect(nonApplicable.supportResolution).toMatchObject({ state: 'not_applicable' })

    for (const state of ['unknown', 'conflict'] as const) {
      const unresolvedReader = new SupportEvidenceDependencySource({
        published: new InMemorySemanticPublicationStore(),
        supportReader: supportReader([immutableSupportInstance({
          applicability: { state, positiveSupport: false },
        })]),
      })
      const unresolved = await unresolvedReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
      expect(unresolved.edges).toEqual([])
      expect(unresolved.supportResolution).toMatchObject({ state })
    }

    const inconsistentReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([immutableSupportInstance({
        applicability: { state: 'applicable', positiveSupport: false },
      })]),
    })
    const inconsistent = await inconsistentReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
    expect(inconsistent.edges).toEqual([])
    expect(inconsistent.supportResolution).toMatchObject({ state: 'incomplete' })

    const wrongTimeReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([immutableSupportInstance({ validAt: '2026-09-21T07:00:00Z' })]),
    })
    const wrongTime = await wrongTimeReader.dependenciesWithResolutionOf(SCOPE, evidence, CTX)
    expect(wrongTime.edges).toEqual([])
    expect(wrongTime.supportResolution).toMatchObject({ state: 'unavailable' })

    let reads = 0
    const unpinnedReader = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: {
        readCandidates: async () => {
          reads += 1
          return { complete: true, candidates: [immutableSupportInstance()] }
        },
      },
    })
    const unpinned = await unpinnedReader.dependenciesWithResolutionOf(
      SCOPE,
      evidenceRecord(randomUUID(), RULE_REF, false),
      CTX,
    )
    expect(unpinned.edges).toEqual([])
    expect(unpinned.supportResolution).toMatchObject({ state: 'unavailable' })
    expect(reads).toBe(0)
  })

  it('does not emit evidence edges from relation premise records', async () => {
    const relationEvidence = randomUUID()
    const support = immutableSupportInstance({
      premiseGroups: [{
        groupId: 'relation:device.located_in',
        facts: [{
          kind: 'relation',
          assertionId: 'relation-statement',
          logicalAssertionId: 'relation-statement',
          sourceStatementId: 'relation-statement',
          subjectEntityId: 'entity-a',
          objectId: 'device.battery',
          schemaRef: DEFINITION,
          sourceRefs: [evidenceRef(relationEvidence)],
        }],
      }],
    })
    const source = new SupportEvidenceDependencySource({
      published: new InMemorySemanticPublicationStore(),
      supportReader: supportReader([support]),
    })

    const result = await source.dependenciesWithResolutionOf(SCOPE, evidenceRecord(randomUUID(), RULE_REF), CTX)
    expect(result.edges).toEqual([])
    expect(result.supportResolution).toMatchObject({ state: 'incomplete' })
    expect(result.edges.map((edge) => edge.toEvidenceId)).not.toContain(relationEvidence)
  })

  it('returns only recorded lineage when the evidence has no rule', async () => {
    const store = new InMemorySemanticPublicationStore()
    const source = new SupportEvidenceDependencySource({ published: store })
    const record = evidenceRecord(randomUUID(), undefined)
    const withLineage: EvidenceRecord = {
      ...record,
      envelope: {
        ...record.envelope,
        dependencies: [
          {
            evidenceRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' },
            relation: 'same_source',
            direction: 'outbound',
          },
        ],
      },
    }
    const edges = await source.dependenciesOf(SCOPE, withLineage, CTX)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.origin).toBe('lineage')
  })
})

describe('HistoryReadService', () => {
  it('replays immutable versions at recordedAt and validAt without erasing history', async () => {
    const store = new InMemorySemanticPublicationStore()
    const statementId = randomUUID()
    await publish(store, [statement({ statementId, sourceRefs: [evidenceRef(randomUUID())] })], [])

    const history = new HistoryReadService({ store })
    const initial = await history.getObjectHistory('device.battery', {}, CTX)
    expect(initial.assertions.map((assertion) => assertion.version)).toEqual(['1'])
    expect(initial.assertions[0]?.status).toBe('active')

    const beforeRetraction = await history.getObjectHistory(
      'device.battery',
      { recordedAt: '2026-09-21T06:00:00Z' },
      CTX,
    )
    expect(beforeRetraction.assertions.map((assertion) => assertion.version)).toEqual(['1'])

    await store.reviseStatement(
      SCOPE,
      {
        expectedRevision: '1',
        revisionId: randomUUID(),
        statementId,
        kind: 'retraction',
        reason: 'the only supporting source was withdrawn',
        recordedAt: '2026-09-21T12:00:00Z',
        actor: 'tester',
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.statement.retracted',
          payload: { statementId },
          idempotencyKey: `retract-${statementId}`,
          availableAt: '2026-09-21T12:00:00Z',
          createdAt: '2026-09-21T12:00:00Z',
        },
      },
      CTX,
    )

    const full = await history.getObjectHistory('device.battery', {}, CTX)
    const versions = new Map(full.assertions.map((assertion) => [assertion.version, assertion]))
    expect([...versions.keys()].sort()).toEqual(['1', '2'])
    // History is not erased by the current retracted projection: version 1 survives.
    expect(versions.get('1')).toMatchObject({ status: 'active', value: { value: true } })
    expect(versions.get('2')).toMatchObject({
      status: 'retracted',
      revisionKind: 'retraction',
      supersedesVersion: '1',
    })

    const asOfBefore = await history.getObjectHistory(
      'device.battery',
      { recordedAt: '2026-09-21T06:00:00Z' },
      CTX,
    )
    expect(asOfBefore.assertions.map((assertion) => assertion.version)).toEqual(['1'])

    const asOfAfter = await history.getObjectHistory(
      'device.battery',
      { recordedAt: '2026-09-21T18:00:00Z' },
      CTX,
    )
    expect(asOfAfter.assertions.map((assertion) => assertion.version).sort()).toEqual(['1', '2'])

    const validOutside = await history.getObjectHistory(
      'device.battery',
      { validAt: '2026-09-23T00:00:00Z' },
      CTX,
    )
    expect(validOutside.assertions).toHaveLength(0)

    const validInside = await history.getObjectHistory(
      'device.battery',
      { validAt: '2026-09-21T06:00:00Z' },
      CTX,
    )
    expect(validInside.assertions.map((assertion) => assertion.version).sort()).toEqual(['1', '2'])
  })

  it('pages a large history and marks the page truncated', async () => {
    const store = new InMemorySemanticPublicationStore()
    const statementId = randomUUID()
    await publish(store, [statement({ statementId, sourceRefs: [evidenceRef(randomUUID())] })], [])
    for (let index = 0; index < 3; index += 1) {
      const expectedRevision: RevisionString = String(index + 1)
      await store.reviseStatement(
        SCOPE,
        {
          expectedRevision,
          revisionId: randomUUID(),
          statementId,
          kind: 'correction',
          reason: `correction ${String(index)}`,
          correctedValue: { value: index % 2 === 0 },
          recordedAt: `2026-09-21T1${String(index)}:00:00Z`,
          actor: 'tester',
          outbox: {
            outboxId: randomUUID(),
            topic: 'semantic.statement.corrected',
            payload: { statementId },
            idempotencyKey: `correct-${statementId}-${String(index)}`,
            availableAt: `2026-09-21T1${String(index)}:00:00Z`,
            createdAt: `2026-09-21T1${String(index)}:00:00Z`,
          },
        },
        CTX,
      )
    }

    const history = new HistoryReadService({ store })
    const first = await history.getObjectHistory('device.battery', { limit: 2 }, CTX)
    expect(first.assertions).toHaveLength(2)
    expect(first.coverage.truncated).toBe(true)
    expect(first.coverage.knownTotal).toBe(4)
    const second = await history.getObjectHistory(
      'device.battery',
      { limit: 2, cursor: first.coverage.cursor ?? '' },
      CTX,
    )
    expect(second.assertions).toHaveLength(2)
    expect(second.coverage.truncated).toBe(false)
  })
})
