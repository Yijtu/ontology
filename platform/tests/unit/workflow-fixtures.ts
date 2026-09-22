import { randomUUID } from 'node:crypto'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import {
  AnswerPublicationService,
  InMemoryAnswerStore,
  InMemoryPublicationValidity,
  InMemoryRunStore,
  InMemoryWorkflowStore,
  InMemoryVerificationStore,
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  RestrictedLimitedAnswerComposer,
  RunPhaseDriver,
  RunService,
  StaticInputValidity,
  WorkflowController,
  createRunCheckpointPort,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import type {
  AnswerPublisherPort,
  AnswerVerifierPort,
  BudgetLedgerPort,
  BudgetPort,
  ComponentManifest,
  DecisionPort,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  GenerationPort,
  InputValidityPort,
  ProfileRef,
  ResourceRef,
  ResumeInput,
  RuntimeAdapter,
  RuntimeCancelReceipt,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeCheckpointRef,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeInput,
  RuntimeSelectorPort,
  ToolContext,
  ToolGateway,
  Uuid,
  VerificationStorePort,
  VersionRef,
  WorkflowInputEntry,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { RecordingControlRepository, fixedClock, toolContext, RUN_A } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import {
  ScriptedGateway,
  forbiddenDecision,
  forbiddenGeneration,
} from './template-runtime-fixtures'

export { RUN_A, SCOPE_A, toolContext, fixedClock, RecordingControlRepository, ScriptedGateway }
export { forbiddenDecision, forbiddenGeneration }

export const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
export const DIGEST = `sha256:${'a'.repeat(64)}`
export const NOW = '2026-09-21T00:00:00Z'
export const DEADLINE = '2030-01-01T00:00:00Z'

export function runtimeManifest(overrides?: Partial<ComponentManifest>): ComponentManifest {
  return {
    kind: 'runtime',
    id: 'runtime-template',
    version: '1.0.0',
    digest: DIGEST,
    contractRange: { min: '0.2.0' },
    provides: [],
    requires: [],
    entrypointRef: { kind: 'package', ref: '@ontology/adapter-runtime-template' },
    trustStatus: 'local_dev',
    ...overrides,
  }
}

export class FakeProfileBinder implements RunProfileBinder {
  binding: RunProfileBinding = {
    profileRef: PROFILE_REF,
    resolvedProfileHash: DIGEST,
    resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: DIGEST },
    runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
  }

  bindProfileForRun(): Promise<RunProfileBinding> {
    return Promise.resolve(this.binding)
  }
}

/** Counts how many strategy loops were started, per component, to prove single ownership. */
export class LoopProbe {
  runtimeLoops = 0
  competingLoops = 0
}

/**
 * A deterministic runtime double. It yields a scripted batch per start/resume call, can
 * block before emitting (for the cancellation race) and can persist a private checkpoint
 * through the injected port so a later resume restores it.
 */
export class ScriptedRuntime implements RuntimeAdapter {
  readonly manifest: ComponentManifest
  readonly startCalls: string[] = []
  readonly resumeCalls: string[] = []
  readonly cancelCalls: { readonly runId: string; readonly reason: string }[] = []
  readonly budgetReserveAttempts: string[] = []
  readonly probe: LoopProbe
  readonly #scripts: RuntimeEvent[][]
  readonly #saveCheckpoint: boolean
  #gate: Promise<void> | undefined
  #releaseGate: (() => void) | undefined

  constructor(options: {
    readonly manifest?: ComponentManifest
    readonly scripts: readonly (readonly RuntimeEvent[])[]
    readonly probe?: LoopProbe
    /** Save a private checkpoint and emit `checkpoint_ready` before the first script. */
    readonly saveCheckpoint?: boolean
  }) {
    this.manifest = options.manifest ?? runtimeManifest()
    this.#scripts = options.scripts.map((script) => [...script])
    this.probe = options.probe ?? new LoopProbe()
    this.#saveCheckpoint = options.saveCheckpoint === true
  }

  /** Block `start`/`resume` until `release()` is called. */
  block(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#releaseGate = resolve
    })
  }

  release(): void {
    this.#releaseGate?.()
    this.#releaseGate = undefined
    this.#gate = undefined
  }

  async *start(input: RuntimeInput, deps: RuntimeDependencies): AsyncGenerator<RuntimeEvent, void, void> {
    this.startCalls.push(input.runId)
    this.probe.runtimeLoops += 1
    await this.#tryReserveBudget(deps)
    if (this.#gate !== undefined) await this.#gate
    if (this.#saveCheckpoint) {
      yield* this.#emitCheckpoint(input.runId, deps)
    }
    for (const event of this.#scripts.shift() ?? []) yield event
  }

  async *resume(input: ResumeInput, deps: RuntimeDependencies): AsyncGenerator<RuntimeEvent, void, void> {
    this.resumeCalls.push(input.runId)
    this.probe.runtimeLoops += 1
    await this.#tryReserveBudget(deps)
    if (this.#gate !== undefined) await this.#gate
    for (const event of this.#scripts.shift() ?? []) yield event
  }

  async cancel(runId: string, reason: string): Promise<RuntimeCancelReceipt> {
    this.cancelCalls.push({ runId, reason })
    this.release()
    return { runId, status: 'cancelling', acceptedAt: NOW, abandonedAttempts: [] }
  }

  async *#emitCheckpoint(
    runId: string,
    deps: RuntimeDependencies,
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const ref: RuntimeCheckpointRef = {
      checkpointId: randomUUID(),
      runId,
      runtimeKind: this.manifest.id,
      runtimeVersion: this.manifest.version,
      stateDigest: DIGEST,
      createdAt: NOW,
    }
    const saved = await deps.checkpoints.save(runId, ref, new Uint8Array([1, 2, 3]), deps.ctx)
    yield checkpointReadyEvent(runId, saved)
  }

  async #tryReserveBudget(deps: RuntimeDependencies): Promise<void> {
    try {
      await deps.budget.reserve('probe', { toolCalls: 1, bytes: 0 }, deps.ctx)
      // A runtime that managed to reserve directly would have reset the shared ledger.
      this.budgetReserveAttempts.push('granted')
    } catch {
      this.budgetReserveAttempts.push('denied')
    }
  }
}

/** Records every runtime selection and always returns the one injected adapter. */
export class RecordingRuntimeSelector implements RuntimeSelectorPort {
  readonly selected: VersionRef[] = []
  readonly #adapter: RuntimeAdapter
  readonly probe: LoopProbe

  constructor(adapter: RuntimeAdapter, probe?: LoopProbe) {
    this.#adapter = adapter
    this.probe = probe ?? new LoopProbe()
  }

  select(runtimeRef: VersionRef): Promise<RuntimeAdapter> {
    if (this.selected.length > 0) this.probe.competingLoops += 1
    this.selected.push(runtimeRef)
    return Promise.resolve(this.#adapter)
  }
}

/** Returns a fixed restricted closure built from the host-injected gateway and ports. */
export class StaticCapabilityFactory implements RuntimeCapabilityFactoryPort {
  readonly calls: Uuid[] = []
  readonly #gateway: ToolGateway
  readonly #generation: GenerationPort
  readonly #decision: DecisionPort
  readonly #checkpoints: RuntimeCapabilitySet['checkpoints']

  constructor(input: {
    readonly gateway: ToolGateway
    readonly checkpoints: RuntimeCapabilitySet['checkpoints']
    readonly generation?: GenerationPort
    readonly decision?: DecisionPort
  }) {
    this.#gateway = input.gateway
    this.#checkpoints = input.checkpoints
    this.#generation = input.generation ?? forbiddenGeneration
    this.#decision = input.decision ?? forbiddenDecision
  }

  forRun(context: { readonly runId: Uuid }): Promise<RuntimeCapabilitySet> {
    this.calls.push(context.runId)
    return Promise.resolve({
      gateway: this.#gateway,
      generation: this.#generation,
      decision: this.#decision,
      checkpoints: this.#checkpoints,
    })
  }
}

/** Counts draft-writer / verifier / publisher calls and can force a usage-unknown hold. */
export class RecordingDraftWriter implements DraftWriterPort {
  readonly calls: DraftWriterRequest[] = []
  usageUnknown = false
  readonly #inner: DraftWriterPort

  constructor(inner: DraftWriterPort) {
    this.#inner = inner
  }

  async writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    this.calls.push(request)
    const result = await this.#inner.writeDraft(request, ctx)
    if (this.usageUnknown) {
      return { ...result, usage: { durationMs: 1, usageUnknown: true } }
    }
    return result
  }
}

export class RecordingVerifier implements AnswerVerifierPort {
  readonly calls: number[] = []
  readonly #inner: AnswerVerifierPort
  failOnce = false
  alwaysFail = false

  constructor(inner: AnswerVerifierPort) {
    this.#inner = inner
  }

  async verify(
    request: Parameters<AnswerVerifierPort['verify']>[0],
    ctx: ToolContext,
  ): Promise<Awaited<ReturnType<AnswerVerifierPort['verify']>>> {
    this.calls.push(this.calls.length + 1)
    const result = await this.#inner.verify(request, ctx)
    if (this.alwaysFail) {
      return { ...result, verdict: 'fail', failedChecks: ['forced_failure'] }
    }
    if (this.failOnce) {
      this.failOnce = false
      return { ...result, verdict: 'fail', failedChecks: ['forced_failure'] }
    }
    return result
  }
}

export class RecordingPublisher implements AnswerPublisherPort {
  readonly publishCalls: number[] = []
  readonly #inner: AnswerPublisherPort

  constructor(inner: AnswerPublisherPort) {
    this.#inner = inner
  }

  publish(
    request: Parameters<AnswerPublisherPort['publish']>[0],
    ctx: ToolContext,
  ): Promise<Awaited<ReturnType<AnswerPublisherPort['publish']>>> {
    this.publishCalls.push(this.publishCalls.length + 1)
    return this.#inner.publish(request, ctx)
  }

  findAnswer(runId: Uuid, ctx: ToolContext) {
    return this.#inner.findAnswer(runId, ctx)
  }
}

/** Counts `openLedger` calls so a test can prove the budget is opened exactly once. */
export class RecordingBudget implements BudgetLedgerPort {
  readonly openLedgerCalls: Uuid[] = []
  readonly #inner: BudgetLedgerPort

  constructor(inner: BudgetLedgerPort) {
    this.#inner = inner
  }

  openLedger(
    input: Parameters<BudgetLedgerPort['openLedger']>[0],
    ctx: ToolContext,
  ): ReturnType<BudgetLedgerPort['openLedger']> {
    this.openLedgerCalls.push(input.ledgerId)
    return this.#inner.openLedger(input, ctx)
  }

  reserve(
    input: Parameters<BudgetLedgerPort['reserve']>[0],
    ctx: ToolContext,
  ): ReturnType<BudgetLedgerPort['reserve']> {
    return this.#inner.reserve(input, ctx)
  }

  recordIntent(
    input: Parameters<BudgetLedgerPort['recordIntent']>[0],
    ctx: ToolContext,
  ): ReturnType<BudgetLedgerPort['recordIntent']> {
    return this.#inner.recordIntent(input, ctx)
  }

  settle(
    input: Parameters<BudgetLedgerPort['settle']>[0],
    ctx: ToolContext,
  ): ReturnType<BudgetLedgerPort['settle']> {
    return this.#inner.settle(input, ctx)
  }

  remaining(
    ledgerId: Uuid,
    ctx: ToolContext,
  ): ReturnType<BudgetLedgerPort['remaining']> {
    return this.#inner.remaining(ledgerId, ctx)
  }
}

export interface WorkflowHarness {
  readonly controller: WorkflowController
  readonly service: RunService
  readonly store: InMemoryRunStore
  readonly budget: RecordingBudget
  readonly budgetService: BudgetService
  readonly budgetStore: InMemoryBudgetLedgerStore
  readonly workflowStore: InMemoryWorkflowStore
  readonly verifications: VerificationStorePort
  readonly selector: RecordingRuntimeSelector
  readonly runtime: ScriptedRuntime
  readonly draftWriter: RecordingDraftWriter
  readonly verifier: RecordingVerifier
  readonly publisher: RecordingPublisher
  readonly validity: StaticInputValidity
  readonly publicationValidity: InMemoryPublicationValidity
  readonly answers: InMemoryAnswerStore
  readonly limited: RestrictedLimitedAnswerComposer
  readonly probe: LoopProbe
  readonly capabilities: StaticCapabilityFactory
  readonly gateway: ScriptedGateway
}

export function buildWorkflowHarness(options: {
  readonly runtime: ScriptedRuntime
  readonly probe?: LoopProbe
  readonly gateway?: ScriptedGateway
  /** Override the bounded draft writer (e.g. to emit structured claims). */
  readonly draftWriter?: DraftWriterPort
  /** Override the verifier (e.g. the real combined `DraftVerificationService`). */
  readonly verifier?: AnswerVerifierPort
}): WorkflowHarness {
  const probe = options.probe ?? options.runtime.probe
  const store = new InMemoryRunStore()
  const control = new RecordingControlRepository()
  const binder = new FakeProfileBinder()
  const service = new RunService({
    store,
    control,
    profiles: binder,
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  const phase = new RunPhaseDriver({ store, control, now: fixedClock(), newId: () => randomUUID() })
  const budgetStore = new InMemoryBudgetLedgerStore()
  const budgetService = new BudgetService({
    store: budgetStore,
    control: new RecordingControlRepository(),
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  const budget = new RecordingBudget(budgetService)
  const workflowStore = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const validity = new StaticInputValidity()
  const gateway = options.gateway ?? new ScriptedGateway()
  const capabilities = new StaticCapabilityFactory({
    gateway,
    checkpoints: createRunCheckpointPort(store),
  })
  const selector = new RecordingRuntimeSelector(options.runtime, probe)
  const draftWriter = new RecordingDraftWriter(options.draftWriter ?? new RestrictedDraftWriter())
  const verifier = new RecordingVerifier(options.verifier ?? new RestrictedAnswerVerifier())
  const publicationValidity = new InMemoryPublicationValidity()
  const answers = new InMemoryAnswerStore(store)
  const limited = new RestrictedLimitedAnswerComposer()
  const publisher = new RecordingPublisher(
    new AnswerPublicationService({
      runs: store,
      answers,
      verifications,
      manifests: workflowStore,
      validity: publicationValidity,
      now: fixedClock(),
      newId: () => randomUUID(),
    }),
  )
  const controller = new WorkflowController({
    runs: service,
    phase,
    budget,
    manifests: workflowStore,
    runtimes: selector,
    capabilities,
    draftWriter,
    limited,
    verifier,
    verifications,
    publisher,
    validity,
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  return {
    controller,
    service,
    store,
    budget,
    budgetService,
    budgetStore,
    workflowStore,
    verifications,
    selector,
    runtime: options.runtime,
    draftWriter,
    verifier,
    publisher,
    validity,
    publicationValidity,
    answers,
    limited,
    probe,
    capabilities,
    gateway,
  }
}

export function ownerContext(runId = RUN_A): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)
}

export function otherContext(runId = RUN_A): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'other-a', runId)
}

export function startInput(overrides?: {
  readonly runId?: string
  readonly idempotencyKey?: string
  readonly budgetOverrides?: { readonly maxRepairAttempts?: number; readonly maxToolCalls?: number }
}): Parameters<WorkflowController['startRun']>[0] {
  return {
    runId: overrides?.runId ?? RUN_A,
    profileRef: PROFILE_REF,
    question: 'compare tomorrow energy strategies',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto', allowWeb: false },
    idempotencyKey: overrides?.idempotencyKey ?? 'workflow-idem-0001',
    ...(overrides?.budgetOverrides === undefined
      ? {}
      : { budgetOverrides: overrides.budgetOverrides }),
  }
}

export function evidenceRef(seed: string): ResourceRef {
  return { id: `evidence-${seed}`, version: '1.0.0', digest: sha256DigestOf(seed), kind: 'evidence' }
}

let sequenceCounter = 0
function base(runId: string): { runId: string; eventId: string; sequence: number; occurredAt: string } {
  sequenceCounter += 1
  return { runId, eventId: randomUUID(), sequence: sequenceCounter, occurredAt: NOW }
}

export function planEvent(runId: string): RuntimeEvent {
  return {
    ...base(runId),
    type: 'plan_proposed',
    planRef: { id: 'plan-1', version: '1.0.0', digest: DIGEST, kind: 'plan' },
    stepCount: 1,
    toolIds: ['ontology_lookup'],
  }
}

export function evidenceEvent(runId: string, refs: readonly ResourceRef[]): RuntimeEvent {
  return { ...base(runId), type: 'evidence_added', evidenceRefs: [...refs] }
}

export function clarificationEvent(runId: string, clarificationId: string): RuntimeEvent {
  return {
    ...base(runId),
    type: 'clarification_requested',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: DIGEST },
    questionType: 'choice',
  }
}

export function collectionCompleteEvent(runId: string, evidenceCount = 1): RuntimeEvent {
  return { ...base(runId), type: 'collection_complete', draftAllowed: true, evidenceCount }
}

export function cancelledEvent(runId: string, reason = 'runtime stopped'): RuntimeEvent {
  return { ...base(runId), type: 'cancelled', reason, abandonedAttempts: [] }
}

export function checkpointRef(
  runId: string,
  manifest: ComponentManifest,
  digest = DIGEST,
): RuntimeCheckpointRef {
  return {
    checkpointId: randomUUID(),
    runId,
    runtimeKind: manifest.id,
    runtimeVersion: manifest.version,
    stateDigest: digest,
    createdAt: NOW,
  }
}

export function checkpointReadyEvent(
  runId: string,
  ref: RuntimeCheckpointRef,
): RuntimeEvent {
  return { ...base(runId), type: 'checkpoint_ready', checkpointRef: ref }
}

export function evidenceEntries(entries: readonly WorkflowInputEntry[]): WorkflowInputEntry[] {
  return entries.filter((entry) => entry.kind === 'evidence')
}

export { randomUUID }
export type { BudgetPort, InputValidityPort }
