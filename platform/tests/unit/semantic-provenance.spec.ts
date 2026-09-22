import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HistoryReadService,
  InMemorySemanticPublicationStore,
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
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const CTX: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'reader', RUN_ID)
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }

function evidenceRef(id: Uuid): PublishedStatement['sourceRefs'][number] {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'evidence' }
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

function evidenceRecord(evidenceId: Uuid, ruleRef: VersionRef | undefined): EvidenceRecord {
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
    recordedSeq: '1',
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
  it('returns the real support-DAG premises and never a relation assertion', async () => {
    const store = new InMemorySemanticPublicationStore()
    const factEvidence = randomUUID()
    const relationEvidence = randomUUID()
    await publish(
      store,
      [
        statement({ statementId: randomUUID(), sourceRefs: [evidenceRef(factEvidence)] }),
        statement({
          statementId: randomUUID(),
          kind: 'relation',
          relationId: 'device.located_in',
          predicate: 'device.located_in',
          value: { value: 'room.one' },
          sourceRefs: [evidenceRef(relationEvidence)],
        }),
      ],
      [ruleVersion({ ruleId: 'rule.battery-ready' })],
    )

    const source = new SupportEvidenceDependencySource({ published: store })
    const evidenceId = randomUUID()
    const edges = await source.dependenciesOf(
      SCOPE,
      evidenceRecord(evidenceId, { id: 'rule.battery-ready', version: '1', digest: DIGEST }),
      CTX,
    )

    expect(edges).toHaveLength(1)
    const edge = edges[0]
    expect(edge).toMatchObject({
      fromEvidenceId: evidenceId,
      toEvidenceId: factEvidence,
      relation: 'derives_from',
      origin: 'support',
    })
    expect(edge?.premiseGroup).toContain('device.battery_present')
    // The relation assertion is a different graph and must never appear as an evidence dependency.
    expect(edges.map((candidate) => candidate.toEvidenceId)).not.toContain(relationEvidence)
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
