import type {
  AuthoringCommandKind,
  BudgetLedgerPort,
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ProfileRef,
  ResearchAuthorizationReceipt,
  ResearchExecutionGoal,
  ResearchRunAdmission,
  ResearchRunAdmissionRequest,
  ResearchRunAdmissionStore,
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
  isToolContext,
  isUuid,
  workspaceResearchProfileRef,
} from '@ontology/contracts'
import type { CreateRunResult } from '../runs/types'
import { ProfileResolverError } from '../profiles/errors'
import { RunServiceError } from '../runs/errors'
import type { RunService } from '../runs/service'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { inputManifestDigest } from '../workflow/canonical'
import type { WorkspaceResearchRunConfigService } from './workspace-research-run-config-service'
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

  constructor(dependencies: WorkspaceResearchRunServiceDependencies) {
    this.#admissions = dependencies.admissions
    this.#runs = dependencies.runs
    this.#configs = dependencies.configs
    this.#manifests = dependencies.manifests
    this.#budget = dependencies.budget
    this.#dispatch = dependencies.dispatch
    this.#artifacts = dependencies.artifacts
    this.#modelBindings = dependencies.modelBindings
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
    await this.#writeResearchManifest(admission, request, created.resolvedProfileHash, config.runtimeRef, ctx)

    // Flip the dispatch-ready barrier, then enqueue. An incomplete admission is never dispatched.
    const ready = await this.#admissions.markReady(scopeRef, runId, ctx)
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
  ): Promise<void> {
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
    await this.#manifests.saveRunManifest(manifest, ctx)
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
