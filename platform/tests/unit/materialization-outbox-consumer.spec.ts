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
  }
}

/** A mutable published read view the test drives directly. */
class FakePublicationView implements MaterializationPublicationView {
  #statements: PublishedStatement[]
  #rules: PublishedRuleVersion[]
  #publicationId: Uuid

  constructor(publicationId: Uuid, statements: PublishedStatement[], rules: PublishedRuleVersion[]) {
    this.#publicationId = publicationId
    this.#statements = statements
    this.#rules = rules
  }

  replaceStatements(statements: PublishedStatement[]): void {
    this.#statements = statements
  }

  async listStatements(_scopeRef: ScopeRef, filter: { publicationId?: Uuid }): Promise<PublishedStatement[]> {
    return this.#statements.filter(
      (statement) => filter.publicationId === undefined || statement.publicationId === filter.publicationId,
    )
  }

  async listRuleVersions(_scopeRef: ScopeRef, filter: { publicationId?: Uuid }): Promise<PublishedRuleVersion[]> {
    return this.#rules.filter((rule) => filter.publicationId === undefined || rule.publicationId === filter.publicationId)
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

function harness(): Harness {
  const scopeRef: ScopeRef = {
    tenantId: '44444444-4444-4444-8444-444444444444',
    spaceId: '55555555-5555-4555-8555-555555555555',
  }
  const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['semantic-publisher', 'platform-admin'])
  const publicationId = randomUUID()
  const view = new FakePublicationView(
    publicationId,
    [statementFor(publicationId, '1', 'active')],
    [ruleVersionFor(publicationId)],
  )
  const store = new InMemoryMaterializationStore()
  const materializer = new IncrementalMaterializer({
    publishedSource: new PublishedSemanticSource(view),
    materialization: store,
  })
  const outbox = new RecordingOutbox()
  const consumer = new MaterializationOutboxConsumer({
    materializer,
    publications: view,
    sequence: new CountingSequence(),
    outbox,
    materialization: store,
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
    const conclusion = advanced.conclusions.find((entry) => entry.propositionKey === PREDICATE)
    expect(conclusion?.value).toBe(true)
    expect(await h.store.listOpenFences(h.scopeRef, h.ctx)).toHaveLength(0)
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
    expect(baseline.conclusions.find((entry) => entry.propositionKey === PREDICATE)?.value).toBe(true)

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
    const conclusion = advanced.conclusions.find((entry) => entry.propositionKey === PREDICATE)
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()

    // History is preserved: the pre-retraction recorded version still resolves the old value.
    const historical = await h.materializer.read({ ...request, asOfRecordedSeq: '1' }, h.ctx)
    expect(historical.conclusions.find((entry) => entry.propositionKey === PREDICATE)?.value).toBe(true)
  })
})
