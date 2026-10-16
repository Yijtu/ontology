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
  PostgresResearchRunAdmissionStore,
  PostgresRunStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
  PostgresWorkspaceResearchRunConfigStore,
} from '@ontology/adapter-control-postgres'
import { IndustryWorkspaceService, ProfileResolver, RunService, WorkspaceResearchRunConfigService, WorkspaceResearchRunService } from '@ontology/application'
import type { ResearchAdmissionArtifactPort, RunProfileBinder, RunWorkspaceResearchBinder } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { ResearchRunAdmissionError, workspaceResearchProfileRef } from '@ontology/contracts'
import type {
  ModelingBrief,
  NewResearchRunAdmission,
  ResearchRunAdmission,
  ResearchRunAdmissionRequest,
  ResearchRunAdmissionStore,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
  WorkflowDispatchPort,
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

function artifactIdFor(identity: string): Uuid {
  const hex = createHash('sha256').update(`artifact:${identity}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Uuid
}

/** A real content-addressed artifact store (in memory): the same identity always yields the same ref. */
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

/** A store wrapper that can fail one method once, to inject a fault at one persistence boundary. */
class FaultyAdmissionStore implements ResearchRunAdmissionStore {
  failOn: 'markReady' | 'begin' | undefined
  constructor(private readonly inner: ResearchRunAdmissionStore) {}
  async begin(scopeRef: ScopeRef, admission: NewResearchRunAdmission, c: ToolContext): Promise<ResearchRunAdmission> {
    if (this.failOn === 'begin') { this.failOn = undefined; throw new Error('injected begin failure') }
    return this.inner.begin(scopeRef, admission, c)
  }
  async markReady(scopeRef: ScopeRef, runId: Uuid, c: ToolContext): Promise<ResearchRunAdmission> {
    if (this.failOn === 'markReady') { this.failOn = undefined; throw new Error('injected markReady failure') }
    return this.inner.markReady(scopeRef, runId, c)
  }
  get(scopeRef: ScopeRef, runId: Uuid, c: ToolContext): Promise<ResearchRunAdmission | undefined> {
    return this.inner.get(scopeRef, runId, c)
  }
  findByIdempotencyKey(scopeRef: ScopeRef, key: string, c: ToolContext): Promise<ResearchRunAdmission | undefined> {
    return this.inner.findByIdempotencyKey(scopeRef, key, c)
  }
}

/** A dispatch wrapper that can fail the durable enqueue once, to inject a fault after the barrier. */
class FaultyDispatchStore implements WorkflowDispatchPort {
  failEnqueue = false
  constructor(private readonly inner: PostgresWorkflowDispatchStore) {}
  async enqueue(input: Parameters<WorkflowDispatchPort['enqueue']>[0], c: ToolContext) {
    if (this.failEnqueue) { this.failEnqueue = false; throw new Error('injected dispatch enqueue failure') }
    return this.inner.enqueue(input, c)
  }
  reconcileOpenRuns(c: ToolContext) { return this.inner.reconcileOpenRuns(c) }
  get(dispatchId: Uuid, c: ToolContext) { return this.inner.get(dispatchId, c) }
  claimNext(request: Parameters<WorkflowDispatchPort['claimNext']>[0], c: ToolContext) { return this.inner.claimNext(request, c) }
  renew(request: Parameters<WorkflowDispatchPort['renew']>[0], c: ToolContext) { return this.inner.renew(request, c) }
  complete(fence: Parameters<WorkflowDispatchPort['complete']>[0], c: ToolContext) { return this.inner.complete(fence, c) }
  fail(request: Parameters<WorkflowDispatchPort['fail']>[0], c: ToolContext) { return this.inner.fail(request, c) }
  cancel(request: Parameters<WorkflowDispatchPort['cancel']>[0], c: ToolContext) { return this.inner.cancel(request, c) }
  cancelRun(runId: Uuid, c: ToolContext) { return this.inner.cancelRun(runId, c) }
}

interface Built {
  readonly service: WorkspaceResearchRunService
  readonly admissionStore: PostgresResearchRunAdmissionStore
  readonly workflowStore: PostgresWorkflowStore
  readonly dispatchStore: PostgresWorkflowDispatchStore
  readonly runs: RunService
  readonly workspaceService: IndustryWorkspaceService
  readonly configService: WorkspaceResearchRunConfigService
}

function build(pool: ControlPostgresDatabase, admissionOverride?: ResearchRunAdmissionStore, dispatchOverride?: WorkflowDispatchPort): Built {
  const control = new ControlPostgresRepository(pool)
  const workspaceStore = new PostgresAssetWorkspaceStore(pool)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: new PostgresJobStore(pool) })
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
  const service = new WorkspaceResearchRunService({
    admissions: admissionOverride ?? admissionStore,
    runs,
    configs: configService,
    manifests: workflowStore,
    budget,
    dispatch: dispatchOverride ?? dispatchStore,
    artifacts: new MemoryArtifacts(),
  })
  return { service, admissionStore, workflowStore, dispatchStore, runs, workspaceService, configService }
}

/** A fresh tenant/space per test, so reconciliation can never observe another test's open runs. */
let scopeCounter = 0
async function freshScope(prefix: string, roles: readonly string[] = ['researcher', 'profile-editor']): Promise<{ scope: JobTestScope; ctx: ToolContext }> {
  scopeCounter += 1
  const scope = await createJobScope(harness.adminClient, `${prefix}-${scopeCounter}`)
  return { scope, ctx: toolContext(scope.tenantId, scope.spaceId, roles, `${prefix}-${scopeCounter}`) }
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
    { namespace: `research-${randomUUID().slice(0, 8)}`, displayName: 'zero-pack research workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'document' } },
    `ws-${randomUUID().slice(0, 12)}`,
    'tester',
    c,
  )
  return created.workspace.workspaceId
}

function requestFor(workspaceId: string, idempotencyKey: string, goal = '整理 GB50500 计价规则'): ResearchRunAdmissionRequest {
  const brief: ModelingBrief = { schemaVersion: 'modeling-brief@1', workspaceId, goal, allowedResearchDomains: ['example.com'],     targetKinds: ['object', 'attribute', 'relation'] }
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

async function countUnscoped(table: string, runId: string): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE run_id = $1::uuid`,
    [runId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function ageRun(runId: string): Promise<void> {
  await harness.adminClient.query(
    `UPDATE agent_platform.runs SET updated_at = clock_timestamp() - interval '10 seconds' WHERE run_id = $1::uuid`,
    [runId],
  )
}

describe('WorkspaceResearchRunService admission (real PostgreSQL)', () => {
  it('commits a complete, dispatchable research run and a re-readable authorization receipt', async () => {
    const { ctx } = await freshScope('admit')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `accept-${randomUUID().slice(0, 12)}`), ctx)
    expect(result.reused).toBe(false)
    expect(result.admission.state).toBe('ready')

    const manifest = await built.workflowStore.getRunManifest(result.runId, ctx)
    expect(manifest?.goal).toEqual({ kind: 'industry_workspace_research', workspaceId, draftRevision: '1' })
    expect(manifest?.authorizationReceiptRef).toBeDefined()

    await expect(countUnscoped('runs', result.runId)).resolves.toBe(1)
    await expect(countUnscoped('workflow_run_manifests', result.runId)).resolves.toBe(1)
    await expect(countUnscoped('workflow_dispatches', result.runId)).resolves.toBe(1)
    await expect(countUnscoped('budget_ledgers', result.runId)).resolves.toBe(1)
    await expect(countUnscoped('research_run_admission', result.runId)).resolves.toBe(1)

    const receipt = await built.service.readAuthorizationReceipt(result.runId, ctx)
    expect(receipt.operatorSubjectId).toBe(ctx.principal.subjectId)
    expect(receipt.allowedCommands).toEqual(['submit_candidates'])
    expect(receipt.allowedDomains).toEqual(['example.com'])
    expect(receipt.effectiveQuota).toEqual({ sourceLimit: 5, candidateLimit: 5, deadline: '2030-01-01T00:00:00Z' })
    expect(receipt.runId).toBe(result.runId)
  }, 30_000)

  it('resolves two concurrent submissions of one request into exactly one identity set', async () => {
    const { ctx } = await freshScope('concurrent')
    const workspaceId = await bootstrapWorkspace(ctx)
    const poolA = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
    const poolB = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
    try {
      const serviceA = build(poolA).service
      const serviceB = build(poolB).service
      const request = requestFor(workspaceId, `concurrent-${randomUUID().slice(0, 12)}`)
      const [first, second] = await Promise.all([serviceA.accept(request, ctx), serviceB.accept(request, ctx)])
      expect(first.runId).toBe(second.runId)
      expect(first.researchId).toBe(second.researchId)
      expect([first.reused, second.reused].filter((value) => value)).toHaveLength(1)
      await expect(countUnscoped('runs', first.runId)).resolves.toBe(1)
      await expect(countUnscoped('workflow_run_manifests', first.runId)).resolves.toBe(1)
      await expect(countUnscoped('workflow_dispatches', first.runId)).resolves.toBe(1)
      await expect(countUnscoped('research_run_admission', first.runId)).resolves.toBe(1)
    } finally {
      await poolA.close().catch(() => undefined)
      await poolB.close().catch(() => undefined)
    }
  }, 30_000)

  it('refuses a different goal or authorization under the same idempotency key', async () => {
    const { ctx } = await freshScope('conflict')
    const workspaceId = await bootstrapWorkspace(ctx)
    const key = `conflict-${randomUUID().slice(0, 12)}`
    await built.service.accept(requestFor(workspaceId, key), ctx)
    await expect(built.service.accept(requestFor(workspaceId, key, 'a different goal'), ctx))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  }, 30_000)

  it('leaves an interrupted preparation at the barrier: no dispatch, and a retry is required', async () => {
    const { scope, ctx } = await freshScope('fault')
    const workspaceId = await bootstrapWorkspace(ctx)
    const flaky = new FaultyAdmissionStore(built.admissionStore)
    const flakyService = build(database, flaky).service
    const key = `fault-${randomUUID().slice(0, 12)}`
    flaky.failOn = 'markReady'
    await expect(flakyService.accept(requestFor(workspaceId, key), ctx)).rejects.toThrow('injected markReady failure')

    const admission = await built.admissionStore.findByIdempotencyKey(scope.scopeRef, key, ctx)
    expect(admission?.state).toBe('preparing')
    if (admission === undefined) throw new Error('the reserved admission should exist')
    await expect(countUnscoped('workflow_dispatches', admission.runId)).resolves.toBe(0)

    // Reconciliation beyond 5 seconds must not take over the half-prepared run.
    await ageRun(admission.runId)
    await expect(built.dispatchStore.reconcileOpenRuns(ctx)).resolves.toBe(0)
    await expect(built.dispatchStore.enqueue({ runId: admission.runId, logicalActionId: 'initial-drive' }, ctx))
      .rejects.toMatchObject({ code: 'RUN_NOT_READY' })

    // A retry of the same request finishes the preparation and becomes dispatchable.
    const retried = await built.service.accept(requestFor(workspaceId, key), ctx)
    expect(retried.runId).toBe(admission.runId)
    expect(retried.admission.state).toBe('ready')
    await expect(countUnscoped('workflow_dispatches', admission.runId)).resolves.toBe(1)
  }, 30_000)

  it('never reconciles a research-profile run that has no ready admission', async () => {
    const { ctx } = await freshScope('orphan')
    const workspaceId = await bootstrapWorkspace(ctx)
    await built.configService.resolveForRun({ workspaceId, draftRevision: '1' }, ctx)
    const runId = randomUUID()
    await built.runs.createRun(
      { runId, profileRef: workspaceResearchProfileRef(workspaceId, '1'), question: 'orphan research run', context: { timeZone: 'UTC' }, preferences: { route: 'pi', allowWeb: true }, idempotencyKey: `orphan-${runId.slice(0, 12)}` },
      ctx,
    )
    await ageRun(runId)
    await expect(built.dispatchStore.reconcileOpenRuns(ctx)).resolves.toBe(0)
    await expect(built.dispatchStore.enqueue({ runId, logicalActionId: 'initial-drive' }, ctx))
      .rejects.toMatchObject({ code: 'RUN_NOT_READY' })
  }, 30_000)

  it('recovers a ready admission whose dispatch enqueue failed, via reconciliation', async () => {
    const { scope, ctx } = await freshScope('dispatch-fault')
    const workspaceId = await bootstrapWorkspace(ctx)
    const faultyDispatch = new FaultyDispatchStore(built.dispatchStore)
    const faultService = build(database, undefined, faultyDispatch).service
    const key = `dispatch-fault-${randomUUID().slice(0, 12)}`
    faultyDispatch.failEnqueue = true
    await expect(faultService.accept(requestFor(workspaceId, key), ctx)).rejects.toThrow('injected dispatch enqueue failure')

    const admission = await built.admissionStore.findByIdempotencyKey(scope.scopeRef, key, ctx)
    expect(admission?.state).toBe('ready')
    if (admission === undefined) throw new Error('the admission should be ready')
    await expect(countUnscoped('workflow_dispatches', admission.runId)).resolves.toBe(0)

    // The barrier was already crossed, so reconciliation recovers the lost dispatch.
    await ageRun(admission.runId)
    await expect(built.dispatchStore.reconcileOpenRuns(ctx)).resolves.toBe(1)
    await expect(countUnscoped('workflow_dispatches', admission.runId)).resolves.toBe(1)
  }, 30_000)

  it('never claims a dirty dispatch for a research run whose admission is not ready', async () => {
    const { scope, ctx } = await freshScope('dirty-claim')
    const workspaceId = await bootstrapWorkspace(ctx)
    const flaky = new FaultyAdmissionStore(built.admissionStore)
    const flakyService = build(database, flaky).service
    const key = `dirty-${randomUUID().slice(0, 12)}`
    flaky.failOn = 'markReady'
    await expect(flakyService.accept(requestFor(workspaceId, key), ctx)).rejects.toThrow('injected markReady failure')
    const admission = await built.admissionStore.findByIdempotencyKey(scope.scopeRef, key, ctx)
    if (admission === undefined) throw new Error('the reserved admission should exist')
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify({ runId: admission.runId.toLowerCase() }), 'utf8').digest('hex')}`
    await harness.adminClient.query(
      `INSERT INTO agent_platform.workflow_dispatches (tenant_id, space_id, run_id, action_kind, logical_action_id, payload, payload_digest)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'drive_run', 'dirty-drive', jsonb_build_object('runId', $3::text), $4)`,
      [scope.tenantId, scope.spaceId, admission.runId, payloadDigest],
    )
    await expect(built.dispatchStore.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, ctx)).resolves.toBeUndefined()
  }, 30_000)

  it('reconciles a ready admission whose dispatch was lost after the barrier', async () => {
    const { ctx } = await freshScope('lost')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `lost-dispatch-${randomUUID().slice(0, 12)}`), ctx)
    await harness.adminClient.query(`UPDATE agent_platform.workflow_dispatches SET state = 'cancelled' WHERE run_id = $1::uuid`, [result.runId])
    await ageRun(result.runId)
    await expect(built.dispatchStore.reconcileOpenRuns(ctx)).resolves.toBe(1)
  }, 30_000)

  it('keeps tenant/space isolation: another scope cannot see the admission or read the receipt', async () => {
    const { ctx } = await freshScope('isolation-a')
    const { scope: otherScope, ctx: otherCtx } = await freshScope('isolation-b')
    const workspaceId = await bootstrapWorkspace(ctx)
    const result = await built.service.accept(requestFor(workspaceId, `isolation-${randomUUID().slice(0, 12)}`), ctx)
    await expect(built.admissionStore.get(otherScope.scopeRef, result.runId, otherCtx)).resolves.toBeUndefined()
    await expect(built.service.readAuthorizationReceipt(result.runId, otherCtx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }, 30_000)

  it('rejects a non-researcher caller', async () => {
    const { scope, ctx } = await freshScope('forbidden')
    const workspaceId = await bootstrapWorkspace(ctx)
    const reader = toolContext(scope.tenantId, scope.spaceId, ['scoped-reader'], 'forbidden-reader')
    await expect(built.service.accept(requestFor(workspaceId, `forbidden-${randomUUID().slice(0, 12)}`), reader))
      .rejects.toBeInstanceOf(ResearchRunAdmissionError)
  }, 30_000)
})
