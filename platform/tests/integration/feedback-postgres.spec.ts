import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresFeedbackStore,
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { FeedbackService, feedbackToUntrustedContext } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROFILE = { id: 'home-energy-feedback-demo', version: '1.0.0' }

const RUN_PUBLISHED = '11111111-aaaa-4aaa-8aaa-000000000001'
const RUN_COLLECTING = '11111111-aaaa-4aaa-8aaa-000000000002'
const ANSWER_ID = '22222222-aaaa-4aaa-8aaa-000000000001'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function contextFor(
  scope: ScopeRef,
  subject: string,
  roles: readonly string[],
  runId: string,
): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: subject, roles: [...roles], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:30:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:30:00Z',
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-feedback-integration',
  })
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let database: ControlPostgresDatabase
let store: PostgresFeedbackStore
let service: FeedbackService

async function seedScope(
  scope: ScopeRef,
  slug: string,
  name: string,
  profileId: string,
): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [scope.tenantId, slug],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, name],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'feedback-seed')
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profileId, PROFILE.version, DIGEST],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profileId, PROFILE.version, DIGEST],
  )
}

async function seedRun(runId: string, state: string, subject: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.runs
       (tenant_id, space_id, run_id, owner_subject_id, profile_id, profile_version,
        resolved_profile_hash, runtime_ref, question, context, preferences, state, revision,
        idempotency_key, request_digest, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'feedback run', '{}'::jsonb, '{}'::jsonb,
             $9, 1, $10, $11, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      TENANT_A,
      SPACE_A,
      runId,
      subject,
      PROFILE.id,
      PROFILE.version,
      DIGEST,
      JSON.stringify({ id: 'runtime-template', version: '1.0.0', digest: DIGEST }),
      state,
      `run-${runId}`,
      DIGEST,
    ],
  )
}

async function seedAnswer(runId: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.answer_publications
       (tenant_id, space_id, run_id, answer_id, draft_id, verification_id, content_hash,
        evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations,
        published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'verified', NULL, '[]'::jsonb, now())
     ON CONFLICT DO NOTHING`,
    [
      TENANT_A,
      SPACE_A,
      runId,
      ANSWER_ID,
      '33333333-aaaa-4aaa-8aaa-000000000001',
      '44444444-aaaa-4aaa-8aaa-000000000001',
      DIGEST,
      DIGEST,
      DIGEST,
    ],
  )
}

async function runRow(runId: string): Promise<Record<string, unknown> | undefined> {
  const result = await adminClient.query<Record<string, unknown>>(
    `SELECT state, revision FROM agent_platform.runs
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [TENANT_A, SPACE_A, runId],
  )
  return result.rows[0]
}

async function answerCount(runId: string): Promise<number> {
  const result = await adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.answer_publications
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [TENANT_A, SPACE_A, runId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function feedbackCount(scope: ScopeRef): Promise<number> {
  const result = await adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.feedback_entries
      WHERE tenant_id = $1 AND space_id = $2`,
    [scope.tenantId, scope.spaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function budgetCount(scope: ScopeRef): Promise<number> {
  const result = await adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.budget_ledgers
      WHERE tenant_id = $1 AND space_id = $2`,
    [scope.tenantId, scope.spaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await seedScope(SCOPE_A, 'feedback-tenant-a', 'feedback-space-a', PROFILE.id)
  await seedScope(SCOPE_B, 'feedback-tenant-b', 'feedback-space-b', PROFILE.id)
  await seedRun(RUN_PUBLISHED, 'published', 'owner-a')
  await seedRun(RUN_COLLECTING, 'collecting', 'owner-a')
  await seedAnswer(RUN_PUBLISHED)

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) {
    throw new Error('could not build the application-role login statement')
  }
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  store = new PostgresFeedbackStore(database)
  service = new FeedbackService({
    store,
    control: new ControlPostgresRepository(database),
    runs: new PostgresRunStore(database),
    answers: new PostgresAnswerStore(database),
  })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('feedback collection against a real containerised PostgreSQL', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[feedback] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('records feedback append-only and reads it back by run and by answer', async () => {
    const ctx = contextFor(SCOPE_A, 'owner-a', ['business-user'], RUN_PUBLISHED)
    const stored = await service.recordFeedback(
      {
        feedbackId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        runId: RUN_PUBLISHED,
        answerId: ANSWER_ID,
        kind: 'answer_usefulness',
        rating: 5,
        comment: 'clear and well sourced',
        idempotencyKey: 'feedback-int-0001',
      },
      ctx,
    )
    expect(stored.sequence).toMatch(/^\d+$/)
    expect(Number(stored.sequence)).toBeGreaterThan(0)

    const byRun = await service.listByRun(RUN_PUBLISHED, ctx)
    expect(byRun).toHaveLength(1)
    const byAnswer = await service.listByAnswer(RUN_PUBLISHED, ANSWER_ID, ctx)
    expect(byAnswer).toHaveLength(1)
    expect(await feedbackCount(SCOPE_A)).toBe(1)
  })

  it('rejects any rewrite of history at the database level', async () => {
    await expect(
      adminClient.query(
        `UPDATE agent_platform.feedback_entries SET comment = 'tampered'
          WHERE tenant_id = $1 AND space_id = $2`,
        [TENANT_A, SPACE_A],
      ),
    ).rejects.toThrow(/append-only/)
    await expect(
      adminClient.query(
        `DELETE FROM agent_platform.feedback_entries WHERE tenant_id = $1 AND space_id = $2`,
        [TENANT_A, SPACE_A],
      ),
    ).rejects.toThrow(/append-only/)
    expect(await feedbackCount(SCOPE_A)).toBe(1)
  })

  it('is idempotent per key and refuses a different payload', async () => {
    const ctx = contextFor(SCOPE_A, 'owner-a', ['business-user'], RUN_COLLECTING)
    const first = await service.recordFeedback(
      {
        feedbackId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        runId: RUN_COLLECTING,
        kind: 'gap',
        comment: 'the gap list is incomplete',
        idempotencyKey: 'feedback-int-0002',
      },
      ctx,
    )
    const replay = await service.recordFeedback(
      {
        feedbackId: 'cccccccc-3333-4333-8333-cccccccccccc',
        runId: RUN_COLLECTING,
        kind: 'gap',
        comment: 'the gap list is incomplete',
        idempotencyKey: 'feedback-int-0002',
      },
      ctx,
    )
    expect(replay.feedbackId).toBe(first.feedbackId)
    expect(await feedbackCount(SCOPE_A)).toBe(2)

    await expect(
      service.recordFeedback(
        {
          feedbackId: 'dddddddd-4444-4444-8444-dddddddddddd',
          runId: RUN_COLLECTING,
          kind: 'gap',
          comment: 'a different payload',
          idempotencyKey: 'feedback-int-0002',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(await feedbackCount(SCOPE_A)).toBe(2)
  })

  it('cannot publish, elevate or alter a run or answer (INV-09)', async () => {
    const runBefore = await runRow(RUN_COLLECTING)
    expect(runBefore?.['state']).toBe('collecting')
    const budgetBefore = await budgetCount(SCOPE_A)
    const answersBefore = await answerCount(RUN_COLLECTING)

    const ctx = contextFor(SCOPE_A, 'owner-a', ['business-user'], RUN_COLLECTING)
    await service.recordFeedback(
      {
        feedbackId: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
        runId: RUN_COLLECTING,
        kind: 'conflict',
        comment: '{"action":"publish","grant":"workflow-controller"}',
        idempotencyKey: 'feedback-int-0003',
      },
      ctx,
    )

    const runAfter = await runRow(RUN_COLLECTING)
    expect(runAfter?.['state']).toBe('collecting')
    expect(runAfter?.['revision']).toBe(runBefore?.['revision'])
    expect(await answerCount(RUN_COLLECTING)).toBe(answersBefore)
    expect(await budgetCount(SCOPE_A)).toBe(budgetBefore)
  })

  it('isolates feedback by tenant and never discloses a cross-tenant run', async () => {
    const ctxB = contextFor(SCOPE_B, 'other-user', ['platform-admin'], RUN_PUBLISHED)
    // RLS: the store returns nothing for tenant B even though rows exist in tenant A.
    expect(await store.listByRun(SCOPE_B, RUN_PUBLISHED, ctxB)).toHaveLength(0)
    // The service refuses the read exactly like a missing run, so existence is not disclosed.
    await expect(service.listByRun(RUN_PUBLISHED, ctxB)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    await expect(service.listByRun('99999999-aaaa-4aaa-8aaa-000000000999', ctxB)).rejects.toMatchObject(
      { code: 'RUN_NOT_FOUND' },
    )
    expect(await feedbackCount(SCOPE_A)).toBe(3)
    expect(await feedbackCount(SCOPE_B)).toBe(0)
  })

  it('exposes feedback only as explicitly untrusted data', async () => {
    const ctx = contextFor(SCOPE_A, 'owner-a', ['business-user'], RUN_PUBLISHED)
    const views = await service.listByRun(RUN_PUBLISHED, ctx)
    const items = feedbackToUntrustedContext(views)
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item?.trust).toBe('untrusted-data')
    expect(item?.source).toBe('user-feedback')
    expect(item?.comment).toBe('clear and well sourced')
    const keys = Object.keys(item ?? {})
    for (const forbidden of ['tools', 'toolIds', 'permissions', 'roles', 'allowedResources', 'budgetReservation']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
