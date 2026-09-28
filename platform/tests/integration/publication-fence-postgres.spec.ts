import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresJobStore,
  PostgresMaterializationStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { InMemoryCandidateStore, InMemoryIndustrySchemaSource, OutboxDispatcher } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { createPostgresJobWorker } from '@ontology/app-worker'
import {
  InMemoryIdentityDecisionStore,
  SemanticPublicationService,
  sha256DigestOf,
} from '@ontology/semantic-engine'
import type {
  NewOutboxMessage,
  PublishedStatement,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import {
  PUBLICATION_DEFINITION_REF,
  PUBLICATION_JOB_ID,
  publicationSchema,
  ruleFor,
} from '../unit/publication-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { FixturePublishedIdentityReader } from './published-identity-reader'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const FACT_PREDICATE = 'device.battery_present'
const NEW_PREDICATE = 'device.battery_absent'
const PROJECTION_REF = { id: 'projection.materialized', version: '1.0.0', digest: DIGEST }
const PUBLISHED_AT = '2026-09-21T06:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase

const now = (): string => new Date().toISOString()

function digestKey(): string {
  return sha256DigestOf({ key: randomUUID() })
}

interface Setup {
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly publication: PostgresSemanticPublicationStore
  readonly identity: FixturePublishedIdentityReader
  readonly composition: ReturnType<typeof createPostgresJobWorker>
  readonly candidates: InMemoryCandidateStore
  readonly service: SemanticPublicationService
}

async function setup(prefix: string): Promise<Setup> {
  const scope = await createJobScope(harness.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, [
    'semantic-reviewer',
    'semantic-publisher',
    'platform-admin',
  ])
  const publication = new PostgresSemanticPublicationStore(database)
  const identity = new FixturePublishedIdentityReader()
  const candidates = new InMemoryCandidateStore()
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    now,
    newId: () => randomUUID(),
  })
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', $4, $5, '1.0.0', 'published',
       $6, $7, 1, '{}'::jsonb, now(), now(), $8, now())`,
    [
      scope.tenantId,
      scope.spaceId,
      PUBLICATION_JOB_ID,
      `${prefix}-source`,
      randomUUID(),
      `${prefix}-${PUBLICATION_JOB_ID.slice(0, 8)}`,
      sha256DigestOf({ jobId: PUBLICATION_JOB_ID }),
      prefix,
    ],
  )
  const service = new SemanticPublicationService({
    store: publication,
    candidates,
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
    ]),
    identity: new InMemoryIdentityDecisionStore(),
    now,
    newId: () => randomUUID(),
  })
  const composition = createPostgresJobWorker({
    connectionString: harness.appUrl,
    handlers: { get: () => undefined },
    budget,
    outboxConsumer: { consume: async () => undefined },
    materialization: { publications: publication, identity },
    now,
    newId: () => randomUUID(),
    maxPoolSize: 4,
  })
  return { scopeRef: scope.scopeRef, ctx, publication, identity, composition, candidates, service }
}

/**
 * Commit a baseline fact directly through the store. Its outbox topic is not one the
 * materialisation consumer owns, so the router falls back to the injected no-op and the fact is
 * simply present for the rule published later through the real service.
 */
async function publishBaselineFact(s: Setup): Promise<void> {
  const publicationId = randomUUID()
  const statement: PublishedStatement = {
    statementId: randomUUID(),
    propositionKey: FACT_PREDICATE,
    kind: 'entity',
    objectId: 'device',
    subjectEntityId: 'entity.battery',
    predicate: 'device',
    value: { attributes: [{ attributeId: FACT_PREDICATE, value: true }] },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: PUBLISHED_AT,
    sourceCandidateId: randomUUID(),
    sourceRefs: [{ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
    publicationId,
    version: '1',
    status: 'active',
  }
  const message: NewOutboxMessage = {
    outboxId: randomUUID(),
    topic: 'test.baseline.setup',
    payload: { publicationId },
    idempotencyKey: `baseline:${publicationId}`,
    availableAt: PUBLISHED_AT,
    createdAt: PUBLISHED_AT,
  }
  const expectedRevision = await s.publication.latestPublicationRevision(s.scopeRef, s.ctx)
  s.identity.bindStatements([statement])
  await s.publication.publish(s.scopeRef, {
    expectedRevision,
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: PUBLICATION_DEFINITION_REF,
      approvedCandidateRefs: [],
      statements: [statement],
      ruleVersions: [],
      outboxId: message.outboxId,
      publishedAt: PUBLISHED_AT,
      actor: s.ctx.principal.subjectId,
    },
    idempotencyKey: `baseline-key:${publicationId}`,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: message,
    outboxJobId: PUBLICATION_JOB_ID,
  }, s.ctx)
}

/** Publish a rule through the real service, so the fence is opened in the publication transaction. */
async function publishRuleViaService(s: Setup): Promise<Uuid> {
  const candidateId = randomUUID()
  await s.candidates.insertCandidates(
    s.scopeRef,
    [
      ruleFor({
        candidateId,
        idempotencyKey: digestKey(),
        ruleId: 'rule.battery-absent',
        objectId: 'device',
        expression: {
          op: 'compare',
          attributeId: FACT_PREDICATE,
          operator: 'eq',
          value: true,
          spans: [],
        },
        conclusion: { predicate: NEW_PREDICATE, value: true },
      }),
    ],
    s.ctx,
  )
  await s.service.reviewCandidate(
    { candidateId, decision: 'approve', reason: 'source verified', expectedRevision: '0' },
    s.ctx,
  )
  const expectedRevision = await s.publication.latestPublicationRevision(s.scopeRef, s.ctx)
  await s.service.publish(
    {
      approvedCandidateRefs: [{ candidateId, kind: 'rule' }],
      schemaRef: PUBLICATION_DEFINITION_REF,
      expectedRevision,
      idempotencyKey: `pub-${candidateId}`,
    },
    s.ctx,
  )
  return candidateId
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('publication transaction opens the invalidation fence (LOCAL-070)', () => {
  it('fences an immediate read, advances to the new conclusion, and stays consistent after a crash reclaim', async () => {
    const s = await setup('publication-fence')
    const materializer = s.composition.materializer
    const consumer = s.composition.materializationConsumer
    if (materializer === undefined || consumer === undefined) {
      throw new Error('the worker composition did not build the materializer')
    }

    await publishBaselineFact(s)
    // Drain the baseline side effect; it is not a materialisation topic.
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)

    const readRequest = {
      scopeRef: s.scopeRef,
      projectionRef: PROJECTION_REF,
      asOfRecordedSeq: '1',
      validAt: '2026-09-21T12:00:00Z',
    }

    await publishRuleViaService(s)

    // Window eliminated: the publication transaction opened the fence, so before the worker has
    // consumed anything the read is fenced instead of returning the just-published rule's value.
    const immediatelyFenced = await materializer.read(readRequest, s.ctx)
    expect(immediatelyFenced.status).toBe('fenced')
    expect(immediatelyFenced.conclusions).toHaveLength(0)

    // The worker consumes the publication event: it must reuse the committed fence, not open a
    // second one, and only enqueue the asynchronous advance.
    await s.composition.dispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const stillFenced = await materializer.read(readRequest, s.ctx)
    expect(stillFenced.status).toBe('fenced')

    // A query issued concurrently with the advance is never stale: it is either fenced or sees the
    // new conclusion, never the pre-advance absence.
    const faultingStore = new FaultInjectingJobStore(database)
    const faultingDispatcher = new OutboxDispatcher({ store: faultingStore, consumer, now })
    faultingStore.failNextMark = true
    const readPromise = materializer.read(readRequest, s.ctx)
    const dispatchPromise = faultingDispatcher.dispatchOnce(s.scopeRef, s.ctx)
    // Attach the rejection handler in the same synchronous turn as the call so the
    // injected crash can never surface as an unhandled rejection while we await the
    // concurrent read (vitest fails the run on unhandled errors even when all tests pass).
    const dispatchOutcome = dispatchPromise.then(
      () => undefined,
      (error: unknown) => error,
    )
    const concurrent = await readPromise
    const dispatchError = await dispatchOutcome
    expect(dispatchError).toBeInstanceOf(Error)
    expect((dispatchError as Error).message).toBe('simulated crash before the outbox mark')
    expect(['fenced', 'materialized', 'on_demand']).toContain(concurrent.status)
    const concurrentConclusion = concurrent.conclusions.find((entry) => entry.predicate === NEW_PREDICATE)
    if (concurrentConclusion !== undefined) expect(concurrentConclusion.value).toBe(true)

    // The advance committed before the crash, so the new conclusion is served and the fence closed.
    const advanced = await materializer.read(readRequest, s.ctx)
    expect(advanced.status).toBe('materialized')
    expect(advanced.conclusions.find((entry) => entry.predicate === NEW_PREDICATE)?.value).toBe(true)
    const generationAfterCrash = advanced.generation

    // The request is re-delivered after the crash. The consumer must not advance the same change
    // twice, and the fence state must stay consistent.
    faultingStore.failNextMark = false
    await faultingDispatcher.dispatchOnce(s.scopeRef, s.ctx)
    const afterRetry = await materializer.read(readRequest, s.ctx)
    expect(afterRetry.generation).toBe(generationAfterCrash)
    expect(afterRetry.conclusions.find((entry) => entry.predicate === NEW_PREDICATE)?.value).toBe(true)
    const fenceStore = new PostgresMaterializationStore(database)
    expect(await fenceStore.listOpenFences(s.scopeRef, s.ctx)).toHaveLength(0)

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
