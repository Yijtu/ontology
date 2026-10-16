import { createHash } from 'node:crypto'
import { PostgresCandidateSourceStore, PostgresCandidateSubmissionStore, PostgresResearchDocumentSetStore, PostgresResearchExecutionStore, PostgresTableArtifactStore, PostgresTableVerificationStore, PostgresTaskPolicyReportStore } from '@ontology/adapter-control-postgres'
import { ArtifactGroundingDocumentSetReader, LocalDocumentExtractionService, LocalStructuredIngestionService, ParsedSourceGroundingReader, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import {
  AnswerPublicationService, CandidateAuthoringCommandGateway, CandidateSourceIngestionService, CandidateSubmissionService, CandidateValidationStageHandler, DraftVerificationService, ExtractionPipeline, ExtractionStageHandler,
  IndustryWorkspaceService, JobService, JobWorker, OutboxDispatcher, ResearchMaterialReadService, RestrictedLimitedAnswerComposer, ResearchWorkflowService, RuleActionCandidateService, RunExecutionPreflightService, RunPhaseDriver,
  RunService, RunTypedResultContextSource, StructuredExtractionService, StructuredExtractionStageHandler, TableHardVerificationService,
  TypedEvidenceDraftWriter, WebResearchService, WorkflowController, createRunCheckpointPort, createSourceGroundingService, ReviewHandoffStageHandler,
} from '@ontology/application'
import { FiniteGrammarRuleSupportValidator, IncrementalMaterializer } from '@ontology/semantic-engine'
import { JobWorkerLoop, MaterializationOutboxConsumer, ProjectEvolutionOutboxConsumer, ResearchStageHandler, TopicOutboxConsumerRouter, WorkflowDispatchWorker, controlRecordSequence, createIngestionHandlerRegistry, createWorkerStageRegistry } from '@ontology/app-worker'
import { DEFAULT_VERIFICATION_POLICY, SCHEMA_DOCUMENTS, TOOL_CATALOGUE, projectCollectionRef } from '@ontology/contracts'
import type { DocumentParserPort, ProjectRevision, RuntimeAdapter, RuntimeCapabilityContext, RuntimeCapabilityFactoryPort, RuntimeCapabilitySet, RuntimeSelectorPort, ScopeRef, ToolContext, Uuid, VersionRef, WorkflowDispatchFence } from '@ontology/contracts'
import type { RunProfileBinder } from '@ontology/application'
import { canonicalJson } from '@ontology/tool-services'
import { RunProgressService } from '../http/run-progress'
import { COMPONENT_VERSION, CORE_EFFECTIVE_LIMITS_REF, CORE_TYPED_RESULT_SCHEMA_REF, WORKER_RUN_ID } from './core-constants'
import { CoreCapabilityError, DISABLED_GENERATION, disabledDecision } from './core-errors'
import { versionRefKey } from './core-composition-shared'
import { sha256DigestOf } from '@ontology/core'
import { createAjv, taskParameterValidator } from './core-validators'
import { profileModelBindingEnabled, resolvedCapabilitiesFrom, scenarioForIndustryRef, sourceRefsOf, workerContext } from './core-component-registration'
import { createCoreAuthoring } from './core-authoring'
import { createCoreDefinitionLabelReader } from './core-definition-labels'
import { createCoreTableResults } from './core-table-results'
import { createBusinessMaterializationConsumer, createCompetencyPreviewOutboxConsumer } from './core-business-materialization'
import { createCoreProjectSemanticReadiness } from './core-project-semantic-readiness'
import { createCoreWebSearchProvider } from './core-web-search'
import { CoreProjectSemanticPartitions } from './core-project-semantic-partitions'
import { CorePublicationValidity, CoreInputValidity } from './core-publication-validity'
import { CoreFactsOutboxFallback, IndustryWorkspaceOutboxConsumer, PackPublicationOutboxConsumer, ProjectRevisionOutboxConsumer, UnsupportedOutboxConsumer } from './core-outbox-consumers'
import { CoreTemplatePlanResolver } from './core-template-plan-resolver'
import { modelConnectionComponentRef } from './core-execution-model-binding'
import { createPostgresProvenanceRead } from './provenance-read'
import type { CoreLocalCompositionOptions } from './core-local-composition'
import type { assembleInfrastructure } from './core-assembly-infrastructure'
import type { assembleQueryPipeline } from './core-assembly-query'

/**
 * Phase C: the run pipeline. It mounts the run/resume services, both runtimes and their selector,
 * the answer controller (draft writer, verifier, publisher), the dispatch/ingestion/outbox workers
 * and the materializer. It mutates `state.host` (controller, jobLoop) since the host start/close
 * lifecycle owns them.
 */
export async function assembleRuntimePipeline(
  state: Awaited<ReturnType<typeof assembleInfrastructure>>,
  query: Awaited<ReturnType<typeof assembleQueryPipeline>>,
  options: CoreLocalCompositionOptions,
) {
  const {
    host, database, artifactRegistry, blobStore, objectStore, parseStore, structuredStore, examples, compute, scopeRef, profileContext,
    profileStore, workflowStore, projectStore, projectReadinessStore,
    taskBindingStore, taskInputSnapshotStore, runExecutionBindingStore, taskFinalizationReceiptStore, identityStore, publicationStore,
    evidenceStore, materializationStore, candidateStore, assetCandidateStore, ruleActionCandidateStore, planReceiptStore,
    runStore, jobStore, dispatchStore, answerStore, workspaceStore, publishedPackStore, coreModelRefs, componentRecords,
    terminology, normalApprovedInputs, projectEvolutionCell, modelCapabilities, modelEnvironment, hostClock, allSourceRefs,
    profileResolver, semanticDefinitions, modelBindingRuntime, runModelBinder, modelBindingService, modelBindingStore, modelConnectionStore,
    deploymentModelCapabilities,
  } = state
  const { mappings, structuredImports, rulePremiseVerifier, semanticTasks, relationsTask, facts, multiSchemaSource, projectQuery, gatewayComposition } = query

  const runProfileBinder = {
    bindProfileForRun: (profileRef: import('@ontology/contracts').ProfileRef, trustedScope: ScopeRef, ctx: ToolContext) =>
      profileResolver.bindRunProfile(profileRef, trustedScope, ctx),
  } satisfies RunProfileBinder
  const runProgress = new RunProgressService({ profiles: profileStore, binder: runProfileBinder, manifests: workflowStore, budget: state.budget })
  const executionPreflight = new RunExecutionPreflightService({
    projects: projectStore,
    taskBindings: taskBindingStore,
    inputSnapshots: taskInputSnapshotStore,
    runExecutionBindings: runExecutionBindingStore,
    readiness: projectReadinessStore,
    operations: compute.registry,
    availableCapabilities: resolvedCapabilitiesFrom(componentRecords),
    supportedResultSchemaRefs: [CORE_TYPED_RESULT_SCHEMA_REF],
    effectiveLimitsRef: CORE_EFFECTIVE_LIMITS_REF,
    parameters: taskParameterValidator(createAjv()),
    projectQuerySnapshot: projectQuery.resolveForCreation,
    ...(structuredImports === undefined ? {} : { projectDocumentIndexSnapshot: structuredImports.resolveForCreation }),
    questionQuerySnapshot: projectQuery.resolveQuestionForCreation,
    projectApprovedInput: async (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext) => (await projectEvolutionCell.current?.resolveApprovedInput(scope, revision, ctx)) ?? await normalApprovedInputs.current?.resolve(scope, revision, ctx),
  })
  const runs = new RunService({ store: runStore, control: state.control, profiles: runProfileBinder, execution: executionPreflight, modelBinding: runModelBinder })
  const phase = new RunPhaseDriver({ store: runStore, control: state.control })
  const dispatchFences = new Map<Uuid, WorkflowDispatchFence>()
  // Both real runtimes are assembled here at the normal Core entry: the deterministic Template
  // executor (fixed/known-step paths) and the dynamic Pi runtime (bounded "query insufficient →
  // supplement → complete" collection). A run selects exactly one by the runtime pinned in its
  // resolved profile; the selector never chooses for it, and both adapters share the same gateway,
  // resolved profile and single budget ledger.
  const runtimeRecords = componentRecords.filter((record) => record.manifest.kind === 'runtime')
  const templateRuntimeRecord = runtimeRecords.find((record) => record.manifest.id === 'runtime-template')
  if (templateRuntimeRecord === undefined) throw new Error('Core template runtime component is not registered')
  const piRuntimeRecord = runtimeRecords.find((record) => record.manifest.id === 'runtime-pi')
  if (piRuntimeRecord === undefined) throw new Error('Core Pi runtime component is not registered')
  const planResolver = new CoreTemplatePlanResolver({
    runs,
    profiles: profileResolver,
    manifests: workflowStore,
    receipts: planReceiptStore,
    semanticDefinitions,
    mappings,
    scenarios: examples.scenarios,
    scopeRef,
    modelRefs: coreModelRefs,
    executionModelRef: async (role, runId, ctx) => {
      const capability = role === 'generation' ? 'generation' : 'decision_jev'
      if (!(await modelBindingService.isUsable(runId, capability, ctx))) return undefined
      const binding = await modelBindingStore.getBinding(scopeRef, runId, capability, ctx)
      if (binding?.connectionId === undefined) return undefined
      const connection = await modelConnectionStore.getConnection(scopeRef, binding.connectionId, ctx)
      // The execution-bound adapter indexes its vendor map by the pinned connection's component ref
      // id, so the planner must name exactly that identity to reach the model it was built with.
      return connection === undefined ? undefined : { modelId: modelConnectionComponentRef(connection).id, version: binding.connectionRevision ?? connection.revision }
    },
    taskBindings: taskBindingStore,
    executionBindings: runExecutionBindingStore,
    operations: compute.registry,
    decisionStateRefProvider: state.decisionStateRefProvider,
    projectQueryDescriptor: projectQuery.resolveExecution,
    semanticTasks,
    isRouteClarificationReceiptApproved: (input, ctx) => state.decisionStateReferences.isApproved(scopeRef, input, ctx),
  })
  const templateRuntime = new TemplateRuntimeAdapter({ manifest: templateRuntimeRecord.manifest, plans: planResolver })
  // The Pi adapter is the same class the conformance suite exercises: it exposes only the canonical
  // four model tools and every proposal is authorized and executed by the run's gateway.
  const piRuntime = new PiRuntimeAdapter({
    manifest: piRuntimeRecord.manifest,
    toolIds: TOOL_CATALOGUE.map((tool) => tool.toolId),
    modelRef: {
      modelId: coreModelRefs.generation?.id ?? 'model-not-configured',
      version: COMPONENT_VERSION,
      provider: 'ontology',
    },
    generationRole: 'planner',
    authoringCommands: ['submit_candidates'],
  })
  const runtimeAdapterByRef = new Map<string, RuntimeAdapter>([
    [versionRefKey(templateRuntimeRecord.manifestRef), templateRuntime],
    [versionRefKey(piRuntimeRecord.manifestRef), piRuntime],
  ])
  const runAllowedCollectionRefs = async (runId: Uuid, ctx: ToolContext): Promise<readonly string[]> => {
    const archived = await runExecutionBindingStore.getBindingByRun(scopeRef, runId, ctx)
    const request = archived?.binding.request
    if (request === undefined) return []
    if (request.mode === 'question') {
      const bindings = await Promise.all(archived!.binding.allowedTaskBindingRefs.map((ref) => taskBindingStore.getBinding(scopeRef, ref, ctx)))
      return bindings.some((binding) => binding?.kind === 'document_qa') ? [projectCollectionRef(request.projectRevisionRef.projectId)] : []
    }
    const binding = await taskBindingStore.getBinding(scopeRef, request.taskBindingRef, ctx)
    // A document-QA run may search only its own pinned project's host-minted collection.
    return binding?.kind === 'document_qa' ? [projectCollectionRef(request.projectRevisionRef.projectId)] : []
  }
  const termLabels = createCoreDefinitionLabelReader({ packs: publishedPackStore, candidates: assetCandidateStore, ruleActions: ruleActionCandidateStore })
  const authoring = createCoreAuthoring({ blobs: blobStore, registry: artifactRegistry, objectStore, workspaces: workspaceStore, jobs: jobStore, parses: parseStore, structured: structuredStore, operations: compute.registry, models: { generationEnabled: deploymentModelCapabilities.generation, decisionEnabled: deploymentModelCapabilities.decision }, terminology: { getTerminology: (...args) => terminology.getTerminology(...args) }, termLabels })
  const tableArtifactStore = new PostgresTableArtifactStore(database, { writer: gatewayComposition.artifacts, reader: state.scopedOriginals })
  const tableVerificationStore = new PostgresTableVerificationStore(database)
  const tableSchema = SCHEMA_DOCUMENTS.find((schema) => schema['$id'] === 'https://ontology.local/schema/tools.schema.json')
  if (tableSchema === undefined) throw new CoreCapabilityError('the actual canonical query output schema is unavailable')
  const tableSchemaRef = await authoring.stableWrite(`core-data-query-output-schema:${sha256DigestOf(canonicalJson(tableSchema))}`, new TextEncoder().encode(canonicalJson(tableSchema)), 'application/schema+json', 'artifact', profileContext)
  const tableResults = createCoreTableResults({ evidence: evidenceStore, artifacts: blobStore, pages: tableArtifactStore, manifests: tableArtifactStore, receipts: tableVerificationStore, finalizationReceipts: taskFinalizationReceiptStore,
    columnLabels: async (input, ctx) => {
      const trustedScope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
      const saved = await runExecutionBindingStore.getBindingByRun(trustedScope, input.runId, ctx)
      if (saved === undefined || canonicalJson(saved.ref) !== canonicalJson(input.executionBindingRef)) throw new CoreCapabilityError('column names require this exact saved run execution binding')
      const request = saved.binding.request, revision = await projectStore.getRevision(trustedScope, request.projectRevisionRef.projectId, request.projectRevisionRef.revision, ctx)
      if (revision === undefined || canonicalJson(revision.ref) !== canonicalJson(request.projectRevisionRef)) throw new CoreCapabilityError('column names require the exact fixed published project definition')
      const selection = request.mode === 'task' ? request : await planReceiptStore.selectedTaskForRun(trustedScope, ctx)
      const labels = await termLabels(trustedScope, revision.industryPackRef, revision.definitionRef, ctx)
      return Object.fromEntries(labels?.attributes.filter((attribute) => attribute.objectId === selection?.parameters['objectId']).map((attribute) => [attribute.attributeId, attribute.displayName]) ?? [])
    },
    writer: { putBytes: async (input, ctx) => { const digest = `sha256:${createHash('sha256').update(input.content).digest('hex')}` as const
      const ref = await authoring.stableWrite(`table-artifact:${digest}`, input.content, input.mediaType, 'artifact', ctx)
      return { blobRef: ref, contentDigest: digest, integrity: { algorithm: 'sha256', digest, verifiedAt: hostClock().toISOString() } } } },
    findArtifact: (_scope, digest, ctx) => authoring.findStableArtifact(`table-artifact:${digest}`, ctx), tableOutputSchema: { ref: tableSchemaRef, body: tableSchema },
    verifier: new TableHardVerificationService({ pages: tableArtifactStore, receipts: tableVerificationStore, progress: tableVerificationStore, artifacts: blobStore, evidence: evidenceStore }) })
  const draftVerifier = new DraftVerificationService({ evidence: evidenceStore, artifacts: blobStore, rulePremises: rulePremiseVerifier, decisionStateRefProvider: state.decisionStateRefProvider,
    policy: { ...DEFAULT_VERIFICATION_POLICY, semanticReview: 'disabled' } })
  // The controlled candidate-submission path (design §5/§7). The model proposes through the
  // authoring-command gateway; the service owns identity/trust/publication state and re-reads the
  // archived evidence before writing. It is wired into every run's capabilities, but the Pi runtime
  // only exposes the command surface for a run whose profile authorizes candidate authoring.
  const candidateSubmissionService = new CandidateSubmissionService({
    workspaces: workspaceStore,
    definitionCandidates: assetCandidateStore,
    terminology,
    evidence: new ResearchMaterialReadService({
      members: new PostgresResearchDocumentSetStore(database),
      content: { read: async (ref, ctx) => {
        const bytes = await blobStore.readAuthorized({ blobRef: ref, scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId } }, ctx)
        return { bytes, contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
      } },
    }),
    receipts: new PostgresCandidateSubmissionStore(database),
    ruleActions: new RuleActionCandidateService({ workspaces: workspaceStore, candidates: ruleActionCandidateStore, support: new FiniteGrammarRuleSupportValidator() }),
    sourceIngestion: new CandidateSourceIngestionService({ artifacts: gatewayComposition.artifacts, sources: new PostgresCandidateSourceStore(database) }),
    sourceGrounding: createSourceGroundingService({ workspaces: workspaceStore, documentSets: new ArtifactGroundingDocumentSetReader(blobStore),
      reader: new ParsedSourceGroundingReader({ blobs: blobStore, documents: parseStore, tables: structuredStore }) }),
    // Re-check the run's dispatch fence (cancel/revoke) before the write transaction; a cancelled
    // run has its fence removed, so a late `submit_candidates` is a FENCE_STALE rejection.
    fence: { isCancelled: async (runId: Uuid) => !dispatchFences.has(runId) },
  })
  const candidateCommandGateway = new CandidateAuthoringCommandGateway(candidateSubmissionService)
  const controllerDependencies = {
    runs,
    phase,
    budget: state.budget,
    manifests: workflowStore,
    runtimes: {
      select: async (runtimeRef: VersionRef) => {
        const adapter = runtimeAdapterByRef.get(versionRefKey(runtimeRef))
        if (adapter === undefined) throw new CoreCapabilityError(`this local deployment does not register runtime ${runtimeRef.id}@${runtimeRef.version}`)
        return adapter
      },
    } satisfies RuntimeSelectorPort,
    capabilities: {
      async forRun(binding: RuntimeCapabilityContext, ctx: ToolContext) {
        if (binding.signal === undefined) throw new CoreCapabilityError('runtime capabilities require the controller execution AbortSignal')
        const run = await runs.getRun(binding.runId, ctx)
        const resolved = await profileResolver.getResolvedProfile({ scopeRef: { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, profileRef: run.profileRef, snapshotHash: binding.resolvedProfileRef.snapshotHash }, ctx)
        const gateway = gatewayComposition.forRun({ runId: binding.runId, ledgerId: binding.budgetLedgerId, resolvedProfile: resolved.resolved, operations: compute.registry })
        // A run's model is the one fixed at accept time (design §5.3): read the persisted binding
        // back, never re-resolve a default. A revoked binding fails closed (`blocked` disables the
        // port) instead of falling through to another model; with no binding at all the legacy
        // environment-configured adapter stays in place.
        const bound = await modelBindingRuntime.capabilitiesForExecution({ executionId: binding.runId, ledgerId: binding.budgetLedgerId, signal: binding.signal, ctx })
        const modelExecution = modelCapabilities.forExecution({ ledgerId: binding.budgetLedgerId, signal: binding.signal })
        const generationBound = profileModelBindingEnabled(resolved.resolved.modelBindings['generation'], coreModelRefs.generation) || bound.generation !== undefined || bound.generationBlocked
        const decisionBound = profileModelBindingEnabled(resolved.resolved.modelBindings['decision'], coreModelRefs.decision) || bound.decision !== undefined || bound.decisionBlocked
        return {
          gateway,
          generation: generationBound
            ? bound.generation ?? (bound.generationBlocked ? DISABLED_GENERATION : modelExecution.generation ?? DISABLED_GENERATION)
            : DISABLED_GENERATION,
          decision: decisionBound
            ? bound.decision ?? (bound.decisionBlocked ? disabledDecision() : modelExecution.decision ?? disabledDecision())
            : disabledDecision(),
          checkpoints: createRunCheckpointPort(runStore),
          commandGateway: candidateCommandGateway,
        } satisfies RuntimeCapabilitySet
      },
    } satisfies RuntimeCapabilityFactoryPort,
    draftWriter: new TypedEvidenceDraftWriter({
      evidence: evidenceStore,
      artifacts: blobStore,
      typedResult: new RunTypedResultContextSource({
        runs: runStore, executionBindings: runExecutionBindingStore, taskBindings: taskBindingStore, manifests: workflowStore,
        evidence: evidenceStore, artifacts: blobStore, artifactWriter: gatewayComposition.artifacts, receipts: taskFinalizationReceiptStore,
        questionTaskSelection: (ctx) => planReceiptStore.selectedTaskForRun(scopeRef, ctx), tables: tableResults.build,
      }),
    }),
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: { verify: async (request: Parameters<DraftVerificationService['verify']>[0], ctx: ToolContext) => { await tableResults.verify(request.draft, ctx); return draftVerifier.verify(request, ctx) } },
    verifications: workflowStore,
    publisher: new AnswerPublicationService({
      runs: runStore, answers: answerStore, verifications: workflowStore, manifests: workflowStore,
      tableVerifications: tableResults.requirements, registerTables: tableResults.register,
      validity: new CorePublicationValidity({
        rulePremises: rulePremiseVerifier,
        ...(structuredImports === undefined ? {} : { documentSources: structuredImports.publicationValidator }),
        relations: relationsTask, evidence: evidenceStore, artifacts: blobStore, facts, scopeRef,
        tables: tableVerificationStore, policies: new PostgresTaskPolicyReportStore(database),
      }),
    }),
    validity: new CoreInputValidity(evidenceStore, scopeRef),
    publicationFence: async (runId: Uuid) => dispatchFences.get(runId),
  }
  host.controller = new WorkflowController(controllerDependencies)

  const workerDispatchContextForOperation = () => workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-dispatch-worker'), hostClock)
  const workflowDispatchWorker = new WorkflowDispatchWorker({
    dispatch: dispatchStore,
    controller: host.controller,
    dispatchContext: workerDispatchContextForOperation(),
    dispatchContextFactory: workerDispatchContextForOperation,
    contextForRun: async (runId) => {
      const runContext = workerDispatchContextForOperation()
      const run = await runs.getRun(runId, runContext)
      const profile = await profileResolver.getResolvedProfile({ scopeRef, profileRef: run.profileRef, snapshotHash: run.resolvedProfileHash }, runContext)
      const scenario = scenarioForIndustryRef(examples.scenarios, profile.resolved.industryRef)
      const archived = await runExecutionBindingStore.getBindingByRun(scopeRef, runId, runContext)
      if (scenario === undefined && archived === undefined) throw new CoreCapabilityError('the profile needs an actual archived project execution binding')
      const snapshotRef = archived?.binding.projectDatasetSnapshotRef
      const sources = snapshotRef === undefined ? scenario === undefined ? [] : sourceRefsOf(scenario) : [projectQuery.sourceRef(snapshotRef.id)]
      return workerContext(scopeRef, sources, runId, run.resolvedProfileHash, hostClock, await runAllowedCollectionRefs(runId, runContext))
    },
    onFenceChange(runId, fence) {
      if (fence === undefined) { dispatchFences.delete(runId); host.activeRunIds.delete(runId) }
      else { dispatchFences.set(runId, fence); host.activeRunIds.add(runId) }
    },
    onError(error) { options.onWorkerError?.(error); process.stderr.write('[core-worker] workflow dispatch cycle failed\n') },
  })

  const jobService = new JobService({ store: jobStore })
  const industryWorkspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: jobStore })
  const parser: DocumentParserPort = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore })
  const pipeline = new ExtractionPipeline({
    schemaSource: state.schemaSource,
    accountingOwner: 'adapter',
    generationForRun: ({ ledgerId, signal }) => modelCapabilities.forExecution({ ledgerId, signal }).generation,
    candidates: candidateStore,
    budget: state.budget,
    modelRef: { modelId: options.modelsEnabled === true ? modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured' : 'model-not-configured', version: COMPONENT_VERSION },
    outputLimit: { maxTokens: 2_048 },
  })
  const structuredExtractionService = new StructuredExtractionService({
    schemaSource: state.schemaSource,
    candidates: candidateStore,
    ingestion: structuredStore,
    originals: {
      read: (request, ctx) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('the structured extraction request carried no approved input reference')
        return blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target }, ctx)
      },
    } satisfies import('@ontology/contracts').ScopedArtifactReader,
    parser: new StructuredDocumentParser(),
  })
  const handlers = createIngestionHandlerRegistry({
    parser,
    structured: new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore }),
    structuredExtraction: new StructuredExtractionStageHandler({ extraction: structuredExtractionService }),
    downstream: [
      new ExtractionStageHandler({ pipeline, parseStore }),
      new CandidateValidationStageHandler({ pipeline, parseStore }),
      new ReviewHandoffStageHandler(),
    ],
  })
  // Bounded research orchestration (design §2.3, A-R02). When the deployment configures a web
  // search provider it also wires the research workflow and its worker stage, so a durable
  // `research` job runs the fixed chain. When no provider is configured the research capability
  // is simply absent — selecting a research model never enables `web_search` on its own.
  // A normal start discovers research by constructing the controlled, snapshot-archiving search
  // provider from deployment configuration; a test host may still inject its own provider. With
  // neither configured, research is explicitly absent (never a fabricated capability).
  const webSearch = options.webSearch ?? createCoreWebSearchProvider({ env: modelEnvironment, artifacts: gatewayComposition.artifacts })
  const researchExecutionStore = new PostgresResearchExecutionStore(database)
  const researchWorkflow = webSearch === undefined ? undefined : new ResearchWorkflowService({
    jobs: jobService,
    executions: researchExecutionStore,
    research: new WebResearchService({
      webSearch,
      ingestion: new CandidateSourceIngestionService({ artifacts: gatewayComposition.artifacts, sources: new PostgresCandidateSourceStore(database) }),
    }),
    budget: state.budget,
    ...(modelBindingService === undefined ? {} : { modelBinding: modelBindingService }),
  })
  const researchHandler = researchWorkflow === undefined ? undefined : new ResearchStageHandler({ workflow: researchWorkflow })
  const routedHandlers = createWorkerStageRegistry({ ingestion: handlers, ...(researchHandler === undefined ? {} : { research: researchHandler }) })
  const jobWorker = new JobWorker({
    store: jobStore, handlers: routedHandlers, budget: state.budget, workerId: 'core-local-ingestion-worker', now: () => hostClock().toISOString(),
    contextForJob: (job) => {
      const scenario = examples.scenarios.find((candidate) => candidate.rawSources.some((source) => `${source.sourceRef.namespace}/${source.sourceRef.sourceId}` === job.sourceRef))
      return workerContext(scopeRef, scenario === undefined ? [] : sourceRefsOf(scenario), job.jobId, scenario?.definitionRef.digest ?? sha256DigestOf(`unmounted-ingestion-job:${job.jobId}`), hostClock)
    },
  })
  const currentProjectRevisions = async (scope: ScopeRef, ctx: ToolContext): Promise<readonly ProjectRevision[]> => {
    const projects = [...await projectStore.listProjects(scope, { state: 'draft', limit: 33 }, ctx), ...await projectStore.listProjects(scope, { state: 'active', limit: 33 }, ctx)]
    if (projects.length > 32) throw new CoreCapabilityError('the actual current project partition inventory exceeds 32 projects')
    const revisions = []
    for (const project of projects) {
      const revision = await projectStore.getRevision(scope, project.projectId, project.activeRevision ?? project.headRevision, ctx)
      if (revision === undefined) throw new CoreCapabilityError('the current project partition revision is unavailable')
      revisions.push(revision)
    }
    return revisions
  }
  const materializer = new IncrementalMaterializer({ publishedSource: new CoreProjectSemanticPartitions(multiSchemaSource, semanticTasks, currentProjectRevisions), materialization: materializationStore })
  const materializationConsumer = new MaterializationOutboxConsumer({
    materializer, publications: publicationStore, sequence: controlRecordSequence(state.control, 'semantic.core-local-materialization'), outbox: jobStore, materialization: materializationStore, publicationBatchSize: 8,
  })
  const outboxConsumer = new TopicOutboxConsumerRouter(
    [
      createBusinessMaterializationConsumer({ inner: materializationConsumer, publications: publicationStore, projects: projectStore, candidates: candidateStore, identity: identityStore,
        afterBusinessMaterialization: createCoreProjectSemanticReadiness({ projects: projectStore, readiness: projectReadinessStore, profiles: profileResolver, selectors: semanticTasks, materialization: materializationStore, currentRevisions: currentProjectRevisions, publications: publicationStore, identity: identityStore, authoring, now: () => hostClock().toISOString() }) }),
      createCompetencyPreviewOutboxConsumer({ projects: projectStore, jobs: jobStore }),
      new CoreFactsOutboxFallback(candidateStore, scopeRef),
      new IndustryWorkspaceOutboxConsumer(workspaceStore, scopeRef),
      new PackPublicationOutboxConsumer(publishedPackStore, scopeRef),
      new ProjectRevisionOutboxConsumer(projectStore, scopeRef),
      new ProjectEvolutionOutboxConsumer({ rebuild: (...args) => {
        if (projectEvolutionCell.current === undefined) throw new CoreCapabilityError('the actual project evolution workflow is not initialized')
        return projectEvolutionCell.current.rebuild(...args)
      } }),
    ],
    new UnsupportedOutboxConsumer(),
  )
  const dispatcher = new OutboxDispatcher({ store: jobStore, consumer: outboxConsumer })
  const provenanceRead = createPostgresProvenanceRead({ database, blobStore })
  host.jobLoop = new JobWorkerLoop({
    worker: jobWorker, dispatcher,
    scopes: async () => [{ scopeRef, ctx: workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-ingestion-worker'), hostClock) }],
    intervalMs: 250,
    onError(error) { options.onWorkerError?.(error); process.stderr.write('[core-worker] ingestion/outbox cycle failed\n') },
  })

  return {
    runProfileBinder, runProgress, executionPreflight, runs, phase, planResolver, termLabels, authoring, tableArtifactStore,
    tableVerificationStore, tableResults, draftVerifier, workflowDispatchWorker, jobService, industryWorkspaceService, parser,
    pipeline, structuredExtractionService, handlers, jobWorker, currentProjectRevisions, materializer, outboxConsumer, dispatcher, provenanceRead,
    researchWorkflow, webSearch,
  }
}
