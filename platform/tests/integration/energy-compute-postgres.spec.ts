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
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { InMemoryRunStore, JobService, JobWorker, RunService } from '@ontology/application'
import type { RunProfileBinder } from '@ontology/application'
import {
  createBlobArtifactWriter,
  createEnergyComputeConfig,
  createSimulationJobPort,
  createToolGatewayComposition,
} from '@ontology/app-api'
import { createSimulationRunGuard, createWorkerStageRegistry, SimulationStageHandler } from '@ontology/app-worker'
import { createToolContext } from '@ontology/contracts'
import type {
  OperationRegistry,
  ResolvedProfile,
  ResourceRef,
  ScopeRef,
  StructuredQueryPort,
  ToolContext,
  ToolGateway,
} from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import type { SemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { RunToolBinding } from '@ontology/tool-services'
import {
  ENERGY_OPERATION_INPUT_MEDIA_TYPE,
  ENERGY_OPERATION_REGISTRY,
  ENERGY_REGISTERED_OPERATIONS,
  SimulationExecutionService,
  encodeEnergyOperationInput,
  energyOperationRef,
} from '@ontology/extension-home-energy'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  canonicalToolValidator,
  resolvedProfile,
} from '../unit/tool-gateway-fixtures'
import { planFor, planningRequest } from '../fixtures/home-energy'
import { RecordingControlRepository } from '../unit/component-registry-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SPACE_LATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN = '33333333-3333-4333-8333-333333333333'
const LEDGER = '88888888-8888-4888-8888-888888888888'
const DIGEST = `sha256:${'a'.repeat(64)}`

const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const SCOPE_LATE: ScopeRef = { tenantId: TENANT, spaceId: SPACE_LATE }

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(subjectId = 'node-46-integration', spaceId = SPACE): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId,
      roles: ['data-editor', 'operator', 'business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: RUN,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-node-46-integration',
  })
}

const CTX = toolContext()

const queryStub: StructuredQueryPort = {
  async validate() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async execute() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async cancel(request) {
    return { targetRef: request.targetRef, state: 'unsupported', acceptedAt: '2026-09-21T00:00:00Z' }
  },
}

const mappingsStub: SemanticMappingRegistry = { resolve: () => undefined, list: () => [] }

function operationInput(includePlan: boolean): EnergyOperationInput {
  const request = planningRequest()
  const plan = planFor(request.snapshot.manifest.slotCount)
  return {
    kind: 'home-energy.operation-input',
    version: '1.0.0',
    dataMode: 'synthetic',
    snapshot: request.snapshot,
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
    ...(includePlan ? { plan } : {}),
  }
}

function profileWithCompute(registry: OperationRegistry): ResolvedProfile {
  return resolvedProfile({
    toolBindings: [{ toolId: 'data_query', enabled: true }],
    computeBindings: registry.operations.map((operation) => ({
      operationRef: operation.operationRef,
      handlerRef: operation.handlerRef,
      inputSchemaRef: {
        id: `${operation.operationRef.id}.input`,
        version: '1.0.0',
        digest: operation.inputSchemaDigest,
      },
      outputSchemaRef: {
        id: `${operation.operationRef.id}.output`,
        version: '1.0.0',
        digest: operation.outputSchemaDigest,
      },
      readOnly: true as const,
      enabled: true,
      limits: operation.limits,
    })),
  })
}

const neverBinder: RunProfileBinder = {
  async bindProfileForRun() {
    throw new Error('the integration test inserts its run directly')
  },
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let budget: BudgetService
let evidenceStore: PostgresEvidenceStore
let gateway: ToolGateway

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'energy-compute-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'energy-compute-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'energy-compute-late-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE_LATE],
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

  objectDir = await mkdtemp(join(tmpdir(), 'energy-compute-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)

  const compute = createEnergyComputeConfig({ blobStore, validator: canonicalToolValidator() })
  const handler = new DataQueryHandler({ query: queryStub, mappings: mappingsStub, compute })
  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  })
  const binding: RunToolBinding = {
    runId: RUN,
    ledgerId: LEDGER,
    resolvedProfile: profileWithCompute(ENERGY_OPERATION_REGISTRY),
    operations: ENERGY_OPERATION_REGISTRY,
  }
  gateway = composition.forRun(binding)
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

async function archiveInput(input: EnergyOperationInput, ctx: ToolContext = CTX): Promise<ResourceRef> {
  const writer = createBlobArtifactWriter(blobStore)
  const stored = await writer.putBytes(
    {
      scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      content: encodeEnergyOperationInput(input),
      mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE,
    },
    ctx,
  )
  return stored.blobRef
}

describe('data_query.kind=compute against real PostgreSQL and blob-local', () => {
  it('runs on a real containerised PostgreSQL', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[energy-compute] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('executes a registered energy operation into a typed result plus durable evidence', async () => {
    await budget.openLedger({ ledgerId: LEDGER, kind: 'run', runId: RUN }, CTX)
    const inputRef = await archiveInput(operationInput(false))
    const plan = ENERGY_REGISTERED_OPERATIONS[0]
    if (plan === undefined) throw new Error('the plan operation is not registered')

    const result = await gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: {
          kind: 'compute',
          operationRef: plan.operationRef,
          inputSchemaDigest: plan.inputSchemaDigest,
          inputRefs: [inputRef],
          parameters: { strategyWhitelist: ['self_consumption'] },
        },
      },
      CTX,
    )

    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)

    // The tool result bytes are really archived and readable in scope.
    const dataRef = result.dataRef
    if (dataRef === undefined) throw new Error('the result carried no dataRef')
    const authorized = await blobStore.getAuthorized({ scopeRef: SCOPE, blobRef: dataRef }, CTX)
    expect(authorized.integrityVerified).toBe(true)
    const payload = JSON.parse(
      new TextDecoder().decode(
        await blobStore.readAuthorized({ scopeRef: SCOPE, blobRef: dataRef }, CTX),
      ),
    ) as { resultKind?: string; computation?: { resultRef?: ResourceRef; domainStatus?: string } }
    expect(payload.resultKind).toBe('computation')
    expect(payload.computation?.domainStatus).toBe('known')
    const domainRef = payload.computation?.resultRef
    if (domainRef === undefined) throw new Error('the computation carried no resultRef')
    const domainBytes = await blobStore.readAuthorized({ scopeRef: SCOPE, blobRef: domainRef }, CTX)
    const domainResult = JSON.parse(new TextDecoder().decode(domainBytes)) as {
      executionMode?: string
      liveSupported?: boolean
      selection?: { optimality?: string }
    }
    expect(domainResult.executionMode).toBe('simulation')
    expect(domainResult.liveSupported).toBe(false)
    expect(domainResult.selection?.optimality).toBe('best_of_tested_candidates')

    // The evidence envelope is durably recorded and explicitly a simulation computation.
    const evidenceRef = result.evidenceRefs[0]
    if (evidenceRef === undefined) throw new Error('the result carried no evidenceRef')
    const record = await evidenceStore.get(SCOPE, evidenceRef.id, CTX)
    expect(record?.envelope.kind).toBe('computation')
    expect(record?.envelope.dataMode).toBe('simulation')
    expect(record?.envelope.payloadRef?.id).toBe(dataRef.id)
  })

  it('never sends a device request and refuses mode=live', async () => {
    const sent: string[] = []
    const execution = new SimulationExecutionService({
      jobs: createSimulationJobPort(
        new JobService({ store: new PostgresJobStore(controlDatabase) }),
      ),
      deviceDriver: {
        async sendCommand() {
          sent.push('device')
        },
      },
    })
    const inputRef = await archiveInput(operationInput(true))
    const plan = planFor(4)
    await expect(
      execution.requestExecution(
        {
          operationRef: energyOperationRef('home-energy.simulate'),
          planRef: plan.planRef,
          inputRefs: [inputRef],
          mode: 'live',
          runId: RUN,
          idempotencyKey: `sim-live-${randomUUID()}`,
        },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(sent).toEqual([])

    const record = await execution.requestExecution(
      {
        operationRef: energyOperationRef('home-energy.simulate'),
        planRef: plan.planRef,
        inputRefs: [inputRef],
        mode: 'simulation',
        runId: RUN,
        idempotencyKey: `sim-run-${randomUUID()}`,
      },
      CTX,
    )
    expect(record.mode).toBe('simulation')
    expect(record.deviceRequestsSent).toBe(0)
    expect(sent).toEqual([])
  })

  it('does not revive a cancelled run when a late simulation job completes', async () => {
    const runStore = new InMemoryRunStore()
    const control = new RecordingControlRepository()
    const runService = new RunService({ store: runStore, control, profiles: neverBinder })
    const runId = randomUUID()
    const workerSubject = 'node-46-worker'
    const lateCtx = toolContext(workerSubject, SPACE_LATE)

    await runStore.insertRun(
      SCOPE_LATE,
      {
        runId,
        ownerSubjectId: workerSubject,
        profileRef: { id: 'home-energy-demo', version: '1.0.0' },
        resolvedProfileHash: DIGEST,
        runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
        question: 'simulate a plan',
        context: { timeZone: 'UTC' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `run-${runId}`,
        requestDigest: DIGEST,
        createdAt: '2026-09-21T00:00:00Z',
      },
      lateCtx,
    )

    const cancelled = await runService.cancelRun(
      { runId, reason: 'the user cancelled the run', expectedRevision: '1' },
      lateCtx,
    )
    expect(cancelled.state).toBe('cancelled')

    const compute = createEnergyComputeConfig({ blobStore, validator: canonicalToolValidator() })
    const inputRef = await archiveInput(operationInput(true), lateCtx)
    const jobService = new JobService({ store: new PostgresJobStore(controlDatabase) })
    const execution = new SimulationExecutionService({ jobs: createSimulationJobPort(jobService) })
    const plan = planFor(4)
    const scheduled = await execution.requestExecution(
      {
        operationRef: energyOperationRef('home-energy.simulate'),
        planRef: plan.planRef,
        inputRefs: [inputRef],
        mode: 'simulation',
        runId,
        idempotencyKey: `sim-late-${runId}`,
      },
      lateCtx,
    )

    const stageRegistry = createWorkerStageRegistry({
      ingestion: { get: () => undefined },
      simulation: new SimulationStageHandler({
        reader: compute.reader,
        artifacts: compute.artifacts,
        operations: compute.registry,
        handlers: compute.handlers,
        runGuard: createSimulationRunGuard(runService),
      }),
    })
    const worker = new JobWorker({
      store: new PostgresJobStore(controlDatabase),
      handlers: stageRegistry,
      budget,
    })
    const processed = await worker.runOnce(SCOPE_LATE, lateCtx)
    expect(processed.disposition).toBe('stopped')

    const finalRun = await runService.getRun(runId, lateCtx)
    expect(finalRun.state).toBe('cancelled')
    const abandoned = await runService.listAbandonedAttempts(runId, lateCtx)
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.reason).toContain('cancelled')

    const job = await jobService.getJob(scheduled.executionId, lateCtx)
    expect(job.stage).toBe('awaiting_review')
    expect(job.documentRef).toContain('"quarantined":true')
  })
})
