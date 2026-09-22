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
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { JobService } from '@ontology/application'
import {
  createApiServer,
  createBlobArtifactWriter,
  createEnergySimulationSurface,
  createScopedBlobReader,
  createSimulationExecutionSurface,
  createSimulationJobPort,
} from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { ENERGY_OPERATION_REGISTRY, createEnergyComputeHandlers } from '@ontology/extension-home-energy'
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
  })
  const execution = createSimulationExecutionSurface({
    jobs: createSimulationJobPort(new JobService({ store: new PostgresJobStore(controlDatabase) })),
    deviceDriver: {
      async sendCommand() {
        deviceRequests.push('device')
      },
    },
  })
  app = createApiServer({ authenticate: loopbackAuth, simulations: { service, execution } })
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
  it('archives a synthetic scenario and runs a registered plan, integrity-verified on read', async () => {
    const scenario = await buildScenario(4, 'sunny')
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
    const first = await buildScenario(4, 'sunny')
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
    const scenario = await buildScenario(4, 'sunny')
    const detail = await planFor(scenario)
    const planRef =
      detail.result.selection.selectedPlanRef ??
      detail.result.candidates[0]?.plan.planRef ??
      detail.result.baseline?.plan.planRef
    if (planRef === undefined) throw new Error('the plan carried no plan reference')

    const simulation = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: {
        operationRef: { id: 'home-energy.simulate', version: '1' },
        planRef,
        inputRefs: [scenario.inputRef],
        mode: 'simulation',
      },
    })
    expect(simulation.statusCode).toBe(202)
    const record = (simulation.json() as { data: { mode: string; liveSupported: boolean; deviceRequestsSent: number } })
      .data
    expect(record.mode).toBe('simulation')
    expect(record.liveSupported).toBe(false)
    expect(record.deviceRequestsSent).toBe(0)

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
})
