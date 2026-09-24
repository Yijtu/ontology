import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  createApiServer,
  createBlobArtifactWriter,
  createEnergySimulationSurface,
  createScopedBlobReader,
  createPostgresSimulationRecordStore,
  createVirtualSolixExecutionSurface,
  createPostgresEnergyPlanVersionStore,
  registerSimulationRoutes,
} from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { ENERGY_OPERATION_REGISTRY, createEnergyComputeHandlers, decodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { recoverLegacyVirtualSolixState } from '../../apps/api/src/composition/recover-virtual-solix-state'
import { DEFAULT_SCENARIO_START_UTC, INITIAL_BATTERY_ENERGY_KWH } from '../../apps/api/src/composition/home-energy-scenario'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * Real PostgreSQL + blob-local acceptance for the home-energy simulation surface (LOCAL-047).
 *
 * It drives the real C6 routes (`/simulations/inputs`, `/simulations`, `/simulations/{id}`,
 * `/executions`) against the real registered compute handlers, the real immutable artifact
 * registry in a containerised PostgreSQL and the real on-disk object store. Nothing in the
 * compute/simulation path is mocked: the plan result is archived, read back and integrity-verified
 * through the same store, and the live execution is refused before any device driver is reached.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT = '22222222-2222-4222-8222-222222222222'
const SPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VERIFIED_RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DIGEST = `sha256:${'a'.repeat(64)}`

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function loopbackAuth(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: TENANT,
      subjectId: 'node-47-integration',
      roles: ['simulation-user', 'business-user', 'operator', 'data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: SPACE,
  }
}

function toolContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId: 'node-47-integration',
      roles: ['simulation-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['artifact', 'dataset'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-node-47-integration',
  })
}

type ResourceRefBody = ResourceRef

interface ScenarioBody {
  readonly inputRef: ResourceRefBody
  readonly inputDigest: string
  readonly dataMode: string
  readonly timeZone: string
  readonly series: readonly { readonly role: string; readonly samplingType: string; readonly unit: string }[]
}

interface DetailBody {
  readonly simulationId: string
  readonly mode: string
  readonly liveSupported: boolean
  readonly domainStatus: string
  readonly integrityVerified: boolean
  readonly resultRef: ResourceRefBody
  readonly scenario: ScenarioBody
  readonly result: {
    readonly status: string
    readonly executionMode: string
    readonly liveSupported: boolean
    readonly inputManifestHash: string
    readonly resultDigest: string
    readonly selection: { readonly optimality: string; readonly selectedPlanRef?: ResourceRefBody }
    readonly candidates: readonly {
      readonly strategy: string
      readonly plan: { readonly planRef: ResourceRefBody }
      readonly simulation: { readonly violations: readonly { readonly constraint: string }[] }
    }[]
    readonly baseline?: { readonly plan: { readonly planRef: ResourceRefBody } }
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let app: ReturnType<typeof createApiServer>
let blobStore: LocalImmutableBlobStore
let artifactRegistry: PostgresArtifactRegistry
let controlDatabase: ControlPostgresDatabase
const deviceRequests: string[] = []

async function buildScenario(backupRequirementKwh: number, weatherScenario: string): Promise<ScenarioBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/simulations/inputs',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: { backupRequirementKwh, weatherScenario },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: ScenarioBody }).data
}

async function planFor(scenario: ScenarioBody): Promise<DetailBody> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/simulations',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: {
      operationRef: { id: 'home-energy.plan', version: '1' },
      inputRefs: [scenario.inputRef],
      parameters: { strategyWhitelist: ['self_consumption', 'reserve_first', 'price_window'] },
    },
  })
  expect(created.statusCode).toBe(202)
  const record = (created.json() as { data: { simulationId: string; mode: string; liveSupported: boolean } }).data
  expect(record.mode).toBe('simulation')
  expect(record.liveSupported).toBe(false)

  const read = await app.inject({ method: 'GET', url: `/api/v1/simulations/${record.simulationId}` })
  expect(read.statusCode).toBe(200)
  return (read.json() as { data: DetailBody }).data
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'node-47-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'node-47-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
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

  objectDir = await mkdtemp(join(tmpdir(), 'node-47-energy-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  artifactRegistry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry: artifactRegistry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const artifacts = createBlobArtifactWriter(blobStore)
  const service = createEnergySimulationSurface({
    blobStore,
    artifacts,
    reader: createScopedBlobReader(blobStore),
    operations: ENERGY_OPERATION_REGISTRY,
    handlers: createEnergyComputeHandlers(),
    records: createPostgresSimulationRecordStore(controlDatabase),
  })
  const execution = createVirtualSolixExecutionSurface({ database: controlDatabase, blobs: blobStore, artifacts, authorizePublishedPlan: async ({ runId }) => runId === VERIFIED_RUN })
  app = createApiServer({ authenticate: loopbackAuth })
  registerSimulationRoutes(app, { authenticate: loopbackAuth, service, execution })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await artifactRegistry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('home-energy simulation surface over real PostgreSQL and blob-local', () => {
  it('serializes the first selected-plan CAS so a concurrent initial selection cannot return 500', async () => {
    const store = createPostgresEnergyPlanVersionStore(controlDatabase)
    const refs = [
      { id: 'plan-race-a', version: '1.0.0', digest: DIGEST, kind: 'plan' as const },
      { id: 'plan-race-b', version: '1.0.0', digest: DIGEST, kind: 'plan' as const },
    ]
    const detail = { selectedPlanRef: refs[0], stateRevision: 0, initialEnergyKwh: INITIAL_BATTERY_ENERGY_KWH, intervals: [{ startUtc: DEFAULT_SCENARIO_START_UTC }] } as never
    const attempt = (planRef: typeof refs[number]) => store.select({
      planKey: 'concurrency-race-fixture', planRef, runId: randomUUID(),
      scenarioRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      stateRevision: 0, detail,
    }, toolContext())
    const results = await Promise.allSettled([attempt(refs[0]!), attempt(refs[1]!)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect((rejected.reason as { code?: string; httpStatus?: number }).httpStatus).toBe(409)
  })

  it('rejects a plan when Virtual SOLIX energy changed without a revision change', async () => {
    const scopeRef = { tenantId: TENANT, spaceId: SPACE }
    const context = toolContext()
    await controlDatabase.withIdentityScope(scopeRef, async (client) => {
      await client.query(`INSERT INTO agent_platform.virtual_solix_states (tenant_id,space_id,device_id,revision,state)
        VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,'virtual-solix-1',0,$1::jsonb)`, [JSON.stringify({ energyKwh: 4, socPercent: 40, revision: 0, updatedAt: new Date().toISOString(), simulatedAt: DEFAULT_SCENARIO_START_UTC })])
    })
    try {
      const store = createPostgresEnergyPlanVersionStore(controlDatabase)
      await expect(store.select({
        planKey: 'stale-state-fixture', planRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'plan' },
        runId: randomUUID(), scenarioRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
        stateRevision: 0,
        detail: { initialEnergyKwh: INITIAL_BATTERY_ENERGY_KWH, intervals: [{ startUtc: DEFAULT_SCENARIO_START_UTC }] } as never,
      }, context)).rejects.toMatchObject({ code: 'STALE_VIRTUAL_STATE', httpStatus: 409 })
    } finally {
      await controlDatabase.withIdentityScope(scopeRef, async (client) => {
        await client.query(`DELETE FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1' AND revision=0`)
      })
    }
  })

  it('marks bounded history incomplete and still resolves an older plan by its indexed ref', async () => {
    const ids = Array.from({ length: 101 }, () => randomUUID())
    const refs = ids.map((id) => ({ id, version: '1.0.0', digest: DIGEST, kind: 'plan' as const }))
    await controlDatabase.withIdentityScope({ tenantId: TENANT, spaceId: SPACE }, async (client) => {
      await client.query(`INSERT INTO agent_platform.energy_plan_versions
        (tenant_id,space_id,plan_key,version_id,plan_ref_key,plan_ref,run_id,scenario_ref,state_revision,status,detail,created_at)
        SELECT current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,'history-fixture',
               x.version_id::uuid,x.ref_key,x.plan_ref::jsonb,x.version_id::uuid,$4::jsonb,0,'Superseded',$5::jsonb,
               now()+x.ordinality*interval '1 millisecond'
        FROM unnest($1::text[],$2::text[],$3::text[]) WITH ORDINALITY AS x(version_id,ref_key,plan_ref,ordinality)`, [
        ids,
        refs.map((ref) => `plan:${ref.id}@${ref.version}:${ref.digest}`),
        refs.map((ref) => JSON.stringify(ref)),
        JSON.stringify({ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }),
        JSON.stringify({ inputManifestHash: DIGEST }),
      ])
    })
    const store = createPostgresEnergyPlanVersionStore(controlDatabase)
    const page = await store.list('history-fixture', toolContext())
    expect(page.versions).toHaveLength(100)
    expect(page.truncated).toBe(true)
    const oldest = refs[0]
    if (oldest === undefined) throw new Error('missing oldest history ref')
    expect(page.versions.some((entry) => entry.planRef.id === oldest.id)).toBe(false)
    expect((await store.get('history-fixture', oldest, toolContext()))?.planRef.id).toBe(oldest.id)
  })

  it('rechecks the selected plan after preflight, before applying Virtual SOLIX actions', async () => {
    const originalScenario = await buildScenario(2, 'sunny')
    const original = await planFor(originalScenario)
    const oldPlan = original.result.selection.selectedPlanRef
    const replacementScenario = await buildScenario(2, 'overcast')
    const replacement = await planFor(replacementScenario)
    const newPlan = replacement.result.selection.selectedPlanRef
    if (oldPlan === undefined || newPlan === undefined) throw new Error('the race fixture needs two feasible plans')
    const versions = createPostgresEnergyPlanVersionStore(controlDatabase)
    const context = toolContext()
    await versions.select({
      planKey: 'virtual-solix-1', planRef: oldPlan, runId: randomUUID(),
      scenarioRef: originalScenario.inputRef, stateRevision: 0,
      detail: { inputManifestHash: original.result.inputManifestHash, initialEnergyKwh: INITIAL_BATTERY_ENERGY_KWH, intervals: [{ startUtc: DEFAULT_SCENARIO_START_UTC }] } as never,
    }, context)
    let replaced = false
    const protectedExecution = createVirtualSolixExecutionSurface({
      database: controlDatabase, blobs: blobStore, artifacts: createBlobArtifactWriter(blobStore),
      requireSelectedPlanVersion: true,
      authorizePublishedPlan: async (_input, ctx) => {
        await versions.select({
          planKey: 'virtual-solix-1', planRef: newPlan, runId: randomUUID(),
          scenarioRef: replacementScenario.inputRef, parentPlanRef: oldPlan, stateRevision: 0,
          detail: { inputManifestHash: replacement.result.inputManifestHash, initialEnergyKwh: INITIAL_BATTERY_ENERGY_KWH, intervals: [{ startUtc: DEFAULT_SCENARIO_START_UTC }] } as never,
        }, ctx)
        replaced = true
        return true
      },
    })
    await expect(protectedExecution.requestExecution({
      runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' },
      planRef: oldPlan, inputRefs: [originalScenario.inputRef], expectedStateRevision: 0,
      mode: 'simulation', idempotencyKey: randomUUID(),
    }, context)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' })
    expect(replaced).toBe(true)
    const current = await versions.getSelected('virtual-solix-1', context)
    expect(current?.planRef.id).toBe(newPlan.id)
    const state = await protectedExecution.getVirtualState?.(context)
    expect(state?.revision).toBe(0)
  })

  it('executes the selected 35% SOC plan through Virtual SOLIX, records every step, and survives restart', async () => {
    const createdScenario = await app.inject({
      method: 'POST', url: '/api/v1/simulations/inputs',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: { reserveSocPercent: 20, weatherScenario: 'sunny' },
    })
    expect(createdScenario.statusCode).toBe(201)
    const scenario = (createdScenario.json() as { data: ScenarioBody & { reserveSocPercent: number; backupRequirementKwh: number } }).data
    expect(scenario.reserveSocPercent).toBe(20)
    expect(scenario.backupRequirementKwh).toBe(2)
    const detail = await planFor(scenario)
    const planRef = detail.result.selection.selectedPlanRef
    if (planRef === undefined) throw new Error('the feasible planner result did not select a plan')
    const unverified = await app.inject({
      method: 'POST', url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'if-match': '0' },
      payload: { runId: randomUUID(), operationRef: { id: 'home-energy.simulate', version: '1' }, planRef, inputRefs: [scenario.inputRef], mode: 'simulation' },
    })
    expect(unverified.statusCode).toBe(422)
    expect((unverified.json() as { error: { code: string } }).error.code).toBe('VERIFICATION_FAILED')
    const idempotencyKey = randomUUID()
    const execute = () => app.inject({
      method: 'POST', url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'if-match': '0' },
      payload: { runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' }, planRef, inputRefs: [scenario.inputRef], mode: 'simulation' },
    })
    const [executionResponse, concurrentReplay] = await Promise.all([execute(), execute()])
    expect(executionResponse.statusCode).toBe(202)
    expect(concurrentReplay.statusCode).toBe(202)
    const execution = (executionResponse.json() as { data: { executionId: string; phase: string; stepRecords: readonly { slotIndex: number; accepted: boolean; observed: boolean; statusHistory: readonly string[]; beforeEnergyKwh: number; afterEnergyKwh: number; stateRef: ResourceRef }[]; finalStateRef: ResourceRef; finalState: { energyKwh: number; socPercent: number; mode: string } } }).data
    expect((concurrentReplay.json() as { data: { executionId: string } }).data.executionId).toBe(execution.executionId)
    expect(execution.phase).toBe('completed')
    expect(execution.stepRecords).toHaveLength(96)
    expect(execution.stepRecords.every((step) => step.accepted && step.observed)).toBe(true)
    expect(execution.stepRecords.every((step) => step.statusHistory.join(',') === 'Requested,Accepted,Observed')).toBe(true)
    expect(execution.finalState.mode).toBe('simulation')
    expect(execution.stepRecords[0]?.beforeEnergyKwh).toBe(3.5)
    expect(execution.stepRecords[0]?.stateRef.kind).toBe('artifact')
    const finalBytes = await blobStore.readAuthorized({ scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: execution.finalStateRef }, toolContext())
    const finalState = JSON.parse(new TextDecoder().decode(finalBytes)) as { energyKwh: number; socPercent: number; mode: string }
    expect(finalState.mode).toBe('simulation')
    expect(finalState.energyKwh).toBe(execution.stepRecords.at(-1)?.afterEnergyKwh)

    const retried = await app.inject({
      method: 'POST', url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'if-match': '0' },
      payload: { runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' }, planRef, inputRefs: [scenario.inputRef], mode: 'simulation' },
    })
    expect(retried.statusCode).toBe(202)
    expect((retried.json() as { data: { executionId: string } }).data.executionId).toBe(execution.executionId)
    const replayAfterAuthorizationChanged = createVirtualSolixExecutionSurface({
      database: controlDatabase, blobs: blobStore, artifacts: createBlobArtifactWriter(blobStore),
      requireSelectedPlanVersion: true, authorizePublishedPlan: async () => false,
    })
    const recoveredReply = await replayAfterAuthorizationChanged.requestExecution({
      runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' },
      planRef, inputRefs: [scenario.inputRef], mode: 'simulation',
      expectedStateRevision: 0, idempotencyKey,
    }, toolContext())
    expect(recoveredReply.executionId).toBe(execution.executionId)
    const changedReplay = await app.inject({
      method: 'POST', url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'if-match': '1' },
      payload: { runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' }, planRef, inputRefs: [scenario.inputRef], mode: 'simulation' },
    })
    expect(changedReplay.statusCode).toBe(422)
    expect((changedReplay.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'if-match': '0' },
      payload: { runId: VERIFIED_RUN, operationRef: { id: 'home-energy.simulate', version: '1' }, planRef, inputRefs: [scenario.inputRef], mode: 'simulation' },
    })
    expect(duplicate.statusCode).toBe(422)

    await app.close()
    const service = createEnergySimulationSurface({ blobStore, artifacts: createBlobArtifactWriter(blobStore), reader: createScopedBlobReader(blobStore), operations: ENERGY_OPERATION_REGISTRY, handlers: createEnergyComputeHandlers(), records: createPostgresSimulationRecordStore(controlDatabase) })
    const executionSurface = createVirtualSolixExecutionSurface({ database: controlDatabase, blobs: blobStore, artifacts: createBlobArtifactWriter(blobStore), authorizePublishedPlan: async ({ runId }) => runId === VERIFIED_RUN })
    app = createApiServer({ authenticate: loopbackAuth })
    registerSimulationRoutes(app, { authenticate: loopbackAuth, service, execution: executionSurface })
    const persistedSimulation = await app.inject({ method: 'GET', url: `/api/v1/simulations/${detail.simulationId}` })
    expect(persistedSimulation.statusCode).toBe(200)
    expect((persistedSimulation.json() as { data: { integrityVerified: boolean } }).data.integrityVerified).toBe(true)
    const persistedExecution = await app.inject({ method: 'GET', url: `/api/v1/executions/${execution.executionId}` })
    expect(persistedExecution.statusCode).toBe(200)
    expect((persistedExecution.json() as { data: { stepRecords: readonly unknown[] } }).data.stepRecords).toHaveLength(96)
  }, 300_000)

  it('archives a synthetic scenario and runs a registered plan, integrity-verified on read', async () => {
    const scenario = await buildScenario(2, 'sunny')
    expect(scenario.dataMode).toBe('synthetic')
    expect(scenario.timeZone).toBe('Asia/Shanghai')
    const roles = scenario.series.map((series) => series.role)
    expect(roles).toContain('load')
    expect(roles).toContain('pv')
    for (const series of scenario.series) {
      expect(series.unit).toBe('kW')
      expect(['observed', 'forecast']).toContain(series.samplingType)
    }

    const detail = await planFor(scenario)
    expect(detail.mode).toBe('simulation')
    expect(detail.liveSupported).toBe(false)
    expect(detail.integrityVerified).toBe(true)
    expect(detail.domainStatus).toBe('known')
    expect(detail.scenario.inputDigest).toBe(scenario.inputDigest)
    expect(detail.result.executionMode).toBe('simulation')
    expect(detail.result.liveSupported).toBe(false)
    expect(detail.result.status).toBe('feasible')
    expect(detail.result.selection.optimality).toBe('best_of_tested_candidates')

    // The typed result artifact is really stored in the containerised registry + on-disk store:
    // reading it back through the scoped store verifies its content digest.
    const bytes = await blobStore.readAuthorized(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: detail.resultRef },
      toolContext(),
    )
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      executionMode?: string
      liveSupported?: boolean
    }
    expect(parsed.executionMode).toBe('simulation')
    expect(parsed.liveSupported).toBe(false)
  })

  it('produces a new plan version when the backup requirement changes', async () => {
    const first = await buildScenario(2, 'sunny')
    const firstPlan = await planFor(first)
    const second = await buildScenario(20, 'sunny')
    const secondPlan = await planFor(second)

    expect(second.inputDigest).not.toBe(first.inputDigest)
    expect(secondPlan.result.resultDigest).not.toBe(firstPlan.result.resultDigest)
    expect(secondPlan.result.status).toBe('infeasible')
    const constraints = secondPlan.result.candidates.flatMap((candidate) =>
      candidate.simulation.violations.map((violation) => violation.constraint),
    )
    expect(constraints).toContain('backup_reserve')
  })

  it('refuses mode=live with CAPABILITY_NOT_CONFIGURED and sends no device request', async () => {
    const scenario = await buildScenario(1, 'sunny')
    const detail = await planFor(scenario)
    const planRef =
      detail.result.selection.selectedPlanRef ??
      detail.result.candidates[0]?.plan.planRef ??
      detail.result.baseline?.plan.planRef
    if (planRef === undefined) throw new Error('the plan carried no plan reference')

    const live = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: {
        operationRef: { id: 'home-energy.simulate', version: '1' },
        planRef,
        inputRefs: [scenario.inputRef],
        mode: 'live',
      },
    })
    expect(live.statusCode).toBe(409)
    expect((live.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(deviceRequests).toEqual([])
  })

  it('returns 404 for an unknown simulation', async () => {
    const missing = await app.inject({ method: 'GET', url: `/api/v1/simulations/${randomUUID()}` })
    expect(missing.statusCode).toBe(404)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('SIMULATION_NOT_FOUND')
  })

  it('recovers a previously persisted execution state that has no stateRef or simulated clock', async () => {
    const scopeRef = { tenantId: TENANT, spaceId: SPACE }
    const context = toolContext()
    const previous = await controlDatabase.withIdentityScope(scopeRef, async (client) => {
      const receipt = await client.query<{ execution_id: string; record: import('@ontology/extension-home-energy').ExecutionRecord }>(`SELECT execution_id,record FROM agent_platform.energy_execution_records ORDER BY created_at DESC LIMIT 1`)
      const state = await client.query<{ state: { energyKwh: number; socPercent: number; revision: number; updatedAt: string; stateRef?: ResourceRef; simulatedAt?: string } }>(`SELECT state FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1'`)
      return { receipt: receipt.rows[0], state: state.rows[0]?.state }
    }, { readOnly: true })
    if (previous.receipt === undefined || previous.state === undefined || previous.receipt.record.finalStateRef === undefined) throw new Error('the legacy recovery fixture requires the earlier simulated execution')
    const receipt = previous.receipt
    const finalStateRef = receipt.record.finalStateRef
    if (finalStateRef === undefined) throw new Error('the execution receipt has no final state ref')
    const oldBytes = await blobStore.readAuthorized({ scopeRef, blobRef: finalStateRef }, context)
    const oldArtifact = JSON.parse(new TextDecoder().decode(oldBytes)) as Record<string, unknown>
    delete oldArtifact['simulatedAt']
    const legacyArtifact = await createBlobArtifactWriter(blobStore).putBytes({ scopeRef, content: new TextEncoder().encode(JSON.stringify(oldArtifact)), mediaType: 'application/vnd.ontology.virtual-solix-state+json' }, context)
    const steps = receipt.record.stepRecords ?? []
    const legacyReceipt = {
      ...receipt.record, finalStateRef: legacyArtifact.blobRef,
      stepRecords: steps.map((step, index) => index === steps.length - 1 ? { ...step, stateRef: legacyArtifact.blobRef } : step),
    }
    const legacyState = { ...previous.state }
    delete legacyState.stateRef
    delete legacyState.simulatedAt
    await controlDatabase.withIdentityScope(scopeRef, async (client) => {
      await client.query(`UPDATE agent_platform.energy_execution_records SET record=$1::jsonb WHERE execution_id=$2::uuid`, [JSON.stringify(legacyReceipt), receipt.execution_id])
      await client.query(`UPDATE agent_platform.virtual_solix_states SET state=$1::jsonb WHERE device_id='virtual-solix-1'`, [JSON.stringify(legacyState)])
    })
    const recovered = await recoverLegacyVirtualSolixState({ database: controlDatabase, blobs: blobStore, artifacts: createBlobArtifactWriter(blobStore), state: legacyState, ctx: context })
    const originalInput = receipt.record.inputRefs[0]
    if (originalInput === undefined) throw new Error('the execution receipt has no scenario input ref')
    const scenario = decodeEnergyOperationInput(await blobStore.readAuthorized({ scopeRef, blobRef: originalInput }, context))
    expect(recovered.simulatedAt).toBe(scenario.snapshot.manifest.horizon.end)
    expect(recovered.stateRef.digest).not.toBe(legacyArtifact.blobRef.digest)
    const reader = createVirtualSolixExecutionSurface({ database: controlDatabase, blobs: blobStore, artifacts: createBlobArtifactWriter(blobStore) })
    const reread = await reader.getVirtualState?.(context)
    expect(reread?.stateRef?.digest).toBe(recovered.stateRef.digest)
    expect(reread?.revision).toBe(legacyState.revision)
  })
})
