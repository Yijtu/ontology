import { createToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  BudgetPort,
  BudgetRemaining,
  CancelResponse,
  ComponentManifest,
  DecisionPort,
  DecisionResult,
  ErrorCode,
  GenerationEvent,
  GenerationPort,
  PlanSpec,
  ResourceRef,
  ResumeInput,
  RuntimeCheckpointPort,
  RuntimeCheckpointRef,
  RuntimeDependencies,
  RuntimeInput,
  ScopeRef,
  ToolCall,
  ToolContext,
  ToolGateway,
  ToolResult,
  ToolResultStatus,
  ToolUsage,
} from '@ontology/contracts'
import type { PublishedPlan, TemplatePlanResolver } from '@ontology/adapter-runtime-template'

export const RUN_ID = '33333333-3333-4333-8333-333333333333'
export const TENANT_ID = '11111111-1111-4111-8111-111111111111'
export const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const NOW = '2026-09-21T00:00:00Z'
export const DEADLINE = '2030-01-01T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`

export const SCOPE: ScopeRef = { tenantId: TENANT_ID, spaceId: SPACE_ID }

export function templateContext(overrides?: {
  readonly runId?: string
  readonly deadline?: string
}): ToolContext {
  const runId = overrides?.runId ?? RUN_ID
  return createToolContext({
    principal: {
      tenantId: TENANT_ID,
      subjectId: 'user:template-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: overrides?.deadline ?? DEADLINE,
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId,
      grantedAt: NOW,
      expiresAt: DEADLINE,
    },
    allowedResources: {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [{ namespace: 'ha-anker', sourceId: 'warehouse' }],
      collectionRefs: ['home-energy/manuals'],
      domains: ['example.com'],
      maxRows: 1000,
    },
    traceId: 'trace-template-runtime',
  })
}

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

export function evidenceRef(seed: string): ResourceRef {
  return { id: `evidence-${seed}`, version: '1.0.0', digest: sha256DigestOf(seed), kind: 'evidence' }
}

export function okResult(
  callId: string,
  inlineData: NonNullable<ToolResult['inlineData']>,
  evidence: readonly ResourceRef[] = [evidenceRef(callId)],
  status: ToolResultStatus = 'ok',
): ToolResult {
  const usage: ToolUsage = { durationMs: 1, rows: 1, bytes: 1, calls: 1 }
  return {
    callId,
    status,
    inlineData,
    schemaRef: { id: 'tool.output', version: '1.0.0', digest: DIGEST },
    evidenceRefs: [...evidence],
    sourceSnapshots: [
      {
        sourceRef: { namespace: 'ha-anker', sourceId: 'warehouse' },
        schemaVersion: '2026-09-01',
        readAt: NOW,
        consistency: 'repeatable_read',
        resultDigest: DIGEST,
      },
    ],
    coverage: { returned: status === 'empty' ? 0 : 1, truncated: false },
    usage,
    warnings: [],
  }
}

export function errorResult(callId: string, code: ErrorCode): ToolResult {
  return {
    callId,
    status: 'error',
    schemaRef: { id: 'tool.output', version: '1.0.0', digest: DIGEST },
    evidenceRefs: [],
    sourceSnapshots: [],
    coverage: { returned: 0, truncated: false },
    usage: { durationMs: 1 },
    warnings: [],
    error: { code, message: `${code} injected`, retryable: false },
  }
}

export type GatewayHandler = (call: ToolCall) => Promise<ToolResult> | ToolResult

/**
 * A scripted gateway: it records every call and cancellation and delegates to a handler
 * registered per tool id. It is a controlled double for the real `ToolGatewayService`; the
 * integration suite exercises the real gateway against PostgreSQL.
 */
export class ScriptedGateway implements ToolGateway {
  readonly calls: ToolCall[] = []
  readonly cancellations: { readonly callId: string; readonly reason: string }[] = []
  readonly #handlers = new Map<string, GatewayHandler>()

  on(toolId: string, handler: GatewayHandler): this {
    this.#handlers.set(toolId, handler)
    return this
  }

  async invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    void ctx
    this.calls.push(call)
    const handler = this.#handlers.get(call.toolId)
    if (handler === undefined) {
      return errorResult(call.callId, 'UNSUPPORTED_QUERY')
    }
    return handler(call)
  }

  async cancel(callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse> {
    void ctx
    this.cancellations.push({ callId, reason })
    return { targetRef: callId, state: 'unsupported', acceptedAt: NOW }
  }

  callIdsFor(toolId: string): string[] {
    return this.calls.filter((call) => call.toolId === toolId).map((call) => call.callId)
  }
}

/**
 * Budget double. `reserve`/`settle` deliberately throw: the runtime must never open or
 * settle a ledger itself, only read the shared projection.
 */
export class FakeBudget implements BudgetPort {
  readonly remainingCalls: string[] = []
  remainingValue: BudgetRemaining

  constructor(remainingValue?: Partial<BudgetRemaining>) {
    this.remainingValue = {
      deadline: DEADLINE,
      toolCallsRemaining: 8,
      repairAttemptsRemaining: 2,
      parallelToolLimit: 4,
      ...remainingValue,
    }
  }

  reserve(): Promise<never> {
    return Promise.reject(new Error('the runtime must not reserve budget directly'))
  }

  settle(): Promise<never> {
    return Promise.reject(new Error('the runtime must not settle budget directly'))
  }

  remaining(runId: string): Promise<BudgetRemaining> {
    this.remainingCalls.push(runId)
    return Promise.resolve(this.remainingValue)
  }
}

export class InMemoryCheckpoints implements RuntimeCheckpointPort {
  readonly saved: { readonly runId: string; readonly ref: RuntimeCheckpointRef; readonly payload: Uint8Array }[] = []

  save(runId: string, ref: RuntimeCheckpointRef, payload: Uint8Array): Promise<RuntimeCheckpointRef> {
    this.saved.push({ runId, ref, payload })
    return Promise.resolve(ref)
  }

  load(runId: string, ref: RuntimeCheckpointRef): Promise<Uint8Array> {
    const found = this.saved.find(
      (entry) => entry.runId === runId && entry.ref.checkpointId === ref.checkpointId,
    )
    if (found === undefined) {
      return Promise.reject(new Error(`no checkpoint ${ref.checkpointId} for run ${runId}`))
    }
    return Promise.resolve(found.payload)
  }

  latest(): { readonly runId: string; readonly ref: RuntimeCheckpointRef; readonly payload: Uint8Array } | undefined {
    return this.saved.at(-1)
  }
}

/** Model ports that must never be reached by the template runtime. */
export const forbiddenGeneration: GenerationPort = {
  generate(): AsyncIterable<GenerationEvent> {
    throw new Error('the template runtime must not call the generation port')
  },
}

export const forbiddenDecision: DecisionPort = {
  decide(): Promise<DecisionResult> {
    throw new Error('the template runtime must not call the decision port')
  },
}

export interface DependencyHarness {
  readonly gateway: ScriptedGateway
  readonly budget: FakeBudget
  readonly checkpoints: InMemoryCheckpoints
  readonly ctx: ToolContext
  readonly controller: AbortController
  readonly dependencies: RuntimeDependencies
}

export function buildDependencies(options?: {
  readonly ctx?: ToolContext
  readonly budget?: Partial<BudgetRemaining>
  readonly gateway?: ScriptedGateway
  readonly checkpoints?: InMemoryCheckpoints
}): DependencyHarness {
  const ctx = options?.ctx ?? templateContext()
  const gateway = options?.gateway ?? new ScriptedGateway()
  const budget = new FakeBudget(options?.budget)
  const checkpoints = options?.checkpoints ?? new InMemoryCheckpoints()
  const controller = new AbortController()
  const dependencies: RuntimeDependencies = {
    ctx,
    gateway,
    generation: forbiddenGeneration,
    decision: forbiddenDecision,
    checkpoints,
    budget,
    signal: controller.signal,
  }
  return { gateway, budget, checkpoints, ctx, controller, dependencies }
}

/** An in-memory published-plan resolver. */
export class StaticPlanResolver implements TemplatePlanResolver {
  readonly resolved: (ResourceRef | undefined)[] = []
  readonly #plan: PublishedPlan

  constructor(plan: PublishedPlan) {
    this.#plan = plan
  }

  resolve(planRef: ResourceRef | undefined): Promise<PublishedPlan> {
    this.resolved.push(planRef)
    return Promise.resolve(this.#plan)
  }
}

export function publishedPlan(spec: PlanSpec, planRef?: ResourceRef): PublishedPlan {
  return {
    planRef:
      planRef ??
      spec.planRef ?? {
        id: 'plan-template-demo',
        version: '1.0.0',
        digest: sha256DigestOf('plan-template-demo'),
        kind: 'plan',
      },
    spec,
  }
}

export function runtimeInput(overrides?: {
  readonly runId?: string
  readonly planRef?: ResourceRef
  readonly remainingBudget?: Partial<BudgetRemaining>
}): RuntimeInput {
  const runId = overrides?.runId ?? RUN_ID
  return {
    runId,
    resolvedProfileRef: {
      id: 'home-energy-demo',
      version: '1.0.0',
      snapshotHash: DIGEST,
    },
    question: 'compare tomorrow backup strategies',
    confirmedContext: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    evidenceRefs: [],
    deficits: [],
    ...(overrides?.planRef === undefined ? {} : { planRef: overrides.planRef }),
    remainingBudget: {
      deadline: DEADLINE,
      toolCallsRemaining: 8,
      repairAttemptsRemaining: 2,
      parallelToolLimit: 4,
      ...overrides?.remainingBudget,
    },
  }
}

export function resumeInput(
  checkpointRef: RuntimeCheckpointRef,
  overrides?: {
    readonly runId?: string
    readonly clarificationResponse?: ResumeInput['clarificationResponse']
    readonly remainingBudget?: Partial<BudgetRemaining>
  },
): ResumeInput {
  const runId = overrides?.runId ?? RUN_ID
  return {
    runId,
    checkpointRef,
    ...(overrides?.clarificationResponse === undefined
      ? {}
      : { clarificationResponse: overrides.clarificationResponse }),
    remainingBudget: {
      deadline: DEADLINE,
      toolCallsRemaining: 8,
      repairAttemptsRemaining: 2,
      parallelToolLimit: 4,
      ...overrides?.remainingBudget,
    },
  }
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A barrier that only releases once `size` callers have arrived. */
export class Barrier {
  #arrived = 0
  #release: (() => void) | undefined

  constructor(private readonly size: number) {}

  async wait(): Promise<void> {
    this.#arrived += 1
    if (this.#arrived >= this.size) {
      this.#release?.()
      return
    }
    await new Promise<void>((resolve) => {
      this.#release = resolve
    })
  }
}
