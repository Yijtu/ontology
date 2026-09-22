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
  NewOutboxMessage,
  OutboxMessageRecord,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const PREDICATE = 'device.battery_present'

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let publication: PostgresSemanticPublicationStore
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
  await publication.publish(scope.scopeRef, input, ctx)
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'incremental-materialization')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  publication = new PostgresSemanticPublicationStore(database)
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
  it('sets the fence first, refuses a stale read during the in-flight recompute and advances asynchronously', async () => {
    const seedPublication = randomUUID()
    const battery = statementFor(seedPublication)
    const rule = ruleVersionFor(seedPublication)
    await publishBundle([battery], [rule], 'materialization-seed')

    const materialization = new PostgresMaterializationStore(database)
    const source = new PublishedSemanticSource(publication)
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
    expect(ticket.affectedRuleIds).toEqual(['rule.battery-present'])

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
    expect(fenced.blockedPropositionKeys).toContain(PREDICATE)
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
    const conclusion = advanced.conclusions.find((entry) => entry.propositionKey === PREDICATE)
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
