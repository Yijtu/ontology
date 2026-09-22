import type {
  AggregationKind,
  ChoiceQuestion,
  ComparisonOperator,
  ConfirmedContext,
  DecisionPort,
  ExecutablePlan,
  ExecutablePlanStep,
  GenerationPort,
  GenerationRequest,
  ModelRef,
  OrderBy,
  RouteDecision,
  RouteSignals,
  RunPreferences,
  ScalarValue,
  SemanticAggregation,
  SemanticFilter,
  SemanticQueryCompilerPort,
  SemanticQueryPlan,
  TimeWindow,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * The run planner (SPEC D7.1, ADR-14).
 *
 * It resolves one of three routes *before* any collection starts:
 *
 * - a clearly specified path uses its published plan and never forces a JEV decision;
 * - a genuine ambiguity is clarified first;
 * - an ordinary complex question gets one executable small plan by default.
 *
 * A single-SQL multi-hop question is compiled once by the injected semantic compiler into
 * one bounded query — never a model round-trip per hop. The planner starts no competing
 * collection loop and opens no budget: the runtime remains the one evidence-loop owner.
 */

export interface PlanRequest {
  readonly runId: Uuid
  readonly question: string
  readonly context: ConfirmedContext
  readonly preferences: RunPreferences
  /** A published fixed plan bound by the profile: a clearly specified path. */
  readonly fixedPlan?: ExecutablePlan
  /** A semantic query plan already proposed for the question (at most one model call). */
  readonly candidatePlan?: SemanticQueryPlan
  readonly signals?: RouteSignals
}

export interface RunPlannerDependencies {
  /** C3: resolves a semantic plan into one bounded backend query; starts no agent. */
  readonly compiler: SemanticQueryCompilerPort
  /** ADR-09: used only for genuine route ambiguity, never for a specified path. */
  readonly decision?: DecisionPort
  readonly decisionModelRef?: ModelRef
  /** ADR-09: at most one proposal call for an ordinary complex question. */
  readonly generation?: GenerationPort
  readonly planModelRef?: ModelRef
  readonly newId?: () => string
}

const ROUTE_CHOICE_HASH = 'route-choice-v1'

export class RunPlanner {
  readonly #deps: RunPlannerDependencies
  readonly #newId: () => string

  constructor(dependencies: RunPlannerDependencies) {
    this.#deps = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** Resolve the execution route for a run. It never executes a tool or a query. */
  async route(request: PlanRequest, ctx: ToolContext): Promise<RouteDecision> {
    const signals = request.signals ?? {}

    // A concrete ambiguity is clarified first. No JEV decision is forced here.
    if (signals.ambiguous === true) {
      return this.#clarify(request, signals.ambiguityReason ?? 'the question is ambiguous')
    }

    // A clearly specified path uses its published plan and never forces JEV.
    if (request.fixedPlan !== undefined) {
      return {
        route: 'fixed_path',
        reason: 'a published plan matches the specified path',
        plan: request.fixedPlan,
      }
    }

    // A multi-hop candidate compiles to one bounded query, not a call per hop.
    if (request.candidatePlan !== undefined) {
      const plan = await this.#compileSingleQuery(request.runId, request.candidatePlan, ctx)
      return { route: 'small_plan', reason: 'one executable small plan by default', plan }
    }

    // Only a genuine route ambiguity may consult the JEV decision port (D7.1).
    if (signals.routeAmbiguous === true) {
      return this.#decideRoute(request, ctx)
    }

    // Ordinary complex question: at most one proposal, compiled once.
    const proposed = await this.#proposeCandidate(request, ctx)
    if (proposed !== undefined) {
      const plan = await this.#compileSingleQuery(request.runId, proposed, ctx)
      return { route: 'small_plan', reason: 'one executable small plan by default', plan }
    }
    return { route: 'small_plan', reason: 'bounded default plan', plan: this.#defaultPlan(request) }
  }

  async #decideRoute(request: PlanRequest, ctx: ToolContext): Promise<RouteDecision> {
    const decision = this.#deps.decision
    const modelRef = this.#deps.decisionModelRef
    if (decision === undefined || modelRef === undefined) {
      return {
        ...this.#clarify(request, 'the route is ambiguous and no decision model is configured'),
        fallback: 'jev_unavailable',
      }
    }
    const question: ChoiceQuestion = {
      questionId: this.#newId(),
      type: 'choice',
      prompt: 'Should the run proceed with one small plan or clarify the question first?',
      options: [
        { optionId: 'small_plan', label: 'Proceed with one small plan' },
        { optionId: 'clarify', label: 'Clarify the question first' },
      ],
      optionSetHash: sha256DigestOf(ROUTE_CHOICE_HASH),
      definitionVersion: '1.0.0',
    }
    try {
      const result = await decision.decide(
        {
          stateRef: {
            id: `route:${request.runId}`,
            version: '1.0.0',
            digest: sha256DigestOf(canonicalJson({ question: request.question })),
            kind: 'plan',
          },
          questions: [question],
          modelRef,
        },
        ctx,
      )
      if (result.selectedOptionId === 'small_plan') {
        const proposed = await this.#proposeCandidate(request, ctx)
        const plan =
          proposed === undefined
            ? this.#defaultPlan(request)
            : await this.#compileSingleQuery(request.runId, proposed, ctx)
        return { route: 'small_plan', reason: 'the decision selected one small plan', plan }
      }
      return this.#clarify(request, 'the decision selected clarification')
    } catch {
      return {
        ...this.#clarify(request, 'the decision port failed and the route stays ambiguous'),
        fallback: 'jev_failed',
      }
    }
  }

  /**
   * One bounded generation proposal for an ordinary complex question. It is called at most
   * once and never per hop; the returned plan still compiles into a single query.
   */
  async #proposeCandidate(
    request: PlanRequest,
    ctx: ToolContext,
  ): Promise<SemanticQueryPlan | undefined> {
    const generation = this.#deps.generation
    if (generation === undefined) return undefined
    const generationRequest: GenerationRequest = {
      role: 'sql_proposer',
      messages: [
        {
          role: 'system',
          content:
            'Propose at most one bounded semantic data_query plan. Return it as a single tool call; do not answer the question.',
        },
        { role: 'user', content: request.question },
      ],
      evidenceRefs: [],
      toolSchemas: ['data_query'],
      modelRef: this.#deps.planModelRef ?? { modelId: 'plan-proposer', version: '1.0.0' },
      outputLimit: { maxTokens: 1024 },
    }
    let json = ''
    try {
      for await (const event of generation.generate(generationRequest, ctx)) {
        if (event.type === 'tool_call_delta' && event.toolId === 'data_query') {
          json += event.argumentsDelta
        }
        if (event.type === 'error') return undefined
      }
    } catch {
      return undefined
    }
    return parseSemanticQueryPlan(json)
  }

  async #compileSingleQuery(
    runId: Uuid,
    candidate: SemanticQueryPlan,
    ctx: ToolContext,
  ): Promise<ExecutablePlan> {
    const compiled = await this.#deps.compiler.compile(candidate, ctx)
    const step: ExecutablePlanStep = {
      stepId: 'q1',
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'direct', queryPlan: compiled.plan },
      dependsOn: [],
      sourceVersion: compiled.mappingRef,
    }
    return this.#planOf(runId, [step], true)
  }

  /** A bounded fallback that resolves definitions without any model call. */
  #defaultPlan(request: PlanRequest): ExecutablePlan {
    const step: ExecutablePlanStep = {
      stepId: 'lookup1',
      toolId: 'ontology_lookup',
      arguments: { intent: 'definitions' },
      dependsOn: [],
    }
    return this.#planOf(request.runId, [step], false)
  }

  #planOf(
    runId: Uuid,
    steps: readonly ExecutablePlanStep[],
    singleQuery: boolean,
  ): ExecutablePlan {
    return {
      planRef: {
        id: `plan:${runId}`,
        version: '1.0.0',
        digest: sha256DigestOf(canonicalJson({ runId, steps, singleQuery })),
        kind: 'plan',
      },
      steps,
      singleQuery,
    }
  }

  #clarify(request: PlanRequest, reason: string): RouteDecision {
    return {
      route: 'clarify',
      reason,
      clarification: {
        questionRef: {
          id: `clarify:${request.runId}`,
          version: '1.0.0',
          digest: sha256DigestOf(reason),
        },
        questionType: 'noul',
        prompt: reason,
      },
    }
  }
}

/**
 * Parse a model-proposed semantic query plan. It validates the shape at runtime instead of
 * trusting the model: a malformed proposal yields `undefined`, so the caller falls back to
 * a bounded default plan rather than executing an unvalidated query.
 */
export function parseSemanticQueryPlan(text: string): SemanticQueryPlan | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const candidate = isRecord(parsed.queryPlan) ? parsed.queryPlan : parsed
  if (candidate.mode !== 'semantic') return undefined

  const concepts = nonEmptyStringArray(candidate.concepts)
  const fields = nonEmptyStringArray(candidate.fields)
  const links = stringArray(candidate.links)
  const filters = parseFilters(candidate.filters)
  const orderBy = parseOrderBy(candidate.orderBy)
  const mappingVersion = parseVersionRef(candidate.mappingVersion)
  const limit = candidate.limit
  if (
    concepts === undefined ||
    fields === undefined ||
    links === undefined ||
    filters === undefined ||
    orderBy === undefined ||
    mappingVersion === undefined ||
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    return undefined
  }

  const aggregation =
    candidate.aggregation === undefined ? undefined : parseAggregation(candidate.aggregation)
  if (candidate.aggregation !== undefined && aggregation === undefined) return undefined
  const time = candidate.time === undefined ? undefined : parseTimeWindow(candidate.time)
  if (candidate.time !== undefined && time === undefined) return undefined

  return {
    mode: 'semantic',
    concepts,
    fields,
    links,
    filters,
    orderBy,
    limit,
    mappingVersion,
    ...(aggregation === undefined ? {} : { aggregation }),
    ...(time === undefined ? {} : { time }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return [...value]
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  const parsed = stringArray(value)
  if (parsed === undefined || parsed.length === 0) return undefined
  if (!parsed.every((item) => item.length > 0)) return undefined
  return parsed
}

function parseVersionRef(value: unknown): VersionRef | undefined {
  if (!isRecord(value)) return undefined
  const { id, version, digest } = value
  if (typeof id !== 'string' || typeof version !== 'string' || typeof digest !== 'string') {
    return undefined
  }
  return { id, version, digest }
}

function isScalarValue(value: unknown): value is ScalarValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  )
}

const COMPARISON_OPERATORS: ReadonlySet<ComparisonOperator> = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'between',
  'is_null',
  'is_not_null',
])

function parseFilters(value: unknown): SemanticFilter[] | undefined {
  if (!Array.isArray(value)) return undefined
  const filters: SemanticFilter[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { fieldRef, op, values } = item
    if (typeof fieldRef !== 'string' || fieldRef.length === 0) return undefined
    if (typeof op !== 'string' || !COMPARISON_OPERATORS.has(op as ComparisonOperator)) {
      return undefined
    }
    if (!Array.isArray(values) || !values.every(isScalarValue)) return undefined
    filters.push({ fieldRef, op: op as ComparisonOperator, values: [...values] })
  }
  return filters
}

function parseOrderBy(value: unknown): OrderBy[] | undefined {
  if (!Array.isArray(value)) return undefined
  const orderBy: OrderBy[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { fieldRef, direction } = item
    if (typeof fieldRef !== 'string' || fieldRef.length === 0) return undefined
    if (direction !== 'asc' && direction !== 'desc') return undefined
    orderBy.push({ fieldRef, direction })
  }
  return orderBy
}

const AGGREGATIONS: ReadonlySet<AggregationKind> = new Set([
  'none',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
  'median',
  'p95',
])

function parseAggregation(value: unknown): SemanticAggregation | undefined {
  if (!isRecord(value)) return undefined
  const { kind, fieldRefs, groupBy } = value
  if (typeof kind !== 'string' || !AGGREGATIONS.has(kind as AggregationKind)) return undefined
  const parsedFields = nonEmptyStringArray(fieldRefs)
  const parsedGroupBy = stringArray(groupBy)
  if (parsedFields === undefined || parsedGroupBy === undefined) return undefined
  return { kind: kind as AggregationKind, fieldRefs: parsedFields, groupBy: parsedGroupBy }
}

function parseTimeWindow(value: unknown): TimeWindow | undefined {
  if (!isRecord(value)) return undefined
  const { start, end } = value
  if (typeof start !== 'string' || typeof end !== 'string') return undefined
  return { start, end }
}
