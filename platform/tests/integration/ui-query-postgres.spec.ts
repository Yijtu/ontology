import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresBudgetLedgerStore,
  PostgresComponentRegistryStore,
  PostgresProfileStore,
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  InMemoryIndustryManifestSource,
  InMemoryWorkflowStore,
  ProfileResolver,
  RunPhaseDriver,
  RunService,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import { RunProgressService, createApiServer } from '@ontology/app-api'
import type { AnswerReader, AuthenticatedRequest } from '@ontology/app-api'
import { BudgetService } from '@ontology/core'
import type {
  PublishedAnswer,
  ResourceRef,
  RevisionString,
  RuntimeEvent,
  ToolContext,
} from '@ontology/contracts'
import {
  INDUSTRY_REF,
  SCOPE_A,
  canonicalProfileValidator,
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
const PROFILE_REF = { id: 'home-energy-demo', version: '1.0.0' }
const FIXED_NOW = '2026-09-21T00:00:00Z'
const ALLOWED_DOMAIN = 'example.com'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let database: ControlPostgresDatabase
let app: ReturnType<typeof createApiServer>
let runService: RunService
let phase: RunPhaseDriver
let budget: BudgetService
let answerStore: PostgresAnswerStore
let manifests: InMemoryWorkflowStore
const bindings = new Map<string, RunProfileBinding>()

const ADMIN_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'pg-editor-a')

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const databaseName = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${databaseName}`
}

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  return {
    principal: { tenantId: SCOPE_A.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: SCOPE_A.spaceId,
    allowedDomains: [ALLOWED_DOMAIN],
  }
}

function ctxFor(runId: string): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user', 'scoped-reader'], 'owner-a', runId)
}

function planEvent(runId: string): RuntimeEvent {
  return {
    type: 'plan_proposed',
    runId,
    eventId: randomUUID(),
    sequence: 0,
    occurredAt: '2026-09-21T00:01:00Z',
    planRef: { id: 'plan-1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    stepCount: 2,
    toolIds: ['data_query'],
  }
}

function collectionCompleteEvent(runId: string): RuntimeEvent {
  return {
    type: 'collection_complete',
    runId,
    eventId: randomUUID(),
    sequence: 1,
    occurredAt: '2026-09-21T00:02:00Z',
    draftAllowed: true,
    evidenceCount: 2,
  }
}

function clarificationEvent(runId: string, clarificationId: string): RuntimeEvent {
  return {
    type: 'clarification_requested',
    runId,
    eventId: randomUUID(),
    sequence: 2,
    occurredAt: '2026-09-21T00:03:00Z',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
    questionType: 'choice',
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

async function createRun(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `ui-query-${randomUUID()}`,
      'x-test-subject': 'owner-a',
      'x-test-roles': 'business-user',
    },
    payload: {
      profileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version },
      question: '在备电要求下比较明天的用电策略',
      context: { siteRef: 'site-demo-a', timeZone: 'Asia/Shanghai' },
      preferences: { route: 'auto', allowWeb: false },
    },
  })
  expect(response.statusCode).toBe(202)
  const runId = (response.json() as { data: { runId: string } }).data.runId
  const binding = bindings.get(runId)
  if (binding === undefined) throw new Error('the run profile binding was not captured')
  const ctx = ctxFor(runId)
  const ledger = await budget.openLedger({ ledgerId: randomUUID(), kind: 'run', runId }, ctx)
  await manifests.saveRunManifest(
    {
      runId,
      resolvedProfileRef: binding.resolvedProfileRef,
      runtimeRef: binding.runtimeRef,
      budgetLedgerId: ledger.ledgerId,
      inputManifestId: randomUUID(),
      createdAt: FIXED_NOW,
    },
    ctx,
  )
  return runId
}

async function consumeBudget(runId: string, toolCalls: number): Promise<void> {
  const ctx = ctxFor(runId)
  const manifest = await manifests.getRunManifest(runId, ctx)
  if (manifest === undefined) throw new Error('the run has no budget ledger')
  const outcome = await budget.reserve(
    { ledgerId: manifest.budgetLedgerId, idempotencyKey: `ui-query-consume-${randomUUID()}`, toolCalls },
    ctx,
  )
  if (outcome.reservation === undefined) throw new Error('the reservation was denied')
  const evidence: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: `sha256:${'e'.repeat(64)}`,
    kind: 'evidence',
  }
  await budget.settle(
    {
      ledgerId: manifest.budgetLedgerId,
      reservationId: outcome.reservation.reservationId,
      status: 'completed',
      usage: { durationMs: 1 },
      evidenceRefs: [evidence],
    },
    ctx,
  )
}

async function getRunView(
  runId: string,
): Promise<{
  state: string
  revision: string
  budget?: { toolCallsRemaining: number }
  scope?: { toolIds: string[]; webSearchEnabled: boolean; allowedDomains: string[] }
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/runs/${runId}`,
    headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { data: never }).data
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'ui-query-tenant') ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'ui-query-space') ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId],
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

  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const control = new ControlPostgresRepository(database)
  const registryStore = new PostgresComponentRegistryStore(database)
  const profileStore = new PostgresProfileStore(database)
  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())
  const resolver = new ProfileResolver({
    control,
    store: profileStore,
    registry: registryStore,
    industry,
    validator: canonicalProfileValidator(),
    now: fixedClock(),
  })
  await seedComponents(registryStore, registeredComponents(), SCOPE_A, ADMIN_A)
  await resolver.publish(
    { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
    ADMIN_A,
  )
  const preflight = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
  if (preflight.status !== 'resolved') throw new Error(`profile preflight failed: ${preflight.status}`)

  const binder: RunProfileBinder = {
    bindProfileForRun: async (profileRef, scopeRef, ctx) => {
      const binding = await resolver.bindRunProfile(profileRef, scopeRef, ctx)
      bindings.set(ctx.runId, binding)
      return binding
    },
  }
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control,
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  manifests = new InMemoryWorkflowStore()
  runService = new RunService({ store: new PostgresRunStore(database), control, profiles: binder, now: fixedClock() })
  phase = new RunPhaseDriver({ store: new PostgresRunStore(database), control, now: fixedClock() })
  answerStore = new PostgresAnswerStore(database)
  const progress = new RunProgressService({ profiles: profileStore, binder, manifests, budget })
  const reader: AnswerReader = {
    getRun: async (runId, ctx) => {
      const view = await runService.getRun(runId, ctx)
      return { state: view.state, revision: view.revision }
    },
    getAnswer: (runId, ctx) => answerStore.findByRun(runId, ctx),
  }

  app = createApiServer({
    authenticate: testAuthenticator,
    runs: { service: runService, progress },
    answers: { reader },
  })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('business query UI routes against real PostgreSQL', () => {
  it('projects the resolved scenario scope with the approved domains', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/scope?profileId=${PROFILE_REF.id}&version=${PROFILE_REF.version}`,
      headers: { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' },
    })
    expect(response.statusCode).toBe(200)
    const scope = (response.json() as { data: { toolIds: string[]; webSearchEnabled: boolean; allowedDomains: string[] } })
      .data
    expect(scope.toolIds).toContain('data_query')
    expect(scope.toolIds).not.toContain('web_search')
    expect(scope.webSearchEnabled).toBe(false)
    expect(scope.allowedDomains).toEqual([ALLOWED_DOMAIN])
    expect(response.body).not.toContain('secret')
  })

  it('keeps the same shared budget across a clarification round', async () => {
    const runId = await createRun()
    await consumeBudget(runId, 2)
    const before = await getRunView(runId)
    expect(before.budget?.toolCallsRemaining).toBe(6)
    expect(before.scope?.toolIds).toContain('data_query')

    const ctx = ctxFor(runId)
    await runService.recordRuntimeEvent(runId, planEvent(runId), ctx)
    const clarificationId = randomUUID()
    await runService.recordRuntimeEvent(runId, clarificationEvent(runId, clarificationId), ctx)
    const waiting = await getRunView(runId)
    expect(waiting.state).toBe('awaiting_input')

    const responded = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/responses`,
      headers: {
        'content-type': 'application/json',
        'x-test-subject': 'owner-a',
        'x-test-roles': 'business-user',
        'if-match': waiting.revision,
      },
      payload: { clarificationId, typedResponse: { choice: 'backup-first' }, expectedRevision: waiting.revision },
    })
    expect(responded.statusCode).toBe(200)

    const after = await getRunView(runId)
    expect(after.state).toBe('collecting')
    expect(after.budget?.toolCallsRemaining).toBe(6)

    const ledgerRow = await adminClient.query<{ tool_calls_consumed: number }>(
      `SELECT tool_calls_consumed FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, runId],
    )
    expect(ledgerRow.rows[0]?.tool_calls_consumed).toBe(2)
  })

  it('streams persisted frames in order and never exposes an unverified draft', async () => {
    const runId = await createRun()
    const ctx = ctxFor(runId)
    await runService.recordRuntimeEvent(runId, planEvent(runId), ctx)
    await runService.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID()), ctx)

    const headers = { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' }
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/events`, headers })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    const frames = sseFrames(response.payload)
    expect(frames.map((frame) => frame.event)).toEqual(['run.state', 'plan.summary', 'clarification.required'])
    expect(response.payload).not.toContain('unverified_answer.delta')

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
  })

  it('reads the real published answer and reports an explicit 202/404 otherwise', async () => {
    const runId = await createRun()
    const ctx = ctxFor(runId)
    await runService.recordRuntimeEvent(runId, planEvent(runId), ctx)
    await runService.recordRuntimeEvent(runId, collectionCompleteEvent(runId), ctx)
    const drafting = await runService.getRun(runId, ctx)
    const verifying = await phase.transition(runId, drafting.revision, 'verifying', {}, ctx)

    const answer: PublishedAnswer = {
      answerId: randomUUID(),
      runId,
      draftId: randomUUID(),
      verificationId: randomUUID(),
      contentHash: `sha256:${'a'.repeat(64)}`,
      evidenceManifestHash: `sha256:${'b'.repeat(64)}`,
      scenarioManifestHash: `sha256:${'c'.repeat(64)}`,
      publicationKind: 'verified',
      limitations: [],
      publishedAt: FIXED_NOW,
    }
    await answerStore.record(
      { answer, expectedRunState: verifying.state, expectedRunRevision: verifying.revision },
      ctx,
    )

    const headers = { 'x-test-subject': 'owner-a', 'x-test-roles': 'business-user' }
    const published = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/answer`, headers })
    expect(published.statusCode).toBe(200)
    const body = (published.json() as { data: PublishedAnswer }).data
    expect(body.contentHash).toBe(answer.contentHash)
    expect(body.publicationKind).toBe('verified')

    const inProgressRun = await createRun()
    const inProgress = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${inProgressRun}/answer`,
      headers,
    })
    expect(inProgress.statusCode).toBe(202)

    const cancelledRun = await createRun()
    const cancelledView = await runService.getRun(cancelledRun, ctxFor(cancelledRun))
    await runService.cancelRun(
      { runId: cancelledRun, reason: 'user cancelled', expectedRevision: cancelledView.revision },
      ctxFor(cancelledRun),
    )
    const unavailable = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${cancelledRun}/answer`,
      headers,
    })
    expect(unavailable.statusCode).toBe(404)
    expect((unavailable.json() as { error: { code: string } }).error.code).toBe('ANSWER_NOT_AVAILABLE')
  })

  it('refuses a stale clarification revision and keeps the budget ledger unchanged', async () => {
    const runId = await createRun()
    const ctx = ctxFor(runId)
    await runService.recordRuntimeEvent(runId, planEvent(runId), ctx)
    const clarificationId = randomUUID()
    await runService.recordRuntimeEvent(runId, clarificationEvent(runId, clarificationId), ctx)
    const waiting = await getRunView(runId)

    const stale: RevisionString = '999'
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/responses`,
      headers: {
        'content-type': 'application/json',
        'x-test-subject': 'owner-a',
        'x-test-roles': 'business-user',
        'if-match': stale,
      },
      payload: { clarificationId, typedResponse: { choice: 'x' }, expectedRevision: stale },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')
    expect(waiting.budget?.toolCallsRemaining).toBe(8)
  })
})
