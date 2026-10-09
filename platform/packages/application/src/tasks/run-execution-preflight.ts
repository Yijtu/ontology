import {
  assertRunExecutionBindingShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  OperationRegistry,
  ProjectReadinessStore,
  ProjectRevision,
  ProjectRevisionRef,
  PublishedTaskBinding,
  ResolvedCapability,
  ResourceRef,
  RunExecutionBinding,
  RunExecutionBindingStore,
  RunExecutionRequest,
  ScopeRef,
  TaskBindingStore,
  TaskCapabilityStatus,
  TaskInputSnapshotStore,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { RunServiceError } from '../runs/errors'
import type { RunExecutionBinder, RunExecutionBinderInput, RunExecutionResolution } from '../runs/types'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { evaluateTaskCapability } from './task-capability'

/** Validates a task's concrete parameters against its published parameter schema. */
export interface TaskParameterValidator {
  validate(
    schema: Readonly<Record<string, unknown>>,
    value: unknown,
  ): { readonly valid: boolean; readonly issues: readonly string[] }
}

export interface RunExecutionPreflightDependencies {
  readonly projects: {
    getRevision(
      scopeRef: ScopeRef,
      projectId: Uuid,
      revision: string,
      ctx: ToolContext,
    ): Promise<ProjectRevision | undefined>
  }
  readonly taskBindings: TaskBindingStore
  readonly inputSnapshots: TaskInputSnapshotStore
  readonly runExecutionBindings: RunExecutionBindingStore
  readonly readiness: ProjectReadinessStore
  readonly operations: OperationRegistry
  /** Capabilities this deployment can actually execute; a task requiring a missing one is not runnable. */
  readonly availableCapabilities: readonly ResolvedCapability[]
  /** Result schema refs this deployment can render. */
  readonly supportedResultSchemaRefs: readonly VersionRef[]
  readonly effectiveLimitsRef: VersionRef
  readonly parameters: TaskParameterValidator
  readonly projectQuerySnapshot?: (scope: ScopeRef, revision: ProjectRevision, parameters: Readonly<Record<string, unknown>>, ctx: ToolContext) => Promise<ResourceRef>
  readonly questionQuerySnapshot?: (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext) => Promise<ResourceRef | undefined>
  /** Server-built evolved input, read from actual approved data pages and human ledger receipts. */
  readonly projectApprovedInput?: (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext) => Promise<ResourceRef | undefined>
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new RunServiceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new RunServiceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameFullRef(
  left: { id: string; version: string; digest: string },
  right: { id: string; version: string; digest: string },
): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameRevisionRef(left: ProjectRevisionRef, right: ProjectRevisionRef): boolean {
  return left.projectId === right.projectId && left.revision === right.revision && left.digest === right.digest
}

/**
 * Server-side resolution of the optional run task/input binding (SPEC v0.3a §EX-2.1).
 *
 * Before a run is created, this service validates every ref the request claims: the project
 * revision digest, the input snapshot (either the revision's own approved input or a registered
 * trusted derived input that pins that revision), the published task binding, the task parameter
 * schema and the deployment capability/readiness preflight. Only then does it build the
 * immutable execution binding and archive it. Identity and scope come from the trusted context,
 * never the request body; a mismatch is an explicit error, never a silently coerced run.
 */
export class RunExecutionPreflightService implements RunExecutionBinder {
  readonly #projects: RunExecutionPreflightDependencies['projects']
  readonly #taskBindings: TaskBindingStore
  readonly #inputSnapshots: TaskInputSnapshotStore
  readonly #runExecutionBindings: RunExecutionBindingStore
  readonly #readiness: ProjectReadinessStore
  readonly #projectApprovedInput: RunExecutionPreflightDependencies['projectApprovedInput']
  readonly #operations: OperationRegistry
  readonly #availableCapabilities: readonly ResolvedCapability[]
  readonly #supportedResultSchemaRefs: readonly VersionRef[]
  readonly #effectiveLimitsRef: VersionRef
  readonly #parameters: TaskParameterValidator
  readonly #projectQuerySnapshot: RunExecutionPreflightDependencies['projectQuerySnapshot']
  readonly #questionQuerySnapshot: RunExecutionPreflightDependencies['questionQuerySnapshot']
  readonly #now: () => string

  constructor(dependencies: RunExecutionPreflightDependencies) {
    this.#projects = dependencies.projects
    this.#taskBindings = dependencies.taskBindings
    this.#inputSnapshots = dependencies.inputSnapshots
    this.#runExecutionBindings = dependencies.runExecutionBindings
    this.#readiness = dependencies.readiness
    this.#projectApprovedInput = dependencies.projectApprovedInput
    this.#operations = dependencies.operations
    this.#availableCapabilities = dependencies.availableCapabilities
    this.#supportedResultSchemaRefs = dependencies.supportedResultSchemaRefs
    this.#effectiveLimitsRef = dependencies.effectiveLimitsRef
    this.#parameters = dependencies.parameters
    this.#projectQuerySnapshot = dependencies.projectQuerySnapshot
    this.#questionQuerySnapshot = dependencies.questionQuerySnapshot
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async bindExecution(
    input: RunExecutionBinderInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RunExecutionResolution> {
    const trustedScope = scopeOf(ctx)
    if (trustedScope.tenantId !== scopeRef.tenantId || trustedScope.spaceId !== scopeRef.spaceId) {
      throw new RunServiceError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }

    const request = input.request
    const revision = await this.#requireRevision(scopeRef, request.projectRevisionRef, ctx)
    const evolvedApproved = revision.approvedInputRef===undefined ? await this.#projectApprovedInput?.(scopeRef,revision,ctx) : undefined
    if(evolvedApproved!==undefined && canonicalJson(input.profileBinding.resolvedProfileRef)!==canonicalJson(revision.profileRef)) throw new RunServiceError('INPUT_SNAPSHOT_INVALID','the evolved task must use its exact validated target profile')
    await this.#verifyInputSnapshot(scopeRef, revision, request, ctx,evolvedApproved)

    const binding = request.mode === 'task'
      ? await this.#requireTaskBinding(scopeRef, revision, request, ctx)
      : undefined

    const allowedTaskBindingRefs = await this.#allowedBindings(scopeRef, revision, ctx, binding)

    let capability: TaskCapabilityStatus | undefined
    if (binding !== undefined) {
      capability = evaluateTaskCapability({
        binding,
        availableCapabilities: this.#availableCapabilities,
        readiness: await this.#readiness.listProjections(scopeRef, revision.ref, ctx),
        operations: this.#operations,
        supportedResultSchemaRefs: this.#supportedResultSchemaRefs,
      })
      if (capability.state !== 'available') {
        throw new RunServiceError(
          capability.state === 'not_ready' ? 'TASK_NOT_READY' : 'TASK_UNAVAILABLE',
          `task ${binding.taskBindingRef.id}@${binding.taskBindingRef.version} is ${capability.state}`,
          {
            reasons: capability.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
          },
        )
      }
    }

    let projectDatasetSnapshotRef: ResourceRef | undefined
    if (binding?.kind === 'structured_query' && request.mode === 'task') {
      if (binding.actionDefinitionRef.digest !== revision.definitionRef.digest) throw new RunServiceError('TASK_NOT_READY', 'the structured query task definition digest differs from the pinned project definition')
      if (this.#projectQuerySnapshot === undefined) throw new RunServiceError('TASK_NOT_READY', 'the official project query snapshot resolver is not mounted')
      projectDatasetSnapshotRef = await this.#projectQuerySnapshot(scopeRef, revision, request.parameters, ctx)
    }
    if (request.mode === 'question' && this.#questionQuerySnapshot !== undefined) {
      const allowed = await Promise.all(allowedTaskBindingRefs.map((ref) => this.#taskBindings.getBinding(scopeRef, ref, ctx)))
      if (allowed.some((binding) => binding?.kind === 'structured_query')) projectDatasetSnapshotRef = await this.#questionQuerySnapshot(scopeRef, revision, ctx)
    }

    const executionBinding: RunExecutionBinding = {
      schemaVersion: 'run-execution-binding@1',
      ...(projectDatasetSnapshotRef === undefined ? {} : { projectDatasetSnapshotRef }),
      runId: input.runId,
      request,
      resolvedProfileRef: input.profileBinding.resolvedProfileRef,
      runtimeRef: input.profileBinding.runtimeRef,
      allowedTaskBindingRefs,
      inputManifestDigestAtCreation: sha256DigestOf(
        canonicalJson({
          projectRevisionRef: revision.ref,
          inputSnapshotRef: request.inputSnapshotRef,
          inputSnapshotDigest: request.inputSnapshotDigest,
          definitionRef: revision.definitionRef,
          mappingRefs: revision.mappingRefs,
          approvedInputRef: revision.approvedInputRef ?? evolvedApproved ?? null,
        }),
      ),
      effectiveLimitsRef: this.#effectiveLimitsRef,
      effectiveTime: { validAt: this.#now(), asOfRecordedSeq: revision.sourceVisibilityEpoch },
    }
    assertRunExecutionBindingShape(executionBinding)

    const executionBindingRef: ResourceRef = {
      id: input.runId,
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(executionBinding)),
      kind: 'plan',
    }
    await this.#runExecutionBindings.archiveBinding(scopeRef, input.runId, executionBindingRef, executionBinding, ctx)
    return {
      executionBindingRef,
      binding: executionBinding,
      ...(capability === undefined ? {} : { capability }),
    }
  }

  async #requireRevision(
    scopeRef: ScopeRef,
    ref: ProjectRevisionRef,
    ctx: ToolContext,
  ): Promise<ProjectRevision> {
    const revision = await this.#projects.getRevision(scopeRef, ref.projectId, ref.revision, ctx)
    if (revision === undefined) {
      throw new RunServiceError('PROJECT_NOT_FOUND', `project revision ${ref.revision} of ${ref.projectId} is not visible in this scope`)
    }
    if (!sameRevisionRef(revision.ref, ref)) {
      throw new RunServiceError(
        'VERSION_CONFLICT',
        `the requested project revision digest does not match the stored revision ${ref.projectId}@${ref.revision}`,
      )
    }
    return revision
  }

  async #verifyInputSnapshot(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    request: RunExecutionRequest,
    ctx: ToolContext,
    evolvedApproved?: ResourceRef,
  ): Promise<void> {
    const approved = revision.approvedInputRef ?? evolvedApproved
    if (approved !== undefined && sameResource(request.inputSnapshotRef, approved)) {
      if (request.inputSnapshotDigest !== approved.digest) {
        throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the approved-input digest does not match the pinned project revision')
      }
      return
    }
    const snapshot = await this.#inputSnapshots.getSnapshot(scopeRef, request.inputSnapshotRef, ctx)
    if (snapshot === undefined) {
      throw new RunServiceError(
        'INPUT_SNAPSHOT_INVALID',
        'the input snapshot is neither the revision approved input nor a registered trusted derived input',
      )
    }
    if (snapshot.ref.digest !== request.inputSnapshotDigest) {
      throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the input snapshot digest does not match the registered artifact')
    }
    const body = snapshot.body
    if (!sameRevisionRef(body.projectRevisionRef, request.projectRevisionRef)) {
      throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the derived input does not pin the requested project revision')
    }
    if (approved === undefined || !sameResource(body.baseInputRef, approved)) {
      throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the derived input does not derive from this revision approved input')
    }
    if (body.baseInputDigest !== approved.digest) {
      throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'the derived input base-input digest does not match the approved input')
    }
    // A derived input may never masquerade as the project's own approved input.
    if (sameResource(request.inputSnapshotRef, approved)) {
      throw new RunServiceError('INPUT_SNAPSHOT_INVALID', 'a derived input cannot be the project approved input itself')
    }
  }

  async #requireTaskBinding(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    request: Extract<RunExecutionRequest, { mode: 'task' }>,
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding> {
    const binding = await this.#taskBindings.getBinding(scopeRef, request.taskBindingRef, ctx)
    if (binding === undefined) {
      throw new RunServiceError(
        'TASK_NOT_BOUND',
        `published task binding ${request.taskBindingRef.id}@${request.taskBindingRef.version} is not available in this scope`,
      )
    }
    if (!sameFullRef(binding.taskBindingRef, request.taskBindingRef)) {
      throw new RunServiceError('VERSION_CONFLICT', 'the published task binding digest does not match the requested ref')
    }
    if (
      binding.actionDefinitionRef.id !== revision.definitionRef.id ||
      binding.actionDefinitionRef.version !== revision.definitionRef.version
    ) {
      throw new RunServiceError(
        'PROFILE_INCOMPATIBLE',
        'the task binding declares a different definition than the pinned project revision',
      )
    }
    if (sha256DigestOf(canonicalJson(binding.parameterSchema)) !== binding.parameterSchemaDigest) {
      throw new RunServiceError('TASK_NOT_BOUND', 'the task parameter schema digest does not match its declaration')
    }
    const validation = this.#parameters.validate(binding.parameterSchema, request.parameters)
    if (!validation.valid) {
      throw new RunServiceError(
        'TASK_PARAMETER_INVALID',
        `task parameters are invalid: ${validation.issues.join('; ')}`,
        { reasons: validation.issues },
      )
    }
    return binding
  }

  async #allowedBindings(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    ctx: ToolContext,
    requested: PublishedTaskBinding | undefined,
  ): Promise<VersionRef[]> {
    if (requested !== undefined) return [requested.taskBindingRef]
    const candidates = await this.#taskBindings.listBindings(
      scopeRef,
      { definitionRef: revision.definitionRef },
      ctx,
    )
    const readiness = await this.#readiness.listProjections(scopeRef, revision.ref, ctx)
    const available: VersionRef[] = []
    for (const candidate of candidates) {
      const status = evaluateTaskCapability({
        binding: candidate,
        availableCapabilities: this.#availableCapabilities,
        readiness,
        operations: this.#operations,
        supportedResultSchemaRefs: this.#supportedResultSchemaRefs,
      })
      if (status.state === 'available') available.push(candidate.taskBindingRef)
    }
    return available
  }
}
