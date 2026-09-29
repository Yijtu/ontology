import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import {
  ControlPostgresDatabase,
  PostgresCandidateStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  InMemoryIndustrySchemaSource,
  JobService,
  OutboxDispatcher,
} from '@ontology/application'
import type { OutboxConsumer } from '@ontology/application'
import {
  IdentityDecisionService,
  SemanticPublicationService,
} from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  CandidateRecord,
  EntityCandidate,
  OutboxMessageRecord,
  RuleCandidate,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import {
  PUBLICATION_DEFINITION_REF,
  entityFor,
  publicationSchema,
  ruleFor,
} from '../unit/publication-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 120_000 })

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let candidateStore: PostgresCandidateStore
let identityStore: PostgresIdentityDecisionStore
let publicationStore: PostgresSemanticPublicationStore
let jobStore: PostgresJobStore
let identityService: IdentityDecisionService
let service: SemanticPublicationService
let app: ReturnType<typeof createApiServer>
let parseId: Uuid
let jobId: Uuid

function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles =
    typeof rolesValue === 'string' && rolesValue.length > 0
      ? rolesValue.split(',')
      : ['semantic-reviewer', 'semantic-publisher']
  return {
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'semantic-publisher',
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: scope.spaceId,
  }
}

function schemaSource(): InMemoryIndustrySchemaSource {
  return new InMemoryIndustrySchemaSource([
    { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
  ])
}

async function seedParse(admin: Client): Promise<Uuid> {
  const id = randomUUID()
  const digest = `sha256:${'a'.repeat(64)}`
  await admin.query(
    `INSERT INTO agent_platform.document_parse_runs (
       tenant_id, space_id, parse_id, original_blob_ref_id, original_content_digest,
       original_media_type, original_kind, media_kind, parser_id, parser_version, offset_unit,
       parse_status, completeness, coverage, normalized_blob_ref_id, normalized_content_digest,
       normalized_media_type, normalized_byte_size, span_map_blob_ref_id, span_map_content_digest,
       span_map_media_type)
     VALUES ($1,$2,$3,$4,$5,'text/plain','document','text','fixture-parser','1.0.0','character',
       'complete','complete','{}'::jsonb,$6,$5,'text/plain',0,$7,$5,'text/plain')`,
    [scope.tenantId, scope.spaceId, id, randomUUID(), digest, randomUUID(), randomUUID()],
  )
  return id
}

function candidateIdempotencyKey(): string {
  return `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`
}

function candidateFor(candidateId: string, attributes?: readonly { attributeId: string; value: string }[]): EntityCandidate {
  return entityFor({
    candidateId,
    idempotencyKey: candidateIdempotencyKey(),
    jobId,
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    ...(attributes === undefined ? {} : { attributes }),
  })
}

async function insert(candidate: CandidateRecord): Promise<void> {
  await candidateStore.insertCandidates(scope.scopeRef, [candidate], ctx)
}

async function createEntity(candidateId: string): Promise<string> {
  const view = await identityService.decide({ candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx)
  if (view.targetEntityId === undefined) throw new Error('create_pending returned no entity')
  return view.targetEntityId
}

async function matchEntity(candidateId: string, entityId: string, expectedRevision = '0'): Promise<void> {
  const candidate = await candidateStore.getCandidate(scope.scopeRef, candidateId, ctx)
  if (candidate?.kind !== 'entity') throw new Error(`expected entity candidate ${candidateId}`)
  const nativeId = candidate.attributes.find((attribute) => attribute.attributeId === 'device_native_id')?.value
  if (typeof nativeId !== 'string' || nativeId.length === 0) {
    throw new Error(`candidate ${candidateId} has no device_native_id`)
  }
  await identityService.decide(
    {
      candidateId,
      kind: 'match',
      expectedRevision,
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: nativeId },
    },
    ctx,
  )
}

/** A candidate with a resolved identity (create_pending then match), ready for review. */
async function seedResolvedEntity(attributes?: readonly { attributeId: string; value: string }[]): Promise<EntityCandidate> {
  const candidateId = randomUUID()
  const candidate = candidateFor(candidateId, attributes)
  await insert(candidate)
  const entityId = await createEntity(candidateId)
  await matchEntity(candidateId, entityId, '1')
  return candidate
}

async function reviewViaHttp(candidateId: string, decision: 'approve' | 'reject', reason: string) {
  const revision = await publicationStore.latestReviewRevision(scope.scopeRef, candidateId, ctx)
  return app.inject({
    method: 'POST',
    url: `/api/v1/candidates/${candidateId}/reviews`,
    headers: {
      'content-type': 'application/json',
      'x-test-roles': 'semantic-reviewer',
      'if-match': revision,
    },
    payload: { decision, reason },
  })
}

async function publishViaHttp(refs: readonly { readonly candidateId: string; readonly kind: string }[], key: string) {
  const revision = await publicationStore.latestPublicationRevision(scope.scopeRef, ctx)
  return app.inject({
    method: 'POST',
    url: '/api/v1/semantic-publications',
    headers: {
      'content-type': 'application/json',
      'x-test-roles': 'semantic-publisher',
      'if-match': revision,
      'idempotency-key': key,
    },
    payload: { approvedCandidateRefs: refs, schemaRef: PUBLICATION_DEFINITION_REF },
  })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  await runControlMigrations({ connectionString: harness.adminUrl, migrationsDir: MIGRATIONS_DIR })
  scope = await createJobScope(harness.adminClient, 'semantic-publication')
  ctx = toolContext(scope.tenantId, scope.spaceId, [
    'semantic-reviewer',
    'semantic-publisher',
    'platform-admin',
  ])

  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  candidateStore = new PostgresCandidateStore(database)
  identityStore = new PostgresIdentityDecisionStore(database)
  publicationStore = new PostgresSemanticPublicationStore(database)
  jobStore = new PostgresJobStore(database)
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  parseId = await seedParse(harness.adminClient)
  jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'semantic-publication-source',
      documentRef: parseId,
      pipelineVersion: '1.0.0',
      idempotencyKey: `semantic-publication-${jobId.slice(0, 8)}`,
    },
    ctx,
  )

  identityService = new IdentityDecisionService({
    store: identityStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  service = new SemanticPublicationService({
    store: publicationStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    identity: identityStore,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  app = createApiServer({ authenticate: authenticator, publications: { service } })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

async function countFor(sql: string, params: readonly unknown[]): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(sql, [...params])
  return Number(result.rows[0]?.count ?? '0')
}

describe('semantic publication against real PostgreSQL', () => {
  it('publishes approved candidates atomically and reads the decision and publication back', async () => {
    const candidate = await seedResolvedEntity()
    const reviewed = await reviewViaHttp(candidate.candidateId, 'approve', 'source verified')
    expect(reviewed.statusCode).toBe(200)

    const published = await publishViaHttp(
      [{ candidateId: candidate.candidateId, kind: 'entity' }],
      'pub-readback',
    )
    expect(published.statusCode).toBe(201)
    const publication = published.json() as {
      data: { publicationId: string; statements: { statementId: string }[]; ruleVersions: unknown[] }
    }
    expect(publication.data.statements).toHaveLength(1)
    expect(publication.data.statements[0]?.statementId).toBe(candidate.candidateId)

    const readBack = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${candidate.candidateId}/reviews`,
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(readBack.statusCode).toBe(200)
    const reviews = readBack.json() as { data: { reviews: { decision: string; reason: string }[] } }
    expect(reviews.data.reviews[0]).toMatchObject({ decision: 'approve', reason: 'source verified' })

    const publicationRead = await app.inject({
      method: 'GET',
      url: `/api/v1/semantic-publications/${publication.data.publicationId}`,
      headers: { 'x-test-roles': 'semantic-publisher' },
    })
    expect(publicationRead.statusCode).toBe(200)

    const statementRead = await app.inject({
      method: 'GET',
      url: `/api/v1/statements/${candidate.candidateId}`,
      headers: { 'x-test-roles': 'semantic-publisher' },
    })
    expect(statementRead.statusCode).toBe(200)
    expect((statementRead.json() as { data: { status: string } }).data.status).toBe('active')
  })

  it('requires If-Match and rejects a stale publication head with 428/409', async () => {
    const candidate = await seedResolvedEntity()
    await reviewViaHttp(candidate.candidateId, 'approve', 'ok')

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/semantic-publications',
      headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-publisher', 'idempotency-key': 'pub-missing-ifmatch' },
      payload: { approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: 'entity' }], schemaRef: PUBLICATION_DEFINITION_REF },
    })
    expect(missing.statusCode).toBe(428)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED')

    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/semantic-publications',
      headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-publisher', 'idempotency-key': 'pub-stale-head', 'if-match': '999' },
      payload: { approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: 'entity' }], schemaRef: PUBLICATION_DEFINITION_REF },
    })
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')
  })

  it('keeps the candidate and published read views separate and returns a specific reason for an unapproved item', async () => {
    const approved = await seedResolvedEntity()
    await reviewViaHttp(approved.candidateId, 'approve', 'ok')
    const unapprovedCandidate = await seedResolvedEntity()

    const published = await publishViaHttp([{ candidateId: approved.candidateId, kind: 'entity' }], 'pub-separation')
    expect(published.statusCode).toBe(201)

    const publishedCount = await countFor(
      `SELECT count(*)::text AS count FROM agent_platform.published_statements WHERE tenant_id = $1 AND space_id = $2`,
      [scope.tenantId, scope.spaceId],
    )
    const unapprovedInView = await countFor(
      `SELECT count(*)::text AS count FROM agent_platform.published_statements
        WHERE tenant_id = $1 AND space_id = $2 AND statement_id = $3`,
      [scope.tenantId, scope.spaceId, unapprovedCandidate.candidateId],
    )
    expect(unapprovedInView).toBe(0)
    // The candidate itself is still present: the two views are genuinely separate tables.
    expect(await candidateStore.getCandidate(scope.scopeRef, unapprovedCandidate.candidateId, ctx)).toBeDefined()

    const refused = await publishViaHttp([{ candidateId: unapprovedCandidate.candidateId, kind: 'entity' }], 'pub-unapproved')
    expect(refused.statusCode).toBe(422)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('CANDIDATE_NOT_APPROVED')
    expect(publishedCount).toBeGreaterThanOrEqual(1)
  })

  it('rolls the whole transaction back on a crash before commit and never duplicates on retry', async () => {
    const candidate = await seedResolvedEntity()
    await reviewViaHttp(candidate.candidateId, 'approve', 'ok')
    const head = await publicationStore.latestPublicationRevision(scope.scopeRef, ctx)
    const outboxBefore = await countFor(
      `SELECT count(*)::text AS count FROM agent_platform.job_outbox WHERE tenant_id = $1 AND space_id = $2`,
      [scope.tenantId, scope.spaceId],
    )

    const faultingStore = new PostgresSemanticPublicationStore(database, {
      faultInjection: {
        beforeCommit: () => {
          throw new Error('injected crash before commit')
        },
      },
    })
    const faultingService = new SemanticPublicationService({
      store: faultingStore,
      candidates: candidateStore,
      schemaSource: schemaSource(),
      identity: identityStore,
      now: () => '2026-09-22T00:00:00Z',
      newId: () => randomUUID(),
    })

    await expect(
      faultingService.publish(
        {
          approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: 'entity' }],
          schemaRef: PUBLICATION_DEFINITION_REF,
          expectedRevision: head,
          idempotencyKey: 'pub-atomicity',
        },
        ctx,
      ),
    ).rejects.toThrow('injected crash before commit')

    // Nothing from the aborted transaction committed: no publication, no fact, no outbox,
    // and the publication head did not advance.
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.semantic_publications WHERE tenant_id = $1 AND space_id = $2 AND idempotency_key = $3`,
        [scope.tenantId, scope.spaceId, 'pub-atomicity'],
      ),
    ).toBe(0)
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.published_statements
          WHERE tenant_id = $1 AND space_id = $2 AND source_candidate_id = $3`,
        [scope.tenantId, scope.spaceId, candidate.candidateId],
      ),
    ).toBe(0)
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.job_outbox WHERE tenant_id = $1 AND space_id = $2`,
        [scope.tenantId, scope.spaceId],
      ),
    ).toBe(outboxBefore)
    expect(await publicationStore.latestPublicationRevision(scope.scopeRef, ctx)).toBe(head)

    // A retry with the same key now succeeds and commits exactly once.
    const retried = await service.publish(
      {
        approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: 'entity' }],
        schemaRef: PUBLICATION_DEFINITION_REF,
        expectedRevision: head,
        idempotencyKey: 'pub-atomicity',
      },
      ctx,
    )
    const replay = await service.publish(
      {
        approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: 'entity' }],
        schemaRef: PUBLICATION_DEFINITION_REF,
        expectedRevision: head,
        idempotencyKey: 'pub-atomicity',
      },
      ctx,
    )
    expect(replay.publicationId).toBe(retried.publicationId)
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.semantic_publications
          WHERE tenant_id = $1 AND space_id = $2 AND idempotency_key = $3`,
        [scope.tenantId, scope.spaceId, 'pub-atomicity'],
      ),
    ).toBe(1)
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.published_statements
          WHERE tenant_id = $1 AND space_id = $2 AND source_candidate_id = $3`,
        [scope.tenantId, scope.spaceId, candidate.candidateId],
      ),
    ).toBe(1)
    expect(
      await countFor(
        `SELECT count(*)::text AS count FROM agent_platform.job_outbox
          WHERE tenant_id = $1 AND space_id = $2 AND topic = 'semantic.publication.published'
            AND payload->>'publicationId' = $3`,
        [scope.tenantId, scope.spaceId, retried.publicationId],
      ),
    ).toBe(1)
  })

  it('returns a specific reason for a bad source and a conflicted rule', async () => {
    const badSource = candidateFor(randomUUID())
    await insert({ ...badSource, sourceSpans: [] })
    await reviewViaHttp(badSource.candidateId, 'approve', 'ok')
    const badResult = await publishViaHttp([{ candidateId: badSource.candidateId, kind: 'entity' }], 'pub-bad-source')
    expect(badResult.statusCode).toBe(422)
    expect((badResult.json() as { error: { code: string } }).error.code).toBe('MISSING_SOURCE')

    const conflictedId = randomUUID()
    const conflicted: RuleCandidate = ruleFor({
      candidateId: conflictedId,
      idempotencyKey: candidateIdempotencyKey(),
      jobId,
      inputVersion: {
        definitionRef: PUBLICATION_DEFINITION_REF,
        parseId,
        parserVersion: '1.0.0',
        pipelineVersion: '1.0.0',
      },
      conflicts: [
        { withRuleId: 'other', withCandidateId: randomUUID(), attributeId: 'device_name', reason: 'contradiction' },
      ],
    })
    await insert(conflicted)
    await reviewViaHttp(conflictedId, 'approve', 'ok')
    const conflictResult = await publishViaHttp([{ candidateId: conflictedId, kind: 'rule' }], 'pub-conflict')
    expect(conflictResult.statusCode).toBe(409)
    expect((conflictResult.json() as { error: { code: string } }).error.code).toBe('CANDIDATE_CONFLICTED')
  })

  it('blocks a publication whose identity constraint check fails', async () => {
    const candidateId = randomUUID()
    const candidate = candidateFor(candidateId)
    await insert(candidate)
    const entityId = await createEntity(candidateId)
    await matchEntity(candidateId, entityId, '1')
    // A merged candidate cannot be cannot-linked through the service. Keep that invariant
    // explicit, then inject a stale legacy constraint to exercise the publication store's
    // defensive check for inconsistent historical/race state.
    await expect(identityService.decide(
      { candidateId, kind: 'reject', expectedRevision: '2', targetEntityId: entityId, justification: 'not the same device' },
      ctx,
    )).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    await harness.adminClient.query(
      `INSERT INTO agent_platform.identity_link_constraints (
         tenant_id, space_id, constraint_id, candidate_id, entity_id, kind, decision_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, 'cannot_link', $6, $7::timestamptz)`,
      [scope.tenantId, scope.spaceId, randomUUID(), candidateId, entityId, randomUUID(), '2026-09-22T00:00:01Z'],
    )
    await reviewViaHttp(candidateId, 'approve', 'ok')

    const blocked = await publishViaHttp([{ candidateId, kind: 'entity' }], 'pub-cannot-link')
    expect(blocked.statusCode).toBe(409)
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('IDENTITY_CONSTRAINT_BLOCKED')
  })

  it('preserves history on a retraction, keeps a supported conclusion and emits the invalidation through the real outbox', async () => {
    const attributes = [
      { attributeId: 'device_native_id', value: 'DEV-SHARED' },
      { attributeId: 'device_name', value: 'Charger One' },
      { attributeId: 'site', value: 'site-a' },
    ]
    const first = await seedResolvedEntity(attributes)
    const secondCandidateId = randomUUID()
    await insert(candidateFor(secondCandidateId, attributes))
    const entityId = await identityStore.listAssertions(scope.scopeRef, { candidateId: first.candidateId, openOnly: true }, ctx).then((rows) => rows[0]?.entityId)
    if (entityId === undefined) throw new Error('the first candidate has no open assertion')
    await matchEntity(secondCandidateId, entityId)
    await reviewViaHttp(first.candidateId, 'approve', 'ok')
    await reviewViaHttp(secondCandidateId, 'approve', 'ok')

    const published = await publishViaHttp(
      [
        { candidateId: first.candidateId, kind: 'entity' },
        { candidateId: secondCandidateId, kind: 'entity' },
      ],
      'pub-multi-evidence',
    )
    expect(published.statusCode).toBe(201)
    const statement = await service.getStatement(first.candidateId, ctx)
    const propositionKey = statement.propositionKey

    const retracted = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${first.candidateId}/revisions`,
      headers: {
        'content-type': 'application/json',
        'x-test-roles': 'semantic-publisher',
        'idempotency-key': 'rev-retract-first',
        'if-match': '1',
      },
      payload: { kind: 'retraction', reason: 'the source was withdrawn' },
    })
    expect(retracted.statusCode).toBe(200)
    expect((retracted.json() as { data: { version: string } }).data.version).toBe('2')

    // History is preserved and the earlier version is still readable.
    const revisions = await app.inject({
      method: 'GET',
      url: `/api/v1/statements/${first.candidateId}/revisions`,
      headers: { 'x-test-roles': 'semantic-publisher' },
    })
    expect(revisions.statusCode).toBe(200)
    expect((revisions.json() as { data: { revisions: unknown[] } }).data.revisions).toHaveLength(1)

    // The conclusion is still supported by the second statement.
    const supported = await app.inject({
      method: 'GET',
      url: `/api/v1/propositions/${propositionKey}`,
      headers: { 'x-test-roles': 'semantic-publisher' },
    })
    expect(supported.statusCode).toBe(200)
    const supportedView = supported.json() as {
      data: { status: string; activeStatements: { statementId: string }[] }
    }
    expect(supportedView.data.status).toBe('supported')
    expect(supportedView.data.activeStatements.map((entry) => entry.statementId)).toEqual([secondCandidateId])

    const consumed: OutboxMessageRecord[] = []
    const consumer: OutboxConsumer = {
      async consume(message: OutboxMessageRecord): Promise<void> {
        consumed.push(message)
      },
    }
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer, now: () => '2026-09-22T00:00:01Z' })
    const delivered = await dispatcher.dispatchOnce(scope.scopeRef, ctx)
    expect(delivered).toBeGreaterThanOrEqual(1)
    expect(consumed.some((message) => message.topic === 'semantic.statement.retracted')).toBe(true)

    // Retracting the last supporting statement withdraws the conclusion.
    const secondRetraction = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${secondCandidateId}/revisions`,
      headers: {
        'content-type': 'application/json',
        'x-test-roles': 'semantic-publisher',
        'idempotency-key': 'rev-retract-second',
        'if-match': '1',
      },
      payload: { kind: 'retraction', reason: 'the last source was withdrawn' },
    })
    expect(secondRetraction.statusCode).toBe(200)
    expect((await service.getPropositionView(propositionKey, ctx)).status).toBe('withdrawn')
  })
})
