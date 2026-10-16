import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAssetWorkspaceStore,
  PostgresBudgetLedgerStore,
  PostgresComponentRegistryStore,
  PostgresJobStore,
  PostgresProfileStore,
  PostgresResearchExecutionStore,
  PostgresResearchRunAdmissionStore,
  PostgresRunStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
  PostgresWorkspaceResearchRunConfigStore,
} from '@ontology/adapter-control-postgres'
import {
  IndustryWorkspaceService,
  JobService,
  JobWorker,
  ProfileResolver,
  RunService,
  WorkspaceResearchRunConfigService,
  WorkspaceResearchRunService,
} from '@ontology/application'
import type { ResearchAdmissionArtifactPort, RunProfileBinder, RunWorkspaceResearchBinder } from '@ontology/application'
import { createWorkerStageRegistry, ResearchStageHandler } from '@ontology/app-worker'
import { BudgetService } from '@ontology/core'
import type {
  ModelingBrief,
  ResearchRunAdmissionRequest,
  ResourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RUNTIME_REF: VersionRef = { id: 'runtime-pi', version: 'pi-runtime@1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const POLICY_REF: VersionRef = { id: 'core-local-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }

let harness: JobDbHarness
let database: ControlPostgresDatabase
let built: Built

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function artifactIdFor(identity: string): string {
  const hex = createHash('sha256').update(`artifact:${identity}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A real content-addressed artifact store (in memory): the same identity yields the same ref. */
class MemoryArtifacts implements ResearchAdmissionArtifactPort {
  readonly #bytes = new Map<string, Uint8Array>()
  async write(identity: string, bytes: Uint8Array): Promise<ResourceRef> {
    const id = artifactIdFor(identity)
    const digest = sha256(bytes)
    this.#bytes.set(`${id}:${digest}`, bytes)
    return { id, version: '1.0.0', digest, kind: 'artifact' }
  }
  async read(ref: ResourceRef): Promise<{ bytes: Uint8Array; contentDigest: string }> {
    const bytes = this.#bytes.get(`${ref.id}:${ref.digest}`)
    if (bytes === undefined) throw new Error(`the artifact ${ref.id} was never written`)
    return { bytes, contentDigest: sha256(bytes) }
  }
}

interface Built {
  readonly service: WorkspaceResearchRunService
  readonly runs: RunService
  readonly executions: PostgresResearchExecutionStore
  readonly workspaceService: IndustryWorkspaceService
  readonly workerA: JobWorker
  readonly workerB: JobWorker
}

function build(pool: ControlPostgresDatabase): Built {
  const control = new ControlPostgresRepository(pool)
  const jobStore = new PostgresJobStore(pool)
  const workspaceStore = new PostgresAssetWorkspaceStore(pool)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: jobStore })
  const configService = new WorkspaceResearchRunConfigService({
    workspaces: workspaceStore,
    configs: new PostgresWorkspaceResearchRunConfigStore(pool),
    runtimeRef: RUNTIME_REF,
    policyRef: POLICY_REF,
    toolBindings: [
      { toolId: 'ontology_lookup', enabled: true, maxCallsPerRun: 4 },
      { toolId: 'document_search', enabled: true },
      { toolId: 'web_search', enabled: true },
      { toolId: 'data_query', enabled: false },
    ],
    now: () => new Date().toISOString(),
  })
  const profileResolver = new ProfileResolver({
    control,
    store: new PostgresProfileStore(pool),
    registry: new PostgresComponentRegistryStore(pool),
    industry: { getManifest: () => Promise.resolve(undefined) },
    validator: () => ({ valid: true, issues: [] }),
    workspaceResearch: configService,
  })
  const runs = new RunService({
    store: new PostgresRunStore(pool),
    control,
    profiles: { bindProfileForRun: () => Promise.reject(new Error('a scenario profile must never be bound by a research admission')) } satisfies RunProfileBinder,
    workspaceResearch: { bindWorkspaceResearchForRun: (request, scopeRef, c) => profileResolver.bindWorkspaceResearchRun(request, scopeRef, c) } satisfies RunWorkspaceResearchBinder,
  })
  const workflowStore = new PostgresWorkflowStore(pool)
  const dispatchStore = new PostgresWorkflowDispatchStore(pool)
  const admissionStore = new PostgresResearchRunAdmissionStore(pool)
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(pool), control })
  const executions = new PostgresResearchExecutionStore(pool)
  const service = new WorkspaceResearchRunService({
    admissions: admissionStore,
    runs,
    configs: configService,
    manifests: workflowStore,
    budget,
    dispatch: dispatchStore,
    artifacts: new MemoryArtifacts(),
    jobs: new JobService({ store: jobStore }),
    executions,
  })
  // The router decides that an agentic research job needs no background ledger; the research handler
  // only hands the accepted run to the same durable dispatch store (`initial-drive`).
  const handlers = createWorkerStageRegistry({
    ingestion: { get: () => undefined },
    research: new ResearchStageHandler({ dispatch: dispatchStore }),
  })
  const workerA = new JobWorker({ store: jobStore, handlers, budget, workerId: 'research-worker-a', now: () => new Date().toISOString() })
  const workerB = new JobWorker({ store: jobStore, handlers, budget, workerId: 'research-worker-b', now: () => new Date().toISOString() })
  return { service, runs, executions, workspaceService, workerA, workerB }
}

let scopeCounter = 0
async function freshScope(prefix: string): Promise<{ scope: JobTestScope; ctx: ToolContext }> {
  scopeCounter += 1
  const scope = await createJobScope(harness.adminClient, `${prefix}-${scopeCounter}`)
  return { scope, ctx: toolContext(scope.tenantId, scope.spaceId, ['researcher', 'platform-admin'], `${prefix}-${scopeCounter}`) }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  built = build(database)
}, 240_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

async function bootstrapWorkspace(c: ToolContext): Promise<string> {
  const created = await built.workspaceService.createWorkspace(
    { namespace: `research-${randomUUID().slice(0, 8)}`, displayName: 'S09 research workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'document' } },
    `ws-${randomUUID().slice(0, 12)}`,
    'tester',
    c,
  )
  // The workspace bootstrap emits an ingestion anchor job. It is not the subject of this test, so
  // park it terminally: the only claimable job is then the agentic research scheduler job.
  await harness.adminClient.query(
    `UPDATE agent_platform.jobs SET stage = 'cancelled' WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND kind = 'ingestion'`,
    [c.principal.tenantId, c.allowedResources.spaceId],
  )
  return created.workspace.workspaceId
}

function requestFor(workspaceId: string, idempotencyKey: string): ResearchRunAdmissionRequest {
  const brief: ModelingBrief = { schemaVersion: 'modeling-brief@1', workspaceId, goal: '整理 GB50500 计价规则', allowedResearchDomains: ['example.com'], targetKinds: ['object', 'attribute'], mustCover: [{ kind: 'rule', name: '停机条件' }] }
  return {
    schemaVersion: 'research-run-admission-request@1',
    workspaceId,
    draftRevision: '1',
    brief,
    context: { timeZone: 'UTC', siteRef: 'research-site' },
    preferences: { route: 'pi', allowWeb: true },
    allowedDomains: ['example.com'],
    limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2030-01-01T00:00:00Z' },
    idempotencyKey,
  }
}

async function countScoped(table: string, runId: string, column = 'run_id'): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE ${column} = $1::uuid`,
    [runId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function jobRow(jobId: string): Promise<{ stage: string; kind: string; pipeline_version: string; last_error?: unknown } | undefined> {
  const result = await harness.adminClient.query<{ stage: string; kind: string; pipeline_version: string; last_error: unknown }>(
    `SELECT stage, kind, pipeline_version, last_error FROM agent_platform.jobs WHERE job_id = $1::uuid`,
    [jobId],
  )
  return result.rows[0]
}

async function backgroundLedgerCount(ledgerId: string): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.budget_ledgers WHERE ledger_id = $1::uuid AND kind = 'background'`,
    [ledgerId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

describe('research dispatch handoff and delivery projection (real PostgreSQL, S09)', () => {
  it('accepts a run, creates exactly one agentic scheduler job, and never a background ledger', async () => {
    const { scope, ctx } = await freshScope('handoff-accept')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `accept-${randomUUID().slice(0, 12)}`), ctx)

    await expect(countScoped('runs', result.runId)).resolves.toBe(1)
    await expect(countScoped('workflow_run_manifests', result.runId)).resolves.toBe(1)
    await expect(countScoped('research_run_admission', result.runId)).resolves.toBe(1)
    await expect(countScoped('budget_ledgers', result.runId)).resolves.toBe(1)
    await expect(countScoped('workflow_dispatches', result.runId)).resolves.toBe(1)

    const job = await jobRow(result.researchId)
    expect(job).toMatchObject({ kind: 'research', pipeline_version: '2.0.0', stage: 'received' })
    // No background ledger has ever been opened for the scheduler job: the run's one manifest ledger is
    // the single ledger execution consumes.
    await expect(backgroundLedgerCount(result.researchId)).resolves.toBe(0)
    expect(scope.tenantId).toBe(ctx.principal.tenantId)
  }, 30_000)

  it('converges two racing job workers onto one dispatch and one execution owner', async () => {
    const { scope, ctx } = await freshScope('handoff-race')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `race-${randomUUID().slice(0, 12)}`), ctx)

    const [first, second] = await Promise.all([
      built.workerA.runOnce(scope.scopeRef, ctx),
      built.workerB.runOnce(scope.scopeRef, ctx),
    ])
    // Exactly one worker claimed the job; the other was idle (the lease is single-owner).
    const dispositions = [first.disposition, second.disposition].sort()
    expect(dispositions).toEqual(['idle', 'stopped'])

    const job = await jobRow(result.researchId)
    expect(job?.stage).toBe('dispatched')
    // The two handoffs (accept's direct enqueue and the worker's idempotent enqueue) converge on ONE
    // durable dispatch; no second execution owner exists.
    await expect(countScoped('workflow_dispatches', result.runId)).resolves.toBe(1)
    await expect(backgroundLedgerCount(result.researchId)).resolves.toBe(0)
  }, 30_000)

  it('replays the handoff idempotently after a crash before the dispatched checkpoint', async () => {
    const { scope, ctx } = await freshScope('handoff-crash')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `crash-${randomUUID().slice(0, 12)}`), ctx)

    // Simulate a crash after the enqueue but before the `dispatched` checkpoint: reset the scheduler
    // job to `received` and abandon its attempt, then reclaim it.
    await harness.adminClient.query(`DELETE FROM agent_platform.job_stage_checkpoints WHERE job_id = $1::uuid`, [result.researchId])
    await harness.adminClient.query(`UPDATE agent_platform.jobs SET stage = 'received' WHERE job_id = $1::uuid`, [result.researchId])
    await harness.adminClient.query(`UPDATE agent_platform.job_attempts SET state = 'abandoned', lease_expires_at = now() - interval '1 hour' WHERE job_id = $1::uuid`, [result.researchId])

    const reclaimed = await built.workerA.runOnce(scope.scopeRef, ctx)
    expect(reclaimed.disposition).toBe('stopped')
    expect((await jobRow(result.researchId))?.stage).toBe('dispatched')
    // A replay reuses the exact same `initial-drive` dispatch; it never opens a second execution owner.
    await expect(countScoped('workflow_dispatches', result.runId)).resolves.toBe(1)
    await expect(backgroundLedgerCount(result.researchId)).resolves.toBe(0)
  }, 30_000)

  it('persists a goal-aware research-execution@2 completion projection from the durable inputs', async () => {
    const { scope, ctx } = await freshScope('delivery')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `delivery-${randomUUID().slice(0, 12)}`), ctx)

    const evidenceRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'artifact' }
    const delivery = {
      runId: result.runId,
      candidateReceipts: [],
      evidenceRefs: [evidenceRef],
      stopReason: 'completed',
      usage: { deadline: '2030-01-01T00:00:00Z', toolCallsRemaining: 4, repairAttemptsRemaining: 1, parallelToolLimit: 1 },
    }

    await built.service.recordDelivery(result.runId, delivery, ctx)
    const projection = await built.executions.getExecution(scope.scopeRef, result.researchId, ctx)
    if (projection?.schemaVersion !== 'research-execution@2') throw new Error('expected the @2 projection')
    expect(projection.runId).toBe(result.runId)
    expect(projection.goal).toMatchObject({ kind: 'industry_workspace_research', workspaceId })
    expect(projection.stopReason).toBe('completed')
    expect(projection.evidence).toHaveLength(1)
    expect(projection.coverageGaps.map((gap) => gap.name)).toEqual(['停机条件'])

    // A replayed delivery rebuilds the identical projection (idempotent), never a second row.
    await built.service.recordDelivery(result.runId, delivery, ctx)
    const reread = await built.executions.getExecution(scope.scopeRef, result.researchId, ctx)
    expect(reread?.schemaVersion).toBe('research-execution@2')
    await expect(countScoped('workspace_research_runs', result.runId)).resolves.toBe(1)
  }, 30_000)
})
