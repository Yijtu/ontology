import type {
  AggregationKind,
  ChoiceQuestion,
  ComparisonOperator,
  ConfirmedContext,
  DecisionPort,
  DecisionResult,
  ExecutablePlan,
  ExecutablePlanStep,
  GenerationMessage,
  GenerationPort,
  GenerationRequest,
  ModelRef,
  OrderBy,
  RouteDecision,
  RouteSignals,
  ResourceRef,
  RunPreferences,
  ScalarValue,
  SchemaVocabulary,
  SchemaVocabularyPort,
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
import { WorkflowControllerError } from './errors'
import type { QuestionRewriter } from './question-rewriting'
import type { DecisionStateRefProvider } from '../verification/service'
import { renderFewShotExamplesData } from '../examples/few-shot-retriever'
import type { FewShotExampleProvider } from '../examples/few-shot-retriever'
import { renderVocabularyBlock, vocabularyEvidenceRef } from './vocabulary'

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
  /**
   * The exact confirmed-mapping / published-definition versions the run is bound to. They
   * are resolved into the bounded schema vocabulary injected into the generation request.
   * Absent/empty refs produce an explicit degradation, never a loose empty schema.
   */
  readonly mappingRefs?: readonly VersionRef[]
  readonly definitionRefs?: readonly VersionRef[]
}

export interface RunPlannerDependencies {
  /** C3: resolves a semantic plan into one bounded backend query; starts no agent. */
  readonly compiler: SemanticQueryCompilerPort
  /**
   * The schema-construction stage. It builds the bounded vocabulary injected into the
   * generation request from confirmed mappings and published definitions only. It is
   * required: a generation proposal is never attempted without it, so the old
   * loose-empty-schema path cannot be reached.
   */
  readonly vocabulary: SchemaVocabularyPort
  /** ADR-09: used only for genuine route ambiguity, never for a specified path. */
  readonly decision?: DecisionPort
  readonly decisionModelRef?: ModelRef
  /**
   * Host-owned immutable archive that registers the exact run/profile authorization before
   * returning its artifact ref. The planner never substitutes a digest or derives the ref.
   */
  readonly decisionStateRefProvider?: DecisionStateRefProvider
  /** ADR-09: at most one proposal call for an ordinary complex question. */
  readonly generation?: GenerationPort
  readonly planModelRef?: ModelRef
  /**
   * The bounded question-rewriting pre-step. When present it runs before any routing/SQL
   * proposal; when absent the router behaves exactly as before. It reuses the injected
   * `GenerationPort` and adds no model port and no public tool.
   */
  readonly rewriter?: QuestionRewriter
  /**
   * LOCAL-076: optional few-shot examples for the proposal prompt. They are retrieved from
   * versioned example sets and injected as untrusted data only; absence or failure of the
   * provider never changes the tool catalogue, budget or the validation the plan still passes.
   */
  readonly examples?: FewShotExampleProvider
  readonly newId?: () => string
}

const ROUTE_CHOICE_HASH = 'route-choice-v1'
const MAX_ROUTE_STATE_BYTES = 65_536
const MAX_ROUTE_STATE_RECORDS = 1_000
const MAX_ROUTE_STATE_REFS = 64

const RECOVERABLE_ROUTE_DECISION_CODES: ReadonlySet<string> = new Set([
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'INSUFFICIENT_DATA',
])

interface RouteDecisionStateInput {
  readonly request: PlanRequest
  readonly ctx: ToolContext
  readonly question: ChoiceQuestion
  readonly vocabulary: SchemaVocabulary
}

/** The application-side bound; the same small caps the engine defaults to. */
const DEFAULT_VOCABULARY_LIMITS = { maxConcepts: 8, maxFields: 32 } as const

/** The outcome of one bounded generation attempt. */
type CandidateProposal =
  | { readonly kind: 'proposed'; readonly plan: SemanticQueryPlan; readonly vocabularyRef: VersionRef }
  | { readonly kind: 'degraded'; readonly reason: string }
  | { readonly kind: 'unavailable' }

export class RunPlanner {
  readonly #deps: RunPlannerDependencies
  readonly #newId: () => string

  constructor(dependencies: RunPlannerDependencies) {
    this.#deps = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Resolve the execution route for a run. It never executes a tool or a query.
   *
   * When a rewrite step is configured it runs first, before any routing or SQL proposal:
   * an ambiguity returns the existing `clarify` route without ever guessing a value, a
   * failure is surfaced as an explicit classified error (the original is never passed
   * through as a rewrite), and a successful rewrite replaces the question the router sees
   * while its traceable record rides on the returned decision.
   */
  async route(request: PlanRequest, ctx: ToolContext): Promise<RouteDecision> {
    const rewriter = this.#deps.rewriter
    if (rewriter === undefined) return this.#routeEffective(request, ctx)

    const outcome = await rewriter.rewrite(
      {
        runId: request.runId,
        question: request.question,
        context: request.context,
        evidenceRefs: [],
      },
      ctx,
    )
    if (outcome.status === 'clarify') {
      return this.#clarify(request, outcome.reason)
    }
    if (outcome.status === 'failed') {
      throw new WorkflowControllerError(
        outcome.error.code,
        `question rewriting failed: ${outcome.error.message}`,
      )
    }
    const decision = await this.#routeEffective(
      { ...request, question: outcome.rewrite.rewrittenQuestion },
      ctx,
    )
    return { ...decision, rewrite: outcome.rewrite }
  }

  async #routeEffective(request: PlanRequest, ctx: ToolContext): Promise<RouteDecision> {
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
    return this.#smallPlanRoute(request, ctx, 'one executable small plan by default')
  }

  /**
   * Build one small plan from a single bounded generation proposal. The schema vocabulary
   * is constructed first: when it is missing or empty the route degrades explicitly to a
   * definition lookup instead of letting a loose empty schema silently produce SQL.
   */
  async #smallPlanRoute(
    request: PlanRequest,
    ctx: ToolContext,
    reason: string,
  ): Promise<RouteDecision> {
    const proposal = await this.#proposeCandidate(request, ctx)
    if (proposal.kind === 'proposed') {
      const plan = await this.#compileSingleQuery(request.runId, proposal.plan, ctx)
      return { route: 'small_plan', reason, plan, vocabularyRef: proposal.vocabularyRef }
    }
    if (proposal.kind === 'degraded') {
      return {
        route: 'small_plan',
        reason: 'the semantic schema vocabulary is unavailable, so no SQL candidate is generated',
        fallback: `vocabulary_gap:${proposal.reason}`,
        plan: this.#defaultPlan(request),
      }
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
    const stateRefProvider = this.#deps.decisionStateRefProvider
    if (stateRefProvider === undefined) {
      return {
        ...this.#clarify(request, 'the route is ambiguous and no authorized decision-state archive is configured'),
        fallback: 'jev_state_not_configured',
      }
    }
    if (ctx.runId !== request.runId) {
      throw new WorkflowControllerError('SCOPE_MISMATCH', 'the route request does not match the trusted run context')
    }

    const vocabulary = await this.#buildVocabulary(request, ctx)
    if (vocabulary.gaps.length > 0 || vocabulary.concepts.length === 0) {
      return {
        ...this.#clarify(request, 'the route is ambiguous and confirmed schema vocabulary is unavailable'),
        fallback: 'jev_schema_unavailable',
      }
    }
    if (
      (request.mappingRefs?.length ?? 0) +
        (request.definitionRefs?.length ?? 0) +
        vocabulary.sources.length >
      MAX_ROUTE_STATE_REFS
    ) {
      return {
        ...this.#clarify(request, 'the route is ambiguous and its confirmed schema references exceed the decision-state bound'),
        fallback: 'jev_state_too_large',
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
    const state = routeDecisionStateOf({ request, ctx, question, vocabulary })
    if (!withinRouteStateBounds(state)) {
      return {
        ...this.#clarify(request, 'the route is ambiguous and its actual decision state exceeds the configured bound'),
        fallback: 'jev_state_too_large',
      }
    }
    const stateRef = await stateRefProvider.archive(
      { runId: request.runId, resolvedProfileHash: ctx.resolvedProfileHash, state },
      ctx,
    )
    if (!isRouteDecisionStateRef(stateRef)) {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'the route-state provider returned an invalid immutable artifact reference')
    }

    let result: DecisionResult
    try {
      result = await decision.decide(
        {
          stateRef,
          questions: [question],
          modelRef,
        },
        ctx,
      )
    } catch (error) {
      if (isRecoverableRouteDecisionFailure(error)) {
        return {
          ...this.#clarify(request, 'the decision provider was unavailable, so the route stays ambiguous'),
          fallback: `jev_failed:${routeDecisionErrorCode(error) ?? 'provider_unavailable'}`,
        }
      }
      throw error
    }
    if (
      result.questionId !== question.questionId ||
      result.questionType !== question.type ||
      result.definitionVersion !== question.definitionVersion ||
      result.optionSetHash !== question.optionSetHash
    ) {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'the route decision did not match its question contract')
    }
    if (result.fallback !== undefined) {
      return {
        ...this.#clarify(request, 'the decision provider returned an explicit fallback, so the route stays ambiguous'),
        fallback: `jev_provider_fallback:${result.fallback.fallback}`,
      }
    }
    if (result.selectedOptionId === 'small_plan') {
      return this.#smallPlanRoute(request, ctx, 'the decision selected one small plan')
    }
    if (result.selectedOptionId === 'clarify') return this.#clarify(request, 'the decision selected clarification')
    throw new WorkflowControllerError('INVALID_SCHEMA', 'the route decision selected an option outside the declared route set')
  }

  /** Resolve the bounded vocabulary for this question from the run's confirmed sources. */
  async #buildVocabulary(request: PlanRequest, ctx: ToolContext): Promise<SchemaVocabulary> {
    return this.#deps.vocabulary.build(
      {
        question: request.question,
        mappingRefs: request.mappingRefs ?? [],
        definitionRefs: request.definitionRefs ?? [],
        maxConcepts: DEFAULT_VOCABULARY_LIMITS.maxConcepts,
        maxFields: DEFAULT_VOCABULARY_LIMITS.maxFields,
      },
      ctx,
    )
  }

  /**
   * One bounded generation proposal for an ordinary complex question. It is called at most
   * once and never per hop; the returned plan still compiles into a single query.
   *
   * The schema vocabulary is built first and injected as untrusted data. It is placed only
   * in the message stream: the tool catalogue, model ref and output limit stay fixed, so no
   * content in the vocabulary can widen authority (INV-07).
   */
  async #proposeCandidate(request: PlanRequest, ctx: ToolContext): Promise<CandidateProposal> {
    const generation = this.#deps.generation
    if (generation === undefined) return { kind: 'unavailable' }
    const vocabulary = await this.#buildVocabulary(request, ctx)
    if (vocabulary.gaps.length > 0 || vocabulary.concepts.length === 0) {
      return {
        kind: 'degraded',
        reason: vocabulary.gaps[0]?.code ?? 'EMPTY_VOCABULARY',
      }
    }
    const messages: GenerationMessage[] = [
      {
        role: 'system',
        content:
          'Propose at most one bounded semantic data_query plan using only the supplied schema vocabulary. Return it as a single tool call; do not answer the question.',
      },
      { role: 'system', content: renderVocabularyBlock(vocabulary) },
      { role: 'user', content: request.question },
    ]
    const examples = this.#deps.examples
    if (examples !== undefined) {
      // Best-effort enrichment: examples are untrusted data appended as their own message.
      // A retrieval failure yields an explicit status and injects nothing; it never fabricates
      // an example and never touches the tool catalogue, role, model or output limit below.
      const retrieved = await examples.retrieve({ query: request.question }, ctx)
      if (retrieved.examples.length > 0) {
        messages.push({ role: 'user', content: renderFewShotExamplesData(retrieved.examples) })
      }
    }
    const generationRequest: GenerationRequest = {
      role: 'sql_proposer',
      messages,
      evidenceRefs: [vocabularyEvidenceRef(vocabulary)],
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
        if (event.type === 'error') return { kind: 'unavailable' }
      }
    } catch {
      return { kind: 'unavailable' }
    }
    const plan = parseSemanticQueryPlan(json)
    if (plan === undefined) return { kind: 'unavailable' }
    return { kind: 'proposed', plan, vocabularyRef: vocabulary.vocabularyRef }
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

function routeDecisionStateOf(input: RouteDecisionStateInput): Readonly<Record<string, unknown>> {
  const { request, ctx, question, vocabulary } = input
  return {
    kind: 'core_run_route_decision',
    version: '1.0.0',
    runId: request.runId,
    resolvedProfileHash: ctx.resolvedProfileHash,
    question: request.question,
    context: request.context,
    routeSignals: {
      routeAmbiguous: request.signals?.routeAmbiguous === true,
      ...(request.signals?.ambiguityReason === undefined
        ? {}
        : { ambiguityReason: request.signals.ambiguityReason }),
    },
    decisionQuestion: {
      questionId: question.questionId,
      type: question.type,
      prompt: question.prompt,
      optionSetHash: question.optionSetHash,
      definitionVersion: question.definitionVersion,
      options: question.options,
    },
    candidateRoutes: [
      {
        optionId: 'small_plan',
        description: 'Proceed with one bounded plan based on the confirmed schema.',
        toolIds: ['data_query', 'ontology_lookup'],
      },
      {
        optionId: 'clarify',
        description: 'Ask the user to resolve the route ambiguity before collecting evidence.',
        toolIds: [],
      },
    ],
    confirmedSchema: {
      vocabularyRef: vocabulary.vocabularyRef,
      concepts: vocabulary.concepts,
      links: vocabulary.links,
      sources: vocabulary.sources,
      truncated: vocabulary.truncated,
      omittedConceptCount: vocabulary.omittedConceptCount,
      omittedFieldCount: vocabulary.omittedFieldCount,
      mappingRefs: request.mappingRefs ?? [],
      definitionRefs: request.definitionRefs ?? [],
    },
  }
}

function withinRouteStateBounds(state: Readonly<Record<string, unknown>>): boolean {
  const encoder = new TextEncoder()
  const pending: unknown[] = [state]
  let recordCount = 0
  let rawTextBytes = 0
  while (pending.length > 0) {
    const value = pending.pop()
    recordCount += 1
    if (recordCount > MAX_ROUTE_STATE_RECORDS) return false
    if (Array.isArray(value)) {
      if (recordCount + value.length > MAX_ROUTE_STATE_RECORDS) return false
      for (const entry of value) pending.push(entry)
    } else if (isRecord(value)) {
      const keys = Object.keys(value)
      if (recordCount + keys.length > MAX_ROUTE_STATE_RECORDS) return false
      for (const key of keys) {
        rawTextBytes += encoder.encode(key).byteLength
        if (rawTextBytes > MAX_ROUTE_STATE_BYTES) return false
        pending.push(value[key])
      }
    } else if (typeof value === 'string') {
      rawTextBytes += encoder.encode(value).byteLength
      if (rawTextBytes > MAX_ROUTE_STATE_BYTES) return false
    }
  }
  return encoder.encode(canonicalJson(state)).byteLength <= MAX_ROUTE_STATE_BYTES
}

function isRouteDecisionStateRef(ref: ResourceRef): boolean {
  return (
    ref.kind === 'artifact' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ref.id) &&
    ref.version.trim().length > 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(ref.digest)
  )
}

function routeDecisionErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const code = error['code']
  return typeof code === 'string' ? code : undefined
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  if (!isRecord(error)) return false
  return error['name'] === 'AbortError' || error['code'] === 'ABORT_ERR'
}

function isRecoverableRouteDecisionFailure(error: unknown): boolean {
  if (isAbortLike(error)) return false
  const code = routeDecisionErrorCode(error)
  return code !== undefined && RECOVERABLE_ROUTE_DECISION_CODES.has(code)
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
