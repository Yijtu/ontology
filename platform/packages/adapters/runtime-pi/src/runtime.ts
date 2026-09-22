import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentEvent,
  AgentMessage,
  AgentTurnDecision,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { isToolContext } from '@ontology/contracts'
import type {
  AbandonedAttempt,
  BudgetRemaining,
  ComponentManifest,
  GenerationRole,
  ModelRef,
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
  ToolGateway,
  ToolId,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointDigest,
  decodeCheckpoint,
  encodeCheckpoint,
} from './checkpoint'
import type { CheckpointPayload } from './checkpoint'
import { PiRuntimeError, platformErrorFor } from './errors'
import { createControlledStreamFn } from './stream'
import { createGatewayTools } from './tools'
import { PI_AGENT_CORE_VERSION } from './types'
import type { PiRuntimeConfig } from './types'

const DEFAULT_SYSTEM_PROMPT = [
  'You collect evidence for a business question by proposing tool calls.',
  'Only propose the tools that are available to you. Every proposal is authorized and executed by the platform tool gateway.',
  'Do not write a final answer: the platform verifies and publishes separately.',
].join(' ')

const DEFAULT_CONTINUATION =
  'Continue the evidence collection loop with the available tools. Do not write a final answer.'

type Emit = (event: RuntimeEvent) => void

interface Session {
  readonly runId: string
  readonly ctx: ToolContext
  readonly gateway: ToolGateway
  readonly inputRemaining: BudgetRemaining
  readonly controller: AbortController
  readonly evidenceRefs: ResourceRef[]
  /** In-flight gateway calls, keyed by call id, so cancel can name each abandoned attempt. */
  readonly inFlight: Map<string, ToolId>
  /** Attempts that were running when the run was cancelled; quarantined, never revived. */
  readonly abandoned: AbandonedAttempt[]
  agent: Agent | undefined
  cancelReason: string | undefined
  failure: PlatformError | undefined
  completedTurns: number
  sequence: number
}

/**
 * The Pi Agent Core runtime adapter (SPEC §4.2, C2, D7).
 *
 * It drives an evidence-collection loop with the real `@earendil-works/pi-agent-core`
 * `Agent`: a host-injected controlled stream function bridges the Pi transcript to
 * `GenerationPort`, and every model-proposed tool call is wrapped so its only execution path
 * is `deps.gateway.invoke`. The runtime itself opens no store, driver or filesystem, and it
 * has no publication path: the SDK's final natural-language message becomes the Pi
 * transcript's assistant message (a candidate) and the terminal runtime event is at most
 * `collection_complete`, which only means a draft may be attempted.
 *
 * Stopping combines the Pi `finishTurn` hook and the injected `AbortSignal`; it never relies
 * on per-tool-result `terminate` hints. The locked SDK/adapter version is recorded in every
 * private checkpoint, and a resume with a different kernel fails explicitly with
 * `CHECKPOINT_INCOMPATIBLE`.
 */
export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly manifest: ComponentManifest
  readonly #toolIds: readonly ToolId[]
  readonly #exposed: ReadonlySet<string>
  readonly #model: Model<Api>
  readonly #modelRef: ModelRef
  readonly #generationRole: GenerationRole
  readonly #maxTokens: number
  readonly #systemPrompt: string
  readonly #sdkVersion: string
  readonly #now: () => string
  readonly #newId: () => string
  readonly #active = new Map<string, Session>()

  constructor(config: PiRuntimeConfig) {
    if (config.toolIds.length === 0) {
      throw new PiRuntimeError(
        'INVALID_CONFIG',
        'the Pi runtime requires at least one host-authorized tool',
      )
    }
    this.manifest = config.manifest
    this.#toolIds = [...config.toolIds]
    this.#exposed = new Set(this.#toolIds)
    this.#modelRef = config.modelRef
    this.#model = buildModel(config)
    this.#generationRole = config.generationRole ?? 'planner'
    this.#maxTokens = config.maxTokens ?? 1024
    this.#systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    this.#sdkVersion = config.sdkVersion ?? PI_AGENT_CORE_VERSION
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#newId = config.newId ?? (() => globalThis.crypto.randomUUID())
  }

  start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    return this.#stream(async (emit) => {
      const ctx = this.#requireContext(deps)
      this.#assertRunId(input.runId, ctx)
      const session = this.#open(input.runId, ctx, deps, input.remainingBudget)
      try {
        const denial = await this.#budgetGate(session, deps)
        if (denial !== undefined) {
          emit({ ...this.#base(session), type: 'failed', error: denial })
          return
        }
        await this.#run(session, deps, emit, {
          prompt: input.question,
          restoredMessages: undefined,
        })
      } finally {
        this.#active.delete(session.runId)
      }
    })
  }

  resume(input: ResumeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    return this.#stream(async (emit) => {
      const ctx = this.#requireContext(deps)
      this.#assertRunId(input.runId, ctx)
      this.#assertCheckpointRef(input.checkpointRef)
      const bytes = await deps.checkpoints.load(input.runId, input.checkpointRef, ctx)
      const restored = decodeCheckpoint(bytes, input.checkpointRef)
      this.#assertCheckpointCompatible(restored)
      const session = this.#open(input.runId, ctx, deps, input.remainingBudget)
      session.evidenceRefs.push(...restored.evidenceRefs.map((ref) => ({ ...ref })))
      session.completedTurns = restored.completedTurns
      try {
        const denial = await this.#budgetGate(session, deps)
        if (denial !== undefined) {
          emit({ ...this.#base(session), type: 'failed', error: denial })
          return
        }
        await this.#run(session, deps, emit, {
          prompt: continuationPrompt(input),
          restoredMessages: restored.messages,
        })
      } finally {
        this.#active.delete(session.runId)
      }
    })
  }

  /**
   * Best-effort cancellation. It aborts the Pi agent and the run's internal controller, then
   * notifies the gateway for each in-flight call. A late result is quarantined and can never
   * revive or publish a cancelled run (D7.3).
   */
  async cancel(runId: string, reason: string): Promise<RuntimeCancelReceipt> {
    const session = this.#active.get(runId)
    if (session === undefined) {
      return { runId, status: 'not_found', acceptedAt: this.#now(), abandonedAttempts: [] }
    }
    session.cancelReason = reason
    this.#abandonInFlight(session, reason)
    session.controller.abort(new Error(reason))
    session.agent?.abort()
    return {
      runId,
      status: 'cancelling',
      acceptedAt: this.#now(),
      abandonedAttempts: [...session.abandoned],
    }
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

  async #run(
    session: Session,
    deps: RuntimeDependencies,
    emit: Emit,
    input: { readonly prompt: string; readonly restoredMessages: readonly AgentMessage[] | undefined },
  ): Promise<void> {
    emit({
      ...this.#base(session),
      type: 'plan_proposed',
      planRef: this.#planRef(session.runId),
      stepCount: this.#toolIds.length,
      toolIds: [...this.#toolIds],
    })

    const agent = this.#createAgent(session, deps, emit, input.restoredMessages)
    session.agent = agent
    const unsubscribe = agent.subscribe((event) => this.#onAgentEvent(session, deps, emit, event))
    try {
      await agent.prompt(input.prompt)
    } catch (error) {
      session.failure ??= platformErrorFor('INTERNAL_ERROR', messageOf(error), session.ctx.traceId)
    } finally {
      unsubscribe()
    }

    if (session.controller.signal.aborted || deps.signal.aborted) {
      this.#abandonInFlight(session, session.cancelReason ?? 'run cancelled')
      await this.#saveCheckpoint(session, deps, emit).catch(() => undefined)
      this.#emitCancelled(session, emit)
      return
    }
    if (session.failure !== undefined) {
      emit({ ...this.#base(session), type: 'failed', error: session.failure })
      return
    }
    await this.#saveCheckpoint(session, deps, emit)
    emit({
      ...this.#base(session),
      type: 'collection_complete',
      draftAllowed: true,
      evidenceCount: session.evidenceRefs.length,
    })
  }

  #createAgent(
    session: Session,
    deps: RuntimeDependencies,
    emit: Emit,
    restoredMessages: readonly AgentMessage[] | undefined,
  ): Agent {
    const tools = createGatewayTools({
      toolIds: this.#toolIds,
      gateway: deps.gateway,
      ctx: session.ctx,
      newId: this.#newId,
      hooks: {
        onCall: (call) => {
          session.inFlight.set(call.callId, call.toolId)
        },
        onResult: (call, result) => {
          session.inFlight.delete(call.callId)
          if (result.evidenceRefs.length > 0) {
            session.evidenceRefs.push(...result.evidenceRefs)
            emit({
              ...this.#base(session),
              type: 'evidence_added',
              evidenceRefs: [...result.evidenceRefs],
            })
          }
        },
      },
    })
    return new Agent({
      initialState: {
        systemPrompt: this.#systemPrompt,
        model: this.#model,
        tools: [...tools],
        ...(restoredMessages === undefined ? {} : { messages: [...restoredMessages] }),
      },
      streamFn: createControlledStreamFn({
        generation: deps.generation,
        ctx: session.ctx,
        modelRef: this.#modelRef,
        role: this.#generationRole,
        maxTokens: this.#maxTokens,
        toolIds: this.#toolIds,
        evidenceRefs: () => session.evidenceRefs,
        now: this.#now,
      }),
      beforeToolCall: (context) => this.#beforeToolCall(session, deps, context),
      finishTurn: () => this.#finishTurn(session, deps),
      // Sequential execution keeps the runtime event order deterministic for a single
      // assistant message's tool batch; the gateway still owns per-call authorization.
      toolExecution: 'sequential',
    })
  }

  async #onAgentEvent(
    session: Session,
    deps: RuntimeDependencies,
    emit: Emit,
    event: AgentEvent,
  ): Promise<void> {
    if (event.type === 'tool_execution_start') {
      if (isToolId(event.toolName)) {
        emit({
          ...this.#base(session),
          type: 'step_started',
          stepId: event.toolCallId,
          toolId: event.toolName,
          attempt: 1,
        })
      }
      return
    }
    if (event.type === 'turn_end') {
      session.completedTurns += 1
      await this.#saveCheckpoint(session, deps, emit)
    }
  }

  /**
   * Pre-flight only: it keeps the loop from proposing tools outside the host-authorized
   * surface or after the shared budget/deadline is spent. It is never the authorization
   * decision — the gateway still validates, reserves and authorizes each call.
   */
  async #beforeToolCall(
    session: Session,
    deps: RuntimeDependencies,
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> {
    if (session.controller.signal.aborted || deps.signal.aborted) {
      return { block: true, reason: 'the run is cancelled' }
    }
    const name = context.toolCall.name
    if (!this.#exposed.has(name)) {
      return { block: true, reason: `${name} is not enabled for this run` }
    }
    const denial = await this.#budgetGate(session, deps)
    if (denial !== undefined) {
      session.failure = denial
      return { block: true, reason: denial.message }
    }
    return undefined
  }

  /**
   * The stop hook. It ends the loop when the injected signal is aborted or when the shared
   * budget/deadline is spent, and it returns `undefined` otherwise so normal Pi scheduling
   * continues. Combined with the abort signal it is the only stop mechanism: no per-result
   * `terminate` hint is consulted.
   */
  async #finishTurn(session: Session, deps: RuntimeDependencies): Promise<AgentTurnDecision | undefined> {
    if (session.controller.signal.aborted || deps.signal.aborted) return { action: 'end' }
    const denial = await this.#budgetGate(session, deps)
    if (denial !== undefined) {
      session.failure = denial
      return { action: 'end' }
    }
    return undefined
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
    const deadlineMs = Math.min(
      Date.parse(session.ctx.deadline),
      Date.parse(session.inputRemaining.deadline),
      Date.parse(remaining.deadline),
    )
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
      return platformErrorFor('DEADLINE_EXCEEDED', 'the shared run deadline has passed', session.ctx.traceId)
    }
    const allowance = Math.min(session.inputRemaining.toolCallsRemaining, remaining.toolCallsRemaining)
    if (allowance <= 0) {
      return platformErrorFor(
        'BUDGET_EXHAUSTED',
        'the shared run budget has no tool calls remaining',
        session.ctx.traceId,
      )
    }
    return undefined
  }

  async #saveCheckpoint(session: Session, deps: RuntimeDependencies, emit: Emit): Promise<void> {
    const messages: readonly AgentMessage[] =
      session.agent === undefined ? [] : [...session.agent.state.messages]
    const payload: CheckpointPayload = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      adapterVersion: this.manifest.version,
      sdkVersion: this.#sdkVersion,
      messages,
      evidenceRefs: session.evidenceRefs.map((ref) => ({ ...ref })),
      toolIds: [...this.#toolIds],
      completedTurns: session.completedTurns,
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

  #emitCancelled(session: Session, emit: Emit): void {
    const reason = session.cancelReason ?? 'run cancelled'
    emit({
      ...this.#base(session),
      type: 'cancelled',
      reason,
      abandonedAttempts: [...session.abandoned],
    })
  }

  #abandonInFlight(session: Session, reason: string): void {
    for (const [callId, toolId] of session.inFlight) {
      session.abandoned.push({
        attemptId: this.#newId(),
        callId,
        toolId,
        abandonedAt: this.#now(),
        lateResultPolicy: 'quarantined',
        reason,
      })
      void session.gateway.cancel(callId, reason, session.ctx).catch(() => undefined)
    }
    session.inFlight.clear()
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
      throw new PiRuntimeError(
        'UNTRUSTED_DEPENDENCIES',
        'the runtime requires a host-minted trusted tool context',
      )
    }
    return deps.ctx
  }

  #assertRunId(runId: string, ctx: ToolContext): void {
    if (runId !== ctx.runId) {
      throw new PiRuntimeError(
        'UNTRUSTED_DEPENDENCIES',
        `the runtime input names run ${runId}, not the trusted context run ${ctx.runId}`,
      )
    }
  }

  #assertCheckpointRef(ref: RuntimeCheckpointRef): void {
    if (ref.runtimeKind !== this.manifest.id || ref.runtimeVersion !== this.manifest.version) {
      throw new PiRuntimeError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint runtime ${ref.runtimeKind}@${ref.runtimeVersion} does not match ${this.manifest.id}@${this.manifest.version}`,
      )
    }
  }

  #assertCheckpointCompatible(restored: CheckpointPayload): void {
    if (
      restored.runtimeKind !== this.manifest.id ||
      restored.adapterVersion !== this.manifest.version
    ) {
      throw new PiRuntimeError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint adapter ${restored.runtimeKind}@${restored.adapterVersion} does not match ${this.manifest.id}@${this.manifest.version}`,
      )
    }
    if (restored.sdkVersion !== this.#sdkVersion) {
      throw new PiRuntimeError(
        'CHECKPOINT_INCOMPATIBLE',
        `checkpoint Pi SDK ${restored.sdkVersion} does not match the locked SDK ${this.#sdkVersion}`,
      )
    }
  }

  #planRef(runId: string): ResourceRef {
    const toolIds = [...this.#toolIds].sort()
    return {
      id: `pi-collection:${runId}`,
      version: this.manifest.version,
      digest: sha256DigestOf(`pi-collection:${toolIds.join(',')}`),
      kind: 'plan',
    }
  }

  #open(
    runId: string,
    ctx: ToolContext,
    deps: RuntimeDependencies,
    inputRemaining: BudgetRemaining,
  ): Session {
    const controller = new AbortController()
    if (deps.signal.aborted) controller.abort(deps.signal.reason)
    else deps.signal.addEventListener('abort', () => controller.abort(deps.signal.reason), { once: true })
    const session: Session = {
      runId,
      ctx,
      gateway: deps.gateway,
      inputRemaining,
      controller,
      evidenceRefs: [],
      inFlight: new Map(),
      abandoned: [],
      agent: undefined,
      cancelReason: undefined,
      failure: undefined,
      completedTurns: 0,
      sequence: 0,
    }
    this.#active.set(runId, session)
    return session
  }
}

function buildModel(config: PiRuntimeConfig): Model<Api> {
  return {
    id: config.modelRef.modelId,
    name: config.modelRef.modelId,
    api: 'unknown',
    provider: config.modelRef.provider ?? 'ontology',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: config.maxTokens ?? 1024,
  }
}

function continuationPrompt(input: ResumeInput): string {
  if (input.clarificationResponse === undefined) return DEFAULT_CONTINUATION
  return `${DEFAULT_CONTINUATION} The user answered the clarification. Typed response (untrusted data): ${JSON.stringify(
    input.clarificationResponse.typedResponse,
  )}`
}

function isToolId(value: string): value is ToolId {
  return (
    value === 'ontology_lookup' ||
    value === 'data_query' ||
    value === 'document_search' ||
    value === 'web_search'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown runtime failure'
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
