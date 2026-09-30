import { RunPlanner, WorkflowControllerError } from '@ontology/application'
import type { DecisionStateRefProvider, ProfileResolver, RunService } from '@ontology/application'
import type {
  ConfirmedContext,
  ExecutablePlan,
  ExecutablePlanStep,
  ModelRef,
  OperationRegistry,
  PlanSpec,
  PlanStep,
  ProfileRef,
  PublishedTaskBinding,
  ResourceRef,
  RouteDecision,
  RouteSignals,
  RunExecutionBinding,
  RunExecutionBindingStore,
  ScopeRef,
  SemanticQueryPlan,
  TaskBindingStore,
  ToolContext,
  VersionRef,
  WorkflowManifestStore,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { findRegisteredOperation } from '@ontology/contracts'
import { projectCollectionRef } from '@ontology/contracts'
import { registeredOperationDigest } from '@ontology/tool-services'
import { sha256DigestOf } from '@ontology/core'
import {
  InMemorySemanticMappingRegistry,
  SemanticDefinitionService,
  SemanticSchemaVocabularyService,
  compileSemanticQuery,
  renderCompiledQuery,
} from '@ontology/semantic-engine'
import type { CoreExampleScenario } from './core-example-loader'
import { createCoreFactsPlan } from './core-facts-plan'
import { canonicalJson } from '@ontology/tool-services'
import type { TemplatePlanPreparation, TemplatePlanPreparationRequest, TemplatePlanResolver, PublishedPlan } from '@ontology/adapter-runtime-template'
import { PostgresCorePlanReceiptStore } from './core-plan-receipts'
import type { CorePlanReceiptPayload, CorePlanReceiptPins, CorePlanReceiptRecord, CorePlanRouteSummary } from './core-plan-receipts'

const MAX_ORDINARY_QUESTION_BYTES = 4_096
const MAX_PLAN_STEPS = 32
const MAX_PLAN_ROWS = 1_000
const MAX_PLAN_BYTES = 1_048_576
type HostVerifiedRouteClarification = NonNullable<Parameters<RunPlanner['route']>[0]['routeClarification']>

export interface CoreModelComponentRefs {
  readonly generation?: VersionRef
  readonly decision?: VersionRef
}

export interface CoreTemplatePlanResolverOptions {
  readonly runs: RunService
  readonly profiles: ProfileResolver
  readonly manifests: WorkflowManifestStore
  readonly receipts: PostgresCorePlanReceiptStore
  readonly semanticDefinitions: SemanticDefinitionService
  readonly mappings: InMemorySemanticMappingRegistry
  readonly scenarios: readonly CoreExampleScenario[]
  readonly scopeRef: ScopeRef
  readonly modelRefs: CoreModelComponentRefs
  /** Published task bindings a task-mode run pins and must resolve deterministically. */
  readonly taskBindings: TaskBindingStore
  /** Archived run execution bindings, so a task run's fixed plan is derived from its own pin. */
  readonly executionBindings: RunExecutionBindingStore
  /** The deployment's registered operations (compute task planning and its contract pin). */
  readonly operations: OperationRegistry
  readonly decisionStateRefProvider: DecisionStateRefProvider
  readonly isRouteClarificationReceiptApproved: (
    input: { readonly runId: string; readonly resolvedProfileHash: string; readonly stateRef: ResourceRef },
    ctx: ToolContext,
  ) => Promise<boolean>
  readonly now?: () => string
}

interface LoadedRunInputs {
  readonly run: Awaited<ReturnType<RunService['getRun']>>
  readonly scopeRef: ScopeRef
  readonly resolved: Awaited<ReturnType<ProfileResolver['getResolvedProfile']>>['resolved']
  readonly scenario: CoreExampleScenario
  readonly inputManifest: WorkflowInputManifest
  readonly question: string
  readonly routeSignals: RouteSignals
  readonly basePins: CorePlanReceiptPins
  /** The archived execution binding when this is a task-mode run; absent for the legacy path. */
  readonly execution?: RunExecutionBinding
  /** The published task binding the execution request selected; present only for task mode. */
  readonly taskBinding?: PublishedTaskBinding
}

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function industryRefFor(scenario: CoreExampleScenario): VersionRef {
  const id = scenario.industryManifest.namespace
  return {
    id,
    version: '1.0.0',
    digest: sha256DigestOf(canonicalJson({ kind: 'industry_pack', id, digestSeed: scenario.industryManifest })),
  }
}

function sameProfileRef(left: ProfileRef, right: ProfileRef): boolean {
  return left.id === right.id && left.version === right.version
}

function stableUuid(seed: string): string {
  const chars = [...sha256DigestOf(seed).slice('sha256:'.length, 'sha256:'.length + 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function effectiveQuestionOf(run: Awaited<ReturnType<RunService['getRun']>>): string {
  return run.questionRewrite?.rewrittenQuestion ?? run.question
}

function confirmedContextOf(run: Awaited<ReturnType<RunService['getRun']>>): ConfirmedContext {
  return {
    timeZone: run.context.timeZone,
    ...(run.context.siteRef === undefined ? {} : { siteRef: run.context.siteRef }),
  }
}

function routeSignalsFor(question: string): RouteSignals {
  if (/(?:\b(?:or|either)\b|或者|还是)/iu.test(question)) {
    return { routeAmbiguous: true, ambiguityReason: 'the request names alternative outcomes and may need clarification' }
  }
  return {}
}

function basePinsWithoutClarification(pins: CorePlanReceiptPins): Omit<CorePlanReceiptPins, 'routeClarificationDigest' | 'routeSignalsDigest'> {
  return {
    runId: pins.runId,
    profileRef: pins.profileRef,
    resolvedProfileHash: pins.resolvedProfileHash,
    runtimeRef: pins.runtimeRef,
    inputManifestDigest: pins.inputManifestDigest,
    effectiveQuestionDigest: pins.effectiveQuestionDigest,
    mappingRefs: pins.mappingRefs,
    definitionRefs: pins.definitionRefs,
    toolBindingsDigest: pins.toolBindingsDigest,
  }
}

function sameBasePins(left: CorePlanReceiptPins, right: CorePlanReceiptPins): boolean {
  return canonicalJson(basePinsWithoutClarification(left)) === canonicalJson(basePinsWithoutClarification(right))
}

function modelBindingMatches(
  resolved: Awaited<ReturnType<ProfileResolver['getResolvedProfile']>>['resolved'],
  modelRefs: CoreModelComponentRefs,
  role: 'generation' | 'decision',
): boolean {
  const binding = resolved.modelBindings[role]
  const configured = modelRefs[role]
  return binding?.enabled === true && configured !== undefined && sameVersionRef(binding.modelRef, configured)
}

function modelRefOf(
  resolved: Awaited<ReturnType<ProfileResolver['getResolvedProfile']>>['resolved'],
  role: 'generation' | 'decision',
): ModelRef | undefined {
  const binding = resolved.modelBindings[role]
  if (binding?.enabled !== true) return undefined
  return { modelId: binding.modelRef.id, version: binding.modelRef.version }
}

function executableFactsPlan(spec: PlanSpec): ExecutablePlan {
  return {
    planRef: spec.planRef,
    singleQuery: spec.steps.length === 1,
    steps: spec.steps.map((step) => {
      const arguments_: Record<string, unknown> = {}
      for (const argument of step.args) {
        if (argument.source?.kind !== 'literal') {
          throw new WorkflowControllerError('INVALID_SCHEMA', 'a registered facts task may contain only literal arguments')
        }
        arguments_[argument.name] = argument.source.value
      }
      return {
        stepId: step.stepId,
        toolId: step.toolId,
        arguments: arguments_,
        dependsOn: [...step.dependsOn],
      }
    }),
  }
}

/** Build a one-step deterministic plan whose ref digest covers the run and the exact step. */
function singleStepPlan(runId: string, label: string, step: ExecutablePlanStep): ExecutablePlan {
  return {
    planRef: {
      id: `plan:${runId}:${label}`,
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson({ runId, label, step })),
      kind: 'plan',
    },
    steps: [step],
    singleQuery: true,
  }
}

function readStructuredQueryParameters(
  value: Readonly<Record<string, unknown>>,
): { readonly objectId: string; readonly fields: readonly string[]; readonly limit?: number } | undefined {
  const objectId = value['objectId']
  const fields = value['fields']
  const limit = value['limit']
  if (typeof objectId !== 'string' || objectId.length === 0) return undefined
  if (!Array.isArray(fields) || !fields.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) {
    return undefined
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return undefined
  return { objectId, fields: [...fields], ...(typeof limit === 'number' ? { limit } : {}) }
}

function readDocumentQaParameters(
  value: Readonly<Record<string, unknown>>,
): { readonly query: string; readonly limit?: number } | undefined {
  const query = value['query']
  const limit = value['limit']
  if (typeof query !== 'string' || query.trim().length === 0) return undefined
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return undefined
  return { query, ...(typeof limit === 'number' ? { limit } : {}) }
}

function planStepsOf(decision: RouteDecision, resolvedToolIds: ReadonlySet<string>): readonly PlanStep[] {
  const plan = decision.plan
  if (decision.route === 'clarify' || plan === undefined) {
    throw new WorkflowControllerError('INVALID_SCHEMA', 'the planner returned no executable plan')
  }
  if (plan.steps.length === 0 || plan.steps.length > MAX_PLAN_STEPS) {
    throw new WorkflowControllerError('INVALID_SCHEMA', 'the planner returned a plan outside the step bound')
  }
  return plan.steps.map((step) => {
    if (!resolvedToolIds.has(step.toolId)) {
      throw new WorkflowControllerError('FORBIDDEN', `the resolved profile does not enable ${step.toolId}`)
    }
    return {
      stepId: step.stepId,
      toolId: step.toolId,
      readOnly: true,
      args: Object.entries(step.arguments).map(([name, value]) => ({
        name,
        required: true,
        source: { kind: 'literal' as const, value },
      })),
      dependsOn: [...step.dependsOn],
      failureBehaviour: 'abort',
    }
  })
}

function planPreparation(record: CorePlanReceiptRecord, sourceReceiptRef?: ResourceRef): TemplatePlanPreparation {
  if (record.payload.kind === 'plan') {
    const published: PublishedPlan = {
      planRef: record.ref,
      spec: { planRef: record.ref, steps: [...record.payload.steps] },
    }
    return {
      kind: 'plan',
      published,
      ...(sourceReceiptRef === undefined ? {} : { sourceReceiptRef }),
    }
  }
  return {
    kind: 'clarification',
    receiptRef: record.ref,
    clarificationId: record.payload.clarificationId,
    clarification: record.payload.clarification,
    ...(record.payload.route.fallback === undefined ? {} : { fallback: record.payload.route.fallback }),
    ...(sourceReceiptRef === undefined ? {} : { sourceReceiptRef }),
  }
}

/** Run-scoped Template route preparation. All execution/model capabilities arrive from the runtime. */
export class CoreTemplatePlanResolver implements TemplatePlanResolver {
  readonly #runs: RunService
  readonly #profiles: ProfileResolver
  readonly #manifests: WorkflowManifestStore
  readonly #receipts: PostgresCorePlanReceiptStore
  readonly #semanticDefinitions: SemanticDefinitionService
  readonly #mappings: InMemorySemanticMappingRegistry
  readonly #scenarios: readonly CoreExampleScenario[]
  readonly #scopeRef: ScopeRef
  readonly #modelRefs: CoreModelComponentRefs
  readonly #taskBindings: TaskBindingStore
  readonly #executionBindings: RunExecutionBindingStore
  readonly #operations: OperationRegistry
  readonly #decisionStateRefProvider: DecisionStateRefProvider
  readonly #isRouteClarificationReceiptApproved: CoreTemplatePlanResolverOptions['isRouteClarificationReceiptApproved']
  readonly #now: () => string

  constructor(options: CoreTemplatePlanResolverOptions) {
    this.#runs = options.runs
    this.#profiles = options.profiles
    this.#manifests = options.manifests
    this.#receipts = options.receipts
    this.#semanticDefinitions = options.semanticDefinitions
    this.#mappings = options.mappings
    this.#scenarios = options.scenarios
    this.#scopeRef = options.scopeRef
    this.#modelRefs = options.modelRefs
    this.#taskBindings = options.taskBindings
    this.#executionBindings = options.executionBindings
    this.#operations = options.operations
    this.#decisionStateRefProvider = options.decisionStateRefProvider
    this.#isRouteClarificationReceiptApproved = options.isRouteClarificationReceiptApproved
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async resolve(planRef: ResourceRef | undefined, ctx: ToolContext): Promise<PublishedPlan> {
    if (planRef === undefined) throw new WorkflowControllerError('INVALID_SCHEMA', 'a full immutable plan receipt is required')
    const loaded = await this.#loadRunInputs(ctx.runId, ctx)
    const receipt = await this.#receipts.getByRef(this.#scopeRef, planRef, ctx)
    if (!sameBasePins(receipt.pins, loaded.basePins) || receipt.payload.kind !== 'plan') {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'the saved receipt does not match this run and immutable profile')
    }
    const preparation = planPreparation(receipt)
    if (preparation.kind !== 'plan') throw new WorkflowControllerError('INVALID_SCHEMA', 'the route receipt is waiting on clarification')
    return preparation.published
  }

  async prepare(request: TemplatePlanPreparationRequest): Promise<TemplatePlanPreparation> {
    const ctx = request.dependencies.ctx
    const loaded = await this.#loadRunInputs(request.input.runId, ctx)
    this.#assertInputMatchesRun(request, loaded)
    const sourceRef = request.planRef
    if (sourceRef !== undefined) {
      const existing = await this.#receipts.getByRef(this.#scopeRef, sourceRef, ctx)
      if (!sameBasePins(existing.pins, loaded.basePins)) {
        throw new WorkflowControllerError('INVALID_SCHEMA', 'the checkpoint receipt pins do not match this run')
      }
      if (existing.payload.kind === 'plan') return planPreparation(existing, sourceRef)
      if (request.mode === 'resume') {
        const input = request.input
        if (!('clarificationResponse' in input) || input.clarificationResponse === undefined) {
          return planPreparation(existing, sourceRef)
        }
        if (input.clarificationResponse.clarificationId !== existing.payload.clarificationId ||
            input.clarificationResponse.expectedRevision !== loaded.run.revision) {
          throw new WorkflowControllerError('VERSION_CONFLICT', 'the route clarification response does not match the pending run revision')
        }
        if (!(await this.#isRouteClarificationReceiptApproved({
          runId: loaded.run.runId,
          resolvedProfileHash: loaded.run.resolvedProfileHash,
          stateRef: existing.payload.clarificationReceiptRef,
        }, ctx))) {
          throw new WorkflowControllerError('FORBIDDEN', 'the route clarification receipt is not authorized for this run/profile')
        }
        const routeClarification = {
          receiptRef: existing.payload.clarificationReceiptRef,
          questionRef: existing.payload.clarification.questionRef,
          clarificationId: existing.payload.clarificationId,
          typedResponse: input.clarificationResponse.typedResponse,
          expectedRevision: input.clarificationResponse.expectedRevision,
        }
        const routeClarificationDigest = sha256DigestOf(canonicalJson(routeClarification))
        const clarifiedSignals: RouteSignals = {}
        const pins: CorePlanReceiptPins = {
          ...loaded.basePins,
          routeSignalsDigest: sha256DigestOf(canonicalJson(clarifiedSignals)),
          routeClarificationDigest,
        }
        return this.#prepareAndSave(loaded, request, pins, clarifiedSignals, routeClarification, existing.ref)
      }
      return planPreparation(existing, sourceRef)
    }
    if (request.mode === 'resume') {
      throw new WorkflowControllerError('CHECKPOINT_INCOMPATIBLE', 'resume requires the exact plan receipt from its checkpoint')
    }
    return this.#prepareAndSave(loaded, request, loaded.basePins, loaded.routeSignals)
  }

  async #loadRunInputs(runId: string, ctx: ToolContext): Promise<LoadedRunInputs> {
    if (runId !== ctx.runId || ctx.principal.tenantId !== this.#scopeRef.tenantId || ctx.allowedResources.spaceId !== this.#scopeRef.spaceId) {
      throw new WorkflowControllerError('SCOPE_MISMATCH', 'route preparation does not match the trusted run scope')
    }
    const run = await this.#runs.getRun(runId, ctx)
    const manifest = await this.#manifests.getRunManifest(runId, ctx)
    if (manifest === undefined) throw new WorkflowControllerError('INVALID_ARGUMENT', 'the run manifest is not available for route preparation')
    const inputManifest = await this.#manifests.getInputManifest(manifest.inputManifestId, ctx)
    if (inputManifest === undefined || inputManifest.runId !== runId) {
      throw new WorkflowControllerError('INVALID_ARGUMENT', 'the immutable input manifest is not available for route preparation')
    }
    if (
      manifest.resolvedProfileRef.id !== run.profileRef.id ||
      manifest.resolvedProfileRef.version !== run.profileRef.version ||
      manifest.resolvedProfileRef.snapshotHash !== run.resolvedProfileHash ||
      manifest.runtimeRef.id !== 'runtime-template' ||
      ctx.resolvedProfileHash !== run.resolvedProfileHash
    ) throw new WorkflowControllerError('CHECKPOINT_INCOMPATIBLE', 'the run manifest does not match its immutable profile/runtime pins')

    const resolvedRecord = await this.#profiles.getResolvedProfile({
      scopeRef: this.#scopeRef,
      profileRef: run.profileRef,
      snapshotHash: run.resolvedProfileHash,
    }, ctx)
    if (!sameVersionRef(resolvedRecord.resolved.runtimeRef, manifest.runtimeRef)) {
      throw new WorkflowControllerError('CHECKPOINT_INCOMPATIBLE', 'the resolved profile runtime differs from the run manifest')
    }
    const scenario = this.#scenarios.find((candidate) =>
      sameVersionRef(resolvedRecord.resolved.industryRef, industryRefFor(candidate)),
    )
    if (scenario === undefined) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the run pins an industry package not mounted by this deployment')

    const question = effectiveQuestionOf(run)
    if (new TextEncoder().encode(question).byteLength > MAX_ORDINARY_QUESTION_BYTES) {
      throw new WorkflowControllerError('INVALID_ARGUMENT', 'the question exceeds the bounded plan-preparation size')
    }
    const routeSignals = routeSignalsFor(question)
    const basePins: CorePlanReceiptPins = {
      runId,
      profileRef: run.profileRef,
      resolvedProfileHash: run.resolvedProfileHash,
      runtimeRef: manifest.runtimeRef,
      inputManifestDigest: inputManifest.digest,
      effectiveQuestionDigest: sha256DigestOf(question),
      mappingRefs: [...resolvedRecord.resolved.mappingRefs],
      definitionRefs: [scenario.definitionRef],
      toolBindingsDigest: sha256DigestOf(canonicalJson(resolvedRecord.resolved.toolBindings)),
      routeSignalsDigest: sha256DigestOf(canonicalJson(routeSignals)),
    }
    const taskContext = await this.#loadTaskContext(run, ctx)
    return {
      run,
      scopeRef: this.#scopeRef,
      resolved: resolvedRecord.resolved,
      scenario,
      inputManifest,
      question,
      routeSignals,
      basePins,
      ...taskContext,
    }
  }

  /**
   * Resolve the archived execution binding a task-mode run pinned, plus the published task
   * binding it selected. The plan for such a run is derived from these exact records, never
   * from the request body. A run without an execution binding (the legacy question path) has
   * no task context and keeps the existing routing behaviour.
   */
  async #loadTaskContext(
    run: Awaited<ReturnType<RunService['getRun']>>,
    ctx: ToolContext,
  ): Promise<{ readonly execution?: RunExecutionBinding; readonly taskBinding?: PublishedTaskBinding }> {
    const executionBindingRef = run.executionBindingRef
    if (executionBindingRef === undefined) return {}
    const archived = await this.#executionBindings.getBindingByRef(this.#scopeRef, executionBindingRef, ctx)
    if (archived === undefined) {
      throw new WorkflowControllerError('INVALID_ARGUMENT', 'the run execution binding is not archived in this scope')
    }
    const execution = archived.binding
    if (execution.request.mode !== 'task') return { execution }
    const taskBinding = await this.#taskBindings.getBinding(this.#scopeRef, execution.request.taskBindingRef, ctx)
    if (taskBinding === undefined) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the run pins a published task binding this deployment does not mount')
    }
    return { execution, taskBinding }
  }

  #assertInputMatchesRun(request: TemplatePlanPreparationRequest, loaded: LoadedRunInputs): void {
    if (request.mode !== 'start') return
    if (!('question' in request.input) || !sameProfileRef(
      { id: request.input.resolvedProfileRef.id, version: request.input.resolvedProfileRef.version },
      loaded.run.profileRef,
    ) || request.input.resolvedProfileRef.snapshotHash !== loaded.run.resolvedProfileHash ||
      request.input.question !== loaded.question) {
      throw new WorkflowControllerError('CHECKPOINT_INCOMPATIBLE', 'RuntimeInput differs from the canonical run question or profile pins')
    }
  }

  async #prepareAndSave(
    loaded: LoadedRunInputs,
    request: TemplatePlanPreparationRequest,
    pins: CorePlanReceiptPins,
    signals: RouteSignals,
    routeClarification?: HostVerifiedRouteClarification,
    sourceReceiptRef?: ResourceRef,
  ): Promise<TemplatePlanPreparation> {
    const requestDigest = sha256DigestOf(canonicalJson(pins))
    const existing = await this.#receipts.findByRequest(this.#scopeRef, pins, requestDigest, request.dependencies.ctx)
    if (existing !== undefined) return planPreparation(existing, sourceReceiptRef)

    const fixedPlan = this.#fixedTaskPlan(loaded) ?? this.#fixedFactsPlan(loaded)
    const generationBound = modelBindingMatches(loaded.resolved, this.#modelRefs, 'generation')
    const decisionBound = modelBindingMatches(loaded.resolved, this.#modelRefs, 'decision')
    const generationModelRef = generationBound ? modelRefOf(loaded.resolved, 'generation') : undefined
    const decisionModelRef = decisionBound ? modelRefOf(loaded.resolved, 'decision') : undefined
    const toolIds = new Set(loaded.resolved.toolBindings.filter((binding) => binding.enabled).map((binding) => binding.toolId))
    if (fixedPlan === undefined && !toolIds.has('data_query')) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the resolved profile does not enable data_query for ordinary semantic plans')
    }
    if (fixedPlan === undefined && !generationBound) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'ordinary semantic planning requires an enabled generation model binding in the resolved profile')
    }
    const mappingRegistry = this.#mappings
    const planner = new RunPlanner({
      vocabulary: new SemanticSchemaVocabularyService({
        mappings: this.#mappings,
        resolveDefinition: async (ref, ctx) => {
          const scenario = this.#scenarios.find((candidate) => sameVersionRef(candidate.definitionRef, ref))
          if (scenario === undefined) return undefined
          const definition = await this.#semanticDefinitions.getVersion({
            scopeRef: this.#scopeRef,
            namespace: scenario.namespace,
            definitionId: ref.id,
            version: ref.version,
          }, ctx)
          return sameVersionRef(definition.ref, ref) ? definition : undefined
        },
      }),
      compiler: {
        async compile(plan: SemanticQueryPlan, ctx: ToolContext) {
          void ctx
          const mappingRef = loaded.resolved.mappingRefs.find((mapping) => sameVersionRef(mapping, plan.mappingVersion))
          if (mappingRef === undefined) throw new WorkflowControllerError('UNSUPPORTED_QUERY', 'the semantic proposal selected a mapping outside the run snapshot')
          const mapping = mappingRegistry.resolve(mappingRef)
          if (mapping === undefined) throw new WorkflowControllerError('UNSUPPORTED_QUERY', 'the selected mapping is unavailable in this deployment')
          const compiled = compileSemanticQuery(plan, mapping, {
            budget: { maxRows: MAX_PLAN_ROWS, maxBytes: MAX_PLAN_BYTES, maxJoinFanout: 10 },
          })
          const rendered = renderCompiledQuery(compiled)
          return {
            plan: {
              mode: 'direct' as const,
              statementKind: 'select' as const,
              sql: rendered.sql,
              parameters: [...rendered.parameters],
              referencedObjects: [...rendered.referencedObjects],
              readOnly: true as const,
            },
            mappingRef: compiled.mappingRef,
            warnings: [],
          }
        },
      },
      ...(generationModelRef === undefined ? {} : {
        generation: request.dependencies.generation,
        planModelRef: generationModelRef,
      }),
      ...(decisionModelRef === undefined ? {} : {
        decision: request.dependencies.decision,
        decisionModelRef,
      }),
      decisionStateRefProvider: this.#decisionStateRefProvider,
    })

    const decision = await planner.route({
      runId: loaded.run.runId,
      question: loaded.question,
      context: confirmedContextOf(loaded.run),
      preferences: loaded.run.preferences,
      ...(fixedPlan === undefined ? {} : { fixedPlan }),
      signals,
      mappingRefs: [...loaded.resolved.mappingRefs],
      definitionRefs: [loaded.scenario.definitionRef],
      ...(routeClarification === undefined ? {} : { routeClarification }),
    }, request.dependencies.ctx, request.dependencies.signal)

    const route: CorePlanRouteSummary = {
      route: decision.route,
      reason: decision.reason,
      signals,
      ...(decision.fallback === undefined ? {} : { fallback: decision.fallback }),
    }
    let payload: CorePlanReceiptPayload
    if (decision.route === 'clarify') {
      if (decision.clarification === undefined) throw new WorkflowControllerError('INVALID_SCHEMA', 'the planner clarified without a typed question')
      if (request.dependencies.signal.aborted) {
        throw new WorkflowControllerError('DEADLINE_EXCEEDED', 'route preparation was cancelled before its clarification receipt was archived')
      }
      const clarificationId = stableUuid(`core-plan-clarification:${requestDigest}`)
      const clarificationReceiptRef = await this.#decisionStateRefProvider.archive({
        runId: loaded.run.runId,
        resolvedProfileHash: loaded.run.resolvedProfileHash,
        state: {
          schemaVersion: 'core-route-clarification-receipt@1',
          runId: loaded.run.runId,
          profileRef: loaded.run.profileRef,
          resolvedProfileHash: loaded.run.resolvedProfileHash,
          runtimeRef: pins.runtimeRef,
          inputManifestDigest: loaded.inputManifest.digest,
          effectiveQuestionDigest: pins.effectiveQuestionDigest,
          mappingRefs: pins.mappingRefs,
          definitionRefs: pins.definitionRefs,
          routeSignals: signals,
          route,
          clarificationId,
          clarification: decision.clarification,
          ...(routeClarification === undefined ? {} : {
            previousResponse: {
              trust: 'untrusted_data',
              receiptRef: routeClarification.receiptRef,
              questionRef: routeClarification.questionRef,
              clarificationId: routeClarification.clarificationId,
              typedResponse: routeClarification.typedResponse,
              expectedRevision: routeClarification.expectedRevision,
            },
          }),
        },
      }, request.dependencies.ctx)
      if (clarificationReceiptRef.kind !== 'artifact' || !/^sha256:[0-9a-f]{64}$/u.test(clarificationReceiptRef.digest)) {
        throw new WorkflowControllerError('INVALID_SCHEMA', 'the route clarification archive returned an invalid artifact reference')
      }
      if (request.dependencies.signal.aborted) {
        throw new WorkflowControllerError('DEADLINE_EXCEEDED', 'route preparation was cancelled after archiving its clarification receipt')
      }
      payload = {
        schemaVersion: 'core-template-plan-receipt@1',
        kind: 'clarification',
        pins,
        route,
        clarificationId,
        clarification: decision.clarification,
        clarificationReceiptRef,
      }
    } else {
      payload = {
        schemaVersion: 'core-template-plan-receipt@1',
        kind: 'plan',
        pins,
        route,
        steps: planStepsOf(decision, toolIds),
      }
    }
    const saved = await this.#receipts.saveIfAbsent(this.#scopeRef, {
      pins,
      requestDigest,
      payload,
      createdAt: this.#now(),
    }, request.dependencies.ctx)
    return planPreparation(saved, sourceReceiptRef)
  }

  /**
   * The deterministic fixed plan for a task-mode run (SPEC v0.3a §EX-2.1: "task mode uses the
   * explicitly bound deterministic plan"). The kind-to-tool mapping follows §EX-3.1; the plan
   * carries only typed arguments derived from the run's own approved input and parameters, so
   * a task never needs a model round-trip and never reads its plan from the request body.
   * A legacy question-mode run has no execution binding and falls through to the existing
   * question routing.
   */
  #fixedTaskPlan(loaded: LoadedRunInputs): ExecutablePlan | undefined {
    const execution = loaded.execution
    if (execution === undefined || execution.request.mode !== 'task') return undefined
    const binding = loaded.taskBinding
    if (binding === undefined) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the run pins a task binding that is not archived')
    }
    switch (binding.kind) {
      case 'published_facts':
        return this.#fixedFactsPlan(loaded)
      case 'compute':
        return this.#computePlan(loaded, binding)
      case 'structured_query':
        return this.#structuredQueryPlan(loaded, execution.request.parameters)
      case 'document_qa':
        return this.#documentQaPlan(loaded, execution.request.parameters)
      case 'rule_judgement':
        throw new WorkflowControllerError(
          'CAPABILITY_NOT_CONFIGURED',
          'rule judgement tasks require the materialised rule-derivation producer, which this deployment does not mount',
        )
      case 'relations':
        throw new WorkflowControllerError(
          'CAPABILITY_NOT_CONFIGURED',
          'relation navigation tasks require the run-scoped published-relation navigator, which is not a model tool on this host',
        )
      default: {
        const exhaustive: never = binding.kind
        throw new WorkflowControllerError('INVALID_SCHEMA', `unhandled task kind ${String(exhaustive)}`)
      }
    }
  }

  #computePlan(loaded: LoadedRunInputs, binding: PublishedTaskBinding): ExecutablePlan {
    if (binding.operationRef === undefined) {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'a compute task binding must pin a registered operation')
    }
    const operation = findRegisteredOperation(this.#operations, binding.operationRef)
    if (operation === undefined) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', `operation ${binding.operationRef.id}@${binding.operationRef.version} is not registered in this deployment`)
    }
    if (binding.registeredOperationDigest !== undefined && registeredOperationDigest(operation) !== binding.registeredOperationDigest) {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'the registered operation record does not match the task binding pin')
    }
    const execution = loaded.execution
    if (execution === undefined || execution.request.mode !== 'task') {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'a compute task requires a task-mode execution binding')
    }
    const step: ExecutablePlanStep = {
      stepId: 'q1',
      toolId: 'data_query',
      arguments: {
        kind: 'compute',
        operationRef: operation.operationRef,
        inputSchemaDigest: operation.inputSchemaDigest,
        parameters: execution.request.parameters,
        inputRefs: [execution.request.inputSnapshotRef],
      },
      dependsOn: [],
    }
    return singleStepPlan(loaded.run.runId, `compute:${binding.taskBindingRef.id}`, step)
  }

  #structuredQueryPlan(loaded: LoadedRunInputs, parameters: Readonly<Record<string, unknown>>): ExecutablePlan {
    if (!loaded.resolved.toolBindings.some((binding) => binding.toolId === 'data_query' && binding.enabled)) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the resolved profile does not enable data_query for a structured query task')
    }
    const parsed = readStructuredQueryParameters(parameters)
    if (parsed === undefined) {
      throw new WorkflowControllerError('INVALID_ARGUMENT', 'a structured query task requires objectId and a fields array')
    }
    const mapping = loaded.resolved.mappingRefs[0]
    if (mapping === undefined) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the resolved profile mounts no mapping for a structured query task')
    }
    const queryPlan: SemanticQueryPlan = {
      mode: 'semantic',
      concepts: [parsed.objectId],
      fields: [...parsed.fields],
      links: [],
      filters: [],
      orderBy: [],
      limit: parsed.limit ?? 100,
      mappingVersion: { id: mapping.id, version: mapping.version, digest: mapping.digest },
    }
    const step: ExecutablePlanStep = {
      stepId: 'q1',
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'semantic', queryPlan },
      dependsOn: [],
      sourceVersion: { id: mapping.id, version: mapping.version, digest: mapping.digest },
    }
    return singleStepPlan(loaded.run.runId, `structured_query:${parsed.objectId}`, step)
  }

  #documentQaPlan(loaded: LoadedRunInputs, parameters: Readonly<Record<string, unknown>>): ExecutablePlan {
    if (!loaded.resolved.toolBindings.some((binding) => binding.toolId === 'document_search' && binding.enabled)) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the resolved profile does not enable document_search for a document Q&A task')
    }
    const parsed = readDocumentQaParameters(parameters)
    if (parsed === undefined) {
      throw new WorkflowControllerError('INVALID_ARGUMENT', 'a document Q&A task requires a query string')
    }
    const execution = loaded.execution
    if (execution === undefined || execution.request.mode !== 'task') {
      throw new WorkflowControllerError('INVALID_SCHEMA', 'a document Q&A task requires a task-mode execution binding')
    }
    // A document-QA run searches only the pinned project's own document collection; the
    // collection ref is host-minted from the trusted execution binding, never from a request
    // body or a model choice.
    const collectionRef = projectCollectionRef(execution.request.projectRevisionRef.projectId)
    const step: ExecutablePlanStep = {
      stepId: 'q1',
      toolId: 'document_search',
      arguments: {
        query: parsed.query,
        allowedCollectionRefs: [collectionRef],
        mode: 'keyword',
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      },
      dependsOn: [],
    }
    return singleStepPlan(loaded.run.runId, `document_qa:${sha256DigestOf(parsed.query)}`, step)
  }

  #fixedFactsPlan(loaded: LoadedRunInputs): ExecutablePlan | undefined {
    if (!loaded.question.trim().startsWith('facts:')) return undefined
    if (!loaded.resolved.toolBindings.some((binding) => binding.toolId === 'ontology_lookup' && binding.enabled)) {
      throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the resolved profile does not enable ontology_lookup for facts tasks')
    }
    const plan = createCoreFactsPlan({
      scenario: loaded.scenario,
      runProfileRef: loaded.run.profileRef,
      resolvedProfileHash: loaded.run.resolvedProfileHash,
      mappingRefs: loaded.resolved.mappingRefs,
      definitionRef: loaded.scenario.definitionRef,
      scopeRef: loaded.scopeRef,
      question: loaded.question,
    })
    return executableFactsPlan(plan)
  }
}
