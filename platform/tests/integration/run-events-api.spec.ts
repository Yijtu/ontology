import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresComponentRegistryStore, runControlMigrations } from '@ontology/adapter-control-postgres'
import { InMemoryIndustryManifestSource } from '@ontology/application'
import { createPostgresRunService, createRunApi } from '@ontology/app-api'
import type { AuthenticatedRequest, RunServiceComposition } from '@ontology/app-api'
import type {
  ComponentKey,
  ComponentVersionRecord,
  ModuleLifecycleState,
  ProfileRef,
  RuntimeCheckpointRef,
  RuntimeEvent,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  INDUSTRY_REF,
  SCOPE_A,
  SCOPE_B,
  canonicalProfileValidator,
  componentRecord,
  fixedClock,
  homeEnergyIndustryManifest,
  registeredComponents,
  sampleProfileSpec,
  seedComponents,
  toolContext,
} from '../unit/profile-resolver-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const RUNTIME_KIND = 'runtime-template'
const RUNTIME_VERSION = '1.0.0'
const OLD_RUNTIME_VERSION = '0.9.0'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let composition: RunServiceComposition
let registryStore: PostgresComponentRegistryStore
let sharedApp: ReturnType<typeof createRunApi> | undefined

const ADMIN_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'pg-editor-a')
const ADMIN_B: ToolContext = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'pg-editor-b')

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function requireVersion(
  key: ComponentKey,
  scopeRef: ScopeRef,
  ctx: ToolContext,
): Promise<ComponentVersionRecord> {
  const record = await registryStore.findVersion(key, scopeRef, ctx)
  if (record === undefined) throw new Error(`component ${key.id}@${key.version} is missing`)
  return record
}

async function transitionComponent(
  scopeRef: ScopeRef,
  key: ComponentKey,
  record: ComponentVersionRecord,
  to: ModuleLifecycleState,
  ctx: ToolContext,
): Promise<void> {
  await registryStore.applyTransition(
    scopeRef,
    key,
    record.lifecycleState,
    { ...record, lifecycleState: to },
    {
      fromState: record.lifecycleState,
      toState: to,
      digest: record.manifestRef.digest,
      payloadDigest: `sha256:${'0'.repeat(64)}`,
      idempotencyKey: `transition:${key.id}:${key.version}:${to}`,
      occurredAt: '2026-09-21T00:05:00Z',
      actor: ctx.principal.subjectId,
    },
    ctx,
  )
}

/**
 * Test-only authenticator. Production uses verified OIDC/JWKS (SPEC §3); here the trusted
 * principal is selected with test headers so a request can be attributed to a tenant, a
 * subject and a role set. The run surface itself never reads identity from the body.
 */
function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  const rawScope = request.headers['x-test-scope']
  const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const isB = scope === 'b'
  return {
    principal: {
      tenantId: isB ? SCOPE_B.tenantId : SCOPE_A.tenantId,
      subjectId: subject,
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: isB ? SCOPE_B.spaceId : SCOPE_A.spaceId,
  }
}

function planEvent(runId: string, eventId: string): RuntimeEvent {
  return {
    type: 'plan_proposed',
    runId,
    eventId,
    sequence: 0,
    occurredAt: '2026-09-21T00:01:00Z',
    planRef: { id: 'plan-1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    stepCount: 2,
    toolIds: ['data_query'],
  }
}

function clarificationEvent(runId: string, eventId: string, clarificationId: string): RuntimeEvent {
  return {
    type: 'clarification_requested',
    runId,
    eventId,
    sequence: 1,
    occurredAt: '2026-09-21T00:02:00Z',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
    questionType: 'choice',
  }
}

function collectionCompleteEvent(runId: string, eventId: string): RuntimeEvent {
  return {
    type: 'collection_complete',
    runId,
    eventId,
    sequence: 2,
    occurredAt: '2026-09-21T00:03:00Z',
    draftAllowed: true,
    evidenceCount: 4,
  }
}

function createBody(question = 'compare tomorrow energy strategies'): Record<string, unknown> {
  return {
    profileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version },
    question,
    context: { siteRef: 'site-demo-a', timeZone: 'Asia/Shanghai' },
    preferences: { route: 'auto', allowWeb: false },
  }
}

function sseFrames(payload: string): { id: string; event: string; data: Record<string, unknown> }[] {
  return payload
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n')
      const id = lines.find((line) => line.startsWith('id: '))?.slice(4) ?? ''
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? ''
      const rawData = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '{}'
      return { id, event, data: JSON.parse(rawData) as Record<string, unknown> }
    })
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
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'runs-tenant-a'), ($2, 'runs-tenant-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_B.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'runs-space-a'), ($3, $4, 'runs-space-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, SCOPE_B.tenantId, SCOPE_B.spaceId],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())

  composition = createPostgresRunService({
    connectionString: appUrl,
    industry,
    validator: canonicalProfileValidator(),
    maxPoolSize: 4,
    now: fixedClock(),
  })
  registryStore = new PostgresComponentRegistryStore(composition.database)

  await seedComponents(registryStore, registeredComponents(), SCOPE_A, ADMIN_A)
  await seedComponents(registryStore, registeredComponents(), SCOPE_B, ADMIN_B)

  for (const [scope, admin] of [
    [SCOPE_A, ADMIN_A],
    [SCOPE_B, ADMIN_B],
  ] as const) {
    await composition.resolver.publish(
      { scopeRef: scope, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
      admin,
    )
    const result = await composition.resolver.preflight({ scopeRef: scope, profileRef: PROFILE_REF }, admin)
    if (result.status !== 'resolved') throw new Error(`profile preflight failed: ${result.status}`)
  }
}, 300_000)

afterAll(async () => {
  await sharedApp?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

function api(): ReturnType<typeof createRunApi> {
  sharedApp ??= createRunApi({ service: composition.service, authenticate: testAuthenticator })
  return sharedApp
}

async function createRun(
  app: ReturnType<typeof api>,
  options?: {
    readonly key?: string
    readonly question?: string
    readonly subject?: string
    readonly roles?: string
    readonly scope?: 'a' | 'b'
  },
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': options?.key ?? `idem-${randomUUID()}`,
      'x-test-subject': options?.subject ?? 'owner-a',
      'x-test-roles': options?.roles ?? 'business-user',
      'x-test-scope': options?.scope ?? 'a',
    },
    payload: createBody(options?.question),
  })
}

describe('run migration 010', () => {
  it('enables RLS and keeps tenant/space in the primary keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('runs', 'run_events', 'runtime_checkpoints', 'run_clarification_responses', 'run_abandoned_attempts')
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.runs', 'agent_platform.run_events', 'agent_platform.runtime_checkpoints'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.runs')).toEqual(['tenant_id', 'space_id', 'run_id'])
    expect(byTable.get('agent_platform.run_events')).toEqual([
      'tenant_id',
      'space_id',
      'run_id',
      'sequence',
    ])
    expect(byTable.get('agent_platform.runtime_checkpoints')).toEqual([
      'tenant_id',
      'space_id',
      'run_id',
      'checkpoint_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('010_run_records_events.sql')
  })
})

describe('POST /runs idempotency', () => {
  it('creates a run, locks the profile hash and reuses the same key/payload', async () => {
    const app = api()
    const key = `idem-${randomUUID()}`
    const first = await createRun(app, { key })
    expect(first.statusCode).toBe(202)
    const firstBody = first.json() as { data: { runId: string; state: string; eventsUrl: string; resolvedProfileHash: string } }
    expect(firstBody.data.state).toBe('created')
    expect(firstBody.data.resolvedProfileHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(firstBody.data.eventsUrl).toBe(`/api/v1/runs/${firstBody.data.runId}/events`)

    const second = await createRun(app, { key })
    expect(second.statusCode).toBe(202)
    const secondBody = second.json() as { data: { runId: string } }
    expect(secondBody.data.runId).toBe(firstBody.data.runId)

    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.runs WHERE idempotency_key = $1`,
      [key],
    )
    expect(rows.rows[0]?.count).toBe('1')
  }, 30_000)

  it('rejects the same key with a different payload with 409 IDEMPOTENCY_CONFLICT', async () => {
    const app = api()
    const key = `idem-${randomUUID()}`
    await createRun(app, { key, question: 'first question' })
    const conflict = await createRun(app, { key, question: 'second question' })
    expect(conflict.statusCode).toBe(409)
    const body = conflict.json() as { error: { code: string } }
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('requires the Idempotency-Key header', async () => {
    const app = api()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'content-type': 'application/json', 'x-test-subject': 'owner-a' },
      payload: createBody(),
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
  })

  it('returns 401 without an authenticated principal', async () => {
    const app = api()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}` },
      payload: createBody(),
    })
    expect(response.statusCode).toBe(401)
  })

  it('hides a run from another tenant/space', async () => {
    const app = api()
    const created = await createRun(app, {})
    const runId = (created.json() as { data: { runId: string } }).data.runId
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
      headers: { 'x-test-subject': 'owner-b', 'x-test-roles': 'business-user', 'x-test-scope': 'b' },
    })
    expect(crossTenant.statusCode).toBe(404)
  })
})

describe('If-Match optimistic concurrency over HTTP', () => {
  it('returns 428 without If-Match and 409 for a stale revision', async () => {
    const app = api()
    const created = await createRun(app, {})
    const runId = (created.json() as { data: { runId: string } }).data.runId
    const headers = { 'content-type': 'application/json', 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' }

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers,
      payload: { reason: 'user changed their mind', expectedRevision: '1' },
    })
    expect(missing.statusCode).toBe(428)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED')

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { ...headers, 'if-match': '99' },
      payload: { reason: 'user changed their mind', expectedRevision: '99' },
    })
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { ...headers, 'if-match': '1' },
      payload: { reason: 'user changed their mind', expectedRevision: '1' },
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as { data: { state: string; revision: string } }
    expect(body.data.state).toBe('cancelled')
    expect(body.data.revision).toBe('3')
  })
})

describe('GET /runs/{id}/events SSE replay', () => {
  async function seededRun(): Promise<string> {
    const runId = randomUUID()
    const ctx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)
    await composition.service.createRun(
      {
        runId,
        profileRef: PROFILE_REF,
        question: 'replay test',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `idem-${runId}`,
      },
      ctx,
    )
    await composition.service.recordRuntimeEvent(runId, planEvent(runId, randomUUID()), ctx)
    await composition.service.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID(), randomUUID()), ctx)
    return runId
  }

  it('streams persisted frames in order and never exposes an unverified draft', async () => {
    const app = api()
    const runId = await seededRun()
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events`,
      headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    const frames = sseFrames(response.payload)
    expect(frames.map((frame) => frame.id)).toEqual(['1', '2', '3'])
    expect(frames.map((frame) => frame.event)).toEqual([
      'run.state',
      'plan.summary',
      'clarification.required',
    ])
    expect(response.payload).not.toContain('unverified_answer.delta')
    expect(response.payload).not.toContain('answer.published')
  })

  it('replays strictly after Last-Event-ID with no duplicates or gaps', async () => {
    const app = api()
    const runId = await seededRun()
    const headers = { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' }
    const all = sseFrames(
      (await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/events`, headers })).payload,
    )
    const replayed = sseFrames(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/runs/${runId}/events`,
          headers: { ...headers, 'last-event-id': '1' },
        })
      ).payload,
    )
    expect(replayed.map((frame) => frame.id)).toEqual(['2', '3'])
    const ids = new Set([...all, ...replayed].map((frame) => frame.id))
    expect(ids.size).toBe(3)
    expect(replayed.every((frame) => Number(frame.id) > 1)).toBe(true)
  })
})

describe('cancel and clarification authorisation', () => {
  it('refuses a cancel by an unrelated user but allows an operator', async () => {
    const app = api()
    const created = await createRun(app, {})
    const runId = (created.json() as { data: { runId: string } }).data.runId
    const payload = { reason: 'not mine to cancel', expectedRevision: '1' }

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'other-a', 'x-test-roles': 'business-user', 'if-match': '1' },
      payload,
    })
    expect(forbidden.statusCode).toBe(403)

    const byOperator = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'operator-a', 'x-test-roles': 'operator', 'if-match': '1' },
      payload: { reason: 'operator stop', expectedRevision: '1' },
    })
    expect(byOperator.statusCode).toBe(200)
    expect((byOperator.json() as { data: { state: string } }).data.state).toBe('cancelled')
  })

  it('refuses a clarification response from a non-owner and accepts the owner', async () => {
    const app = api()
    const runId = randomUUID()
    const ctx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)
    await composition.service.createRun(
      {
        runId,
        profileRef: PROFILE_REF,
        question: 'clarify me',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `idem-${runId}`,
      },
      ctx,
    )
    const clarificationId = randomUUID()
    await composition.service.recordRuntimeEvent(runId, planEvent(runId, randomUUID()), ctx)
    await composition.service.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID(), clarificationId), ctx)

    const body = { clarificationId, typedResponse: { choice: 'a' }, expectedRevision: '3' }
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/responses`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'other-a', 'x-test-roles': 'business-user', 'if-match': '3' },
      payload: body,
    })
    expect(forbidden.statusCode).toBe(403)

    const owner = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/responses`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user', 'if-match': '3' },
      payload: body,
    })
    expect(owner.statusCode).toBe(200)
    const parsed = owner.json() as { data: { state: string; revision: string } }
    expect(parsed.data.state).toBe('continued')
    expect(parsed.data.revision).toBe('4')
  })
})

describe('cancelled-run isolation and checkpoint compatibility', () => {
  it('quarantines a late runtime result and never revives or publishes a cancelled run', async () => {
    const app = api()
    const created = await createRun(app, {})
    const runId = (created.json() as { data: { runId: string } }).data.runId
    const ctx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user', 'if-match': '1' },
      payload: { reason: 'stop the run', expectedRevision: '1' },
    })
    expect(cancelled.statusCode).toBe(200)
    const revision = (cancelled.json() as { data: { revision: string } }).data.revision

    const late = await composition.service.recordRuntimeEvent(runId, collectionCompleteEvent(runId, randomUUID()), ctx)
    expect(late.disposition).toBe('abandoned')

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
      headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
    })
    const viewBody = view.json() as { data: { state: string; revision: string } }
    expect(viewBody.data.state).toBe('cancelled')
    expect(viewBody.data.revision).toBe(revision)

    const abandoned = await composition.service.listAbandonedAttempts(runId, ctx)
    expect(abandoned).toHaveLength(1)

    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/events`,
      headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
    })
    expect(events.payload).not.toContain('answer.published')
    expect(events.payload).not.toContain('unverified_answer.delta')
  })

  it('rejects an incompatible checkpoint and resumes with the matching runtime version', async () => {
    const app = api()
    const runId = randomUUID()
    const ctx = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)
    await composition.service.createRun(
      {
        runId,
        profileRef: PROFILE_REF,
        question: 'checkpoint test',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `idem-${runId}`,
      },
      ctx,
    )
    const clarificationId = randomUUID()
    await composition.service.recordRuntimeEvent(runId, planEvent(runId, randomUUID()), ctx)
    await composition.service.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID(), clarificationId), ctx)
    const waiting = await composition.service.getRun(runId, ctx)
    expect(waiting.state).toBe('awaiting_input')

    const checkpointId = randomUUID()
    const stateDigest = `sha256:${'7'.repeat(64)}`
    const ref: RuntimeCheckpointRef = await composition.service.saveRuntimeCheckpoint(
      {
        runId,
        checkpointId,
        runtimeKind: RUNTIME_KIND,
        runtimeVersion: RUNTIME_VERSION,
        stateDigest,
        payload: new Uint8Array([1, 2, 3, 4]),
      },
      ctx,
    )
    expect(ref.checkpointId).toBe(checkpointId)

    const incompatible = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/resume`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user', 'if-match': waiting.revision },
      payload: { checkpointId, runtimeKind: RUNTIME_KIND, runtimeVersion: OLD_RUNTIME_VERSION, stateDigest, expectedRevision: waiting.revision },
    })
    expect(incompatible.statusCode).toBe(409)
    expect((incompatible.json() as { error: { code: string } }).error.code).toBe('CHECKPOINT_INCOMPATIBLE')

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/resume`,
      headers: { 'content-type': 'application/json', 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user', 'if-match': waiting.revision },
      payload: { checkpointId, runtimeKind: RUNTIME_KIND, runtimeVersion: RUNTIME_VERSION, stateDigest, expectedRevision: waiting.revision },
    })
    expect(resumed.statusCode).toBe(200)
    expect((resumed.json() as { data: { state: string } }).data.state).toBe('collecting')
  })
})

describe('locked profile immutability', () => {
  it('leaves a run bound to its original resolved profile after a newer component version', async () => {
    const app = api()
    const created = await createRun(app, {})
    const runId = (created.json() as { data: { runId: string } }).data.runId
    const firstHash = (created.json() as { data: { resolvedProfileHash: string } }).data.resolvedProfileHash

    const beforeRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, firstHash],
    )
    const beforeText = beforeRow.rows[0]?.body
    if (beforeText === undefined) throw new Error('the locked resolved profile row is missing')

    await seedComponents(
      registryStore,
      [
        componentRecord({
          kind: 'data_backend',
          id: 'data-postgres',
          version: '1.1.0',
          digest: `sha256:${'9'.repeat(64)}`,
          provides: [{ name: 'structured_query', version: '1.1.0' }],
        }),
      ],
      SCOPE_A,
      ADMIN_A,
    )
    const previous: ComponentKey = { kind: 'data_backend', id: 'data-postgres', version: '1.0.0' }
    await transitionComponent(SCOPE_A, previous, await requireVersion(previous, SCOPE_A, ADMIN_A), 'deprecated', ADMIN_A)

    const second = await createRun(app, {})
    expect(second.statusCode).toBe(202)
    const secondHash = (second.json() as { data: { resolvedProfileHash: string } }).data.resolvedProfileHash
    expect(secondHash).not.toBe(firstHash)

    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
      headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
    })
    expect((view.json() as { data: { resolvedProfileHash: string } }).data.resolvedProfileHash).toBe(firstHash)

    const afterRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, firstHash],
    )
    expect(afterRow.rows[0]?.body).toBe(beforeText)
  })
})
