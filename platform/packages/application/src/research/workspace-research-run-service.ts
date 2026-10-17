import type {
  AuthoringCommandKind,
  BudgetLedgerPort,
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelingBriefMustCover,
  ProfileRef,
  ResearchAuthorizationReceipt,
  ResearchCandidateReceiptSummary,
  ResearchExecutionGoal,
  ResearchExecutionStore,
  ResearchLimits,
  ResearchRunAdmission,
  ResearchRunAdmissionRequest,
  ResearchRunAdmissionStore,
  ResearchStopReason,
  ResourceRef,
  RevisionString,
  RunManifest,
  RunState,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
  WorkflowDispatchPort,
  WorkflowInputEntry,
  WorkflowInputManifest,
  WorkflowManifestStore,
} from '@ontology/contracts'
import {
  ResearchRunAdmissionError,
  assertModelingBriefShape,
  isRecord,
  isToolContext,
  isUuid,
  workspaceResearchProfileRef,
} from '@ontology/contracts'
import type { CreateRunResult } from '../runs/types'
import type { ResearchDelivery } from '../workflow/types'
import { ProfileResolverError } from '../profiles/errors'
import { RunServiceError } from '../runs/errors'
import type { RunService } from '../runs/service'
import type { JobService } from '../jobs/service'
import {
  RESEARCH_JOB_REQUEST_KIND,
  RESEARCH_JOB_VERSION_AGENT,
  encodeResearchJobRequest,
} from '../assets/candidate-sources/research-job-ref'
import { DEFAULT_RESEARCH_BUDGET_REF } from '../assets/candidate-sources/research-workflow-service'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { inputManifestDigest } from '../workflow/canonical'
import type { WorkspaceResearchRunConfigService } from './workspace-research-run-config-service'
import { buildResearchExecutionProjection, candidateSummaryOf, initialResearchExecutionProjection } from './research-run-projection'
import { deterministicUuid, runBudgetLedgerId } from './run-ledger'

/** Roles allowed to admit a research run. */
const RESEARCH_ROLES: readonly string[] = ['researcher', 'platform-admin']

/**
 * The controlled authoring commands a workspace-research run is authorized to invoke (design §5).
 * The receipt records them so a reader can prove exactly what the run may write.
 */
const RESEARCH_AUTHORING_COMMANDS: readonly AuthoringCommandKind[] = ['submit_candidates']

/**
 * A host-injected immutable-artifact port. It writes content-addressed bytes under a stable identity
 * (so a replay returns the same ref) and can **read the exact bytes back with their digest** by ref,
 * which is what makes an authorization receipt actually re-readable rather than a claim.
 */
export interface ResearchAdmissionArtifactPort {
  write(identity: string, bytes: Uint8Array, mediaType: string, ctx: ToolContext): Promise<ResourceRef>
  read(
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentDigest: Sha256Digest }>
}

export interface WorkspaceResearchRunServiceDependencies {
  readonly admissions: ResearchRunAdmissionStore
  readonly runs: RunService
  /** Resolves the frozen workspace-research config (S04) the admission is pinned to. */
  readonly configs: WorkspaceResearchRunConfigService
  readonly manifests: WorkflowManifestStore
  readonly budget: BudgetLedgerPort
  readonly dispatch: WorkflowDispatchPort
  readonly artifacts: ResearchAdmissionArtifactPort
  /**
   * The model execution binding store (S02). When mounted, the admission records the model snapshot
   * the run's pinned `research` binding was fixed to, so a reader can see the exact model config.
   */
  readonly modelBindings?: ExecutionModelBindingStore
  /**
   * The durable job service (S09, design §8). When mounted, an accepted run also gets its agentic
   * research **scheduler** job (`research` kind, `2.0.0`): the job only hands the already-accepted run
   * to the durable dispatch queue and finishes at the `dispatched` stage. The `WorkflowDispatchWorker`
   * stays the only controller driver. Absent for a host that schedules through the dispatch store
   * alone (the S05 behaviour), which is why the field is optional.
   */
  readonly jobs?: JobService
  /**
   * The research-execution projection store (S09, design §8). When mounted, completing a run persists
   * a goal-aware `research-execution@2` projection. Absent means the host keeps only the S05 delivery.
   */
  readonly executions?: ResearchExecutionStore
  /**
   * The per-candidate summaries of a run, read from the durable candidate-submission receipts (design
   * §8). When mounted it is preferred over the lossy per-call delivery summary, so a candidate is
   * projected with its real kind.
   */
  readonly candidateSummaries?: (runId: Uuid, ctx: ToolContext) => Promise<readonly ResearchCandidateReceiptSummary[]>
  readonly now?: () => string
}

export interface ResearchRunAdmissionResult {
  readonly runId: Uuid
  readonly researchId: Uuid
  readonly state: RunState
  readonly revision: RevisionString
  readonly reused: boolean
  readonly admission: ResearchRunAdmission
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ResearchRunAdmissionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ResearchRunAdmissionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertAdmitter(ctx: ToolContext): void {
  if (!ctx.principal.roles.some((role) => RESEARCH_ROLES.includes(role))) {
    throw new ResearchRunAdmissionError('FORBIDDEN', 'admitting a research run requires a researcher or platform-admin role')
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

/**
 * The controlled research run admission entry (design §4/§8, node S05).
 *
 * It fixes the whole accept pipeline before a run can be scheduled: it resolves and pins the
 * workspace-research config (S04), writes the brief / authorization receipt / frozen-config
 * artifacts (all re-readable), reuses `RunService` to create the run (which pins the workspace
 * profile and the per-run model binding), persists the one research manifest (with the goal and the
 * authorization receipt) over the one shared ledger and input manifest, flips the durable
 * dispatch-ready barrier, and only then enqueues the durable dispatch.
 *
 * The admission is idempotent on the request key and derives the run/research identity from a digest
 * that covers the research goal **and** the authorization content, so two concurrent submissions of
 * one logical request resolve to exactly one set of identities. A preflight that would change the
 * pinned config (a different frozen draft/config snapshot) is detected at accept and refused, never
 * silently retargeted. No new controller is introduced: the durable dispatch drives the existing
 * `WorkflowController`.
 */
export class WorkspaceResearchRunService {
  readonly #admissions: ResearchRunAdmissionStore
  readonly #runs: RunService
  readonly #configs: WorkspaceResearchRunConfigService
  readonly #manifests: WorkflowManifestStore
  readonly #budget: BudgetLedgerPort
  readonly #dispatch: WorkflowDispatchPort
  readonly #artifacts: ResearchAdmissionArtifactPort
  readonly #modelBindings: ExecutionModelBindingStore | undefined
  readonly #jobs: JobService | undefined
  readonly #executions: ResearchExecutionStore | undefined
  readonly #candidateSummaries: ((runId: Uuid, ctx: ToolContext) => Promise<readonly ResearchCandidateReceiptSummary[]>) | undefined
  readonly #now: () => string

  constructor(dependencies: WorkspaceResearchRunServiceDependencies) {
    this.#admissions = dependencies.admissions
    this.#runs = dependencies.runs
    this.#configs = dependencies.configs
    this.#manifests = dependencies.manifests
    this.#budget = dependencies.budget
    this.#dispatch = dependencies.dispatch
    this.#artifacts = dependencies.artifacts
    this.#modelBindings = dependencies.modelBindings
    this.#jobs = dependencies.jobs
    this.#executions = dependencies.executions
    this.#candidateSummaries = dependencies.candidateSummaries
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /**
   * Admit a research run. The call is safe to replay: the same request key either returns the
   * already-ready run or finishes an interrupted preparation, and a different digest under the same
   * key is refused rather than overwritten.
   */
  async accept(request: ResearchRunAdmissionRequest, ctx: ToolContext): Promise<ResearchRunAdmissionResult> {
    assertAdmitter(ctx)
    const scopeRef = scopeOf(ctx)
    assertRequestShape(request)

    // Fix the workspace-research config first; a preflight that would change it is detected here.
    const config = await this.#configs.resolveForRun(
      { workspaceId: request.workspaceId, draftRevision: request.draftRevision },
      ctx,
    )
    const profileRef = workspaceResearchProfileRef(request.workspaceId, request.draftRevision)
    const goal: ResearchExecutionGoal = {
      kind: 'industry_workspace_research',
      workspaceId: request.workspaceId,
      draftRevision: request.draftRevision,
    }
    const materialScopeRefs = [...(request.materialScopeRefs ?? [])]
    const issuedAuthorization = {
      operatorSubjectId: ctx.principal.subjectId,
      operatorRoles: [...ctx.principal.roles],
      allowedCommands: [...RESEARCH_AUTHORING_COMMANDS],
      materialScopeRefs,
      allowedDomains: [...request.allowedDomains],
      effectiveQuota: request.limits,
    }
    const requestDigest = sha256DigestOf(
      canonicalJson({
        goal,
        brief: request.brief,
        context: request.context,
        preferences: request.preferences,
        allowedDomains: request.allowedDomains,
        limits: request.limits,
        materialScopeRefs,
        configSnapshotHash: config.snapshotHash,
        authorization: issuedAuthorization,
      }),
    )
    const runId = deterministicUuid('research-run', requestDigest)
    const researchId = deterministicUuid('research-execution', requestDigest)

    // Detect a silent retarget: an admission for this key already pinned a different frozen config
    // (or a different goal) — refuse instead of changing the recipient.
    const existing = await this.#admissions.findByIdempotencyKey(scopeRef, request.idempotencyKey, ctx)
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw new ResearchRunAdmissionError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already admitted with a different research goal, authorization or frozen config',
        )
      }
      if (existing.state === 'ready') {
        const run = await this.#runs.getRun(existing.runId, ctx)
        await this.#dispatch.enqueue({ runId: existing.runId, logicalActionId: 'initial-drive' }, ctx)
        return { runId: existing.runId, researchId: existing.researchId, state: run.state, revision: run.revision, reused: true, admission: existing }
      }
    }

    // Reuse `RunService` to create the run: it pins the workspace-research profile and the
    // per-execution model binding, and is idempotent on the request key (a concurrent submit reuses
    // the same run). Its fixed creation instant is the receipt's deterministic `issuedAt`.
    const created = await this.#createRun(runId, profileRef, request, ctx)
    const runView = await this.#runs.getRun(created.runId, ctx)
    const issuedAt = runView.createdAt

    const authorizationReceipt: ResearchAuthorizationReceipt = {
      schemaVersion: 'research-authorization-receipt@1',
      researchId,
      runId,
      workspaceId: request.workspaceId,
      draftRevision: request.draftRevision,
      operatorSubjectId: issuedAuthorization.operatorSubjectId,
      operatorRoles: issuedAuthorization.operatorRoles,
      allowedCommands: issuedAuthorization.allowedCommands,
      materialScopeRefs: issuedAuthorization.materialScopeRefs,
      allowedDomains: issuedAuthorization.allowedDomains,
      effectiveQuota: issuedAuthorization.effectiveQuota,
      deadline: request.limits.deadline,
      profileRef,
      configSnapshotHash: config.snapshotHash,
      issuedAt,
    }
    // Immutable artifacts written before the barrier: the brief, the authorization receipt and the
    // frozen config. Each is re-readable by ref, so the receipt is evidence, not a claim.
    const briefRef = await this.#artifacts.write(
      `research-brief:${runId}`,
      encodeJson({ schemaVersion: 'research-brief@1', runId, researchId, goal, brief: request.brief, limits: request.limits, allowedDomains: request.allowedDomains, materialScopeRefs }),
      'application/json',
      ctx,
    )
    const authorizationReceiptRef = await this.#artifacts.write(
      `research-authorization-receipt:${runId}`,
      encodeJson(authorizationReceipt),
      'application/json',
      ctx,
    )
    const configSnapshotRef = await this.#artifacts.write(
      `research-run-config:${runId}`,
      encodeJson(config),
      'application/json',
      ctx,
    )
    const modelSnapshotRefs = await this.#modelSnapshotRefs(scopeRef, runId, ctx)

    const admission = await this.#admissions.begin(
      scopeRef,
      {
        runId,
        researchId,
        workspaceId: request.workspaceId,
        draftRevision: request.draftRevision,
        idempotencyKey: request.idempotencyKey,
        requestDigest,
        goal,
        briefRef,
        authorizationReceiptRef,
        configSnapshotRef,
        modelSnapshotRefs,
        toolSnapshotRefs: [],
        configSnapshotHash: config.snapshotHash,
        createdAt: issuedAt,
      },
      ctx,
    )

    // Persist the one complete research manifest over the one shared ledger and input manifest. This
    // is the "complete research manifest" the controller requires; it is never synthesized later.
    const manifest = await this.#writeResearchManifest(admission, request, created.resolvedProfileHash, config.runtimeRef, ctx)

    // Flip the dispatch-ready barrier, then enqueue. An incomplete admission is never dispatched.
    const ready = await this.#admissions.markReady(scopeRef, runId, ctx)
    // S09 (design §8): also create the agentic research **scheduler** job. Its handler only hands this
    // accepted run to the durable dispatch queue (idempotently, on the same `initial-drive` action the
    // direct enqueue below uses) and finishes at `dispatched`; `WorkflowDispatchWorker` stays the only
    // controller driver. `createJob` is idempotent on its key, so a replay reuses the same job.
    if (this.#jobs !== undefined) {
      await this.#jobs.createJob(
        {
          jobId: researchId,
          kind: 'research',
          sourceRef: 'workbench.research',
          datasetRef: encodeResearchJobRequest({
            kind: RESEARCH_JOB_REQUEST_KIND,
            version: RESEARCH_JOB_VERSION_AGENT,
            researchId,
            runId,
            manifestRef: manifestRefFor(runId, manifest),
          }),
          pipelineVersion: RESEARCH_JOB_VERSION_AGENT,
          idempotencyKey: `research-dispatch-handoff:${runId}`,
        },
        ctx,
      )
    }
    // Persist the initial in-flight `@2` run projection from the durable inputs (design §8/§10), so
    // the research entry can read/cancel/resume the run by its research id immediately instead of
    // only after completion. It is written **after** the scheduler job exists so its `jobId` link is
    // valid; the completion `recordDelivery` advances this same row.
    if (this.#executions !== undefined) {
      const ledger = await this.#budget.openLedger({ ledgerId: manifest.budgetLedgerId, kind: 'run', runId }, ctx)
      await this.#executions.putExecution(scopeRef, initialResearchExecutionProjection({
        researchId,
        workspaceId: request.workspaceId,
        runId,
        jobId: researchId,
        goal,
        briefRef: admission.briefRef,
        policyRef: config.policyRef,
        budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
        limits: request.limits,
        mustCover: request.brief.mustCover ?? [],
        budgetLimits: ledger.limits,
        ledgerDeadline: ledger.deadline,
        recordedAt: this.#now(),
      }), ctx)
    }
    await this.#dispatch.enqueue({ runId, logicalActionId: 'initial-drive' }, ctx)
    return { runId, researchId, state: runView.state, revision: runView.revision, reused: created.reused, admission: ready }
  }

  /**
   * Read the authorization receipt back from its immutable artifact, verifying the byte digest and
   * shape. This is the "授权回执要能实际回读" path: a reader can prove who authorized the run, what
   * it may write, the material it may read, the domains it may reach and the effective quota.
   */
  async readAuthorizationReceipt(runId: Uuid, ctx: ToolContext): Promise<ResearchAuthorizationReceipt> {
    const scopeRef = scopeOf(ctx)
    const admission = await this.#admissions.get(scopeRef, runId, ctx)
    if (admission === undefined) {
      throw new ResearchRunAdmissionError('NOT_FOUND', `no research admission for run ${runId} is visible in this scope`)
    }
    const read = await this.#artifacts.read(admission.authorizationReceiptRef, ctx)
    if (read.contentDigest !== admission.authorizationReceiptRef.digest) {
      throw new ResearchRunAdmissionError('STORE_FAILED', 'the authorization receipt failed its immutable byte digest')
    }
    const decoded = decodeJson(read.bytes)
    assertAuthorizationReceiptShape(decoded, admission)
    return decoded
  }

  /**
   * Persist the goal-aware completion projection of an ended research run (design §8, S09). The
   * controller hands its bounded `ResearchDelivery`; this reads the durable admission, the archived
   * brief/frozen config, the single ledger and (when mounted) the persisted candidate receipts, and
   * commits a `research-execution@2` projection. It is idempotent per run: a replay rebuilds the same
   * deterministic projection. Runs not admitted as workspace research (and hosts with no projection
   * store) are a no-op.
   */
  async recordDelivery(runId: Uuid, delivery: ResearchDelivery, ctx: ToolContext): Promise<void> {
    const executions = this.#executions
    if (executions === undefined) return
    const scopeRef = scopeOf(ctx)

    // Read the admission first; a run with no workspace-research admission is not one of ours.
    const admission = await this.#admissions.get(scopeRef, runId, ctx)
    if (admission === undefined) return
    const manifest = await this.#manifests.getRunManifest(runId, ctx)
    if (manifest === undefined || manifest.goal?.kind !== 'industry_workspace_research') return

    const brief = await this.#readBrief(admission.briefRef, ctx)
    const policyRef = await this.#readPolicyRef(admission.configSnapshotRef, ctx)
    // Re-open the run's one ledger (idempotent): the projection reports the ledger's real ceilings and
    // measured consumption, never a fabricated zero.
    const ledger = await this.#budget.openLedger({ ledgerId: manifest.budgetLedgerId, kind: 'run', runId }, ctx)
    const runState = await this.#manifests.getRunState(runId, ctx)
    const candidateReceipts = this.#candidateSummaries === undefined
      ? delivery.candidateReceipts.flatMap(candidateSummaryOf)
      : await this.#candidateSummaries(runId, ctx)

    const projection = buildResearchExecutionProjection({
      researchId: admission.researchId,
      workspaceId: admission.workspaceId,
      runId,
      goal: manifest.goal,
      briefRef: admission.briefRef,
      policyRef,
      budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
      limits: brief.limits,
      mustCover: brief.mustCover,
      budgetLimits: ledger.limits,
      ledgerDeadline: ledger.deadline,
      consumed: ledger.consumed,
      usageUnknown: runState?.usageUnknown ?? false,
      candidateReceipts,
      evidenceRefs: delivery.evidenceRefs,
      stopReason: normaliseStopReason(delivery.stopReason),
      recordedAt: this.#now(),
    })
    await executions.putExecution(scopeRef, projection, ctx)
  }

  async #readBrief(
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<{ readonly limits: ResearchLimits; readonly mustCover: readonly ModelingBriefMustCover[] }> {
    const read = await this.#artifacts.read(ref, ctx)
    const decoded = decodeJson(read.bytes)
    if (!isRecord(decoded) || !isRecord(decoded['limits']) || !isRecord(decoded['brief'])) {
      throw new ResearchRunAdmissionError('STORE_FAILED', 'the archived research brief is malformed')
    }
    assertModelingBriefShape(decoded['brief'])
    const mustCover = decoded['brief'].mustCover ?? []
    return { limits: decoded['limits'] as unknown as ResearchLimits, mustCover }
  }

  async #readPolicyRef(ref: ResourceRef, ctx: ToolContext): Promise<VersionRef> {
    const read = await this.#artifacts.read(ref, ctx)
    const decoded = decodeJson(read.bytes)
    if (isRecord(decoded) && isRecord(decoded['policyRef'])) {
      return decoded['policyRef'] as unknown as VersionRef
    }
    throw new ResearchRunAdmissionError('STORE_FAILED', 'the archived research run config is missing its policy reference')
  }

  async #createRun(runId: Uuid, profileRef: ProfileRef, request: ResearchRunAdmissionRequest, ctx: ToolContext): Promise<CreateRunResult> {
    try {
      return await this.#runs.createRun(
        { runId, profileRef, question: request.brief.goal, context: request.context, preferences: request.preferences, idempotencyKey: request.idempotencyKey },
        ctx,
      )
    } catch (error) {
      if (error instanceof RunServiceError) {
        const code =
          error.code === 'IDEMPOTENCY_CONFLICT'
            ? 'IDEMPOTENCY_CONFLICT'
            : error.code === 'VERSION_CONFLICT'
              ? 'VERSION_CONFLICT'
              : error.code === 'SCOPE_MISMATCH'
                ? 'SCOPE_MISMATCH'
                : 'STORE_FAILED'
        throw new ResearchRunAdmissionError(code, `could not create the admitted research run: ${error.message}`, { cause: error })
      }
      if (error instanceof ProfileResolverError) {
        throw new ResearchRunAdmissionError('STORE_FAILED', `could not bind the workspace-research run config: ${error.message}`, { cause: error })
      }
      throw error
    }
  }

  async #modelSnapshotRefs(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<readonly VersionRef[]> {
    if (this.#modelBindings === undefined) return []
    const binding: ExecutionModelBinding | undefined = await this.#modelBindings.getBinding(scopeRef, runId, 'research', ctx)
    return binding?.snapshotRef === undefined ? [] : [binding.snapshotRef]
  }

  async #writeResearchManifest(
    admission: ResearchRunAdmission,
    request: ResearchRunAdmissionRequest,
    resolvedProfileHash: Sha256Digest,
    runtimeRef: VersionRef,
    ctx: ToolContext,
  ): Promise<RunManifest> {
    const runId = admission.runId
    const draftRevision = admission.goal.kind === 'industry_workspace_research' ? admission.goal.draftRevision : admission.draftRevision
    const workspaceId = admission.goal.kind === 'industry_workspace_research' ? admission.goal.workspaceId : admission.workspaceId
    const profileRef = workspaceResearchProfileRef(workspaceId, draftRevision)
    const ledgerId = runBudgetLedgerId(runId)
    // Fix the run's **absolute** deadline and its source/candidate ceilings on the one ledger at
    // accept time. The ledger open is idempotent (it re-reads the stored row), so a replay or a
    // resume reuses the original deadline and quota instead of sliding them to "now".
    await this.#budget.openLedger({
      ledgerId,
      kind: 'run',
      runId,
      deadline: request.limits.deadline,
      overrideLimits: {
        maxSources: request.limits.sourceLimit,
        maxCandidates: request.limits.candidateLimit,
      },
    }, ctx)
    const inputManifest = await this.#manifests.saveInputManifest(this.#inputManifest(admission), ctx)
    const manifest: RunManifest = {
      runId,
      resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: resolvedProfileHash },
      runtimeRef,
      budgetLedgerId: ledgerId,
      inputManifestId: inputManifest.manifestId,
      createdAt: admission.createdAt,
      goal: admission.goal,
      authorizationReceiptRef: admission.authorizationReceiptRef,
    }
    return this.#manifests.saveRunManifest(manifest, ctx)
  }

  #inputManifest(admission: ResearchRunAdmission): WorkflowInputManifest {
    const runId = admission.runId
    const recordedAt = admission.createdAt
    const entries: WorkflowInputEntry[] = [
      {
        entryId: deterministicUuid('question-entry', runId),
        kind: 'confirmed_context',
        label: `research-goal:${runId}`,
        addedInPhase: 'preflight',
        recordedAt,
        readAt: recordedAt,
      },
      {
        entryId: deterministicUuid('authorization-entry', runId),
        kind: 'confirmed_context',
        label: `authorization:${runId}`,
        ref: admission.authorizationReceiptRef,
        addedInPhase: 'preflight',
        recordedAt,
        readAt: recordedAt,
      },
    ]
    return {
      manifestId: deterministicUuid('input-manifest', runId),
      runId,
      revision: '1',
      entries,
      digest: inputManifestDigest(runId, entries),
    }
  }
}

const RESEARCH_STOP_REASONS: readonly ResearchStopReason[] = [
  'completed', 'partial_results', 'cancelled', 'deadline_exceeded',
  'budget_exhausted', 'no_results', 'provider_failed',
]

/** Map a delivery stop reason onto the canonical contract, never inventing an unknown reason. */
function normaliseStopReason(value: string): ResearchStopReason {
  return (RESEARCH_STOP_REASONS as readonly string[]).includes(value)
    ? (value as ResearchStopReason)
    : 'completed'
}

/**
 * The content-addressed reference of the persisted run manifest, carried by the agentic scheduler
 * job so a reader can pin exactly which manifest the accepted run was scheduled against. It is a
 * reference only; the manifest bytes live in the workflow store.
 */
function manifestRefFor(runId: Uuid, manifest: RunManifest): ResourceRef {
  return {
    id: deterministicUuid('run-manifest', runId),
    version: '1.0.0',
    digest: sha256DigestOf(canonicalJson(manifest)),
    kind: 'artifact',
  }
}

function assertRequestShape(request: ResearchRunAdmissionRequest): void {
  if (request.schemaVersion !== 'research-run-admission-request@1') {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'the admission request schemaVersion is unknown')
  }
  if (!isUuid(request.workspaceId)) throw new ResearchRunAdmissionError('INVALID_REQUEST', 'workspaceId must be a uuid')
  if (typeof request.draftRevision !== 'string' || !/^(0|[1-9]\d*)$/.test(request.draftRevision)) {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'draftRevision must be a decimal revision string')
  }
  assertModelingBriefShape(request.brief)
  if (request.brief.workspaceId !== request.workspaceId) {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'the brief must target the admitted workspace')
  }
  if (!Array.isArray(request.allowedDomains) || request.allowedDomains.length === 0 || request.allowedDomains.length > 32) {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'allowedDomains must be a bounded non-empty list')
  }
  if (typeof request.limits.deadline !== 'string' || request.limits.deadline.length === 0) {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'the research limits require an original deadline')
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 256) {
    throw new ResearchRunAdmissionError('INVALID_REQUEST', 'idempotencyKey must be 8..256 characters')
  }
}

function assertAuthorizationReceiptShape(value: unknown, admission: ResearchRunAdmission): asserts value is ResearchAuthorizationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResearchRunAdmissionError('STORE_FAILED', 'the authorization receipt is not an object')
  }
  const record = value as Record<string, unknown>
  if (
    record['schemaVersion'] !== 'research-authorization-receipt@1' ||
    record['runId'] !== admission.runId ||
    record['researchId'] !== admission.researchId ||
    record['workspaceId'] !== admission.workspaceId ||
    typeof record['operatorSubjectId'] !== 'string' ||
    !Array.isArray(record['operatorRoles']) ||
    !Array.isArray(record['allowedCommands']) ||
    !Array.isArray(record['materialScopeRefs']) ||
    !Array.isArray(record['allowedDomains']) ||
    typeof record['deadline'] !== 'string'
  ) {
    throw new ResearchRunAdmissionError('STORE_FAILED', 'the authorization receipt violates its contract')
  }
}
