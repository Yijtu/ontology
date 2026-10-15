import { ERROR_CATALOG, isToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  AbandonedAttempt,
  BudgetRemaining,
  ComponentManifest,
  PlatformError,
  ResourceRef,
  ResumeInput,
  RuntimeAdapter,
  RuntimeCancelReceipt,
  RuntimeCheckpointRef,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeInput,
  ToolContext,
  ToolId,
  ToolResult,
  VersionRef,
  ErrorCode,
} from '@ontology/contracts'
import {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointDigest,
  decodeCheckpoint,
  encodeCheckpoint,
} from './checkpoint'
import type { CheckpointPayload } from './checkpoint'
import { TemplateRuntimeError, platformErrorFor } from './errors'
import { resolveArguments, validatePlan } from './plan'
import type {
  PublishedPlan,
  StepOutput,
  TemplatePlanPreparation,
  TemplatePlanPreparationRequest,
  TemplatePlanResolver,
  TemplateRuntimeConfig,
} from './types'

const RUNTIME_KIND = 'runtime-template'

type StepStatus = 'pending' | 'running' | 'done' | 'failed'
type StepOutcome = 'done' | 'failed' | 'aborted' | 'abort_run'
type Emit = (event: RuntimeEvent) => void
type PreparedPlan = { readonly kind: 'plan'; readonly published: PublishedPlan; readonly receiptBacked: boolean }
  | (Extract<TemplatePlanPreparation, { readonly kind: 'clarification' }> & { readonly receiptBacked: true })

interface Runnable {
  readonly step: PublishedPlan['spec']['steps'][number]
  readonly arguments: Readonly<Record<string, unknown>>
}

interface RestoredState {
  readonly completed: ReadonlySet<string>
  readonly outputs: ReadonlyMap<string, StepOutput>
  readonly evidenceRefs: readonly ResourceRef[]
}

interface Session {
  readonly runId: string
  readonly ctx: ToolContext
  readonly plan: PublishedPlan
  readonly inputRemaining: BudgetRemaining
  readonly clarifications: Readonly<Record<string, unknown>> | undefined
  readonly controller: AbortController
  /** Attempts that were running when the run was cancelled; quarantined, never revived. */
  readonly abandoned: AbandonedAttempt[]
  /** A new prepare-capable resolver persisted the plan receipt before execution. */
  readonly checkpointOnStart: boolean
  cancelReason: string | undefined
  parallelLimit: number
  sequence: number
}

/**
 * The template runtime adapter (SPEC §4.2, C2, D7).
 *
 * It executes an already-registered `PlanSpec` through the host-injected gateway, never
 * through a store, SDK or filesystem. Nodes run in declared dependency order; independent
 * read-only nodes run concurrently (bounded by the run's parallel-tool limit); a node only
 * starts after every predecessor completed successfully. Arguments are bound from the
 * actual bounded predecessor outputs, and a required argument that cannot be bound yields
 * a typed clarification instead of a guessed value.
 *
 * It obeys the same evidence, budget, cancellation and completion contract as the Pi
 * runtime: one shared budget, the injected `AbortSignal`, version-gated checkpoints, and a
 * terminal `collection_complete` that means "a draft may be attempted" — never a published
 * answer.
 */
export class TemplateRuntimeAdapter implements RuntimeAdapter {
  readonly manifest: ComponentManifest
  readonly #plans: TemplatePlanResolver
  readonly #now: () => string
  readonly #newId: () => string
  readonly #active = new Map<string, Session>()

  constructor(config: TemplateRuntimeConfig) {
    this.manifest = config.manifest
    this.#plans = config.plans
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#newId = config.newId ?? (() => globalThis.crypto.randomUUID())
  }

  start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    return this.#stream(async (emit) => {
      const ctx = this.#requireContext(deps)
      this.#assertRunId(input.runId, ctx)
      const preparation = await this.#prepareOrFail({
        mode: 'start',
        input,
        ...(input.planRef === undefined ? {} : { planRef: input.planRef }),
        dependencies: deps,
      }, emit)
      if (preparation === undefined) return
      if (preparation.kind === 'clarification') {
        await this.#emitPreparationClarification(input.runId, preparation, deps, emit)
        return
      }
      const session = this.#open(
        input.runId,
        ctx,
        deps.signal,
        preparation.published,
        input.remainingBudget,
        undefined,
        preparation.receiptBacked,
      )
      try {
        await this.#execute(session, deps, emit, undefined)
      } finally {
        this.#active.delete(session.runId)
      }
    })
  }

  resume(input: ResumeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    return this.#stream(async (emit) => {
      const ctx = this.#requireContext(deps)
      this.#assertRunId(input.runId, ctx)
      this.#assertCheckpointCompatible(input.checkpointRef)
      const bytes = await deps.checkpoints.load(input.runId, input.checkpointRef, ctx)
      const restored = decodeCheckpoint(bytes, input.checkpointRef)
      const preparation = await this.#prepareOrFail({
        mode: 'resume',
        input,
        planRef: restored.planRef,
        dependencies: deps,
      }, emit)
      if (preparation === undefined) return
      if (preparation.kind === 'clarification') {
        await this.#emitPreparationClarification(input.runId, preparation, deps, emit)
        return
      }
      const session = this.#open(
        input.runId,
        ctx,
        deps.signal,
        preparation.published,
        input.remainingBudget,
        input.clarificationResponse?.typedResponse,
        preparation.receiptBacked,
      )
      try {
        await this.#execute(session, deps, emit, {
          completed: new Set(restored.completedStepIds),
          outputs: new Map(
            restored.stepOutputs.map((output) => [
              output.stepId,
              {
                stepId: output.stepId,
                inlineData: output.inlineData,
                evidenceRefs: output.evidenceRefs,
                status: output.status,
              } satisfies StepOutput,
            ]),
          ),
          evidenceRefs: restored.evidenceRefs,
        })
      } finally {
        this.#active.delete(session.runId)
      }
    })
  }

  /**
   * Best-effort cancellation. It aborts the run's internal controller; the generator then
   * emits `cancelled` and notifies the gateway for each in-flight call. It never claims a
   * remote task stopped when the transport cannot cancel it.
   */
  async cancel(runId: string, reason: string): Promise<RuntimeCancelReceipt> {
    const session = this.#active.get(runId)
    if (session === undefined) {
      return { runId, status: 'not_found', acceptedAt: this.#now(), abandonedAttempts: [] }
    }
    session.cancelReason = reason
    session.controller.abort(new Error(reason))
    return { runId, status: 'cancelling', acceptedAt: this.#now(), abandonedAttempts: [] }
  }

  async *#stream(runner: (emit: Emit) => Promise<void>): AsyncGenerator<RuntimeEvent, void, void> {
    const queue = new AsyncQueue<RuntimeEvent>()
    let failure: unknown
    const run = runner((event) => queue.push(event))
      .catch((error: unknown) => {
        failure = error
      })
      .finally(() => {
        queue.close()
      })
    for await (const event of queue) yield event
    await run
    if (failure !== undefined) throw failure
  }

  async #execute(
    session: Session,
    deps: RuntimeDependencies,
    emit: Emit,
    restored: RestoredState | undefined,
  ): Promise<void> {
    const steps = session.plan.spec.steps
    const status = new Map<string, StepStatus>()
    const outputs = new Map<string, StepOutput>()
    const evidence: ResourceRef[] = []

    if (restored !== undefined) {
      for (const stepId of restored.completed) status.set(stepId, 'done')
      for (const [stepId, output] of restored.outputs) outputs.set(stepId, output)
      evidence.push(...restored.evidenceRefs)
    }
    for (const step of steps) {
      if (!status.has(step.stepId)) status.set(step.stepId, 'pending')
    }

    if (session.controller.signal.aborted) {
      this.#emitCancelled(session, emit)
      return
    }

    emit({
      ...this.#base(session),
      type: 'plan_proposed',
      planRef: session.plan.planRef,
      stepCount: steps.length,
      toolIds: uniqueToolIds(steps),
    })

    // The receipt has already been archived by a prepare-capable host. Persist its exact ref
    // before the first operation so a reclaimed run can load the same plan without another
    // planner/model call. Legacy resolvers retain their previous checkpoint cadence.
    if (restored === undefined && session.checkpointOnStart) {
      await this.#saveCheckpoint(session, deps, outputs, evidence, emit)
    }

    for (;;) {
      if (session.controller.signal.aborted) {
        this.#emitCancelled(session, emit)
        return
      }

      const pending = steps.filter((step) => status.get(step.stepId) === 'pending')
      if (pending.length === 0) break

      const denial = await this.#budgetGate(session, deps)
      if (denial !== undefined) {
        emit({ ...this.#base(session), type: 'failed', error: denial })
        return
      }

      const ready = pending.filter((step) =>
        step.dependsOn.every((dependency) => status.get(dependency) === 'done'),
      )
      if (ready.length === 0) {
        // No runnable step remains: a predecessor failed under `continue` and its
        // dependents can never bind. Surface the gap as a typed clarification.
        const blocked = pending[0]
        if (blocked === undefined) break
        await this.#saveCheckpoint(session, deps, outputs, evidence, emit)
        this.#emitClarification(session, emit, blocked.stepId, blocked.args[0]?.name ?? 'input', 'predecessor_not_available')
        return
      }

      const runnable: Runnable[] = []
      for (const step of ready) {
        const resolved = resolveArguments(step, outputs, session.clarifications)
        if (!resolved.ok) {
          await this.#saveCheckpoint(session, deps, outputs, evidence, emit)
          this.#emitClarification(
            session,
            emit,
            step.stepId,
            resolved.missing.argumentName,
            resolved.missing.reason,
          )
          return
        }
        runnable.push({ step, arguments: resolved.arguments })
      }

      const readOnly = runnable.filter((entry) => entry.step.readOnly)
      const serial = runnable.filter((entry) => !entry.step.readOnly)

      const outcomes = await runWithLimit(readOnly, session.parallelLimit, (entry) =>
        this.#runStep(entry, session, deps, emit, status, outputs, evidence),
      )
      if (outcomes.includes('abort_run')) return
      if (outcomes.includes('aborted')) {
        this.#emitCancelled(session, emit)
        return
      }

      for (const entry of serial) {
        const outcome = await this.#runStep(entry, session, deps, emit, status, outputs, evidence)
        if (outcome === 'abort_run') return
        if (outcome === 'aborted') {
          this.#emitCancelled(session, emit)
          return
        }
      }

      await this.#saveCheckpoint(session, deps, outputs, evidence, emit)
    }

    await this.#saveCheckpoint(session, deps, outputs, evidence, emit)
    emit({
      ...this.#base(session),
      type: 'collection_complete',
      draftAllowed: true,
      evidenceCount: evidence.length,
    })
  }

  async #runStep(
    entry: Runnable,
    session: Session,
    deps: RuntimeDependencies,
    emit: Emit,
    status: Map<string, StepStatus>,
    outputs: Map<string, StepOutput>,
    evidence: ResourceRef[],
  ): Promise<StepOutcome> {
    const { step, arguments: args } = entry
    if (session.controller.signal.aborted) return 'aborted'

    status.set(step.stepId, 'running')
    const callId = this.#newId()
    emit({ ...this.#base(session), type: 'step_started', stepId: step.stepId, toolId: step.toolId, attempt: 1 })

    let result: ToolResult
    try {
      result = await deps.gateway.invoke(
        { callId, toolId: step.toolId, arguments: { ...args } },
        session.ctx,
      )
    } catch (error) {
      status.set(step.stepId, 'failed')
      if (session.controller.signal.aborted) {
        this.#abandon(session, deps, callId, step.toolId)
        return 'aborted'
      }
      const platformError = platformErrorFor('INTERNAL_ERROR', messageOf(error), session.ctx.traceId)
      if (step.failureBehaviour === 'abort') {
        emit({ ...this.#base(session), type: 'failed', error: platformError })
        return 'abort_run'
      }
      return 'failed'
    }

    if (session.controller.signal.aborted) {
      status.set(step.stepId, 'failed')
      this.#abandon(session, deps, callId, step.toolId)
      return 'aborted'
    }

    if (result.status === 'error') {
      status.set(step.stepId, 'failed')
      const error =
        result.error ?? platformErrorFor('INTERNAL_ERROR', `step ${step.stepId} failed`, session.ctx.traceId)
      if (step.failureBehaviour === 'abort') {
        emit({ ...this.#base(session), type: 'failed', error })
        return 'abort_run'
      }
      return 'failed'
    }

    status.set(step.stepId, 'done')
    outputs.set(step.stepId, {
      stepId: step.stepId,
      inlineData: result.inlineData,
      evidenceRefs: result.evidenceRefs,
      status: result.status,
    })
    if (result.evidenceRefs.length > 0) {
      evidence.push(...result.evidenceRefs)
      emit({ ...this.#base(session), type: 'evidence_added', evidenceRefs: [...result.evidenceRefs] })
    }
    return 'done'
  }

  /**
   * Admission gate for new work. The run has one shared ledger, so the runtime reads the
   * authoritative remaining projection and intersects it with the input's remaining budget
   * and the trusted deadline. Nothing here opens or resets a ledger: a retry/resume draws
   * from the same monotonic counters.
   */
  async #budgetGate(session: Session, deps: RuntimeDependencies): Promise<PlatformError | undefined> {
    let remaining: BudgetRemaining
    try {
      remaining = await deps.budget.remaining(session.runId, session.ctx)
    } catch (error) {
      return platformErrorFor('INTERNAL_ERROR', messageOf(error), session.ctx.traceId)
    }
    session.parallelLimit = Math.max(1, remaining.parallelToolLimit)

    const deadlineMs = Math.min(
      Date.parse(session.ctx.deadline),
      Date.parse(session.inputRemaining.deadline),
      Date.parse(remaining.deadline),
    )
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
      return platformErrorFor('DEADLINE_EXCEEDED', 'the shared run deadline has passed', session.ctx.traceId)
    }
    const allowance = Math.min(
      session.inputRemaining.toolCallsRemaining,
      remaining.toolCallsRemaining,
    )
    if (allowance <= 0) {
      return platformErrorFor(
        'BUDGET_EXHAUSTED',
        'the shared run budget has no tool calls remaining',
        session.ctx.traceId,
      )
    }
    return undefined
  }

  async #saveCheckpoint(
    session: Session,
    deps: RuntimeDependencies,
    outputs: ReadonlyMap<string, StepOutput>,
    evidence: readonly ResourceRef[],
    emit: Emit,
  ): Promise<void> {
    const payload: CheckpointPayload = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      planRef: session.plan.planRef,
      completedStepIds: [...outputs.keys()].sort(),
      stepOutputs: [...outputs.values()].map((output) => ({
        stepId: output.stepId,
        inlineData: output.inlineData,
        evidenceRefs: [...output.evidenceRefs],
        status: output.status,
      })),
      evidenceRefs: evidence.map((ref) => ({ ...ref })),
    }
    const ref: RuntimeCheckpointRef = {
      checkpointId: this.#newId(),
      runId: session.runId,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      stateDigest: checkpointDigest(payload),
      createdAt: this.#now(),
    }
    const saved = await deps.checkpoints.save(session.runId, ref, encodeCheckpoint(payload), session.ctx)
    emit({ ...this.#base(session), type: 'checkpoint_ready', checkpointRef: saved })
  }

  #emitClarification(
    session: Session,
    emit: Emit,
    stepId: string,
    argumentName: string,
    reason: string,
  ): void {
    // The fixed RuntimeEvent union only admits the decision question types (choice/score/
    // noul). A missing required plan argument is surfaced as a typed `choice` clarification
    // so the platform can collect the value; it is never guessed or defaulted.
    const planRef = session.plan.planRef
    const questionRef: VersionRef = {
      id: `clarify:${planRef.id}:${stepId}:${argumentName}`,
      version: planRef.version,
      digest: sha256DigestOf(`${planRef.digest}:${stepId}:${argumentName}:${reason}`),
    }
    emit({
      ...this.#base(session),
      type: 'clarification_requested',
      clarificationId: this.#newId(),
      questionRef,
      questionType: 'choice',
    })
  }

  #emitCancelled(session: Session, emit: Emit): void {
    const reason = session.cancelReason ?? 'run cancelled'
    emit({ ...this.#base(session), type: 'cancelled', reason, abandonedAttempts: [...session.abandoned] })
  }

  /**
   * Quarantine one in-flight attempt and notify the gateway (best effort). The late result
   * can never revive or publish a cancelled run (D7.3/SPEC §4.3).
   */
  #abandon(session: Session, deps: RuntimeDependencies, callId: string, toolId: ToolId): void {
    const reason = session.cancelReason ?? 'run cancelled'
    session.abandoned.push({
      attemptId: this.#newId(),
      callId,
      toolId,
      abandonedAt: this.#now(),
      lateResultPolicy: 'quarantined',
      reason,
    })
    void deps.gateway.cancel(callId, reason, session.ctx).catch(() => undefined)
  }

  #base(session: Session): {
    readonly runId: string
    readonly eventId: string
    readonly sequence: number
    readonly occurredAt: string
  } {
    const base = {
      runId: session.runId,
      eventId: this.#newId(),
      sequence: session.sequence,
      occurredAt: this.#now(),
    }
    session.sequence += 1
    return base
  }

  #requireContext(deps: RuntimeDependencies): ToolContext {
    if (!isToolContext(deps.ctx)) {
      throw new TemplateRuntimeError(
        'UNTRUSTED_DEPENDENCIES',
        'the runtime requires a host-minted trusted tool context',
      )
    }
    return deps.ctx
  }

  #assertRunId(runId: string, ctx: ToolContext): void {
    if (runId !== ctx.runId) {
      throw new TemplateRuntimeError(
        'UNTRUSTED_DEPENDENCIES',
        `the runtime input names run ${runId}, not the trusted context run ${ctx.runId}`,
      )
    }
  }

  #assertCheckpointCompatible(ref: RuntimeCheckpointRef): void {
    if (ref.runtimeKind !== this.manifest.id || ref.runtimeVersion !== this.manifest.version) {
      throw new TemplateRuntimeError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint runtime ${ref.runtimeKind}@${ref.runtimeVersion} does not match ${this.manifest.id}@${this.manifest.version}`,
      )
    }
  }

  async #resolvePlan(planRef: ResourceRef | undefined, ctx: ToolContext): Promise<PublishedPlan> {
    let published: PublishedPlan
    try {
      published = await this.#plans.resolve(planRef, ctx)
    } catch (error) {
      if (error instanceof TemplateRuntimeError) throw error
      throw new TemplateRuntimeError('PLAN_NOT_FOUND', 'the template plan could not be resolved', {
        cause: error,
      })
    }
    validatePlan(published.spec)
    if (
      planRef !== undefined &&
      (published.planRef.id !== planRef.id || published.planRef.version !== planRef.version)
    ) {
      throw new TemplateRuntimeError(
        'INVALID_PLAN',
        `resolved plan ${published.planRef.id}@${published.planRef.version} does not match the requested ${planRef.id}@${planRef.version}`,
      )
    }
    return published
  }

  async #preparePlan(
    request: TemplatePlanPreparationRequest,
  ): Promise<PreparedPlan> {
    if (this.#plans.prepare === undefined) {
      const published = await this.#resolvePlan(request.planRef, request.dependencies.ctx)
      return { kind: 'plan', published, receiptBacked: false }
    }

    const preparation = await this.#plans.prepare(request)
    if (request.planRef !== undefined && !sameResourceRef(preparation.sourceReceiptRef, request.planRef)) {
      throw new TemplateRuntimeError('INVALID_PLAN', 'the requested plan receipt was not resolved by its full resource reference')
    }
    if (preparation.kind === 'clarification') {
      if (preparation.receiptRef.kind !== 'plan' || !isResourceRef(preparation.receiptRef)) {
        throw new TemplateRuntimeError('INVALID_PLAN', 'a route clarification requires a complete immutable plan receipt')
      }
      return { ...preparation, receiptBacked: true }
    }

    const published = preparation.published
    if (
      published.planRef.kind !== 'plan' ||
      !sameResourceRef(published.planRef, published.spec.planRef)
    ) {
      throw new TemplateRuntimeError('INVALID_PLAN', 'the prepared plan and its immutable receipt reference do not match')
    }
    if (request.planRef !== undefined && !sameResourceRef(preparation.sourceReceiptRef, request.planRef)) {
      throw new TemplateRuntimeError('INVALID_PLAN', 'the checkpoint plan receipt changed during preparation')
    }
    validatePlan(published.spec)
    return { kind: 'plan', published, receiptBacked: true }
  }

  async #prepareOrFail(request: TemplatePlanPreparationRequest, emit: Emit): Promise<PreparedPlan | undefined> {
    try { return await this.#preparePlan(request) } catch (error) {
      // Recovery incompatibility retains its existing throw/unsafe-recovery contract. An
      // aborted operation must not emit a late failure over an accepted cancellation.
      if (request.dependencies.signal.aborted || typeof error !== 'object' || error === null || !('code' in error) || !isCanonicalErrorCode(error.code) || error.code === 'CHECKPOINT_INCOMPATIBLE') throw error
      emit({ type: 'failed', runId: request.input.runId, eventId: this.#newId(), sequence: 0, occurredAt: this.#now(),
        error: platformErrorFor(error.code, 'The task could not be planned with the current authorized inputs and capabilities.', request.dependencies.ctx.traceId) })
      return undefined
    }
  }

  async #emitPreparationClarification(
    runId: string,
    preparation: Extract<TemplatePlanPreparation, { readonly kind: 'clarification' }>,
    deps: RuntimeDependencies,
    emit: Emit,
  ): Promise<void> {
    if (deps.signal.aborted) return
    const receiptRef = preparation.receiptRef
    const payload: CheckpointPayload = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      planRef: receiptRef,
      completedStepIds: [],
      stepOutputs: [],
      evidenceRefs: [],
    }
    const checkpointRef: RuntimeCheckpointRef = {
      checkpointId: this.#newId(),
      runId,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      stateDigest: checkpointDigest(payload),
      createdAt: this.#now(),
    }
    const saved = await deps.checkpoints.save(runId, checkpointRef, encodeCheckpoint(payload), deps.ctx)
    if (deps.signal.aborted) return
    emit({
      runId,
      eventId: this.#newId(),
      sequence: 0,
      occurredAt: this.#now(),
      type: 'checkpoint_ready',
      checkpointRef: saved,
    })
    emit({
      runId,
      eventId: this.#newId(),
      sequence: 1,
      occurredAt: this.#now(),
      type: 'clarification_requested',
      clarificationId: preparation.clarificationId,
      questionRef: preparation.clarification.questionRef,
      questionType: preparation.clarification.questionType,
    })
  }

  #open(
    runId: string,
    ctx: ToolContext,
    signal: AbortSignal,
    plan: PublishedPlan,
    inputRemaining: BudgetRemaining,
    clarifications: Readonly<Record<string, unknown>> | undefined,
    checkpointOnStart = false,
  ): Session {
    const controller = new AbortController()
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    const session: Session = {
      runId,
      ctx,
      plan,
      inputRemaining,
      clarifications,
      controller,
      abandoned: [],
      checkpointOnStart,
      cancelReason: undefined,
      parallelLimit: 1,
      sequence: 0,
    }
    this.#active.set(runId, session)
    return session
  }
}

/** The runtime's public component id, used for checkpoint compatibility. */
export const TEMPLATE_RUNTIME_KIND = RUNTIME_KIND

function uniqueToolIds(steps: readonly PublishedPlan['spec']['steps'][number][]): ToolId[] {
  const ids: ToolId[] = []
  for (const step of steps) {
    if (!ids.includes(step.toolId)) ids.push(step.toolId)
  }
  return ids
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown runtime failure'
}

function isCanonicalErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CATALOG, value)
}

function isResourceRef(value: unknown): value is ResourceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && record['id'].length > 0 &&
    typeof record['version'] === 'string' && record['version'].length > 0 &&
    typeof record['digest'] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(record['digest']) &&
    typeof record['kind'] === 'string' && record['kind'].length > 0
}

function sameResourceRef(left: ResourceRef | undefined, right: ResourceRef): boolean {
  return left !== undefined && left.id === right.id && left.version === right.version &&
    left.digest === right.digest && left.kind === right.kind
}

/**
 * Run `items` through `fn` with at most `limit` in flight. Independent read-only nodes use
 * this to overlap; a limit of one degrades to a strictly sequential pass.
 */
async function runWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const width = Math.min(Math.max(1, limit), items.length)
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

class AsyncQueue<T> {
  readonly #items: T[] = []
  #waiter: (() => void) | undefined
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    this.#items.push(item)
    this.#waiter?.()
    this.#waiter = undefined
  }

  close(): void {
    this.#closed = true
    this.#waiter?.()
    this.#waiter = undefined
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    for (;;) {
      while (this.#items.length > 0) {
        const item = this.#items.shift()
        if (item !== undefined) yield item
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#waiter = resolve
      })
    }
  }
}
