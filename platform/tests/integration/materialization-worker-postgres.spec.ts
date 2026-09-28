import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { OutboxDispatcher } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { createPostgresJobWorker } from '@ontology/app-worker'
import { PublishedSemanticSource, sha256DigestOf } from '@ontology/semantic-engine'
import type {
  NewOutboxMessage,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { FixturePublishedIdentityReader } from './published-identity-reader'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const PREDICATE = 'device.battery_present'
const PROJECTION_REF = { id: 'projection.materialized', version: '1.0.0', digest: DIGEST }
const PUBLISHED_AT = '2026-09-21T06:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase

const now = (): string => new Date().toISOString()

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
    recordedAt: PUBLISHED_AT,
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
    recordedAt: PUBLISHED_AT,
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

function attributeStatementFor(
  publicationId: Uuid,
  subjectEntityId: string,
  attributes: readonly { readonly attributeId: string; readonly value: unknown }[],
): PublishedStatement {
  return {
    statementId: randomUUID(),
    propositionKey: `${subjectEntityId}.attributes`,
    kind: 'entity',
    objectId: 'device',
    subjectEntityId,
    predicate: 'device',
    value: { attributes },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: PUBLISHED_AT,
    sourceCandidateId: randomUUID(),
    sourceRefs: sourceRefs(),
    publicationId,
    version: '1',
    status: 'active',
  }
}

interface Setup {
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly jobId: Uuid
  readonly publication: PostgresSemanticPublicationStore
  readonly identity: FixturePublishedIdentityReader
  readonly composition: ReturnType<typeof createPostgresJobWorker>
}

async function setup(prefix: string): Promise<Setup> {
  const scope = await createJobScope(harness.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  const publication = new PostgresSemanticPublicationStore(database)
  const identity = new FixturePublishedIdentityReader()
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    now,
    newId: () => randomUUID(),
  })
  const jobId = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', $4, $5, '1.0.0', 'published',
       $6, $7, 1, '{}'::jsonb, now(), now(), $8, now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      `${prefix}-source`,
      randomUUID(),
      `${prefix}-${jobId.slice(0, 8)}`,
      sha256DigestOf({ jobId }),
      prefix,
    ],
  )
  const composition = createPostgresJobWorker({
    connectionString: harness.appUrl,
    handlers: { get: () => undefined },
    budget,
    outboxConsumer: { consume: async () => undefined },
    materialization: { publications: publication, identity },
    now,
    newId: () => randomUUID(),
    maxPoolSize: 2,
  })
  return { scopeRef: scope.scopeRef, ctx, jobId, publication, identity, composition }
}

async function publishBundle(
  setupValue: Setup,
  statements: readonly PublishedStatement[],
  ruleVersions: readonly PublishedRuleVersion[],
  key: string,
  outboxTopic: string,
): Promise<Uuid> {
  const publicationId = randomUUID()
  const expectedRevision = await setupValue.publication.latestPublicationRevision(
    setupValue.scopeRef,
    setupValue.ctx,
  )
  const message: NewOutboxMessage = {
    outboxId: randomUUID(),
    topic: outboxTopic,
    payload: { publicationId },
    idempotencyKey: `${key}:outbox`,
    availableAt: PUBLISHED_AT,
    createdAt: PUBLISHED_AT,
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
      publishedAt: PUBLISHED_AT,
      actor: setupValue.ctx.principal.subjectId,
    },
    idempotencyKey: key,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: message,
    outboxJobId: setupValue.jobId,
  }
  setupValue.identity.bindStatements(statements)
  await setupValue.publication.publish(setupValue.scopeRef, input, setupValue.ctx)
  return publicationId
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('IncrementalMaterializer wired into the worker against real PostgreSQL and the real outbox', () => {
  it('publishes, opens the fence, advances asynchronously and serves the new conclusion', async () => {
    const s = await setup('materialization-worker')
    const materializer = s.composition.materializer
    expect(materializer).toBeDefined()
    if (materializer === undefined) throw new Error('the worker composition did not build the materializer')

    const seedPublication = randomUUID()
    const battery = statementFor(seedPublication)
    const rule = ruleVersionFor(seedPublication)
    await publishBundle(s, [battery], [rule], 'materialization-seed', 'semantic.publication.published')

    const readRequest = {
      scopeRef: s.scopeRef,
      projectionRef: PROJECTION_REF,
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }

    // Dispatch the publication event: the fence opens and the advance request is enqueued.
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const fenced = await materializer.read(readRequest, s.ctx)
    expect(fenced.status).toBe('fenced')
    expect(fenced.conclusions).toHaveLength(0)

    // Dispatch the request: the worker advances the projection.
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const materialized = await materializer.read(readRequest, s.ctx)
    expect(materialized.status).toBe('materialized')
    expect(materialized.conclusions.find((entry) => entry.predicate === PREDICATE)?.value).toBe(true)

    // A retraction opens the fence again; a read during the in-flight recompute is not stale.
    await s.publication.reviseStatement(
      s.scopeRef,
      {
        expectedRevision: '1',
        revisionId: randomUUID(),
        statementId: battery.statementId,
        kind: 'retraction',
        reason: 'the only supporting source was withdrawn',
        recordedAt: '2026-09-21T07:00:00Z',
        actor: s.ctx.principal.subjectId,
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.statement.retracted',
          payload: {
            statementId: battery.statementId,
            propositionKey: PREDICATE,
            kind: 'retraction',
            revisionId: randomUUID(),
          },
          idempotencyKey: `retract-${battery.statementId}`,
          availableAt: '2026-09-21T07:00:00Z',
          createdAt: '2026-09-21T07:00:00Z',
        },
      },
      s.ctx,
    )
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const retractRequest = { ...readRequest, asOfRecordedSeq: '3' }
    const retractFenced = await materializer.read(retractRequest, s.ctx)
    expect(retractFenced.status).toBe('fenced')
    expect(retractFenced.conclusions).toHaveLength(0)

    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const retracted = await materializer.read(retractRequest, s.ctx)
    const conclusion = retracted.conclusions.find((entry) => entry.predicate === PREDICATE)
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()

    // History is preserved: the pre-retraction recorded version still resolves the old value.
    const historical = await materializer.read({ ...readRequest, asOfRecordedSeq: '2' }, s.ctx)
    expect(historical.conclusions.find((entry) => entry.predicate === PREDICATE)?.value).toBe(true)

    await s.composition.close()
  })

  it('projects 1001 attributes, preserves OR support after a parent retract, and applies an exception without business false', async () => {
    const s = await setup('materialization-attribute-retract')
    const materializer = s.composition.materializer
    if (materializer === undefined) throw new Error('the worker composition did not build the materializer')
    try {
      const seedPublication = randomUUID()
      const subjectEntityId = 'entity.device-attribute-scale'
      const auxiliary = Array.from({ length: 1_001 }, (_, index) => ({
        attributeId: `auxiliary_${String(index).padStart(4, '0')}`,
        value: `value-${String(index)}`,
      }))
      const large = attributeStatementFor(seedPublication, subjectEntityId, [
        { attributeId: 'in_service', value: true },
        ...auxiliary,
      ])
      const alternate = attributeStatementFor(seedPublication, subjectEntityId, [
        { attributeId: 'in_service', value: true },
        { attributeId: 'retired', value: false },
      ])
      const rule: PublishedRuleVersion = {
        ruleVersionId: randomUUID(),
        ruleId: 'rule.device.maintenance',
        version: '1',
        objectId: 'device',
        severity: 'soft',
        impact: 'low',
        expression: { op: 'compare', attributeId: 'in_service', operator: 'eq', value: true, spans: [] },
        exceptions: [{
          exceptionId: 'already-retired',
          condition: { op: 'compare', attributeId: 'retired', operator: 'eq', value: true, spans: [] },
          spans: [],
        }],
        conclusion: { predicate: 'device.needs_maintenance', value: true },
        recordedAt: PUBLISHED_AT,
        sourceCandidateId: randomUUID(),
        publicationId: seedPublication,
      }
      await publishBundle(s, [large, alternate], [rule], 'attribute-retract-seed', 'semantic.publication.published')
      const publishedSnapshot = await new PublishedSemanticSource(s.publication, { identity: s.identity }).load(s.scopeRef, s.ctx)
      expect(publishedSnapshot.complete).toBe(true)
      expect(publishedSnapshot.facts.filter((fact) => fact.sourceStatementId === large.statementId)).toHaveLength(1_002)
      expect(publishedSnapshot.entityBindings.some((binding) =>
        binding.entityId === subjectEntityId && binding.sourceStatementId === large.statementId && binding.predicate === 'auxiliary_1000',
      )).toBe(true)
      while (await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx) > 0) { /* drain publication and advances */ }

      const request = {
        scopeRef: s.scopeRef,
        projectionRef: PROJECTION_REF,
        asOfRecordedSeq: '3',
        validAt: '2026-09-21T12:00:00Z',
      }
      const baseline = await materializer.read(request, s.ctx)
      const baselineConclusion = baseline.conclusions.find((entry) => entry.predicate === 'device.needs_maintenance')
      expect(baseline.status).toBe('materialized')
      expect(baselineConclusion?.value).toBe(true)
      expect(baselineConclusion?.satisfiedBy.find((entry) => entry.alternativeIds.length > 0)?.alternativeIds).toHaveLength(2)
      expect(baselineConclusion?.ruleArtifacts?.[0]?.applicability.exceptionStates[0]?.state).toBe('false')
      expect(baselineConclusion?.ruleArtifacts).toHaveLength(1)
      expect(baselineConclusion?.ruleArtifacts?.[0]?.subjectEntityId).toBe(subjectEntityId)

      await s.publication.reviseStatement(
        s.scopeRef,
        {
          expectedRevision: '1',
          revisionId: randomUUID(),
          statementId: large.statementId,
          kind: 'retraction',
          reason: 'remove the high-cardinality parent statement',
          recordedAt: '2026-09-21T07:00:00Z',
          actor: s.ctx.principal.subjectId,
          outbox: {
            outboxId: randomUUID(),
            topic: 'semantic.statement.retracted',
            payload: { statementId: large.statementId, revisionId: randomUUID(), kind: 'retraction' },
            idempotencyKey: `retract-large-${large.statementId}`,
            availableAt: '2026-09-21T07:00:00Z',
            createdAt: '2026-09-21T07:00:00Z',
          },
        },
        s.ctx,
      )
      await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
      const firstRetractionRequest = { ...request, asOfRecordedSeq: '4' }
      expect((await materializer.read(firstRetractionRequest, s.ctx)).status).toBe('fenced')
      await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
      const afterLargeRetraction = await materializer.read(firstRetractionRequest, s.ctx)
      const stillSupported = afterLargeRetraction.conclusions.find((entry) => entry.predicate === 'device.needs_maintenance')
      expect(stillSupported?.value).toBe(true)
      expect(stillSupported?.satisfiedBy.find((entry) => entry.alternativeIds.length > 0)?.alternativeIds).toHaveLength(1)
      expect(stillSupported?.ruleArtifacts?.[0]?.applicability.exceptionStates[0]?.state).toBe('false')
      expect(stillSupported?.ruleArtifacts).toHaveLength(1)

      await s.publication.reviseStatement(
        s.scopeRef,
        {
          expectedRevision: '1',
          revisionId: randomUUID(),
          statementId: alternate.statementId,
          kind: 'retraction',
          reason: 'remove the last OR support',
          recordedAt: '2026-09-21T08:00:00Z',
          actor: s.ctx.principal.subjectId,
          outbox: {
            outboxId: randomUUID(),
            topic: 'semantic.statement.retracted',
            payload: { statementId: alternate.statementId, revisionId: randomUUID(), kind: 'retraction' },
            idempotencyKey: `retract-alternate-${alternate.statementId}`,
            availableAt: '2026-09-21T08:00:00Z',
            createdAt: '2026-09-21T08:00:00Z',
          },
        },
        s.ctx,
      )
      await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
      await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
      const afterLastRetraction = await materializer.read({ ...request, asOfRecordedSeq: '5' }, s.ctx)
      const unsupported = afterLastRetraction.conclusions.find((entry) => entry.predicate === 'device.needs_maintenance')
      expect(unsupported?.domainStatus).toBe('unknown')
      expect(unsupported?.value).toBeUndefined()
      expect(unsupported?.value).not.toBe(false)
    } finally {
      await s.composition.close()
    }
  })

  it('does not double-advance a change when the outbox is re-delivered after a crash reclaim', async () => {
    const s = await setup('materialization-crash')
    const materializer = s.composition.materializer
    const consumer = s.composition.materializationConsumer
    if (materializer === undefined || consumer === undefined) {
      throw new Error('the worker composition did not build the materialization consumer')
    }

    const seedPublication = randomUUID()
    const battery = statementFor(seedPublication)
    const rule = ruleVersionFor(seedPublication)
    await publishBundle(s, [battery], [rule], 'crash-seed', 'semantic.publication.published')

    const readRequest = {
      scopeRef: s.scopeRef,
      projectionRef: PROJECTION_REF,
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    expect((await materializer.read(readRequest, s.ctx)).status).toBe('materialized')

    // A correction is one change: open the fence and enqueue a single advance request.
    await s.publication.reviseStatement(
      s.scopeRef,
      {
        expectedRevision: '1',
        revisionId: randomUUID(),
        statementId: battery.statementId,
        kind: 'correction',
        reason: 'the measured value was corrected',
        correctedValue: { value: false },
        recordedAt: '2026-09-21T08:00:00Z',
        actor: s.ctx.principal.subjectId,
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.statement.corrected',
          payload: {
            statementId: battery.statementId,
            propositionKey: PREDICATE,
            kind: 'correction',
            revisionId: randomUUID(),
          },
          idempotencyKey: `correct-${battery.statementId}`,
          availableAt: '2026-09-21T08:00:00Z',
          createdAt: '2026-09-21T08:00:00Z',
        },
      },
      s.ctx,
    )
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const correctionRequest = { ...readRequest, asOfRecordedSeq: '3' }
    const fenced = await materializer.read(correctionRequest, s.ctx)
    expect(fenced.status).toBe('fenced')

    // The advance commits, then the process "crashes" before the outbox mark, so the request is
    // re-delivered. The consumer must not advance the same change twice.
    const faultingStore = new FaultInjectingJobStore(database)
    const faultingDispatcher = new OutboxDispatcher({ store: faultingStore, consumer, now })
    faultingStore.failNextMark = true
    await expect(faultingDispatcher.dispatchOnce(s.scopeRef, s.ctx)).rejects.toThrow(
      'simulated crash before the outbox mark',
    )
    const afterCrash = await materializer.read(correctionRequest, s.ctx)
    const generationAfterCrash = afterCrash.generation

    faultingStore.failNextMark = false
    await faultingDispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const afterRetry = await materializer.read(correctionRequest, s.ctx)
    expect(afterRetry.generation).toBe(generationAfterCrash)

    await s.composition.close()
  })
})

/** Fails the first outbox mark so the request stays pending and is re-delivered, like a crash. */
class FaultInjectingJobStore extends PostgresJobStore {
  failNextMark = false

  override async markOutboxDispatched(
    ...args: Parameters<PostgresJobStore['markOutboxDispatched']>
  ): ReturnType<PostgresJobStore['markOutboxDispatched']> {
    if (this.failNextMark) {
      this.failNextMark = false
      throw new Error('simulated crash before the outbox mark')
    }
    return super.markOutboxDispatched(...args)
  }
}
