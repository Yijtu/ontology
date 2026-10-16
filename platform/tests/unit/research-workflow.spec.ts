import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  AtomicReserveOutcome,
  AtomicSettleOutcome,
  BudgetConsumption,
  BudgetLedgerLimits,
  BudgetLedgerPort,
  BudgetLedgerRecord,
  BudgetLedgerSnapshot,
  BudgetReservationRecord,
  BudgetReserveInput,
  BudgetSettlementInput,
  CandidateSource,
  CandidateSourceListFilter,
  CandidateSourceRecord,
  CandidateSourceReviewState,
  CandidateSourceStore,
  ImmutableArtifactWriter,
  ModelingBrief,
  OpenBudgetLedgerInput,
  ResearchExecutionAny,
  ResearchExecutionPage,
  ResearchExecutionStore,
  ResearchRequest,
  ScopeRef,
  SourceTrustTier,
  ToolContext,
  Uuid,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '@ontology/contracts'
import {
  CandidateSourceIngestionService,
  DEFAULT_RESEARCH_BUDGET_REF,
  DEFAULT_RESEARCH_POLICY_REF,
  InMemoryJobStore,
  JobService,
  LegacyResearchExecutor,
  RESEARCH_JOB_VERSION_CATALOGUE,
  ResearchWorkflowService,
  WebResearchService,
  decodeResearchJobRequest,
  isCatalogueResearchJobRequest,
} from '@ontology/application'
import type { ResearchSearchBinder, ResearchSearchResolver } from '@ontology/application'

const TENANT = '00000000-0000-4000-8000-000000000001'
const SPACE = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'
const NOW = '2026-10-15T00:00:00Z'

function ctx(roles: readonly string[] = ['researcher', 'platform-admin']): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT, subjectId: 'researcher-1', roles: [...roles], scopes: ['tool:invoke'], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: NOW, expiresAt: '2099-01-01T00:00:00Z' },
    allowedResources: { tenantId: TENANT, spaceId: SPACE, resourceKinds: ['artifact'], sourceRefs: [], collectionRefs: [], domains: ['standards.example.org'], maxRows: 100 },
    traceId: 'trace-research-workflow',
  })
}

function digestOf(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

class FakeStore implements CandidateSourceStore {
  #byKey = new Map<string, CandidateSourceRecord>()
  get size(): number { return this.#byKey.size }
  async putSource(_scope: ScopeRef, input: { readonly source: CandidateSource; readonly idempotencyKey: string }): Promise<CandidateSourceRecord> {
    const existing = this.#byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    const record: CandidateSourceRecord = { ...input.source, revision: '1' }
    this.#byKey.set(input.idempotencyKey, record)
    return record
  }
  async getSource(_scope: ScopeRef, sourceId: Uuid): Promise<CandidateSourceRecord | undefined> {
    return [...this.#byKey.values()].find((source) => source.sourceId === sourceId)
  }
  async listSources(_scope: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter): Promise<readonly CandidateSourceRecord[]> {
    return [...this.#byKey.values()].filter((source) => source.workspaceId === workspaceId
      && (filter.reviewState === undefined || source.reviewState === filter.reviewState)
      && (filter.trustTier === undefined || source.trustTier === filter.trustTier))
  }
  async reviewSource(_scope: ScopeRef, input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string }): Promise<CandidateSourceRecord> {
    const current = [...this.#byKey.values()].find((source) => source.sourceId === input.sourceId)
    if (current === undefined) throw new Error('missing source')
    return { ...current, reviewState: input.reviewState, trustTier: input.trustTier ?? current.trustTier, reviewedBy: input.reviewedBy }
  }
}

class FakeWriter implements ImmutableArtifactWriter {
  async putBytes(): Promise<{ blobRef: CandidateSource['contentRef']; contentDigest: `sha256:${string}`; integrity: { algorithm: 'sha256'; digest: `sha256:${string}` } }> {
    throw new Error('archived snapshots must not re-archive bytes')
  }
}

class FakeSearchProvider implements WebSearchProvider {
  readonly providerRef = { id: 'web-search.fake', version: '1.0.0', digest: digestOf('fake') }
  lastRequest: WebSearchProviderRequest | undefined
  onSearch: (() => Promise<void>) | undefined
  constructor(readonly result: WebSearchProviderResult, readonly fail = false) {}
  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult> {
    this.lastRequest = request
    if (this.onSearch !== undefined) await this.onSearch()
    if (this.fail) throw new Error('provider unavailable')
    return this.result
  }
}

const TERMINAL = ['completed', 'cancelled', 'failed']

/** The legacy orchestration always carries a job id; narrow the dual-version execution for a test. */
function jobIdOf(execution: ResearchExecutionAny): Uuid {
  if (execution.jobId === undefined) throw new Error('expected the legacy run to carry a job id')
  return execution.jobId
}

class FakeExecutionStore implements ResearchExecutionStore {
  readonly rows = new Map<string, ResearchExecutionAny>()
  async putExecution(_scope: ScopeRef, execution: ResearchExecutionAny): Promise<ResearchExecutionAny> {
    const existing = this.rows.get(execution.researchId)
    if (existing !== undefined && TERMINAL.includes(existing.status)) return existing
    this.rows.set(execution.researchId, { ...execution })
    return execution
  }
  async getExecution(_scope: ScopeRef, researchId: Uuid): Promise<ResearchExecutionAny | undefined> {
    return this.rows.get(researchId)
  }
  async listExecutions(_scope: ScopeRef, workspaceId: Uuid): Promise<ResearchExecutionPage> {
    return { executions: [...this.rows.values()].filter((row) => row.workspaceId === workspaceId) }
  }
}

const ZERO_USAGE: BudgetConsumption = { toolCalls: 0, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0 }
const LIMITS: BudgetLedgerLimits = { maxToolCalls: 20, maxRepairAttempts: 2, maxParallelTools: 2, maxRows: 1000, maxBytes: 1_000_000, deadlineMs: 600_000 }

class FakeBudget implements BudgetLedgerPort {
  readonly ledgers = new Map<string, { record: BudgetLedgerRecord; reservations: Map<string, BudgetReservationRecord> }>()
  reserveCalls: { ledgerId: string; idempotencyKey: string }[] = []
  deny = false
  async openLedger(input: OpenBudgetLedgerInput): Promise<BudgetLedgerRecord> {
    const existing = this.ledgers.get(input.ledgerId)
    if (existing !== undefined) return existing.record
    const record: BudgetLedgerRecord = {
      ledgerId: input.ledgerId, kind: input.kind, limits: LIMITS, deadline: '2099-01-01T00:00:00Z',
      consumed: ZERO_USAGE, revision: '1', createdAt: NOW, updatedAt: NOW,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    }
    this.ledgers.set(input.ledgerId, { record, reservations: new Map() })
    return record
  }
  #snapshot(ledgerId: string): BudgetLedgerSnapshot {
    const ledger = this.ledgers.get(ledgerId)
    if (ledger === undefined) throw new Error('LEDGER_NOT_FOUND')
    return {
      ledgerId, kind: ledger.record.kind, deadline: ledger.record.deadline,
      remaining: { deadline: ledger.record.deadline, toolCallsRemaining: LIMITS.maxToolCalls - ledger.record.consumed.toolCalls, repairAttemptsRemaining: LIMITS.maxRepairAttempts, parallelToolLimit: LIMITS.maxParallelTools },
      rowsRemaining: LIMITS.maxRows, bytesRemaining: LIMITS.maxBytes, parallelToolsRemaining: LIMITS.maxParallelTools,
    }
  }
  async reserve(input: BudgetReserveInput): Promise<AtomicReserveOutcome> {
    this.reserveCalls.push({ ledgerId: input.ledgerId, idempotencyKey: input.idempotencyKey })
    const ledger = this.ledgers.get(input.ledgerId)
    if (ledger === undefined) throw new Error('LEDGER_NOT_FOUND')
    const remaining = this.#snapshot(input.ledgerId)
    if (this.deny) return { granted: false, remaining, denial: { code: 'BUDGET_EXHAUSTED', message: 'budget exhausted' } }
    const existing = ledger.reservations.get(input.idempotencyKey)
    if (existing !== undefined) return { granted: true, remaining, reservation: existing }
    const reservation: BudgetReservationRecord = {
      reservationId: randomUUID(), ledgerId: input.ledgerId, idempotencyKey: input.idempotencyKey,
      status: 'reserved', intentRequired: false, reserved: { ...ZERO_USAGE, toolCalls: input.toolCalls ?? 0 }, parallelTools: 0,
      usageUnknown: false, evidenceRefs: [], deadline: input.requestedDeadline ?? ledger.record.deadline, grantedAt: NOW, expiresAt: ledger.record.deadline,
    }
    ledger.reservations.set(input.idempotencyKey, reservation)
    return { granted: true, remaining, reservation }
  }
  async recordIntent(): Promise<never> { throw new Error('not used') }
  async settle(input: BudgetSettlementInput): Promise<AtomicSettleOutcome> {
    const ledger = this.ledgers.get(input.ledgerId)
    if (ledger === undefined) throw new Error('RESERVATION_NOT_FOUND')
    const existing = [...ledger.reservations.values()].find((entry) => entry.reservationId === input.reservationId)
    const reservation: BudgetReservationRecord = existing === undefined
      ? { reservationId: input.reservationId, ledgerId: input.ledgerId, idempotencyKey: 'settled', status: 'settled', intentRequired: false, reserved: ZERO_USAGE, parallelTools: 0, usageUnknown: false, evidenceRefs: [], deadline: '2099-01-01T00:00:00Z', grantedAt: NOW, expiresAt: '2099-01-01T00:00:00Z' }
      : existing
    return { reservation, applied: true, remaining: this.#snapshot(input.ledgerId) }
  }
  async remaining(ledgerId: string): Promise<BudgetLedgerSnapshot> {
    return this.#snapshot(ledgerId)
  }
}

function brief(overrides: Partial<ModelingBrief> = {}): ModelingBrief {
  return {
    schemaVersion: 'modeling-brief@1',
    workspaceId: WORKSPACE,
    goal: '按 GB50500 建桥架计价本体',
    allowedResearchDomains: ['standards.example.org'],
    freshnessHint: 'year',
    targetKinds: ['object', 'attribute'],
    sourceLimit: 5,
    candidateLimit: 5,
    ...overrides,
  }
}

function request(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    schemaVersion: 'research-request@1',
    workspaceId: WORKSPACE,
    brief: brief(),
    limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2099-01-01T00:00:00Z' },
    allowedDomains: ['standards.example.org'],
    policyRef: DEFAULT_RESEARCH_POLICY_REF,
    budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
    idempotencyKey: `research-key-${randomUUID().slice(0, 8)}`,
    ...overrides,
  }
}

function build(result: WebSearchProviderResult, fail = false) {
  const sources = new FakeStore()
  const executions = new FakeExecutionStore()
  const budget = new FakeBudget()
  const jobs = new JobService({ store: new InMemoryJobStore(), newId: () => randomUUID() })
  const provider = new FakeSearchProvider(result, fail)
  const ingestion = new CandidateSourceIngestionService({ artifacts: new FakeWriter(), sources, now: () => NOW })
  const executor = new LegacyResearchExecutor({
    executions, budget, now: () => NOW,
    research: new WebResearchService({ webSearch: provider, ingestion }),
  })
  const workflow = new ResearchWorkflowService({ jobs, executions, budget, now: () => NOW })
  return { workflow, executor, sources, executions, budget, jobs, provider }
}

const WITH_SNAPSHOT: WebSearchProviderResult = {
  pages: [
    { url: 'https://standards.example.org/gb50500', title: 'GB50500', snippet: 'load tables', fetchedAt: NOW,
      contentDigest: digestOf('page-a'), snapshotRef: { id: '00000000-0000-4000-8000-0000000000aa', version: '1.0.0', digest: digestOf('page-a'), kind: 'artifact' } },
    { url: 'https://standards.example.org/more', title: 'more', snippet: 'no snapshot', fetchedAt: NOW, contentDigest: digestOf('page-b') },
  ],
  truncated: true,
  excludedCount: 2,
}

async function runOnce(h: ReturnType<typeof build>, input = request()) {
  const context = ctx()
  const queued = await h.workflow.start(input, context)
  await h.budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
  const executed = await h.executor.execute(
    { researchId: queued.researchId, request: input },
    context,
    jobIdOf(queued),
    new AbortController().signal,
  )
  return { context, queued, executed }
}

describe('research workflow orchestration', () => {
  it('starts a durable research job + queued execution and replays idempotently', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const input = request()
    const first = await h.workflow.start(input, context)
    expect(first.status).toBe('queued')
    expect(jobIdOf(first)).toBe(first.researchId)
    expect(first.coverage.archivedSnapshots).toBe(0)
    const job = await h.jobs.getJob(jobIdOf(first), context)
    expect(job.kind).toBe('research')

    const replay = await h.workflow.start(input, context)
    expect(replay.researchId).toBe(first.researchId)
    expect(h.executions.rows.size).toBe(1)
  })

  it('runs the bounded chain into proposed sources with honest coverage', async () => {
    const h = build(WITH_SNAPSHOT)
    const { executed } = await runOnce(h)
    expect(h.provider.lastRequest?.limit).toBe(5)
    expect(h.provider.lastRequest?.allowedDomains).toEqual(['standards.example.org'])
    expect(executed.status).toBe('awaiting_confirmation')
    expect(executed.stage).toBe('awaiting_source_review')
    expect(executed.stopReason).toBe('partial_results')
    expect(executed.sourceCount).toBe(1)
    expect(executed.coverage).toMatchObject({ pagesDiscovered: 2, archivedSnapshots: 1, skippedWithoutSnapshot: 1, excludedCount: 2, truncated: true })
    expect(executed.sources).toHaveLength(1)
    expect(h.sources.size).toBe(1)
  })

  it('refuses research for a principal without the researcher role', async () => {
    const h = build(WITH_SNAPSHOT)
    await expect(h.workflow.start(request(), ctx(['business-user']))).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('cancels a queued run and admits no late result', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const input = request()
    const queued = await h.workflow.start(input, context)
    await h.workflow.cancel(queued.researchId, context)
    await h.budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
    const executed = await h.executor.execute({ researchId: queued.researchId, request: input }, context, jobIdOf(queued), new AbortController().signal)
    expect(executed.status).toBe('cancelled')
    expect(executed.stopReason).toBe('cancelled')
    expect(executed.sourceCount).toBe(0)
    expect(h.sources.size).toBe(0)
  })

  it('stops mid-run when cancelled during the provider call and admits no page', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const input = request()
    const queued = await h.workflow.start(input, context)
    await h.budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
    h.provider.onSearch = async () => { await h.workflow.cancel(queued.researchId, context) }
    const executed = await h.executor.execute({ researchId: queued.researchId, request: input }, context, jobIdOf(queued), new AbortController().signal)
    expect(executed.status).toBe('cancelled')
    expect(executed.sourceCount).toBe(0)
    expect(h.sources.size).toBe(0)
  })

  it('is restart-safe: replaying execute does not register a second source', async () => {
    const h = build(WITH_SNAPSHOT)
    const input = request()
    const context = ctx()
    const queued = await h.workflow.start(input, context)
    await h.budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
    await h.executor.execute({ researchId: queued.researchId, request: input }, context, jobIdOf(queued), new AbortController().signal)
    const replay = await h.executor.execute({ researchId: queued.researchId, request: input }, context, jobIdOf(queued), new AbortController().signal)
    expect(replay.status).toBe('awaiting_confirmation')
    expect(h.sources.size).toBe(1)
  })

  it('shares one budget ledger and never resets it on a reclaimed attempt', async () => {
    const h = build(WITH_SNAPSHOT)
    const { queued } = await runOnce(h)
    expect(h.budget.reserveCalls.length).toBeGreaterThan(0)
    expect(h.budget.reserveCalls.every((call) => call.ledgerId === jobIdOf(queued))).toBe(true)
    // The same ledger is reused: opening it again returns the same record rather than a fresh budget.
    expect(await h.budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background' })).toMatchObject({ ledgerId: jobIdOf(queued) })
  })

  it('stops on an exhausted budget without calling the provider', async () => {
    const h = build(WITH_SNAPSHOT)
    h.budget.deny = true
    const { executed } = await runOnce(h)
    expect(executed.status).toBe('failed')
    expect(executed.stopReason).toBe('budget_exhausted')
    expect(h.provider.lastRequest).toBeUndefined()
  })

  it('classifies a provider failure instead of returning an empty saved list', async () => {
    const h = build(WITH_SNAPSHOT, true)
    const { executed } = await runOnce(h)
    expect(executed.status).toBe('failed')
    expect(executed.stopReason).toBe('provider_failed')
    expect(h.sources.size).toBe(0)
  })

  it('reports no_results honestly when the provider returns nothing', async () => {
    const h = build({ pages: [], truncated: false, excludedCount: 0 })
    const { executed } = await runOnce(h)
    expect(executed.status).toBe('completed')
    expect(executed.stopReason).toBe('no_results')
    expect(executed.sourceCount).toBe(0)
  })

  it('resumes a non-terminal run by re-arming the same job on the same ledger', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const queued = await h.workflow.start(request(), context)
    const resumed = await h.workflow.resume(queued.researchId, context)
    expect(resumed.researchId).toBe(queued.researchId)
    expect(resumed.jobId).toBe(jobIdOf(queued))
    expect(resumed.status).toBe('queued')
    // Re-arming reuses the one logical job: no second run/ledger is created.
    expect(h.executions.rows.size).toBe(1)
  })

  it('refuses to resume a terminal run (cancelled/completed/failed cannot be revived)', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const queued = await h.workflow.start(request(), context)
    await h.workflow.cancel(queued.researchId, context)
    await expect(h.workflow.resume(queued.researchId, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('continues an ended run with a new linked execution and its own budget', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const first = await h.workflow.start(request(), context)
    await h.workflow.cancel(first.researchId, context)
    const next = await h.workflow.continuations(first.researchId, request({ idempotencyKey: 'continuation-source-key' }), context)
    expect(next.researchId).not.toBe(first.researchId)
    expect(next.jobId).not.toBe(jobIdOf(first))
    expect(next.continuedFromResearchId).toBe(first.researchId)
    expect(next.status).toBe('queued')
    expect(h.executions.rows.size).toBe(2)
    // The predecessor is untouched: the continuation never rewrites the frozen run.
    expect(h.executions.rows.get(first.researchId)?.status).toBe('cancelled')
  })

  it('refuses to continue an active run', async () => {
    const h = build(WITH_SNAPSHOT)
    const context = ctx()
    const first = await h.workflow.start(request(), context)
    await expect(h.workflow.continuations(first.researchId, request({ idempotencyKey: 'continuation-source-key' }), context))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

describe('catalogue-pinned research (S03)', () => {
  function catalogueWorkflow(h: ReturnType<typeof build>, searchBinding: ResearchSearchBinder): ResearchWorkflowService {
    return new ResearchWorkflowService({ jobs: h.jobs, executions: h.executions, budget: h.budget, now: () => NOW, searchBinding })
  }

  it('pins the search binding at accept time and writes a catalogue-version job', async () => {
    const h = build(WITH_SNAPSHOT)
    const pinned: { researchId: string; workspaceId: string }[] = []
    const workflow = catalogueWorkflow(h, {
      async bindSearchForResearch(input) { pinned.push(input); return { state: 'available' } },
    })
    const context = ctx()
    const queued = await workflow.start(request(), context)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.workspaceId).toBe(WORKSPACE)
    const job = await h.jobs.getJob(jobIdOf(queued), context)
    expect(job.pipelineVersion).toBe(RESEARCH_JOB_VERSION_CATALOGUE)
    expect(isCatalogueResearchJobRequest(decodeResearchJobRequest(job.datasetRef))).toBe(true)
  })

  it('refuses a new run when the catalogue search cannot be pinned', async () => {
    const h = build(WITH_SNAPSHOT)
    const workflow = catalogueWorkflow(h, {
      async bindSearchForResearch() { return { state: 'blocked', reason: 'TOOL_DISABLED', message: '公共搜索服务已停用' } },
    })
    await expect(workflow.start(request(), ctx())).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(h.executions.rows.size).toBe(0)
  })

  it('runs a catalogue job through the resolved provider', async () => {
    const sources = new FakeStore()
    const executions = new FakeExecutionStore()
    const budget = new FakeBudget()
    const provider = new FakeSearchProvider(WITH_SNAPSHOT)
    const ingestion = new CandidateSourceIngestionService({ artifacts: new FakeWriter(), sources, now: () => NOW })
    const resolver: ResearchSearchResolver = {
      async resolveForResearch({ workspaceId }) {
        expect(workspaceId).toBe(WORKSPACE)
        return { state: 'available', provider, connectionName: '兼容网关', adapterType: 'http_compat' }
      },
    }
    const executor = new LegacyResearchExecutor({ executions, budget, now: () => NOW, catalogue: { search: resolver, ingestion } })
    const context = ctx()
    const jobs = new JobService({ store: new InMemoryJobStore(), newId: () => randomUUID() })
    const queued = await new ResearchWorkflowService({ jobs, executions, budget, now: () => NOW }).start(request(), context)
    await budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
    const executed = await executor.execute(
      { researchId: queued.researchId, request: request(), providerSource: 'catalogue' },
      context, jobIdOf(queued), new AbortController().signal,
    )
    expect(executed.status).toBe('awaiting_confirmation')
    expect(provider.lastRequest).toBeDefined()
    expect(sources.size).toBe(1)
  })

  it('fails a catalogue job closed when the pinned search is blocked, admitting no page', async () => {
    const sources = new FakeStore()
    const executions = new FakeExecutionStore()
    const budget = new FakeBudget()
    const ingestion = new CandidateSourceIngestionService({ artifacts: new FakeWriter(), sources, now: () => NOW })
    const resolver: ResearchSearchResolver = {
      async resolveForResearch() { return { state: 'blocked', reason: 'TOOL_DISABLED', message: 'disabled' } },
    }
    const executor = new LegacyResearchExecutor({ executions, budget, now: () => NOW, catalogue: { search: resolver, ingestion } })
    const context = ctx()
    const jobs = new JobService({ store: new InMemoryJobStore(), newId: () => randomUUID() })
    const queued = await new ResearchWorkflowService({ jobs, executions, budget, now: () => NOW }).start(request(), context)
    await budget.openLedger({ ledgerId: jobIdOf(queued), kind: 'background', runId: jobIdOf(queued) })
    await expect(executor.execute(
      { researchId: queued.researchId, request: request(), providerSource: 'catalogue' },
      context, jobIdOf(queued), new AbortController().signal,
    )).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(sources.size).toBe(0)
    expect(executions.rows.get(queued.researchId)?.status).toBe('failed')
  })
})

