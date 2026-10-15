import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresCandidateSourceStore,
  PostgresJobStore,
  PostgresResearchExecutionStore,
} from '@ontology/adapter-control-postgres'
import {
  CandidateSourceIngestionService,
  JobService,
  JobWorker,
  ResearchWorkflowService,
  WebResearchService,
} from '@ontology/application'
import { createWorkerStageRegistry, ResearchStageHandler } from '@ontology/app-worker'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  AtomicReserveOutcome,
  AtomicSettleOutcome,
  BudgetLedgerPort,
  BudgetLedgerRecord,
  BudgetLedgerSnapshot,
  BudgetReserveInput,
  BudgetSettlementInput,
  CreateIndustryWorkspaceInput,
  ImmutableArtifactWriter,
  ResourceRef,
  ToolContext,
  Uuid,
  WebSearchProvider,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RECORDED_AT = '2026-10-15T00:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let app: ReturnType<typeof createApiServer>
let workspaceId: Uuid
let worker: JobWorker
let executions: PostgresResearchExecutionStore
let sourceStore: PostgresCandidateSourceStore

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function digestOf(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: sha('a'), kind: 'artifact' }
}

class FakeWriter implements ImmutableArtifactWriter {
  async putBytes(): Promise<{ blobRef: ResourceRef; contentDigest: `sha256:${string}`; integrity: { algorithm: 'sha256'; digest: `sha256:${string}` } }> {
    throw new Error('archived snapshots must not re-archive bytes')
  }
}

class FakeProvider implements WebSearchProvider {
  readonly providerRef = { id: 'web-search.fake', version: '1.0.0', digest: digestOf('fake') }
  constructor(readonly result: WebSearchProviderResult) {}
  async search(): Promise<WebSearchProviderResult> { return this.result }
}

class FakeBudget implements BudgetLedgerPort {
  #reservations = new Map<string, string>()
  async openLedger(input: { readonly ledgerId: string; readonly kind: 'run' | 'background'; readonly runId?: string }): Promise<BudgetLedgerRecord> {
    return {
      ledgerId: input.ledgerId, kind: input.kind, limits: { maxToolCalls: 10, maxRepairAttempts: 1, maxParallelTools: 2, maxRows: 100, maxBytes: 100000, deadlineMs: 600000 },
      deadline: '2099-01-01T00:00:00Z', consumed: { toolCalls: 0, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0 }, revision: '1', createdAt: RECORDED_AT, updatedAt: RECORDED_AT,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    }
  }
  #snapshot(ledgerId: string): BudgetLedgerSnapshot {
    return { ledgerId, kind: 'background', deadline: '2099-01-01T00:00:00Z', remaining: { deadline: '2099-01-01T00:00:00Z', toolCallsRemaining: 9, repairAttemptsRemaining: 1, parallelToolLimit: 2 }, rowsRemaining: 100, bytesRemaining: 100000, parallelToolsRemaining: 2 }
  }
  async reserve(input: BudgetReserveInput): Promise<AtomicReserveOutcome> {
    const existing = this.#reservations.get(input.idempotencyKey) ?? randomUUID()
    this.#reservations.set(input.idempotencyKey, existing)
    return {
      granted: true, remaining: this.#snapshot(input.ledgerId),
      reservation: { reservationId: existing, ledgerId: input.ledgerId, idempotencyKey: input.idempotencyKey, status: 'reserved', intentRequired: false, reserved: { toolCalls: 1, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0 }, parallelTools: 0, usageUnknown: false, evidenceRefs: [], deadline: input.requestedDeadline ?? '2099-01-01T00:00:00Z', grantedAt: RECORDED_AT, expiresAt: '2099-01-01T00:00:00Z' },
    }
  }
  async recordIntent(): Promise<never> { throw new Error('not used') }
  async settle(input: BudgetSettlementInput): Promise<AtomicSettleOutcome> {
    return { reservation: { reservationId: input.reservationId, ledgerId: input.ledgerId, idempotencyKey: 'x', status: 'settled', intentRequired: false, reserved: { toolCalls: 1, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0 }, parallelTools: 0, usageUnknown: false, evidenceRefs: [], deadline: '2099-01-01T00:00:00Z', grantedAt: RECORDED_AT, expiresAt: '2099-01-01T00:00:00Z' }, applied: true, remaining: this.#snapshot(input.ledgerId) }
  }
  async remaining(ledgerId: string): Promise<BudgetLedgerSnapshot> { return this.#snapshot(ledgerId) }
}

function authenticator(request: { headers: Record<string, string | string[] | undefined> }): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ['researcher']
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return { principal: { tenantId: chosen.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 }, spaceId: chosen.spaceId }
}

function headersOf(roles = 'researcher', scopeName = 'primary'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-test-roles': roles, 'x-test-subject': 'researcher-1', 'x-test-scope': scopeName, 'idempotency-key': `idem-${randomUUID()}` }
}

async function post(url: string, body?: object, roles = 'researcher', scopeName = 'primary') {
  return app.inject({ method: 'POST', url, headers: headersOf(roles, scopeName), ...(body === undefined ? {} : { payload: body }) })
}
async function get(url: string, roles = 'researcher') {
  return app.inject({ method: 'GET', url, headers: headersOf(roles) })
}

const body = {
  goal: '按 GB50500 建桥架计价本体',
  allowedResearchDomains: ['standards.example.org'],
  targetKinds: ['object', 'attribute'],
  sourceLimit: 5,
  candidateLimit: 5,
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'research-runs')
  otherScope = await createJobScope(harness.adminClient, 'research-runs-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  const jobStore = new PostgresJobStore(database)
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  executions = new PostgresResearchExecutionStore(database)
  sourceStore = new PostgresCandidateSourceStore(database)

  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const anchorJobId = randomUUID()
  await jobService.createJob({ jobId: anchorJobId, kind: 'ingestion', sourceRef: 'research-runs', documentRef: randomUUID(), pipelineVersion: '1.0.0', idempotencyKey: `anchor-${anchorJobId.slice(0, 12)}` }, ctx)
  workspaceId = randomUUID()
  const createInput: CreateIndustryWorkspaceInput = {
    workspace: { workspaceId, namespace: 'test.industry', displayName: 'Research runs workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, headRevision: '1', state: 'draft' },
    firstDraft: { workspaceId, revision: '1', digest: sha('d'), documentSetRef: resourceRef(), candidateRefs: [] },
    idempotencyKey: `ws-${randomUUID().slice(0, 12)}`, requestDigest: sha('1'), actor: 'tester', recordedAt: RECORDED_AT,
    outbox: { outboxId: randomUUID(), topic: 'asset.workspace.created', payload: { workspaceId }, idempotencyKey: `ob-${randomUUID().slice(0, 12)}`, availableAt: RECORDED_AT, createdAt: RECORDED_AT }, outboxJobId: anchorJobId,
  }
  await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)

  const provider = new FakeProvider({
    pages: [{ url: 'https://standards.example.org/gb50500', title: 'GB50500', snippet: 'load tables', fetchedAt: RECORDED_AT,
      contentDigest: digestOf('page-a'), snapshotRef: { id: randomUUID(), version: '1.0.0', digest: digestOf('page-a'), kind: 'artifact' } }],
    truncated: false, excludedCount: 0,
  })
  const workflow = new ResearchWorkflowService({
    jobs: jobService,
    executions,
    research: new WebResearchService({ webSearch: provider, ingestion: new CandidateSourceIngestionService({ artifacts: new FakeWriter(), sources: sourceStore, now: () => RECORDED_AT }) }),
    budget: new FakeBudget(),
    now: () => RECORDED_AT,
  })
  // The worker is driven directly in this test; the real host mounts the same router.
  worker = new JobWorker({
    store: jobStore,
    handlers: createWorkerStageRegistry({ ingestion: { get: () => undefined }, research: new ResearchStageHandler({ workflow }) }),
    budget: new FakeBudget(),
    workerId: 'research-test-worker',
    now: () => '2099-01-01T00:00:00Z',
  })
  app = createApiServer({ authenticate: authenticator, candidateSources: { sources: sourceStore, researchWorkflow: workflow } })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('bounded research runs (real PostgreSQL)', () => {
  it('accepts an async run with 202, returns the queued execution, and runs it in the worker', async () => {
    const accepted = await post(`/api/v1/industry-workspaces/${workspaceId}/research-runs`, body)
    expect(accepted.statusCode).toBe(202)
    const payload = accepted.json() as { data: { researchId: string; jobId: string; execution: { status: string } } }
    expect(payload.data.execution.status).toBe('queued')
    expect(payload.data.researchId).toBe(payload.data.jobId)

    for (let i = 0; i < 8; i += 1) {
      const result = await worker.runOnce(scope.scopeRef, ctx)
      if (result.disposition === 'idle') break
    }

    const read = await get(`/api/v1/industry-workspaces/${workspaceId}/research-runs/${payload.data.researchId}`)
    expect(read.statusCode).toBe(200)
    const view = read.json() as { data: { execution: { status: string; stage: string; stopReason: string; sourceCount: number; sources?: { url: string }[] }; usage?: unknown } }
    expect(view.data.execution).toMatchObject({ status: 'awaiting_confirmation', stage: 'awaiting_source_review', stopReason: 'completed', sourceCount: 1 })
    expect(view.data.execution.sources?.[0]?.url).toBe('https://standards.example.org/gb50500')
    expect(view.data.usage).toBeDefined()

    const listed = await sourceStore.listSources(scope.scopeRef, workspaceId, {}, ctx)
    expect(listed.some((source) => source.trustTier === 'agent_researched' && source.reviewState === 'proposed')).toBe(true)
  })

  it('cancels a run and freezes it: a later terminal write cannot resurrect it', async () => {
    const accepted = await post(`/api/v1/industry-workspaces/${workspaceId}/research-runs`, body)
    const { researchId } = (accepted.json() as { data: { researchId: string } }).data
    const cancelled = await post(`/api/v1/industry-workspaces/${workspaceId}/research-runs/${researchId}/cancel`, {})
    expect(cancelled.statusCode).toBe(200)
    expect((cancelled.json() as { data: { execution: { status: string } } }).data.execution.status).toBe('cancelled')

    const frozen = await executions.getExecution(scope.scopeRef, researchId, ctx)
    if (frozen === undefined) throw new Error('expected the cancelled run to be readable')
    await executions.putExecution(scope.scopeRef, { ...frozen, status: 'completed' }, ctx)
    const reread = await executions.getExecution(scope.scopeRef, researchId, ctx)
    expect(reread?.status).toBe('cancelled')
  })

  it('isolates a run from another tenant/space', async () => {
    const accepted = await post(`/api/v1/industry-workspaces/${workspaceId}/research-runs`, body)
    const { researchId } = (accepted.json() as { data: { researchId: string } }).data
    const foreign = await get(`/api/v1/industry-workspaces/${workspaceId}/research-runs/${researchId}`, 'researcher')
    expect(foreign.statusCode).toBe(200)
    const otherScopeRead = await executions.getExecution(otherScope.scopeRef, researchId, toolContext(otherScope.tenantId, otherScope.spaceId, ['platform-admin']))
    expect(otherScopeRead).toBeUndefined()
  })
})
