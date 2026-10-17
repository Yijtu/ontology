import { randomUUID } from 'node:crypto'
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
  ModelingBrief,
  OpenBudgetLedgerInput,
  ResearchExecutionAny,
  ResearchExecutionPage,
  ResearchExecutionStore,
  ResearchRequest,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import {
  DEFAULT_RESEARCH_BUDGET_REF,
  DEFAULT_RESEARCH_POLICY_REF,
  InMemoryJobStore,
  JobService,
  RESEARCH_JOB_VERSION_CATALOGUE,
  ResearchWorkflowService,
  decodeResearchJobRequest,
  isCatalogueResearchJobRequest,
} from '@ontology/application'
import type { ResearchSearchBinder } from '@ontology/application'

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

const TERMINAL = ['completed', 'cancelled', 'failed']

/** The retained compatibility facade always carries a job id for a `@1` record. */
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

const ZERO_USAGE: BudgetConsumption = { toolCalls: 0, repairAttempts: 0, rows: 0, bytes: 0, modelTokens: 0, searches: 0, modelRounds: 0, sources: 0, candidates: 0, downloadBytes: 0, readBytes: 0 }
const LIMITS: BudgetLedgerLimits = { maxToolCalls: 20, maxRepairAttempts: 2, maxParallelTools: 2, maxRows: 1000, maxBytes: 1_000_000, deadlineMs: 600_000 }

class FakeBudget implements BudgetLedgerPort {
  readonly ledgers = new Map<string, { record: BudgetLedgerRecord; reservations: Map<string, BudgetReservationRecord> }>()
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
    const ledger = this.ledgers.get(input.ledgerId)
    if (ledger === undefined) throw new Error('LEDGER_NOT_FOUND')
    const remaining = this.#snapshot(input.ledgerId)
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

function build() {
  const executions = new FakeExecutionStore()
  const budget = new FakeBudget()
  const jobs = new JobService({ store: new InMemoryJobStore(), newId: () => randomUUID() })
  const workflow = new ResearchWorkflowService({ jobs, executions, budget, now: () => NOW })
  return { workflow, executions, budget, jobs }
}

/**
 * S11 retired the fixed execution chain, so the facade is a start/read/cancel/resume compatibility
 * surface only: it owns the durable job + execution lifecycle and never executes a provider call.
 */
describe('research workflow orchestration (S11 compatibility facade)', () => {
  it('starts a durable research job + queued execution and replays idempotently', async () => {
    const h = build()
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

  it('refuses research for a principal without the researcher role', async () => {
    const h = build()
    await expect(h.workflow.start(request(), ctx(['business-user']))).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('cancels a queued run and freezes it against a later terminal write', async () => {
    const h = build()
    const context = ctx()
    const input = request()
    const queued = await h.workflow.start(input, context)
    const cancelled = await h.workflow.cancel(queued.researchId, context)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.stopReason).toBe('cancelled')
    // A late write cannot resurrect the frozen run.
    const revived = await h.workflow.get(queued.researchId, context)
    expect(revived.execution.status).toBe('cancelled')
  })

  it('resumes a non-terminal run by re-arming the same job on the same ledger', async () => {
    const h = build()
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
    const h = build()
    const context = ctx()
    const queued = await h.workflow.start(request(), context)
    await h.workflow.cancel(queued.researchId, context)
    await expect(h.workflow.resume(queued.researchId, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('continues an ended run with a new linked execution and its own budget', async () => {
    const h = build()
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
    const h = build()
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
    const h = build()
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
    const h = build()
    const workflow = catalogueWorkflow(h, {
      async bindSearchForResearch() { return { state: 'blocked', reason: 'TOOL_DISABLED', message: '公共搜索服务已停用' } },
    })
    await expect(workflow.start(request(), ctx())).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(h.executions.rows.size).toBe(0)
  })
})
