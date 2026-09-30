import type {
  AggregationKind,
  ChoiceQuestion,
  ComparisonOperator,
  ConfirmedContext,
  DecisionPort,
  DecisionResult,
  ExecutablePlan,
  ExecutablePlanStep,
  GenerationEvent,
  GenerationMessage,
  GenerationPort,
  GenerationRequest,
  ModelRef,
  OrderBy,
  PlatformError,
  RouteDecision,
  RouteSignals,
  RevisionString,
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
 * - a clearly specified path uses its published plan and never invokes a model;
 * - a genuine ambiguity is clarified first;
 * - a supported ordinary complex question gets one bounded semantic plan; unsupported
 *   questions fail visibly instead of being changed into a definitions lookup.
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
  /** Host-verified response to one prior route clarification receipt. */
  readonly routeClarification?: {
    readonly receiptRef: ResourceRef
    readonly questionRef: VersionRef
    readonly clarificationId: Uuid
    readonly typedResponse: Readonly<Record<string, unknown>>
    readonly expectedRevision: RevisionString
  }
  /**
   * The exact confirmed-mapping / published-definition versions the run is bound to. They
   * are resolved into the bounded schema vocabulary injected into the generation request.
   * Absent/empty refs cannot produce a semantic plan.
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
   * The bounded question-rewriting pre-step. When present it runs before routing/SQL
   * proposal for ordinary requests; fixed plans and deterministic ambiguities bypass it.
   * It reuses the injected `GenerationPort` and adds no model port and no public tool.
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
const MAX_GENERATION_EVENT_COUNT = 1_024
const MAX_GENERATION_STREAM_BYTES = 131_072
const MAX_PROPOSED_TOOL_JSON_BYTES = 65_536

const RECOVERABLE_ROUTE_DECISION_CODES: ReadonlySet<string> = new Set([
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'INSUFFICIENT_DATA',
])
const RECOVERABLE_GENERATION_CODES: ReadonlySet<string> = new Set([
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
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
  | { readonly kind: 'recoverable_failure'; readonly error: PlatformError }

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
   * For ordinary requests, a configured rewrite runs before routing or SQL proposal. A
   * fixed plan and a deterministic ambiguity are handled first without model calls. Rewrite
   * ambiguity clarifies, failure remains classified, and a successful rewrite is traceable
   * on the returned decision. `signal` is the active run signal when the host can provide it.
   */
  async route(request: PlanRequest, ctx: ToolContext, signal?: AbortSignal): Promise<RouteDecision> {
    throwIfPlanningStopped(ctx, signal)

    const routeClarification = request.routeClarification
    if (routeClarification !== undefined) {
      if (ctx.runId !== request.runId) {
        throw new WorkflowControllerError('SCOPE_MISMATCH', 'the route clarification does not match the trusted run context')
      }
      const routeClarificationState = routeClarificationStateOf(routeClarification)
      if (
        !isRouteClarificationReceiptRef(routeClarification.receiptRef) ||
        !parseVersionRef(routeClarification.questionRef) ||
        typeof routeClarification.clarificationId !== 'string' ||
        routeClarification.clarificationId.trim().length === 0 ||
        !isRecord(routeClarification.typedResponse) ||
        typeof routeClarification.expectedRevision !== 'string' ||
        routeClarification.expectedRevision.trim().length === 0 ||
        !withinRouteStateBounds(routeClarificationState)
      ) {
        throw new WorkflowControllerError('INVALID_SCHEMA', 'the host-verified route clarification is invalid or exceeds its bound')
      }
    }

    // A deterministic ambiguity needs no model, and a host-supplied fixed plan is already
    // the selected answer path. Neither case should be rewritten or routed through a model.
    if (
      request.signals?.ambiguous === true ||
      request.fixedPlan !== undefined ||
      request.routeClarification !== undefined
    ) {
      return this.#routeEffective(request, ctx, signal)
    }

    const rewriter = this.#deps.rewriter
    if (rewriter === undefined) return this.#routeEffective(request, ctx, signal)

    const outcome = await rewriter.rewrite(
      {
        runId: request.runId,
        question: request.question,
        context: request.context,
        evidenceRefs: [],
      },
      ctx,
    )
    throwIfPlanningStopped(ctx, signal)
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
      signal,
    )
    return { ...decision, rewrite: outcome.rewrite }
  }

  async #routeEffective(request: PlanRequest, ctx: ToolContext, signal?: AbortSignal): Promise<RouteDecision> {
    throwIfPlanningStopped(ctx, signal)
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
      const plan = await this.#compileSingleQuery(request.runId, request.candidatePlan, ctx, signal)
      return { route: 'small_plan', reason: 'one executable small plan by default', plan }
    }

    // Only a genuine route ambiguity may consult the JEV decision port (D7.1).
    if (signals.routeAmbiguous === true) {
      return this.#decideRoute(request, ctx, signal)
    }

    // Ordinary complex question: at most one proposal, compiled once.
    return this.#smallPlanRoute(request, ctx, 'one executable small plan by default', signal)
  }

  /**
   * Build one small plan from a single bounded generation proposal. Missing confirmed
   * vocabulary is an unsupported query, never an invitation to substitute a different task.
   */
  async #smallPlanRoute(
    request: PlanRequest,
    ctx: ToolContext,
    reason: string,
    signal?: AbortSignal,
  ): Promise<RouteDecision> {
    const proposal = await this.#proposeCandidate(request, ctx, signal)
    if (proposal.kind === 'proposed') {
      throwIfPlanningStopped(ctx, signal)
      const plan = await this.#compileSingleQuery(request.runId, proposal.plan, ctx, signal)
      return { route: 'small_plan', reason, plan, vocabularyRef: proposal.vocabularyRef }
    }
    return {
      ...this.#clarify(request, 'the generation provider was unavailable, so the question needs clarification'),
      fallback: `generation_failed:${proposal.error.code}`,
    }
  }

  async #decideRoute(request: PlanRequest, ctx: ToolContext, signal?: AbortSignal): Promise<RouteDecision> {
    throwIfPlanningStopped(ctx, signal)
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
    throwIfPlanningStopped(ctx, signal)
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
    throwIfPlanningStopped(ctx, signal)
    const stateRef = await stateRefProvider.archive(
      { runId: request.runId, resolvedProfileHash: ctx.resolvedProfileHash, state },
      ctx,
    )
    throwIfPlanningStopped(ctx, signal)
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
      throwIfPlanningStopped(ctx, signal)
      if (isRecoverableRouteDecisionFailure(error)) {
        return {
          ...this.#clarify(request, 'the decision provider was unavailable, so the route stays ambiguous'),
          fallback: `jev_failed:${routeDecisionErrorCode(error) ?? 'provider_unavailable'}`,
        }
      }
      throw error
    }
    throwIfPlanningStopped(ctx, signal)
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
      return this.#smallPlanRoute(request, ctx, 'the decision selected one small plan', signal)
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
  async #proposeCandidate(request: PlanRequest, ctx: ToolContext, signal?: AbortSignal): Promise<CandidateProposal> {
    const generation = this.#deps.generation
    if (generation === undefined) {
      throw new WorkflowControllerError(
        'CAPABILITY_NOT_CONFIGURED',
        'the selected route requires a generation model, but none is configured',
      )
    }
    throwIfPlanningStopped(ctx, signal)
    const vocabulary = await this.#buildVocabulary(request, ctx)
    throwIfPlanningStopped(ctx, signal)
    if (vocabulary.gaps.length > 0 || vocabulary.concepts.length === 0) {
      const gap = vocabulary.gaps[0]?.code ?? 'EMPTY_VOCABULARY'
      throw new WorkflowControllerError(
        'UNSUPPORTED_QUERY',
        `the selected mappings do not provide a complete semantic vocabulary (${gap})`,
      )
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
    if (request.routeClarification !== undefined) {
      const state = routeClarificationStateOf(request.routeClarification)
      messages.push({
        role: 'user',
        content: `<route_clarification_response untrusted="true">\n${canonicalJson(state)}\n</route_clarification_response>`,
      })
    }
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
    throwIfPlanningStopped(ctx, signal)
    let json = ''
    let proposalBytes = 0
    let streamBytes = 0
    let eventCount = 0
    let callId: string | undefined
    let completed = false
    let recoverableFailure: PlatformError | undefined
    try {
      for await (const event of generation.generate(generationRequest, ctx)) {
        throwIfPlanningStopped(ctx, signal)
        eventCount += 1
        const eventBytes = boundedJsonByteLength(event, MAX_GENERATION_STREAM_BYTES - streamBytes)
        if (eventCount > MAX_GENERATION_EVENT_COUNT || eventBytes > MAX_GENERATION_STREAM_BYTES - streamBytes) {
          throw new WorkflowControllerError('INVALID_SCHEMA', 'the generation stream exceeded its bounded output limit')
        }
        streamBytes += eventBytes
        if (completed && event.type !== 'usage') {
          throw new WorkflowControllerError('INVALID_SCHEMA', 'the generation stream emitted content after completion')
        }
        if (event.type === 'tool_call_delta') {
          if (event.toolId !== 'data_query') {
            throw new WorkflowControllerError('INVALID_SCHEMA', 'the planner received a tool call outside data_query')
          }
          if (callId !== undefined && callId !== event.callId) {
            throw new WorkflowControllerError('INVALID_SCHEMA', 'the planner received more than one proposed tool call')
          }
          proposalBytes += utf8ByteLength(event.argumentsDelta)
          if (proposalBytes > MAX_PROPOSED_TOOL_JSON_BYTES) {
            throw new WorkflowControllerError('INVALID_SCHEMA', 'the proposed semantic query exceeded its byte limit')
          }
          callId = event.callId
          json += event.argumentsDelta
        } else if (event.type === 'completed') {
          if (completed) {
            throw new WorkflowControllerError('INVALID_SCHEMA', 'the generation stream completed more than once')
          }
          completed = true
          if (event.stopReason !== 'tool_calls') {
            throw new WorkflowControllerError('UNSUPPORTED_QUERY', 'the model did not return a semantic data_query proposal')
          }
        } else if (event.type === 'error') {
          if (isRecoverableGenerationFailure(event.error)) {
            recoverableFailure = event.error
            break
          }
          throw new WorkflowControllerError(event.error.code, event.error.message)
        }
      }
    } catch (error) {
      throwIfPlanningStopped(ctx, signal)
      if (isAbortLike(error)) throw error
      if (isRecoverableGenerationFailure(error)) {
        recoverableFailure = toPlatformError(error)
      } else {
        throw error
      }
    }
    throwIfPlanningStopped(ctx, signal)
    if (recoverableFailure !== undefined) return { kind: 'recoverable_failure', error: recoverableFailure }
    if (!completed) {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'the generation stream ended without a completed event')
    }
    if (callId === undefined || json.trim().length === 0) {
      throw new WorkflowControllerError('UNSUPPORTED_QUERY', 'the model did not return a semantic data_query proposal')
    }
    const plan = parseSemanticQueryPlan(json)
    if (plan === undefined) {
      throw new WorkflowControllerError('UNSUPPORTED_QUERY', 'the model proposal is not a supported semantic query')
    }
    return { kind: 'proposed', plan, vocabularyRef: vocabulary.vocabularyRef }
  }

  async #compileSingleQuery(
    runId: Uuid,
    candidate: SemanticQueryPlan,
    ctx: ToolContext,
    signal?: AbortSignal,
  ): Promise<ExecutablePlan> {
    throwIfPlanningStopped(ctx, signal)
    const compiled = await this.#deps.compiler.compile(candidate, ctx)
    throwIfPlanningStopped(ctx, signal)
    const step: ExecutablePlanStep = {
      stepId: 'q1',
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'direct', queryPlan: compiled.plan },
      dependsOn: [],
      sourceVersion: compiled.mappingRef,
    }
    return this.#planOf(runId, [step], true)
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
    ...(request.routeClarification === undefined
      ? {}
      : { routeClarification: routeClarificationStateOf(request.routeClarification) }),
  }
}

function routeClarificationStateOf(
  clarification: NonNullable<PlanRequest['routeClarification']>,
): Readonly<Record<string, unknown>> {
  return {
    receiptRef: clarification.receiptRef,
    questionRef: clarification.questionRef,
    clarificationId: clarification.clarificationId,
    typedResponse: clarification.typedResponse,
    expectedRevision: clarification.expectedRevision,
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

function isRouteClarificationReceiptRef(ref: unknown): ref is ResourceRef {
  if (!isRecord(ref)) return false
  return (
    ref.kind === 'artifact' &&
    typeof ref.id === 'string' &&
    ref.id.trim().length > 0 &&
    typeof ref.version === 'string' &&
    ref.version.trim().length > 0 &&
    typeof ref.digest === 'string' &&
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

type RecoverableGenerationCode = 'MODEL_UNAVAILABLE' | 'RATE_LIMITED'

function recoverableGenerationCode(error: unknown): RecoverableGenerationCode | undefined {
  if (isAbortLike(error)) return undefined
  const code = routeDecisionErrorCode(error)
  if (code === undefined || !RECOVERABLE_GENERATION_CODES.has(code)) return undefined
  if (code !== 'MODEL_UNAVAILABLE' && code !== 'RATE_LIMITED') return undefined
  if (isRecord(error) && error['retryable'] === false) return undefined
  return code
}

function isRecoverableGenerationFailure(error: unknown): boolean {
  return recoverableGenerationCode(error) !== undefined
}

function toPlatformError(error: unknown): PlatformError {
  const code = recoverableGenerationCode(error)
  if (code === undefined) throw error
  const message = isRecord(error) && typeof error['message'] === 'string' && error['message'].length > 0
    ? error['message']
    : 'the generation provider was unavailable'
  return { code, message, retryable: true }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('the planning operation was cancelled', 'AbortError')
}

function throwIfPlanningStopped(ctx: ToolContext, signal: AbortSignal | undefined): void {
  throwIfAborted(signal)
  const deadlineMs = Date.parse(ctx.deadline)
  if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
    throw new WorkflowControllerError('DEADLINE_EXCEEDED', 'the planning deadline has passed')
  }
}

/** Conservatively counts JSON payload bytes without stringifying an untrusted event. */
function boundedJsonByteLength(value: GenerationEvent, limit: number): number {
  const pending: unknown[] = [value]
  let bytes = 0
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    visited += 1
    if (visited > MAX_GENERATION_EVENT_COUNT * 32) return limit + 1
    if (current === null) {
      bytes += 4
    } else if (typeof current === 'string') {
      bytes += utf8ByteLength(current) + 2
    } else if (typeof current === 'number') {
      bytes += Number.isFinite(current) ? String(current).length : 4
    } else if (typeof current === 'boolean') {
      bytes += current ? 4 : 5
    } else if (Array.isArray(current)) {
      if (pending.length + current.length > MAX_GENERATION_EVENT_COUNT * 32) return limit + 1
      bytes += 2 + Math.max(0, current.length - 1)
      for (const entry of current) pending.push(entry)
    } else if (isRecord(current)) {
      const entries = Object.entries(current)
      if (pending.length + entries.length > MAX_GENERATION_EVENT_COUNT * 32) return limit + 1
      bytes += 2 + Math.max(0, entries.length - 1)
      for (const [key, entry] of entries) {
        bytes += utf8ByteLength(key) + 3
        pending.push(entry)
      }
    } else if (current !== undefined) {
      return limit + 1
    }
    if (bytes > limit) return limit + 1
  }
  return bytes
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * Parse a model-proposed semantic query plan. It validates the shape at runtime instead of
 * trusting the model: a malformed proposal yields `undefined`, so the caller can reject it
 * rather than executing an unvalidated query or substituting an unrelated task.
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
