import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresBudgetLedgerStore,
  PostgresCandidateCommitStore,
  PostgresCandidateRunBindingStore,
  PostgresCandidateSourceStore,
  PostgresCandidateSubmissionStore,
  PostgresComponentRegistryStore,
  PostgresJobStore,
  PostgresProfileStore,
  PostgresResearchRunAdmissionStore,
  PostgresRuleActionCandidateStore,
  PostgresRunStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
  PostgresWorkspaceResearchRunConfigStore,
} from '@ontology/adapter-control-postgres'
import { CandidateSubmissionService, IndustryWorkspaceService, ProfileResolver, RunService, StaticDefinitionTerminologySource, WorkspaceResearchRunConfigService, WorkspaceResearchRunService, runBudgetLedgerId } from '@ontology/application'
import type { ResearchAdmissionArtifactPort, RunProfileBinder, RunWorkspaceResearchBinder } from '@ontology/application'
import type { CandidateEvidencePort, CandidateSubmission, ModelingBrief, ResearchRunAdmissionRequest, ResourceRef, ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

const RUNTIME_REF: VersionRef = { id: 'runtime-pi', version: 'pi-runtime@1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const POLICY_REF: VersionRef = { id: 'core-local-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }
const DIGEST = `sha256:${'d'.repeat(64)}`

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

/** A receipt store that can fail the receipt write once, to fault between the candidate and its receipt. */
class FaultyReceipts extends PostgresCandidateSubmissionStore {
  failNext = false
  override async record(
    scopeRef: Parameters<PostgresCandidateSubmissionStore['record']>[0],
    input: Parameters<PostgresCandidateSubmissionStore['record']>[1],
    ctx: Parameters<PostgresCandidateSubmissionStore['record']>[2],
    client?: Parameters<PostgresCandidateSubmissionStore['record']>[3],
  ): ReturnType<PostgresCandidateSubmissionStore['record']> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected receipt write failure')
    }
    return super.record(scopeRef, input, ctx, client)
  }
}

interface Built {
  readonly admission: WorkspaceResearchRunService
  readonly workspaceService: IndustryWorkspaceService
  readonly dispatches: PostgresWorkflowDispatchStore
  readonly budget: BudgetService
  readonly makeSubmission: (receipts: PostgresCandidateSubmissionStore) => CandidateSubmissionService
}

function build(pool: ControlPostgresDatabase): Built {
  const control = new ControlPostgresRepository(pool)
  const workspaceStore = new PostgresAssetWorkspaceStore(pool)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: new PostgresJobStore(pool) })
  const configService = new WorkspaceResearchRunConfigService({
    workspaces: workspaceStore,
    configs: new PostgresWorkspaceResearchRunConfigStore(pool),
    runtimeRef: RUNTIME_REF,
    policyRef: POLICY_REF,
    toolBindings: [
      { toolId: 'ontology_lookup', enabled: true },
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
  const dispatches = new PostgresWorkflowDispatchStore(pool)
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(pool), control })
  const admission = new WorkspaceResearchRunService({
    admissions: new PostgresResearchRunAdmissionStore(pool),
    runs,
    configs: configService,
    manifests: workflowStore,
    budget,
    dispatch: dispatches,
    artifacts: new MemoryArtifacts(),
  })
  const candidateSourceStore = new PostgresCandidateSourceStore(pool)
  const ruleActionStore = new PostgresRuleActionCandidateStore(pool)
  const evidence: CandidateEvidencePort = {
    resolve: async (request) => request.evidence.map((item, index) => ({
      index,
      sourceRef: item.kind === 'web_page' ? item.snapshotRef : item.sourceRef,
      parserVersion: item.parserVersion,
      contentDigest: item.kind === 'web_page' ? item.contentDigest : DIGEST,
      trustTier: 'agent_researched' as const,
      reReadVerified: false,
    })),
  }
  const makeSubmission = (receipts: PostgresCandidateSubmissionStore): CandidateSubmissionService => new CandidateSubmissionService({
    workspaces: workspaceStore,
    definitionCandidates: new PostgresAssetCandidateStore(pool),
    terminology: new StaticDefinitionTerminologySource(),
    evidence,
    receipts,
    runBinding: new PostgresCandidateRunBindingStore(pool),
    commit: new PostgresCandidateCommitStore({
      database: pool,
      assetCandidates: new PostgresAssetCandidateStore(pool),
      sources: candidateSourceStore,
      ruleActions: ruleActionStore,
      receipts,
    }),
    budget,
    ledgerIdFor: runBudgetLedgerId,
    now: () => new Date().toISOString(),
  })
  return { admission, workspaceService, dispatches, budget, makeSubmission }
}

let scopeCounter = 0

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
    { namespace: `commit-${randomUUID().slice(0, 8)}`, displayName: 'commit-fence workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' } },
    `ws-${randomUUID().slice(0, 12)}`,
    'tester',
    c,
  )
  return created.workspace.workspaceId
}

function requestFor(workspaceId: string, idempotencyKey: string): ResearchRunAdmissionRequest {
  const brief: ModelingBrief = { schemaVersion: 'modeling-brief@1', workspaceId, goal: '整理 GB50500 计价规则', allowedResearchDomains: ['example.com'], targetKinds: ['object', 'attribute', 'relation'] }
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

interface Committed {
  readonly workspaceId: string
  readonly runId: Uuid
  readonly ctx: ToolContext
  readonly subject: CandidateSubmissionService
}

/** Admit a real research run, lease its dispatch, and build the atomic submission path. */
async function admitRun(prefix: string, opts: { receipts?: PostgresCandidateSubmissionStore; submitRoles?: readonly string[] } = {}): Promise<Committed> {
  scopeCounter += 1
  const scope = await createJobScope(harness.adminClient, `${prefix}-${scopeCounter}`)
  const operator = toolContext(scope.tenantId, scope.spaceId, ['researcher', 'profile-editor'], `${prefix}-${scopeCounter}`)
  const ctx = toolContext(scope.tenantId, scope.spaceId, opts.submitRoles ?? ['researcher', 'profile-editor'], `${prefix}-${scopeCounter}`)
  const workspaceId = await bootstrapWorkspace(operator)
  const result = await built.admission.accept(requestFor(workspaceId, `admit-${randomUUID().slice(0, 12)}`), operator)
  const receipts = opts.receipts ?? new PostgresCandidateSubmissionStore(database)
  const subject = built.makeSubmission(receipts)
  return { workspaceId, runId: result.runId, ctx, subject }
}

async function leaseFence(runId: Uuid, ctx: ToolContext): Promise<{ dispatchId: Uuid; ownerId: Uuid; attempt: string }> {
  const ownerId = randomUUID()
  const lease = await built.dispatches.claimNext({ ownerId, leaseDurationMs: 60_000 }, ctx)
  if (lease === undefined || lease.runId !== runId) throw new Error('the admitted run has no claimable dispatch')
  return { dispatchId: lease.dispatchId, ownerId: lease.leaseOwnerId, attempt: lease.attempt }
}

function definitionCommand(workspaceId: string, candidate: CandidateSubmission): { schemaVersion: 'submit-candidates@1'; commandKind: 'submit_candidates'; workspaceId: string; candidates: CandidateSubmission[] } {
  return { schemaVersion: 'submit-candidates@1', commandKind: 'submit_candidates', workspaceId, candidates: [candidate] }
}

function definitionCandidate() {
  const snapshotRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' as const }
  return {
    kind: 'definition' as const,
    definitionKind: 'object' as const,
    reason: 'grounded in the archived guide',
    evidence: [{
      kind: 'web_page' as const,
      url: 'https://docs.example.com/tariff',
      snapshotRef,
      snapshotManifestRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' as const },
      contentDigest: DIGEST,
      fetchedAt: '2026-10-16T00:00:00Z',
      parserVersion: '1.0.0',
    }],
    payload: {
      kind: 'object' as const,
      logicalId: 'HeatPumpTariff',
      displayName: '热泵电价',
      businessMeaning: 'A residential heat-pump tariff.',
      suggestedReason: 'The archived guide describes it.',
      identityAttributeIds: [],
    },
  } satisfies CandidateSubmission
}

async function counts(runId: Uuid, workspaceId: string): Promise<{ candidates: number; receipts: number; fences: number }> {
  const candidate = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.asset_candidate_versions WHERE workspace_id = $1::uuid`, [workspaceId],
  )
  const receipt = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.candidate_submission_receipts WHERE run_id = $1::uuid`, [runId],
  )
  const fence = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.research_candidate_commit_fences WHERE run_id = $1::uuid`, [runId],
  )
  return { candidates: Number(candidate.rows[0]?.count ?? 0), receipts: Number(receipt.rows[0]?.count ?? 0), fences: Number(fence.rows[0]?.count ?? 0) }
}

describe('atomic candidate commit fence (real PostgreSQL, migration 105)', () => {
  it('commits the candidate, its links and the receipt, and returns the original receipt on a replay', async () => {
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-happy')
    const fence = await leaseFence(runId, ctx)
    const command = definitionCommand(workspaceId, definitionCandidate())
    const request = { command, runId, logicalActionId: 'action-1', idempotencyKey: `commit-${randomUUID().slice(0, 12)}` }

    const first = await subject.submit(scopeOf(ctx), request, ctx, { fence })
    expect(first.replayed).toBe(false)
    expect(first.accepted).toHaveLength(1)
    const candidateId = first.accepted[0]?.candidateId
    expect(candidateId).toBeDefined()

    const after = await counts(runId, workspaceId)
    expect(after).toEqual({ candidates: 1, receipts: 1, fences: 1 })

    const replay = await subject.submit(scopeOf(ctx), request, ctx, { fence })
    expect(replay.replayed).toBe(true)
    expect(replay.accepted[0]?.candidateId).toBe(candidateId)
    expect(await counts(runId, workspaceId)).toEqual({ candidates: 1, receipts: 1, fences: 1 })
  }, 30_000)

  it('does not leave a candidate without a receipt when the receipt write fails', async () => {
    const faulty = new FaultyReceipts(database)
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-receipt-fault', { receipts: faulty })
    const fence = await leaseFence(runId, ctx)
    faulty.failNext = true
    await expect(subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `fault-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence })).rejects.toThrow('injected receipt write failure')

    // The candidate insert rolled back with the receipt, so nothing orphaned.
    expect(await counts(runId, workspaceId)).toEqual({ candidates: 0, receipts: 0, fences: 0 })

    // A retry afterwards commits cleanly.
    const retry = await subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `fault-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence })
    expect(retry.replayed).toBe(false)
  }, 30_000)

  it('refuses a candidate once the run was cancelled, leaving no candidate behind', async () => {
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-cancel')
    const fence = await leaseFence(runId, ctx)
    await harness.adminClient.query(`UPDATE agent_platform.runs SET state = 'cancelled', cancelled_at = now() WHERE run_id = $1::uuid`, [runId])
    await built.dispatches.cancelRun(runId, ctx)

    await expect(subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `cancel-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence })).rejects.toMatchObject({ code: 'FENCE_STALE' })

    expect(await counts(runId, workspaceId)).toEqual({ candidates: 0, receipts: 0, fences: 0 })
  }, 30_000)

  it('refuses a candidate from a worker that lost its lease, leaving no candidate behind', async () => {
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-lease')
    const staleFence = await leaseFence(runId, ctx)
    // Expire the lease and let another worker reclaim it: the attempt bumps, so the stale fence is void.
    await harness.adminClient.query(`UPDATE agent_platform.workflow_dispatches SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1::uuid`, [runId])
    const reclaimed = await built.dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 60_000 }, ctx)
    expect(reclaimed?.attempt).not.toBe(staleFence.attempt)

    await expect(subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `lease-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence: staleFence })).rejects.toMatchObject({ code: 'FENCE_STALE' })

    expect(await counts(runId, workspaceId)).toEqual({ candidates: 0, receipts: 0, fences: 0 })
  }, 30_000)

  it('refuses a command aimed at a workspace other than the run binding', async () => {
    const { runId, ctx, subject } = await admitRun('commit-other-workspace')
    const otherWorkspace = randomUUID()
    await expect(subject.submit(scopeOf(ctx), {
      command: definitionCommand(otherWorkspace, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `ws-${randomUUID().slice(0, 12)}`,
    }, ctx, {})).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  }, 30_000)

  it('refuses a moved draft instead of modelling a newer one', async () => {
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-draft')
    const fence = await leaseFence(runId, ctx)
    await harness.adminClient.query(
      `INSERT INTO agent_platform.asset_draft_versions
         (tenant_id, space_id, workspace_id, revision, digest, body, document_set_ref, idempotency_key, request_digest, actor, recorded_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 2, $4::text,
               jsonb_build_object('workspaceId', $3::text, 'revision', '2', 'digest', $4::text, 'documentSetRef', $5::jsonb, 'candidateRefs', '[]'::jsonb),
               $5::jsonb, $6::text, $7::text, 'tester', now())`,
      [ctx.principal.tenantId, ctx.allowedResources.spaceId, workspaceId, DIGEST,
        JSON.stringify({ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' }), `draft-${randomUUID().slice(0, 12)}`, DIGEST],
    )
    await harness.adminClient.query(`UPDATE agent_platform.industry_workspaces SET head_revision = 2 WHERE workspace_id = $1::uuid`, [workspaceId])

    await expect(subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `draft-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence })).rejects.toMatchObject({ code: 'FENCE_STALE' })

    expect((await counts(runId, workspaceId)).candidates).toBe(0)
  }, 30_000)

  it('keeps a researcher from gaining editor rights through the worker identity', async () => {
    const { workspaceId, runId, ctx, subject } = await admitRun('commit-researcher', { submitRoles: ['researcher'] })
    const fence = await leaseFence(runId, ctx)
    const receipt = await subject.submit(scopeOf(ctx), {
      command: definitionCommand(workspaceId, definitionCandidate()), runId, logicalActionId: 'action-1', idempotencyKey: `role-${randomUUID().slice(0, 12)}`,
    }, ctx, { fence })
    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.rejected[0]?.code).toBe('PERMISSION_DENIED')
    // The rejection is recorded, but no asset candidate was written: the researcher gained no edit right.
    expect((await counts(runId, workspaceId)).candidates).toBe(0)
  }, 30_000)
})

function scopeOf(ctx: ToolContext): { tenantId: string; spaceId: string } {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
