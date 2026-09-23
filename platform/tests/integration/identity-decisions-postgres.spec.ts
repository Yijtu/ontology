import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import {
  ControlPostgresDatabase,
  PostgresCandidateStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import { OutboxDispatcher } from '@ontology/application'
import type { OutboxConsumer } from '@ontology/application'
import { IdentityDecisionService } from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  EntityCandidate,
  IdentityDecisionDraft,
  IndustrySchema,
  OutboxMessageRecord,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { entityCandidate, IDENTITY_DEFINITION_REF } from '../unit/identity-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 120_000 })

/** A definition with a `device` and a `sensor` object whose display names can collide. */
function decisionSchema(ref: VersionRef): IndustrySchema {
  return {
    namespace: 'home-energy',
    definitionRef: ref,
    objects: [
      {
        objectId: 'device',
        displayName: 'Device',
        identityScopeId: 'device_identity',
        attributes: [
          { attributeId: 'device_native_id', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'device_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
        ],
      },
      {
        objectId: 'sensor',
        displayName: 'Sensor',
        identityScopeId: 'sensor_identity',
        attributes: [
          { attributeId: 'sensor_native_id', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'sensor_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
        ],
      },
    ],
    relations: [],
    identityScopes: [
      { identityScopeId: 'device_identity', objectId: 'device', scopeDimensions: ['site'], identityAttributeIds: ['device_native_id'] },
      { identityScopeId: 'sensor_identity', objectId: 'sensor', scopeDimensions: ['site'], identityAttributeIds: ['sensor_native_id'] },
    ],
  }
}

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let candidateStore: PostgresCandidateStore
let decisionStore: PostgresIdentityDecisionStore
let jobStore: PostgresJobStore
let service: IdentityDecisionService
let app: ReturnType<typeof createApiServer>
let parseId: Uuid
let jobId: Uuid
let device: EntityCandidate
let sensor: EntityCandidate

function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ['semantic-reviewer']
  return {
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'identity-reviewer',
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: scope.spaceId,
  }
}

function postDecision(candidateId: Uuid, body: Record<string, unknown>, ifMatch?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/candidates/${candidateId}/decision`,
    headers: {
      'content-type': 'application/json',
      'x-test-roles': 'semantic-reviewer',
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    payload: body,
  })
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

function candidateFor(objectId: string, identityScopeId: string, attributeId: string, value: string): EntityCandidate {
  return {
    ...entityCandidate({
      candidateId: randomUUID(),
      jobId,
      objectId,
      identityScopeId,
      attributes: [{ attributeId, value }],
      idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
      inputVersion: {
        definitionRef: IDENTITY_DEFINITION_REF,
        parseId,
        parserVersion: '1.0.0',
        pipelineVersion: '1.0.0',
      },
    }),
  }
}

async function seedCandidate(objectId: string, identityScopeId: string, attributeId: string, value = 'Shared Name'): Promise<EntityCandidate> {
  const candidate = candidateFor(objectId, identityScopeId, attributeId, value)
  await candidateStore.insertCandidates(scope.scopeRef, [candidate], ctx)
  return candidate
}

beforeAll(async () => {
  harness = await startJobDatabase()
  await runControlMigrations({ connectionString: harness.adminUrl, migrationsDir: MIGRATIONS_DIR })
  scope = await createJobScope(harness.adminClient, 'identity-decisions')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-reviewer', 'data-editor'])

  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  candidateStore = new PostgresCandidateStore(database)
  decisionStore = new PostgresIdentityDecisionStore(database)
  jobStore = new PostgresJobStore(database)
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  parseId = await seedParse(harness.adminClient)

  jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'identity-decisions-source',
      documentRef: parseId,
      pipelineVersion: '1.0.0',
      idempotencyKey: `identity-decisions-${jobId.slice(0, 8)}`,
    },
    ctx,
  )

  device = candidateFor('device', 'device_identity', 'device_name', 'Shared Name')
  sensor = candidateFor('sensor', 'sensor_identity', 'sensor_name', 'Shared Name')
  await candidateStore.insertCandidates(scope.scopeRef, [device, sensor], ctx)

  service = new IdentityDecisionService({
    store: decisionStore,
    candidates: candidateStore,
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: IDENTITY_DEFINITION_REF, schema: decisionSchema(IDENTITY_DEFINITION_REF) },
    ]),
    scoreThreshold: 0.8,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  app = createApiServer({ authenticate: authenticator, decisions: { service, candidates: candidateStore } })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('identity decisions against real PostgreSQL', () => {
  it('lists candidates and rejects a decision without If-Match with 428', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/candidates',
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(listed.statusCode).toBe(200)
    const body = listed.json() as { data: { candidates: { candidateId: string }[] } }
    expect(body.data.candidates.map((entry) => entry.candidateId)).toEqual(
      expect.arrayContaining([device.candidateId, sensor.candidateId]),
    )

    const missing = await postDecision(device.candidateId, { kind: 'create_pending' })
    expect(missing.statusCode).toBe(428)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED')
  })

  it('never merges on a model score alone and refuses a below-threshold score', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_name')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    expect(created.statusCode).toBe(200)
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId

    const scoreOnly = await postDecision(
      candidate.candidateId,
      {
        kind: 'match',
        targetEntityId: entityId,
        scoreEvidence: { score: 0.99, backendRef: { id: 'sim', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` } },
      },
      '1',
    )
    expect(scoreOnly.statusCode).toBe(422)
    expect((scoreOnly.json() as { error: { code: string } }).error.code).toBe('IDENTITY_EVIDENCE_REQUIRED')

    const lowScore = await postDecision(
      candidate.candidateId,
      {
        kind: 'match',
        targetEntityId: entityId,
        scoreEvidence: { score: 0.2, backendRef: { id: 'sim', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` } },
      },
      '1',
    )
    expect(lowScore.statusCode).toBe(422)
    expect((lowScore.json() as { error: { code: string } }).error.code).toBe('IDENTITY_SCORE_BELOW_THRESHOLD')
  })

  it('merges with a strong identity, keeps history and rejects a stale revision with 409', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_native_id', 'DEV-1')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId

    const matched = await postDecision(
      candidate.candidateId,
      { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } },
      '1',
    )
    expect(matched.statusCode).toBe(200)
    expect((matched.json() as { data: { revision: string } }).data.revision).toBe('2')

    const stale = await postDecision(candidate.candidateId, { kind: 'clarify' }, '1')
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')

    const rows = await harness.adminClient.query<{ kind: string }>(
      `SELECT kind FROM agent_platform.identity_decisions
        WHERE candidate_id = $1 ORDER BY revision`,
      [candidate.candidateId],
    )
    expect(rows.rows.map((row) => row.kind)).toEqual(['create_pending', 'match'])

    const revisionOne = await service.getDecision(candidate.candidateId, '1', ctx)
    expect(revisionOne.kind).toBe('create_pending')
  })

  it('never merges a device and a sensor that share a display name', async () => {
    const deviceCandidate = await seedCandidate('device', 'device_identity', 'device_name')
    const sensorCandidate = await seedCandidate('sensor', 'sensor_identity', 'sensor_name')
    const sensorCreated = await postDecision(sensorCandidate.candidateId, { kind: 'create_pending' }, '0')
    expect(sensorCreated.statusCode).toBe(200)
    const sensorEntityId = (sensorCreated.json() as { data: { targetEntityId: string } }).data.targetEntityId

    const deviceInto = await postDecision(
      deviceCandidate.candidateId,
      { kind: 'match', targetEntityId: sensorEntityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } },
      '0',
    )
    expect(deviceInto.statusCode).toBe(409)
    expect((deviceInto.json() as { error: { code: string } }).error.code).toBe('IDENTITY_SCOPE_MISMATCH')
  })

  it('blocks a merge with a cannot-link constraint recorded by a reject', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_name')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId

    const rejected = await postDecision(candidate.candidateId, { kind: 'reject', targetEntityId: entityId }, '1')
    expect(rejected.statusCode).toBe(200)

    const blocked = await postDecision(
      candidate.candidateId,
      { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } },
      '2',
    )
    expect(blocked.statusCode).toBe(409)
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('IDENTITY_CONFLICT')
  })

  it('does not persist a cannot-link while its membership is still active', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_native_id', 'DEV-1')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId
    const matched = await postDecision(candidate.candidateId, {
      kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' },
    }, '1')
    expect(matched.statusCode).toBe(200)

    const conflicting = await postDecision(candidate.candidateId, { kind: 'reject', targetEntityId: entityId }, '2')
    expect(conflicting.statusCode).toBe(409)
    expect((conflicting.json() as { error: { code: string } }).error.code).toBe('IDENTITY_CONFLICT')
    expect(await decisionStore.listAssertions(scope.scopeRef, { candidateId: candidate.candidateId, openOnly: true }, ctx)).toHaveLength(1)
    expect(await decisionStore.listLinkConstraints(scope.scopeRef, candidate.candidateId, ctx)).toHaveLength(0)
  })

  it('CAS-locks the target entity so a stale cluster update cannot commit', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_native_id', 'DEV-1')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId
    const matched = await postDecision(candidate.candidateId, {
      kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' },
    }, '1')
    expect(matched.statusCode).toBe(200)
    expect((await decisionStore.getEntity(scope.scopeRef, entityId, ctx))?.revision).toBe('2')

    const other = await seedCandidate('device', 'device_identity', 'device_native_id', 'DEV-1')
    const draft: IdentityDecisionDraft = {
      decisionId: randomUUID(), candidateId: other.candidateId, objectId: 'device', identityScopeId: 'device_identity',
      kind: 'clarify', targetEntityId: entityId, evidenceRefs: [], recordedAt: '2026-09-22T00:00:00Z', actor: 'identity-reviewer',
    }
    await expect(decisionStore.appendDecision(scope.scopeRef, { expectedRevision: '0', expectedEntityRevision: '1', draft }, ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await decisionStore.latestRevision(scope.scopeRef, other.candidateId, ctx)).toBe('0')
    expect((await decisionStore.getEntity(scope.scopeRef, entityId, ctx))?.revision).toBe('2')
  })

  it('separates sources on a split and delivers the downstream invalidation through the real outbox', async () => {
    const candidate = await seedCandidate('device', 'device_identity', 'device_native_id', 'DEV-1')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId
    const matched = await postDecision(
      candidate.candidateId,
      { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } },
      '1',
    )
    expect(matched.statusCode).toBe(200)

    const split = await service.decide(
      {
        candidateId: candidate.candidateId,
        kind: 'split',
        expectedRevision: '2',
        targetEntityId: entityId,
        justification: 'the earlier merge was wrong',
      },
      ctx,
    )
    expect(split.kind).toBe('split')
    expect(split.invalidationOutboxId).toBeDefined()

    // The merge membership is closed, not deleted: history stays auditable.
    const open = await decisionStore.listAssertions(scope.scopeRef, { entityId, openOnly: true }, ctx)
    expect(open).toHaveLength(0)
    const closed = await decisionStore.listAssertions(scope.scopeRef, { entityId }, ctx)
    expect(closed.length).toBeGreaterThan(0)
    expect(closed.every((assertion) => assertion.validTo !== undefined)).toBe(true)

    const pending = await harness.adminClient.query<{ payload: Record<string, unknown>; state: string }>(
      `SELECT payload, state FROM agent_platform.job_outbox
        WHERE tenant_id = $1 AND space_id = $2 AND topic = 'identity.decision.split'`,
      [scope.tenantId, scope.spaceId],
    )
    expect(pending.rows).toHaveLength(1)
    expect(pending.rows[0]?.state).toBe('pending')
    expect(pending.rows[0]?.payload['entityId']).toBe(entityId)

    const consumed: OutboxMessageRecord[] = []
    const consumer: OutboxConsumer = {
      async consume(message: OutboxMessageRecord): Promise<void> {
        consumed.push(message)
      },
    }
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer, now: () => '2026-09-22T00:00:01Z' })
    const delivered = await dispatcher.dispatchOnce(scope.scopeRef, ctx)
    expect(delivered).toBeGreaterThanOrEqual(1)
    expect(consumed.some((message) => message.topic === 'identity.decision.split')).toBe(true)

    const dispatched = await harness.adminClient.query<{ state: string }>(
      `SELECT state FROM agent_platform.job_outbox
        WHERE tenant_id = $1 AND space_id = $2 AND topic = 'identity.decision.split'`,
      [scope.tenantId, scope.spaceId],
    )
    expect(dispatched.rows[0]?.state).toBe('dispatched')
  })

  it('serialises concurrent decisions with the same If-Match', async () => {
    const candidate = await seedCandidate('sensor', 'sensor_identity', 'sensor_name')
    const created = await postDecision(candidate.candidateId, { kind: 'create_pending' }, '0')
    expect(created.statusCode).toBe(200)

    const [first, second] = await Promise.all([
      postDecision(candidate.candidateId, { kind: 'clarify' }, '1'),
      postDecision(candidate.candidateId, { kind: 'clarify' }, '1'),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 409])
  })
})
