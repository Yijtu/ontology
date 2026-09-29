import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  IncrementalMaterializer,
  InMemoryMaterializationStore,
  PublishedSemanticSource,
} from '@ontology/semantic-engine'
import {
  MaterializationOutboxConsumer,
  MATERIALIZATION_REQUESTED_TOPIC,
  PUBLICATION_PUBLISHED_TOPIC,
  STATEMENT_RETRACTED_TOPIC,
} from '@ontology/app-worker'
import type {
  MaterializationPublicationView,
  MaterializationRecordSequence,
} from '@ontology/app-worker'
import type {
  NewOutboxMessage,
  OutboxMessageRecord,
  PublishedRuleVersion,
  PublishedStatement,
  ResourceRef,
  ScopeRef,
  SemanticPublicationVersion,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'
import { FixturePublishedIdentityReader } from '../integration/published-identity-reader'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const PREDICATE = 'device.battery_present'
const PROJECTION_REF = { id: 'projection.materialized', version: '1.0.0', digest: DIGEST }

function sourceRefs(): ResourceRef[] {
  return [{ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' }]
}

function statementFor(publicationId: Uuid, version: string, status: 'active' | 'retracted'): PublishedStatement {
  return {
    statementId: '11111111-1111-4111-8111-111111111111',
    propositionKey: PREDICATE,
    kind: 'entity',
    objectId: PREDICATE,
    subjectEntityId: 'entity.battery',
    predicate: PREDICATE,
    value: { value: true },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    sourceRefs: sourceRefs(),
    publicationId,
    version,
    status,
  }
}

function ruleVersionFor(publicationId: Uuid): PublishedRuleVersion {
  return {
    ruleVersionId: '22222222-2222-4222-8222-222222222222',
    ruleId: 'rule.battery-present',
    version: '1',
    objectId: PREDICATE,
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: PREDICATE, operator: 'eq', value: true, spans: [] },
    exceptions: [],
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    publicationId,
    conclusion: { predicate: PREDICATE, value: true },
  }
}

/** A mutable published read view the test drives directly. */
class FakePublicationView implements MaterializationPublicationView {
  #statements: PublishedStatement[]
  #rules: PublishedRuleVersion[]
  #publicationId: Uuid
  #readRevision = 1

  constructor(publicationId: Uuid, statements: PublishedStatement[], rules: PublishedRuleVersion[]) {
    this.#publicationId = publicationId
    this.#statements = statements
    this.#rules = rules
  }

  replaceStatements(statements: PublishedStatement[]): void {
    this.#statements = statements
    this.#readRevision += 1
  }

  replaceRules(rules: PublishedRuleVersion[]): void {
    this.#rules = rules
    this.#readRevision += 1
  }

  async latestReadRevision(): Promise<string> {
    return String(this.#readRevision)
  }

  async listStatements(
    _scopeRef: ScopeRef,
    filter: { publicationId?: Uuid; afterStatementId?: Uuid; limit?: number },
  ): Promise<PublishedStatement[]> {
    return this.#statements
      .filter((statement) => filter.publicationId === undefined || statement.publicationId === filter.publicationId)
      .filter((statement) => filter.afterStatementId === undefined || statement.statementId > filter.afterStatementId)
      .sort((left, right) => left.statementId.localeCompare(right.statementId))
      .slice(0, filter.limit ?? this.#statements.length)
  }

  async listRuleVersions(
    _scopeRef: ScopeRef,
    filter: { publicationId?: Uuid; afterRule?: { ruleId: string; version: string }; limit?: number },
  ): Promise<PublishedRuleVersion[]> {
    return this.#rules
      .filter((rule) => filter.publicationId === undefined || rule.publicationId === filter.publicationId)
      .filter((rule) => filter.afterRule === undefined ||
        rule.ruleId > filter.afterRule.ruleId ||
        (rule.ruleId === filter.afterRule.ruleId && BigInt(rule.version) > BigInt(filter.afterRule.version)))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId) || Number(left.version) - Number(right.version))
      .slice(0, filter.limit ?? this.#rules.length)
  }

  async getPublication(_scopeRef: ScopeRef, publicationId: Uuid): Promise<SemanticPublicationVersion | undefined> {
    if (publicationId !== this.#publicationId) return undefined
    return {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      revision: '1',
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: this.#statements,
      ruleVersions: this.#rules,
      outboxId: randomUUID(),
      publishedAt: '2026-09-21T06:00:00Z',
      actor: 'publisher',
    }
  }

  async getStatement(_scopeRef: ScopeRef, statementId: Uuid): Promise<PublishedStatement | undefined> {
    return this.#statements.find((statement) => statement.statementId === statementId)
  }
}

class CountingSequence implements MaterializationRecordSequence {
  #counter = 0
  readonly #byKey = new Map<string, string>()

  async next(_scopeRef: ScopeRef, idempotencyKey: string): Promise<string> {
    const existing = this.#byKey.get(idempotencyKey)
    if (existing !== undefined) return existing
    this.#counter += 1
    const sequence = String(this.#counter)
    this.#byKey.set(idempotencyKey, sequence)
    return sequence
  }
}

class RecordingOutbox {
  readonly messages: OutboxMessageRecord[] = []

  async appendOutbox(_scopeRef: ScopeRef, jobId: Uuid, message: NewOutboxMessage): Promise<OutboxMessageRecord> {
    const record: OutboxMessageRecord = { ...message, jobId, state: 'pending', attempts: 0 }
    this.messages.push(record)
    return record
  }
}

function messageOf(topic: string, payload: Readonly<Record<string, unknown>>): OutboxMessageRecord {
  return {
    outboxId: randomUUID(),
    jobId: '33333333-3333-4333-8333-333333333333',
    topic,
    payload,
    idempotencyKey: `${topic}:${randomUUID()}`,
    state: 'pending',
    attempts: 0,
    availableAt: '2026-09-21T06:00:00Z',
    createdAt: '2026-09-21T06:00:00Z',
  }
}

interface Harness {
  readonly store: InMemoryMaterializationStore
  readonly materializer: IncrementalMaterializer
  readonly view: FakePublicationView
  readonly outbox: RecordingOutbox
  readonly consumer: MaterializationOutboxConsumer
  readonly ctx: ToolContext
  readonly scopeRef: ScopeRef
  readonly publicationId: Uuid
}

function harness(pageSize?: number): Harness {
  const scopeRef: ScopeRef = {
    tenantId: '44444444-4444-4444-8444-444444444444',
    spaceId: '55555555-5555-4555-8555-555555555555',
  }
  const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['semantic-publisher', 'platform-admin'])
  const publicationId = randomUUID()
  const statement = statementFor(publicationId, '1', 'active')
  const identity = new FixturePublishedIdentityReader()
  identity.bindStatements([statement])
  const view = new FakePublicationView(publicationId, [statement], [ruleVersionFor(publicationId)])
  const store = new InMemoryMaterializationStore()
  const materializer = new IncrementalMaterializer({
    publishedSource: new PublishedSemanticSource(view, { identity }),
    materialization: store,
  })
  const outbox = new RecordingOutbox()
  const consumer = new MaterializationOutboxConsumer({
    materializer,
    publications: view,
    sequence: new CountingSequence(),
    outbox,
    materialization: store,
    ...(pageSize === undefined ? {} : { pageSize }),
  })
  return { store, materializer, view, outbox, consumer, ctx, scopeRef, publicationId }
}

describe('materialization outbox consumer (LOCAL-069)', () => {
  it('opens the fence on publish, enqueues the change, then advances to the new conclusion', async () => {
    const h = harness()

    await h.consumer.consume(messageOf(PUBLICATION_PUBLISHED_TOPIC, { publicationId: h.publicationId }), h.ctx)

    const requests = h.outbox.messages.filter((message) => message.topic === MATERIALIZATION_REQUESTED_TOPIC)
    expect(requests).toHaveLength(2)
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(2)

    const request = {
      scopeRef: h.scopeRef,
      projectionRef: PROJECTION_REF,
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }

    // In-flight recomputation: the fence withholds the stale conclusion.
    const fenced = await h.materializer.read(request, h.ctx)
    expect(fenced.status).toBe('fenced')
    expect(fenced.conclusions).toHaveLength(0)

    for (const message of requests) await h.consumer.consume(message, h.ctx)

    const advanced = await h.materializer.read(request, h.ctx)
    expect(advanced.status).toBe('materialized')
    const conclusion = advanced.conclusions.find((entry) => entry.predicate === PREDICATE)
    expect(conclusion?.value).toBe(true)
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(0)
  })

  it('reuses the fence the publication transaction opened instead of opening a second one', async () => {
    const h = harness()
    const statementFenceId = randomUUID()
    const ruleFenceId = randomUUID()
    await h.store.openFence(
      h.scopeRef,
      { fenceId: statementFenceId, reason: 'opened in the publication transaction', propositionKeys: [], openedAt: '2026-09-21T06:00:00Z' },
      h.ctx,
    )
    await h.store.openFence(
      h.scopeRef,
      { fenceId: ruleFenceId, reason: 'opened in the publication transaction', propositionKeys: [], openedAt: '2026-09-21T06:00:00Z' },
      h.ctx,
    )

    await h.consumer.consume(
      messageOf(PUBLICATION_PUBLISHED_TOPIC, {
        publicationId: h.publicationId,
        materializationFences: [
          { changeId: '11111111-1111-4111-8111-111111111111', fenceId: statementFenceId },
          { changeId: '22222222-2222-4222-8222-222222222222', fenceId: ruleFenceId },
        ],
      }),
      h.ctx,
    )

    // The consumer must not open a third fence; it binds the two already-committed ones.
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(2)
    const requests = h.outbox.messages.filter((message) => message.topic === MATERIALIZATION_REQUESTED_TOPIC)
    expect(requests).toHaveLength(2)
    expect(requests.map((message) => message.payload['fenceId']).sort()).toEqual(
      [statementFenceId, ruleFenceId].sort(),
    )

    for (const message of requests) await h.consumer.consume(message, h.ctx)
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(0)
    const advanced = await h.materializer.read(
      { scopeRef: h.scopeRef, projectionRef: PROJECTION_REF, asOfRecordedSeq: '2', validAt: '2026-09-21T12:00:00Z' },
      h.ctx,
    )
    expect(advanced.status).toBe('materialized')
    expect(advanced.conclusions.find((entry) => entry.predicate === PREDICATE)?.value).toBe(true)
  })

  it('walks every bounded statement and rule publication page without repeating a cursor', async () => {
    const h = harness(1)
    h.view.replaceStatements([
      statementFor(h.publicationId, '1', 'active'),
      { ...statementFor(h.publicationId, '1', 'active'), statementId: '11111111-1111-4111-8111-111111111112' },
      { ...statementFor(h.publicationId, '1', 'active'), statementId: '11111111-1111-4111-8111-111111111113' },
    ])
    const originalRule = ruleVersionFor(h.publicationId)
    // The keyset is ordered by logical rule id then numeric revision.
    const additionalRules: PublishedRuleVersion[] = [
      { ...originalRule, ruleVersionId: '22222222-2222-4222-8222-222222222223', ruleId: 'rule.battery-secondary', version: '1' },
      { ...originalRule, ruleVersionId: '22222222-2222-4222-8222-222222222224', ruleId: 'rule.battery-secondary', version: '2' },
    ]
    h.view.replaceRules([originalRule, ...additionalRules])

    await h.consumer.consume(messageOf(PUBLICATION_PUBLISHED_TOPIC, { publicationId: h.publicationId }), h.ctx)

    const requests = h.outbox.messages.filter((message) => message.topic === MATERIALIZATION_REQUESTED_TOPIC)
    expect(requests).toHaveLength(6)
    const changes = requests.map((message) => (message.payload['change'] as { kind?: string }).kind)
    expect(changes.filter((kind) => kind === 'assertion_published')).toHaveLength(3)
    expect(changes.filter((kind) => kind === 'rule_changed')).toHaveLength(3)
  })

  it('routes an identity split through its transactionally pre-opened scope fence', async () => {
    const h = harness()
    const eventId = randomUUID()
    const fenceId = randomUUID()
    const candidateId = randomUUID()
    await h.store.openFence(
      h.scopeRef,
      { fenceId, reason: 'identity split committed', propositionKeys: [], openedAt: '2026-09-21T06:00:00Z' },
      h.ctx,
    )

    await h.consumer.consume(messageOf('identity.decision.split', {
      eventId,
      materializationFenceId: fenceId,
      decisionId: randomUUID(),
      entityId: 'entity.battery',
      objectId: PREDICATE,
      identityScopeId: 'device-inventory',
      separatedCandidateIds: [candidateId],
      reason: 'records describe distinct batteries',
      recordedAt: '2026-09-21T06:00:00Z',
      actor: 'reviewer',
    }), h.ctx)

    const request = h.outbox.messages[0]
    expect(request?.topic).toBe(MATERIALIZATION_REQUESTED_TOPIC)
    expect(request?.payload['fenceId']).toBe(fenceId)
    expect((request?.payload['change'] as { kind?: string }).kind).toBe('identity_changed')
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(1)
  })

  it('does not advance twice when the same request is re-delivered after a crash reclaim', async () => {
    const h = harness()
    await h.consumer.consume(messageOf(PUBLICATION_PUBLISHED_TOPIC, { publicationId: h.publicationId }), h.ctx)
    const requests = h.outbox.messages.filter((message) => message.topic === MATERIALIZATION_REQUESTED_TOPIC)
    const [first] = requests
    if (first === undefined) throw new Error('expected a materialization request')

    await h.consumer.consume(first, h.ctx)
    const afterFirst = await h.store.getProjectionState(h.scopeRef, h.ctx)
    expect(afterFirst).toBeDefined()

    // At-least-once re-delivery: the consumer runs `advance` again with the same change.
    await h.consumer.consume(first, h.ctx)
    const afterRedelivery = await h.store.getProjectionState(h.scopeRef, h.ctx)
    expect(afterRedelivery?.generation).toBe(afterFirst?.generation)
    expect(afterRedelivery?.watermark.value).toBe(afterFirst?.watermark.value)
  })

  it('retracts a statement through the fence and keeps the historical conclusion', async () => {
    const h = harness()
    await h.consumer.consume(messageOf(PUBLICATION_PUBLISHED_TOPIC, { publicationId: h.publicationId }), h.ctx)
    for (const message of h.outbox.messages) {
      if (message.topic === MATERIALIZATION_REQUESTED_TOPIC) await h.consumer.consume(message, h.ctx)
    }

    const request = {
      scopeRef: h.scopeRef,
      projectionRef: PROJECTION_REF,
      asOfRecordedSeq: '3',
      validAt: '2026-09-21T12:00:00Z',
    }
    const baseline = await h.materializer.read({ ...request, asOfRecordedSeq: '2' }, h.ctx)
    expect(baseline.conclusions.find((entry) => entry.predicate === PREDICATE)?.value).toBe(true)

    h.view.replaceStatements([statementFor(h.publicationId, '2', 'retracted')])
    await h.consumer.consume(
      messageOf(STATEMENT_RETRACTED_TOPIC, {
        statementId: '11111111-1111-4111-8111-111111111111',
        revisionId: randomUUID(),
        kind: 'retraction',
      }),
      h.ctx,
    )

    const fenced = await h.materializer.read(request, h.ctx)
    expect(fenced.status).toBe('fenced')
    expect(fenced.conclusions).toHaveLength(0)

    const retractionRequest = h.outbox.messages[h.outbox.messages.length - 1]
    if (retractionRequest === undefined) throw new Error('expected a retraction request')
    await h.consumer.consume(retractionRequest, h.ctx)

    const advanced = await h.materializer.read(request, h.ctx)
    const conclusion = advanced.conclusions.find((entry) => entry.predicate === PREDICATE)
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()

    // History is preserved: the pre-retraction recorded version still resolves the old value.
    const historical = await h.materializer.read({ ...request, asOfRecordedSeq: '1' }, h.ctx)
    expect(historical.conclusions.find((entry) => entry.predicate === PREDICATE)?.value).toBe(true)
  })
})
