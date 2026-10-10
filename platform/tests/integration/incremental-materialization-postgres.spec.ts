import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresJobStore,
  PostgresMaterializationStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { OutboxDispatcher } from '@ontology/application'
import type { OutboxConsumer } from '@ontology/application'
import { IncrementalMaterializer, PublishedSemanticSource, sha256DigestOf } from '@ontology/semantic-engine'
import type { MaterializationTicket } from '@ontology/semantic-engine'
import type {
  MaterializationChange,
  MaterializedConclusion,
  NewOutboxMessage,
  OutboxMessageRecord,
  ProjectionSlice,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  RuleComputationArtifact,
  RulePremiseObservation,
  RulePremiseReplayInput,
  ResourceRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { FixturePublishedIdentityReader } from './published-identity-reader'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const PREDICATE = 'device.battery_present'

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let publication: PostgresSemanticPublicationStore
let identity: FixturePublishedIdentityReader
let jobStore: PostgresJobStore
let jobId: Uuid

function sourceRefs(): ResourceRef[] {
  return [{ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' }]
}

function statementFor(publicationId: Uuid): PublishedStatement {
  return {
    statementId: randomUUID(),
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
    version: '1',
    status: 'active',
  }
}

function ruleVersionFor(publicationId: Uuid): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId: 'rule.battery-present',
    version: '1',
    objectId: PREDICATE,
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: PREDICATE, operator: 'eq', value: true, spans: [] },
    exceptions: [],
    conclusion: { predicate: PREDICATE, value: true },
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

async function publishBundle(
  statements: readonly PublishedStatement[],
  ruleVersions: readonly PublishedRuleVersion[],
  key: string,
  outbox?: NewOutboxMessage,
): Promise<void> {
  const publicationId = randomUUID()
  const expectedRevision = await publication.latestPublicationRevision(scope.scopeRef, ctx)
  const message: NewOutboxMessage = outbox ?? {
    outboxId: randomUUID(),
    topic: 'semantic.publication.published',
    payload: { publicationId },
    idempotencyKey: `${key}:outbox`,
    availableAt: '2026-09-21T06:00:00Z',
    createdAt: '2026-09-21T06:00:00Z',
  }
  const input: PublishSemanticPublicationInput = {
    expectedRevision,
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: statements.map((statement) => ({ ...statement, publicationId })),
      ruleVersions: ruleVersions.map((rule) => ({ ...rule, publicationId })),
      outboxId: message.outboxId,
      publishedAt: '2026-09-21T06:00:00Z',
      actor: ctx.principal.subjectId,
    },
    idempotencyKey: key,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: message,
    outboxJobId: jobId,
  }
  identity.bindStatements(statements)
  await publication.publish(scope.scopeRef, input, ctx)
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'incremental-materialization')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  publication = new PostgresSemanticPublicationStore(database)
  identity = new FixturePublishedIdentityReader()
  jobStore = new PostgresJobStore(database)

  jobId = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', 'incremental-materialization', $4, '1.0.0', 'published',
       $5, $6, 1, '{}'::jsonb, now(), now(), 'incremental-materialization-test', now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      randomUUID(),
      `incremental-materialization-${jobId.slice(0, 8)}`,
      sha256DigestOf({ jobId }),
    ],
  )
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('incremental materialisation against real PostgreSQL and the real outbox', () => {
  it('atomically closes a bounded set of actual fences and rolls back missing or foreign batch members', async () => {
    const owner = await createJobScope(harness.adminClient, 'materialization-batch-owner')
    const foreign = await createJobScope(harness.adminClient, 'materialization-batch-foreign')
    const ownerCtx = toolContext(owner.tenantId, owner.spaceId, ['platform-admin'])
    const foreignCtx = toolContext(foreign.tenantId, foreign.spaceId, ['platform-admin'])
    const store = new PostgresMaterializationStore(database)
    const openedAt = new Date().toISOString()
    const first = await store.openFence(owner.scopeRef, { fenceId: randomUUID(), reason: 'first actual batch change', propositionKeys: [], openedAt }, ownerCtx)
    const second = await store.openFence(owner.scopeRef, { fenceId: randomUUID(), reason: 'second actual batch change', propositionKeys: [], openedAt }, ownerCtx)
    const unrelated = await store.openFence(foreign.scopeRef, { fenceId: randomUUID(), reason: 'another tenant batch', propositionKeys: [], openedAt }, foreignCtx)
    const input = { fenceId: first.fenceId, expectedGeneration: '0', recordedSeq: '2', watermark: { kind: 'sequence' as const, value: '2' }, slices: [], committedAt: new Date().toISOString() }
    const originalState = await store.getProjectionState(owner.scopeRef, ownerCtx)

    for (const unavailable of [randomUUID(), unrelated.fenceId]) {
      await expect(store.commitProjection(owner.scopeRef, { ...input, additionalFenceIds: [unavailable] }, ownerCtx)).rejects.toMatchObject({ code: 'FENCE_NOT_FOUND' })
      expect(await store.getProjectionState(owner.scopeRef, ownerCtx)).toEqual(originalState)
      expect(await store.readSlices(owner.scopeRef, {}, ownerCtx)).toEqual([])
      expect((await store.getFence(owner.scopeRef, first.fenceId, ownerCtx))?.state).toBe('open')
      expect((await store.getFence(owner.scopeRef, second.fenceId, ownerCtx))?.state).toBe('open')
      expect((await store.getFence(foreign.scopeRef, unrelated.fenceId, foreignCtx))?.state).toBe('open')
    }

    const committed = await store.commitProjection(owner.scopeRef, { ...input, additionalFenceIds: [second.fenceId] }, ownerCtx)
    expect(committed.state).toMatchObject({ generation: '1', watermark: { kind: 'sequence', value: '2' }, dirty: false })
    expect(await store.listOpenFences(owner.scopeRef, ownerCtx)).toEqual([])
    expect((await store.getFence(owner.scopeRef, first.fenceId, ownerCtx))?.state).toBe('closed')
    expect((await store.getFence(owner.scopeRef, second.fenceId, ownerCtx))?.state).toBe('closed')
    expect((await store.getFence(foreign.scopeRef, unrelated.fenceId, foreignCtx))?.state).toBe('open')
    await expect(store.commitProjection(owner.scopeRef, { ...input, additionalFenceIds: [second.fenceId] }, ownerCtx)).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' })
    expect(await store.getProjectionState(owner.scopeRef, ownerCtx)).toEqual(committed.state)
  })

  it('round-trips wide premise archives unchanged across two bulk SQL chunks', async () => {
    const owner = await createJobScope(harness.adminClient, 'materialization-bulk-roundtrip')
    const ownerCtx = toolContext(owner.tenantId, owner.spaceId, ['platform-admin'])
    const store = new PostgresMaterializationStore(database)
    const openedAt = new Date().toISOString()
    const fences = []
    for (let index = 0; index < 8; index += 1) {
      fences.push(await store.openFence(owner.scopeRef, {
        fenceId: randomUUID(), reason: 'round-trip batch event ' + String(index + 1), propositionKeys: [], openedAt,
      }, ownerCtx))
    }

    const definitionRef: VersionRef = { id: 'round-trip-definition', version: '1.0.0', digest: DIGEST }
    const ruleRef: VersionRef = { id: 'round-trip-rule', version: '1.0.0', digest: DIGEST }
    const premiseStatements = Array.from({ length: 200 }, () => statementFor(randomUUID()))
    const premiseFacts: RulePremiseObservation[] = Array.from({ length: 40 }, (_, index) => ({
      assertionId: 'premise-' + String(index),
      logicalAssertionId: 'logical-premise-' + String(index),
      recordedSeq: String(index + 1),
      op: index % 2 === 0 ? 'assert' : 'correct',
      subject: 'entity.premise-' + String(index),
      predicate: 'device.exact_cost',
      value: index === 0 ? { kind: 'scalar_decimal', amount: '123456789012345678.123456789012345678' } : '中文“quoted” premise ' + String(index),
      objectId: 'device',
      attributeId: 'device.exact_cost',
      validity: VALIDITY,
      sourceRef: { namespace: 'documents', sourceId: 'wide-premise-' + String(index) },
    }))
    const sharedBase: Omit<RulePremiseReplayInput, 'request' | 'evaluatedRuleIds' | 'complete'> = {
      declarations: [ruleVersionFor(randomUUID())],
      attributeStatements: premiseStatements,
      relationStatements: [],
      identityBindings: [],
      subjects: Array.from({ length: 40 }, (_, index) => ({ subjectEntityId: 'entity.premise-' + String(index), objectId: 'device' })),
      facts: premiseFacts,
      completeRangeAttributeIds: ['device.exact_cost'],
    }
    const separateBase: typeof sharedBase = { ...sharedBase, completeRangeAttributeIds: ['device.other_complete_range'] }
    const archiveRequest = (sequence: number) => ({
      scopeRef: owner.scopeRef,
      projectionRef: { id: 'projection.bulk-roundtrip', version: '1.0.0', digest: DIGEST },
      asOfRecordedSeq: String(sequence),
      validAt: '2026-09-21T' + String(sequence).padStart(2, '0') + ':00:00Z',
    })
    const artifactOf = (sequence: number, base: typeof sharedBase, capturePremise = true): RuleComputationArtifact => ({
      ...(capturePremise ? { premiseInput: {
        ...base,
        request: archiveRequest(sequence),
        evaluatedRuleIds: ['rule.roundtrip.' + String(sequence)],
        complete: sequence % 2 === 0,
      } } : {}),
      schemaVersion: 'rule-computation-artifact@1',
      scopeRef: owner.scopeRef,
      definitionRef,
      ruleRef,
      ruleId: 'rule.roundtrip.' + String(sequence),
      ruleVersionId: randomUUID(),
      publishedRevision: String(sequence),
      instanceKey: 'instance.' + String(sequence),
      objectId: 'device',
      subjectEntityId: 'entity.roundtrip.' + String(sequence),
      predicate: 'device.exact_cost',
      applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true },
      factRefs: [{ assertionId: 'artifact-fact-' + String(sequence), logicalAssertionId: 'artifact-logical-fact-' + String(sequence), recordedSeq: String(sequence), digest: DIGEST }],
      sourceStatementIds: ['artifact-statement-' + String(sequence)],
      inputDigest: DIGEST,
      computationDigest: DIGEST,
      sourceSpans: [],
      complete: sequence % 2 === 0,
    })
    const conclusionOf = (sequence: number, variant: number): MaterializedConclusion => ({
      propositionKey: 'device.roundtrip.' + String(sequence),
      qualifiedPropositionKey: sha256DigestOf('qualified-roundtrip-' + String(sequence)),
      predicate: 'device.exact_cost',
      domainStatus: 'known',
      value: '包含中文、"quoted" 和 123456789012345678.123456789012345678 / ' + String(sequence),
      satisfiedBy: [{ groupId: 'group-' + String(sequence), alternativeIds: ['alternative-' + String(sequence)] }],
      ruleRefs: [ruleRef],
      factRefs: [{ assertionId: 'slice-fact-' + String(sequence), logicalAssertionId: 'slice-logical-fact-' + String(sequence), recordedSeq: String(sequence), digest: DIGEST }],
      supportNodeId: 'support-' + String(sequence),
      ...(sequence === 1 ? {} : { ruleArtifacts: sequence === 2 ? [] : [
        ...(sequence === 3 && variant === 0 ? [artifactOf(30, sharedBase, false)] : []),
        artifactOf(sequence * 2 + variant, sequence === 4 && variant === 1 ? separateBase : sharedBase),
      ] }),
    })
    const slices: ProjectionSlice[] = Array.from({ length: 16 }, (_, index) => {
      const sequence = Math.floor(index / 2) + 1
      const variant = index % 2
      const conclusion = conclusionOf(sequence, variant)
      const propositionKey = 'device.roundtrip.' + String(sequence) + '.' + String(variant)
      return {
        scopeRef: owner.scopeRef,
        generation: '0',
        propositionKey,
        qualifiedPropositionKey: sha256DigestOf('qualified-roundtrip-' + String(sequence) + '-' + String(variant)),
        predicate: 'device.exact_cost',
        domainStatus: 'known',
        ...(conclusion.value === undefined ? {} : { value: conclusion.value }),
        validity: { validFrom: new Date('2026-09-21T' + String(sequence).padStart(2, '0') + ':' + (variant === 0 ? '00' : '30') + ':00Z').toISOString(), validTo: new Date('2026-09-22T00:00:00Z').toISOString() },
        recordedSeq: String(sequence),
        conclusion: { ...conclusion, propositionKey, qualifiedPropositionKey: sha256DigestOf('qualified-roundtrip-' + String(sequence) + '-' + String(variant)) },
      }
    })
    const expectedSlices = slices.map((slice) => ({ ...slice, generation: '1' }))
    const commitInput = {
      fenceId: fences[0]!.fenceId,
      additionalFenceIds: fences.slice(1).map((fence) => fence.fenceId),
      expectedGeneration: '0' as const,
      recordedSeq: '8',
      watermark: { kind: 'sequence' as const, value: '8' },
      slices,
      committedAt: new Date().toISOString(),
    }
    const committed = await store.commitProjection(owner.scopeRef, commitInput, ownerCtx)

    expect(committed).toMatchObject({ state: { generation: '1', watermark: { kind: 'sequence', value: '8' } }, appendedSlices: 16 })
    expect(await store.readSlices(owner.scopeRef, {}, ownerCtx)).toEqual(expectedSlices)
    expect(await store.listOpenFences(owner.scopeRef, ownerCtx)).toEqual([])

    await expect(store.commitProjection(owner.scopeRef, commitInput, ownerCtx)).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' })
    expect(await store.getProjectionState(owner.scopeRef, ownerCtx)).toEqual(committed.state)
    expect(await store.readSlices(owner.scopeRef, {}, ownerCtx)).toEqual(expectedSlices)
  })

  it('sets the fence first, refuses a stale read during the in-flight recompute and advances asynchronously', async () => {
    const seedPublication = randomUUID()
    const battery = statementFor(seedPublication)
    const rule = ruleVersionFor(seedPublication)
    await publishBundle([battery], [rule], 'materialization-seed')

    const materialization = new PostgresMaterializationStore(database)
    const source = new PublishedSemanticSource(publication, { identity })
    let faultEnabled = false
    const materializer = new IncrementalMaterializer({
      publishedSource: source,
      materialization,
      faultInjection: {
        beforeCommit: () => {
          if (faultEnabled) throw new Error('injected materialisation fault')
        },
      },
    })

    const initialChange: MaterializationChange = {
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq: '1',
      recordedAt: '2026-09-21T06:00:00Z',
      kind: 'assertion_published',
      logicalAssertionId: battery.statementId,
      predicate: PREDICATE,
      validity: VALIDITY,
    }
    await materializer.applyChange(initialChange, ctx)

    const readRequest = {
      scopeRef: scope.scopeRef,
      projectionRef: { id: 'projection.materialized', version: '1.0.0', digest: DIGEST },
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }
    const baseline = await materializer.read({ ...readRequest, asOfRecordedSeq: '1' }, ctx)
    expect(baseline.status).toBe('materialized')
    expect(baseline.conclusions[0]?.value).toBe(true)

    // Publish sets the fence before the worker recomputes.
    const retractChange: MaterializationChange = {
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq: '2',
      recordedAt: '2026-09-21T07:00:00Z',
      kind: 'assertion_retracted',
      logicalAssertionId: battery.statementId,
      predicate: PREDICATE,
      validity: VALIDITY,
    }
    const ticket = await materializer.beginChange(retractChange, ctx)
    expect(ticket.affectedRuleIds).toHaveLength(3)
    expect(ticket.affectedRuleIds.filter((id) => id.endsWith(':dependency-consequence'))).toHaveLength(1)
    expect(ticket.affectedRuleIds.every((ruleId) => ruleId.startsWith('rule-instance:'))).toBe(true)

    // The semantic change commits, then the change is handed to the worker through the real outbox.
    await publication.reviseStatement(
      scope.scopeRef,
      {
        expectedRevision: '1',
        revisionId: randomUUID(),
        statementId: battery.statementId,
        kind: 'retraction',
        reason: 'the only supporting source was withdrawn',
        recordedAt: '2026-09-21T07:00:00Z',
        actor: ctx.principal.subjectId,
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.statement.retracted',
          payload: { statementId: battery.statementId },
          idempotencyKey: `retract-${battery.statementId}`,
          availableAt: '2026-09-21T07:00:00Z',
          createdAt: '2026-09-21T07:00:00Z',
        },
      },
      ctx,
    )

    const tickets = new Map<string, MaterializationTicket>([[retractChange.changeId, ticket]])
    const consumer: OutboxConsumer = {
      async consume(message: OutboxMessageRecord, consumerCtx: ToolContext): Promise<void> {
        if (message.topic !== 'semantic.materialization.requested') return
        const changeId = message.payload['changeId']
        if (typeof changeId !== 'string') return
        const pending = tickets.get(changeId)
        if (pending === undefined) return
        await materializer.advance(pending, consumerCtx)
      },
    }
    await publishBundle([], [], 'materialization-request', {
      outboxId: randomUUID(),
      topic: 'semantic.materialization.requested',
      payload: { changeId: retractChange.changeId },
      idempotencyKey: `materialization-request:${retractChange.changeId}`,
      availableAt: '2026-09-21T07:00:00Z',
      createdAt: '2026-09-21T07:00:00Z',
    })
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer })

    // A read while the fence is open must not return the stale "known true" conclusion.
    const fenced = await materializer.read(readRequest, ctx)
    expect(fenced.status).toBe('fenced')
    expect(fenced.blockedPropositionKeys.length).toBeGreaterThan(0)
    expect(fenced.conclusions).toHaveLength(0)

    // A fault during the asynchronous advance leaves the fence open: still no stale read.
    faultEnabled = true
    await expect(dispatcher.dispatchOnce(scope.scopeRef, ctx)).rejects.toThrow('injected materialisation fault')
    const stillFenced = await materializer.read(readRequest, ctx)
    expect(stillFenced.status).toBe('fenced')
    expect(stillFenced.conclusions).toHaveLength(0)

    // The retry drains the outbox, advances the projection and closes the fence.
    faultEnabled = false
    await dispatcher.dispatchOnce(scope.scopeRef, ctx)
    const advanced = await materializer.read(readRequest, ctx)
    expect(advanced.status).toBe('materialized')
    const conclusion = advanced.conclusions.find((entry) => entry.predicate === PREDICATE)
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()

    // History is preserved: the pre-retraction recorded version still resolves the old conclusion.
    const historical = await materializer.read({ ...readRequest, asOfRecordedSeq: '1' }, ctx)
    expect(historical.conclusions[0]?.value).toBe(true)

    // The fence is closed and the projection generation advanced.
    const state = await materialization.getProjectionState(scope.scopeRef, ctx)
    expect(state?.dirty).toBe(false)
    expect(Number(state?.generation)).toBeGreaterThanOrEqual(2)
    expect(await materialization.listOpenFences(scope.scopeRef, ctx)).toHaveLength(0)
  })
})
