import { randomUUID } from 'node:crypto'
import type {
  BudgetRemaining,
  CancelResponse,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  DirectSqlQueryPlan,
  ErrorCode,
  ExecutablePlan,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  SemanticQueryCompilerPort,
  SemanticQueryPlan,
  ToolCall,
  ToolContext,
  ToolGateway,
  ToolResult,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'

export const PLANNING_RUN = '22222222-2222-4222-8222-222222222222'
export const SOURCE_VERSION = {
  id: 'home-energy.mapping.join',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
} as const

export const BUDGET: BudgetRemaining = {
  deadline: '2030-01-01T00:00:00Z',
  toolCallsRemaining: 8,
  repairAttemptsRemaining: 2,
  parallelToolLimit: 4,
}

export function budgetWith(overrides: Partial<BudgetRemaining>): BudgetRemaining {
  return { ...BUDGET, ...overrides }
}

/** A three-concept, two-link (multi-hop) semantic query plan. */
export function multiHopPlan(): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: ['energy_reading', 'meter', 'site'],
    fields: ['energy_kwh', 'meter_name', 'site_name'],
    links: ['reading_meter', 'meter_site'],
    filters: [],
    orderBy: [],
    limit: 50,
    mappingVersion: { ...SOURCE_VERSION },
  }
}

export function multiHopPlanJson(): string {
  return JSON.stringify({ kind: 'query', mode: 'semantic', queryPlan: multiHopPlan() })
}

export function directPlanFor(plan: SemanticQueryPlan): DirectSqlQueryPlan {
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: `SELECT ${plan.fields.join(', ')} FROM readings JOIN meters ON readings.meter_id = meters.meter_id`,
    parameters: [],
    referencedObjects: [
      {
        sourceRef: { namespace: 'home-energy', sourceId: 'warehouse' },
        objectPath: 'public.energy_readings',
      },
    ],
    readOnly: true,
  }
}

export function fixedPlan(): ExecutablePlan {
  return {
    planRef: {
      id: 'plan-fixed',
      version: '1.0.0',
      digest: sha256DigestOf('plan-fixed'),
      kind: 'plan',
    },
    steps: [
      {
        stepId: 'lookup1',
        toolId: 'ontology_lookup',
        arguments: { intent: 'definitions' },
        dependsOn: [],
      },
    ],
    singleQuery: false,
  }
}

/** Counts every generation call and replays one scripted stream. */
export class CountingGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  #script: GenerationEvent[] = []

  script(events: readonly GenerationEvent[]): this {
    this.#script = [...events]
    return this
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    this.calls.push(request)
    for (const event of this.#script) yield event
  }
}

/** Counts every compile call and returns one bounded direct query per plan. */
export class CountingCompiler implements SemanticQueryCompilerPort {
  readonly calls: SemanticQueryPlan[] = []

  compile(
    plan: SemanticQueryPlan,
    ctx: ToolContext,
  ): Promise<{ plan: DirectSqlQueryPlan; mappingRef: SemanticQueryPlan['mappingVersion']; warnings: string[] }> {
    void ctx
    this.calls.push(plan)
    return Promise.resolve({
      plan: directPlanFor(plan),
      mappingRef: plan.mappingVersion,
      warnings: [],
    })
  }
}

/** Counts every JEV decision call; can be made to fail so the fallback path is provable. */
export class CountingDecision implements DecisionPort {
  readonly calls: DecisionRequest[] = []
  selected = 'small_plan'
  fail = false

  decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request)
    if (this.fail) return Promise.reject(new Error('the decision port is unavailable'))
    const question = request.questions[0]
    if (question === undefined) return Promise.reject(new Error('no question was supplied'))
    const optionSetHash =
      question.type === 'noul' ? sha256DigestOf(question.questionId) : question.optionSetHash
    return Promise.resolve({
      questionId: question.questionId,
      questionType: question.type,
      definitionVersion: '1.0.0',
      optionSetHash,
      selectedOptionId: this.selected,
    })
  }
}

/** A gateway double that replays one scripted result per invocation. */
export class QueuedGateway implements ToolGateway {
  readonly calls: ToolCall[] = []
  #results: ToolResult[] = []

  queue(result: ToolResult): this {
    this.#results.push(result)
    return this
  }

  invoke(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call)
    const next = this.#results.shift()
    if (next === undefined) return Promise.reject(new Error('no scripted tool result'))
    return Promise.resolve({ ...next, callId: call.callId })
  }

  cancel(callId: string): Promise<CancelResponse> {
    return Promise.resolve({
      targetRef: callId,
      state: 'unsupported',
      acceptedAt: '2026-09-21T00:00:00Z',
    })
  }
}

/** Builds a minimal ToolResult with the given status and evidence seed. */
export function toolResult(options: {
  readonly callId?: string
  readonly status: ToolResult['status']
  readonly evidenceSeed?: string
  readonly resultDigest?: string
  readonly errorCode?: ErrorCode
}): ToolResult {
  const callId = options.callId ?? randomUUID()
  const digest = options.resultDigest ?? sha256DigestOf(options.evidenceSeed ?? 'shared')
  const evidenceSeed = options.evidenceSeed ?? 'shared'
  const base: ToolResult = {
    callId,
    status: options.status,
    schemaRef: { id: 'tool.output', version: '1.0.0', digest },
    evidenceRefs:
      options.status === 'error'
        ? []
        : [
            {
              id: `evidence-${evidenceSeed}`,
              version: '1.0.0',
              digest: sha256DigestOf(evidenceSeed),
              kind: 'evidence',
            },
          ],
    sourceSnapshots:
      options.status === 'error'
        ? []
        : [
            {
              sourceRef: { namespace: 'home-energy', sourceId: 'warehouse' },
              schemaVersion: '2026-09-01',
              readAt: '2026-09-21T00:00:00Z',
              consistency: 'repeatable_read',
              resultDigest: digest,
            },
          ],
    coverage: { returned: options.status === 'ok' ? 1 : 0, truncated: false },
    usage: { durationMs: 1 },
    warnings: [],
  }
  if (options.status === 'error') {
    return {
      ...base,
      error: {
        code: options.errorCode ?? 'SOURCE_UNAVAILABLE',
        message: 'injected tool failure',
        retryable: true,
      },
    }
  }
  if (options.status === 'ok' || options.status === 'partial') {
    return { ...base, inlineData: { rows: [] } }
  }
  return base
}
