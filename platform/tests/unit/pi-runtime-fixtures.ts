import { createToolContext } from '@ontology/contracts'
import type {
  BudgetRemaining,
  ComponentManifest,
  DecisionPort,
  DecisionResult,
  GenerationCompleted,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  GenerationTextDelta,
  GenerationToolCallDelta,
  GenerationUsageEvent,
  ResourceRef,
  RuntimeDependencies,
  ToolContext,
  ToolId,
} from '@ontology/contracts'
import type { PiRuntimeConfig } from '@ontology/adapter-runtime-pi'
import {
  DEADLINE,
  FakeBudget,
  InMemoryCheckpoints,
  NOW,
  RUN_ID,
  SCOPE,
  ScriptedGateway,
  evidenceRef,
  runtimeInput,
} from './template-runtime-fixtures'

const DIGEST = `sha256:${'a'.repeat(64)}`
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export { RUN_ID, NOW, DEADLINE, SCOPE, evidenceRef, runtimeInput, InMemoryCheckpoints, ScriptedGateway }

export function piContext(overrides?: {
  readonly runId?: string
  readonly deadline?: string
}): ToolContext {
  const runId = overrides?.runId ?? RUN_ID
  return createToolContext({
    principal: {
      tenantId: TENANT_ID,
      subjectId: 'user:pi-test',
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
    traceId: 'trace-pi-runtime',
  })
}

export function piManifest(overrides?: Partial<ComponentManifest>): ComponentManifest {
  return {
    kind: 'runtime',
    id: 'runtime-pi',
    version: '1.0.0',
    digest: DIGEST,
    contractRange: { min: '0.2.0' },
    provides: [],
    requires: [],
    entrypointRef: { kind: 'package', ref: '@ontology/adapter-runtime-pi' },
    trustStatus: 'local_dev',
    ...overrides,
  }
}

export function piConfig(overrides?: Partial<PiRuntimeConfig>): PiRuntimeConfig {
  return {
    manifest: piManifest(),
    toolIds: ['ontology_lookup', 'document_search'],
    modelRef: { modelId: 'company-model-demo', version: '1.0.0', provider: 'company' },
    ...overrides,
  }
}

export function textDelta(text: string): GenerationTextDelta {
  return { type: 'text_delta', text }
}

export function toolCallDelta(
  callId: string,
  toolId: ToolId,
  args: Readonly<Record<string, unknown>>,
): GenerationToolCallDelta {
  return { type: 'tool_call_delta', callId, toolId, argumentsDelta: JSON.stringify(args) }
}

export function usageEvent(inputTokens: number, outputTokens: number): GenerationUsageEvent {
  return { type: 'usage', usage: { inputTokens, outputTokens } }
}

export function completedEvent(
  stopReason: GenerationCompleted['stopReason'] = 'stop',
): GenerationCompleted {
  return { type: 'completed', stopReason, candidateOnly: true }
}

/** A scripted step for one generation call: a fixed event list, or a block until abort. */
export type ScriptEntry =
  | { readonly kind: 'events'; readonly events: readonly GenerationEvent[] }
  | { readonly kind: 'block' }

export function events(...entries: GenerationEvent[]): ScriptEntry {
  return { kind: 'events', events: entries }
}

export const BLOCK: ScriptEntry = { kind: 'block' }

/**
 * Deterministic `GenerationPort` double. It records every request and, when the consumer
 * stops before the script's `completed` event (e.g. because the run was cancelled), records
 * a `usage_unknown` settlement — mirroring the real generation adapter's cleanup contract
 * for a remote call that may already have been billed. No model is called.
 */
export class ScriptedGeneration implements GenerationPort {
  readonly requests: GenerationRequest[] = []
  readonly settlements: ('completed' | 'usage_unknown')[] = []
  readonly #scripts: ScriptEntry[]
  readonly #signal: AbortSignal | undefined

  constructor(scripts: readonly ScriptEntry[], options?: { readonly signal?: AbortSignal }) {
    this.#scripts = [...scripts]
    this.#signal = options?.signal
  }

  generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    this.requests.push(request)
    const entry = this.#scripts.shift() ?? events()
    const settlements = this.settlements
    const signal = this.#signal
    return (async function* (): AsyncGenerator<GenerationEvent, void, void> {
      let complete = false
      try {
        if (entry.kind === 'block') {
          await waitForAbort(signal)
          return
        }
        for (const event of entry.events) {
          yield event
          if (event.type === 'completed') complete = true
        }
        complete = true
      } finally {
        settlements.push(complete ? 'completed' : 'usage_unknown')
      }
    })()
  }
}

export const forbiddenDecision: DecisionPort = {
  decide(): Promise<DecisionResult> {
    throw new Error('the Pi runtime must not call the decision port')
  },
}

export interface PiDependencyHarness {
  readonly gateway: ScriptedGateway
  readonly budget: FakeBudget
  readonly checkpoints: InMemoryCheckpoints
  readonly generation: ScriptedGeneration
  readonly ctx: ToolContext
  readonly controller: AbortController
  readonly dependencies: RuntimeDependencies
}

export function buildPiDependencies(options?: {
  readonly ctx?: ToolContext
  readonly budget?: Partial<BudgetRemaining>
  readonly gateway?: ScriptedGateway
  readonly checkpoints?: InMemoryCheckpoints
  readonly scripts?: readonly ScriptEntry[]
  readonly controller?: AbortController
}): PiDependencyHarness {
  const ctx = options?.ctx ?? piContext()
  const gateway = options?.gateway ?? new ScriptedGateway()
  const budget = new FakeBudget(options?.budget)
  const checkpoints = options?.checkpoints ?? new InMemoryCheckpoints()
  const controller = options?.controller ?? new AbortController()
  const generation = new ScriptedGeneration(options?.scripts ?? [], { signal: controller.signal })
  const dependencies: RuntimeDependencies = {
    ctx,
    gateway,
    generation,
    decision: forbiddenDecision,
    checkpoints,
    budget,
    signal: controller.signal,
  }
  return { gateway, budget, checkpoints, generation, ctx, controller, dependencies }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export type { ResourceRef }
