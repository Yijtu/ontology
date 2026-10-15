import { randomUUID } from 'node:crypto'
import { PostgresCandidateSourceStore, PostgresProjectEvolutionStore, PostgresSourceAdmissionStore } from '@ontology/adapter-control-postgres'
import { ArtifactGroundingDocumentSetReader, ParsedSourceGroundingReader, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import { DATA_DUCKDB_ADAPTER_REF } from '@ontology/adapter-data-duckdb'
import { DATA_POSTGRES_ADAPTER_REF } from '@ontology/adapter-data-postgres'
import {
  CandidateSourceIngestionService, CandidateSourceReviewService, ComponentRegistry, CompositeReviewableCandidateReader, DefinitionCandidateEditingService, DefinitionCandidateGenerationService,
  IndustryAssetPublicationService, IndustryPackExportService, IndustryPackUpgradeService,
  IndustryValidationService, InMemoryIndustryPackCatalogue, InstanceReviewService, JobService,
  ProjectMappingService, ProjectService, PublishedPackRuleDeclarationReader, ResultHistoryService, RuleActionCandidateService,
  RuleActionCandidateGenerationService, RunServiceError, StoreBackedIndustryPackCatalogue, SyntheticExampleService,
  TableArtifactReadService, VerifiedResultExportService, VerifiedResultReadService, WebResearchService, WorkspaceSourceAdmissionService,
  createSourceGroundingService, encodeStructuredExtractionRef, readWorkspacePublicationSourceDrafts,
  ModelConnectionService, ModelAssignmentService,
} from '@ontology/application'
import { ArchivedRulePremiseReplayVerifier, FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, IdentityDecisionService } from '@ontology/semantic-engine'
import type { ActionCapabilityBindingInput, GenerationPort, ProfileRef, ProjectRevision, ScopeRef, ToolContext, VerifiedTableManifestSource } from '@ontology/contracts'
import { createRequestToolContext } from '../http/context'
import type { CoreApiDependencies } from '../core-main'
import { COMPONENT_VERSION, CORE_TYPED_RESULT_SCHEMA_REF } from './core-constants'
import { CoreCapabilityError } from './core-errors'
import { sameVersionRef } from './core-composition-shared'
import { createAjv, manifestValidator, taskParameterValidator } from './core-validators'
import { capability, componentRef } from './core-component-ref'
import { profileModelBindingEnabled, resolvedCapabilitiesFrom, resolveScenarioProfile, scenarioForIndustryRef, schemasByScenario } from './core-component-registration'
import { validateCoreFactsRequest } from './core-facts-providers'
import { registerCoreSourceViewRoutes } from '../http/core-source-views'
import { registerCoreImportRoute, registerCoreRelationNavigationRoute } from '../http/core-core-routes'
import { registerModelConnectionRoutes } from '../http/core-model-connections'
import { createCoreModelProbe } from './core-model-probe'
import { registerProjectImportRoute } from '../http/project-imports'
import { createCompetencyQuestionWorkflow } from './competency-questions'
import { createCompetencyValidationTargetReader } from './competency-validation-target'
import { createNormalCoreCompetencyExecution } from './core-competency-execution'
import { createCoreExecutionPreview } from './core-execution-preview'
import { createCoreSourceViewReader } from './core-source-view'
import { createCoreProjectComputeInput } from './core-project-compute-input'
import { createCorePackExecutionProfiles } from './core-pack-execution-profiles'
import { createCoreVerifiedTableSource } from './core-verified-tables'
import { createProjectFactWorkflow } from './project-facts'
import { createCoreApprovedInput } from './core-approved-input'
import { createCoreRunRequestResolver } from './core-run-request'
import { createCoreInstanceIdentity } from './core-instance-identity'
import { createCoreProjectApi } from './core-project-api'
import { createProjectEvolutionWorkflow } from './project-evolution'
import { createCoreStructuredImportWorkflow } from './core-structured-import-service'
import { createSourceAdmissionPorts } from './core-source-admission'
import { createBlobArtifactWriter } from './tool-gateway'
import type { CoreLocalCompositionOptions } from './core-local-composition'
import type { assembleInfrastructure } from './core-assembly-infrastructure'
import type { assembleQueryPipeline } from './core-assembly-query'
import type { assembleRuntimePipeline } from './core-assembly-runtime'

/**
 * Phase D: authoring, competency/validation, the project side and the final API dependency graph.
 * It also owns the run submission validation (`runValidation`) and the scenario profile reader the
 * HTTP layer consumes, and the route registration callback.
 */
export async function assembleDeployment(
  state: Awaited<ReturnType<typeof assembleInfrastructure>>,
  query: Awaited<ReturnType<typeof assembleQueryPipeline>>,
  runtime: Awaited<ReturnType<typeof assembleRuntimePipeline>>,
  options: CoreLocalCompositionOptions,
): Promise<{ readonly dependencies: CoreApiDependencies }> {
  const {
    host, database, artifactRegistry, blobStore, objectStore, parseStore, structuredStore, examples, compute, scopeRef, profileContext,
    profileStore, workflowStore, projectStore, projectReadinessStore, projectMappingStore, projectDocumentStore, projectRecordStore,
    taskBindingStore, taskInputSnapshotStore, runExecutionBindingStore, runStore, jobStore, identityStore, publicationStore, definitionStore, evidenceStore,
    materializationStore, candidateStore, assetCandidateStore, ruleActionCandidateStore, ruleActionGenerationStore, definitionEditingStore,
    instanceReviewStore, syntheticExampleSetStore, validationReportStore, scopedOriginals, publishedPackStore, publishedPackRules,
    packRuleReader, answerStore, dispatchStore, budget, modelEnvironment, modelCapabilities, schemaSource, projectDatasetAdapter,
    publishedProjectDatasetSource, normalApprovedInputs, projectDatasetService, profileResolver, sources, coreModelRefs, componentRecords,
    profileRefsByScenario, profileSpecsByScenario, availableTasksByScenario, terminology, executionPreview, projectEvolutionCell, hostClock, componentStore,
  } = state
  const { structuredImports, documentSpanReader, projectDocumentIndexService, structuredPremiseSources, structuredClauseSources, semanticTasks, computeResultStore, computeOutputBindingsStore, computeInvocationStore, gatewayComposition } = query
  const { runProgress, runs, termLabels, authoring, tableArtifactStore, tableVerificationStore, workflowDispatchWorker, jobService, industryWorkspaceService, provenanceRead } = runtime

  const runValidation = async (
    submission: { readonly profileRef: ProfileRef; readonly question: string; readonly scopeRef: ScopeRef; readonly task?: import('@ontology/contracts').RunExecutionRequest },
    ctx: ToolContext,
  ) => {
    // A fixed task run resolves its own deterministic plan and its own input/approved refs through
    // the run execution binding; its capability/readiness preflight already ran in
    // `RunExecutionPreflightService`, so it must not be forced through the ordinary NL
    // generation/data_query admission. The legacy `facts:` path keeps its dedicated check.
    if (submission.task !== undefined && submission.task.mode === 'task') return
    if (submission.task?.mode === 'question') {
      const binding = await profileResolver.bindRunProfile(submission.profileRef, submission.scopeRef, ctx)
      const actual = await profileResolver.getResolvedProfile({ scopeRef: submission.scopeRef, profileRef: submission.profileRef, snapshotHash: binding.resolvedProfileHash }, ctx)
      if (!profileModelBindingEnabled(actual.resolved.modelBindings['generation'], coreModelRefs.generation)) throw new CoreCapabilityError('natural-language task selection is not configured for this actual project profile')
      if (!actual.resolved.toolBindings.some((tool) => tool.enabled && ['ontology_lookup', 'data_query', 'document_search'].includes(tool.toolId))) throw new CoreCapabilityError('this actual project profile has no enabled supported data tool')
      return
    }
    const { scenario, resolved, snapshotHash } = await resolveScenarioProfile(profileResolver, examples.scenarios, submission.profileRef, submission.scopeRef, ctx)
    if (submission.question.trim().startsWith('facts:')) {
      if (!resolved.toolBindings.some((binding) => binding.toolId === 'ontology_lookup' && binding.enabled)) {
        throw new CoreCapabilityError('this profile does not enable ontology_lookup for registered facts tasks')
      }
      validateCoreFactsRequest({ scenario, runProfileRef: submission.profileRef, resolvedProfileHash: snapshotHash, mappingRefs: resolved.mappingRefs, definitionRef: scenario.definitionRef, scopeRef: submission.scopeRef, question: submission.question })
      return
    }
    if (!resolved.toolBindings.some((binding) => binding.toolId === 'data_query' && binding.enabled)) {
      throw new CoreCapabilityError('ordinary natural-language queries require data_query to be enabled in the resolved profile')
    }
    if (!modelCapabilities.generationEnabled || !profileModelBindingEnabled(resolved.modelBindings['generation'], coreModelRefs.generation)) {
      throw new CoreCapabilityError('ordinary natural-language queries require a configured generation model bound by the resolved profile')
    }
    const catalog = resolved.backendBindings['catalog']
    if (catalog === undefined || !sameVersionRef(catalog.adapterRef, DATA_DUCKDB_ADAPTER_REF) || resolved.mappingRefs.length === 0) {
      throw new CoreCapabilityError('ordinary semantic queries require the run profile’s mounted read-only catalog mapping')
    }
  }

  const readScenarioProfile = async (scenarioId: string) => {
    const mountedScenario = examples.scenarios.find((scenario) => scenario.scenarioId === scenarioId)
    if (mountedScenario === undefined) return undefined
    const active = await profileResolver.getActiveProfile(scopeRef, mountedScenario.profileRef.id, profileContext)
    const profileRef = active?.profileRef ?? mountedScenario.profileRef
    const record = await profileResolver.getProfileVersion({ scopeRef, profileRef }, profileContext)
    const selectedScenario = scenarioForIndustryRef(examples.scenarios, record.spec.industryRef)
    if (selectedScenario === undefined) throw new CoreCapabilityError(`active profile ${profileRef.id}@${profileRef.version} pins an unmounted industry package`)
    const snapshotHash = active?.snapshotHash ?? (await profileResolver.bindRunProfile(profileRef, scopeRef, profileContext)).resolvedProfileHash
    const resolvedRecord = await profileResolver.getResolvedProfile({ scopeRef, profileRef, snapshotHash }, profileContext)
    return {
      profileRef,
      baseProfileSpec: record.spec,
      environment: record.environment,
      availableTasks: schemasByScenario([selectedScenario])[selectedScenario.scenarioId] ?? [],
      definitionRef: selectedScenario.definitionRef,
      namespace: selectedScenario.namespace,
      label: selectedScenario.label,
      sourceScenarioId: selectedScenario.scenarioId,
      mappingRefs: record.spec.mappingRefs,
      rawSourceRefs: selectedScenario.rawSources.map((source) => source.sourceRef),
      models: {
        generation: profileModelBindingEnabled(resolvedRecord.resolved.modelBindings['generation'], coreModelRefs.generation),
        decision: profileModelBindingEnabled(resolvedRecord.resolved.modelBindings['decision'], coreModelRefs.decision),
      },
    }
  }

  const competencyQuestions = createCompetencyQuestionWorkflow({ blobs: blobStore, registry: artifactRegistry, reviews: publicationStore, operations: compute.registry })
  const reviewableCandidates = new CompositeReviewableCandidateReader({ competencyQuestions: competencyQuestions.service, definition: assetCandidateStore, instance: candidateStore, ruleActions: ruleActionCandidateStore })
  publishedPackRules.current = new PublishedPackRuleDeclarationReader({ packs: publishedPackStore, registry: componentStore, definitions: definitionStore,
    candidates: ruleActionCandidateStore, reviews: publicationStore, reviewableCandidates, projects: projectStore })
  const projectFacts = createProjectFactWorkflow({
    materialization: { projects: projectStore, mappings: projectMappingStore, records: projectRecordStore,
      projectDocuments: projectDocumentStore, ingestion: structuredStore, candidates: candidateStore, schemaSource, jobs: jobStore,
      resolveSourceJob: async (scope, parseId, ctx, definitionRef) => {
        const parse = await structuredStore.getParse(scope, parseId, ctx)
        if (parse === undefined || parse.parseOptions === undefined) return undefined
        const documentRef = encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId, parserVersion: parse.parserVersion,
          definitionRef, format: parse.format, originalRef: parse.originalRef, originalMediaType: parse.originalMediaType, options: parse.parseOptions })
        const job = await new JobService({ store: state.jobStore }).createJob({ jobId: randomUUID(), kind: 'ingestion',
          sourceRef: parse.originalRef.id, documentRef, pipelineVersion: '1.0.0', initialStage: 'awaiting_review',
          initialCounts: { total: parse.counts.total, processed: parse.counts.succeeded, failed: parse.counts.failed, skipped: parse.counts.skipped }, idempotencyKey: `core-fact-source:${parseId}:${definitionRef.digest}` }, ctx)
        return job.jobId
      } },
    publication: { store: publicationStore, identity: identityStore, reviewableCandidates }, instanceRecords: instanceReviewStore,
  })
  const semanticPublication = projectFacts.publication
  const identityService = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource })
  const ruleSupport = new FiniteGrammarRuleSupportValidator()
  const sourceGrounding = createSourceGroundingService({ workspaces: state.workspaceStore,
    documentSets: new ArtifactGroundingDocumentSetReader(blobStore),
    reader: new ParsedSourceGroundingReader({ blobs: blobStore, documents: parseStore, tables: structuredStore }) })
  const generationForRun = async ({ ctx, signal }: { readonly ctx: ToolContext; readonly signal: AbortSignal }): Promise<GenerationPort | undefined> => {
    if (!modelCapabilities.generationEnabled) return undefined
    signal.throwIfAborted()
    const ledger = await budget.openLedger({ ledgerId: randomUUID(), kind: 'background', runId: ctx.runId }, ctx)
    signal.throwIfAborted()
    return modelCapabilities.forExecution({ ledgerId: ledger.ledgerId, signal }).generation
  }
  const actionBindingContext = (): ActionCapabilityBindingInput => ({ registry: compute.registry, availableCapabilities: ['agent_runtime', 'structured_query', 'document_search', 'industry.semantics'], recordedAt: hostClock().toISOString() })
  const ruleActionCandidateService = new RuleActionCandidateService({ workspaces: state.workspaceStore, candidates: ruleActionCandidateStore, support: ruleSupport })
  const definitionGenerationService = new DefinitionCandidateGenerationService({
    sourceGrounding, competencyQuestions: competencyQuestions.service, workspaces: state.workspaceStore, candidates: assetCandidateStore, terminology, generationForRun,
    modelRef: { modelId: options.modelsEnabled === true ? modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured' : 'model-not-configured', version: COMPONENT_VERSION },
    outputLimit: { maxTokens: 16_384 },
  })
  const ruleActionGenerationService = new RuleActionCandidateGenerationService({
    workspaces: state.workspaceStore, definitionCandidates: assetCandidateStore, candidates: ruleActionCandidateStore, batches: ruleActionGenerationStore,
    service: ruleActionCandidateService, terminology, sourceGrounding, generationForRun, bindingContext: actionBindingContext,
    modelRef: { modelId: modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured', version: COMPONENT_VERSION }, outputLimit: { maxTokens: 16_384 },
  })
  const staticPackCatalogue = new InMemoryIndustryPackCatalogue()
  for (const scenario of examples.scenarios) staticPackCatalogue.registerPack({ ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest), manifest: scenario.industryManifest, testSuite: scenario.testSuite })
  const packCatalogue = new StoreBackedIndustryPackCatalogue({ store: publishedPackStore, fallback: staticPackCatalogue })
  const definitionEditingService = new DefinitionCandidateEditingService({
    baseCatalogue: packCatalogue, publishedPacks: publishedPackStore, reviewableCandidates, reviews: publicationStore, workspaces: state.workspaceStore,
    candidates: assetCandidateStore, terminology, editing: definitionEditingStore, publishedDefinitions: definitionStore, newId: () => randomUUID(),
  })
  const instanceReviewService = new InstanceReviewService({ store: instanceReviewStore })
  const syntheticExampleService = new SyntheticExampleService({ workspaces: state.workspaceStore, sets: syntheticExampleSetStore })
  const competencyTarget = createCompetencyValidationTargetReader({ workspaces: state.workspaceStore, definitionCandidates: assetCandidateStore,
    ruleActions: ruleActionCandidateStore, ruleGeneration: ruleActionGenerationStore, reviews: publicationStore, reviewableCandidates,
    definitions: definitionStore, candidates: candidateStore, grounding: sourceGrounding, publishedRules: packRuleReader, packs: publishedPackStore,
    sourceDraft: async (scope, workspaceId, current, ctx, signal) => (await readWorkspacePublicationSourceDrafts({ workspaces: state.workspaceStore, packs: publishedPackStore, definitions: assetCandidateStore, ruleActions: ruleActionCandidateStore }, scope, workspaceId, current, ctx, signal)).at(-1) })
  const competencyRunner = createNormalCoreCompetencyExecution({ database, blobs: blobStore, parses: parseStore, structured: structuredStore,
    query: projectDatasetAdapter, producerComponentRef: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'),
    binding: async (request, ctx) => executionPreview.current?.bindingFor(request, ctx), target: competencyTarget, publishedRules: packRuleReader, packs: publishedPackStore,
    questions: competencyQuestions, profiles: profileStore, budget, operations: compute.registry, artifacts: gatewayComposition.artifacts, reader: scopedOriginals,
    gateway: ({ runId, ledgerId, resolved }) => gatewayComposition.forRun({ runId, ledgerId, resolvedProfile: resolved, operations: compute.registry }),
  })
  const industryValidationService = new IndustryValidationService({
    requireCompetencyQuestions: true, competencyRunner, workspaces: state.workspaceStore, exampleSets: syntheticExampleSetStore, reports: validationReportStore,
    definitions: definitionEditingService, ruleActions: ruleActionCandidateStore, support: ruleSupport, evaluator: new FiniteGrammarSyntheticEvaluator(),
  })
  const industryAssetPublicationService = new IndustryAssetPublicationService({
    baseCatalogue: packCatalogue, requireCompetencyQuestions: true, competencyQuestions: competencyQuestions.service, reviewableCandidates, reviews: publicationStore,
    workspaces: state.workspaceStore, validations: validationReportStore, definitionCandidates: assetCandidateStore, ruleActions: ruleActionCandidateStore,
    syntheticSets: syntheticExampleSetStore, definitions: definitionStore, store: publishedPackStore,
  })
  const componentRegistry = new ComponentRegistry({ control: state.control, store: componentStore, artifacts: blobStore, validator: manifestValidator(createAjv()) })
  const previewHost = examples.scenarios[0]
  const packExecutionProfiles = previewHost === undefined ? undefined : createCorePackExecutionProfiles({ packs: publishedPackStore, definitions: definitionStore,
    components: componentRegistry, profiles: profileResolver, authoring, executionProfileRef: previewHost.profileRef,
    dataBackendRef: options.projectDataset === undefined ? DATA_DUCKDB_ADAPTER_REF : DATA_POSTGRES_ADAPTER_REF, semanticCapability: capability('semantic_read') })
  if (packExecutionProfiles !== undefined) executionPreview.current = createCoreExecutionPreview({ workspaces: state.workspaceStore, definitions: definitionStore,
    terms: assetCandidateStore, actions: ruleActionCandidateStore, reviews: publicationStore, reviewable: reviewableCandidates,
    validation: industryValidationService, publication: industryAssetPublicationService, packs: publishedPackStore,
    executionProfiles: packExecutionProfiles, rules: packRuleReader, authoring, actionContext: actionBindingContext, reader: scopedOriginals, validateTarget: competencyTarget, termLabels })
  const packExportService = new IndustryPackExportService({ catalogue: packCatalogue, definitions: definitionStore, published: publishedPackStore })
  const packUpgradeService = new IndustryPackUpgradeService({ profiles: profileResolver, profileStore, registry: componentRegistry, registryStore: componentStore })
  const projectService = new ProjectService({ evolutionPolicy: 'staged_only', projects: projectStore, readiness: projectReadinessStore, jobs: state.jobStore, catalogue: packCatalogue })
  const projectMappingService = new ProjectMappingService({ projects: projectStore, revisions: projectStore, mappings: projectMappingStore, records: projectRecordStore, ingestion: structuredStore, schemaSource, originals: scopedOriginals, parser: new StructuredDocumentParser() })
  const instanceIdentity = createCoreInstanceIdentity({ projects: projectStore, documents: projectDocumentStore, candidates: candidateStore, identities: identityStore, instances: instanceReviewStore, schemas: schemaSource, reader: scopedOriginals })
  const projectEvolutionStore = new PostgresProjectEvolutionStore(database)
  normalApprovedInputs.current = createCoreApprovedInput({ projects: projectStore, documents: projectDocumentStore, records: projectRecordStore, evolutions: projectEvolutionStore, identity: identityStore, mappings: projectMappingStore,
    instances: instanceReviewStore, candidates: candidateStore, reviews: publicationStore, reviewable: reviewableCandidates, schemas: schemaSource, source: publishedProjectDatasetSource, reader: scopedOriginals, authoring })
  const approvedInputs = normalApprovedInputs.current
  const resolveApprovedInput = async (scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext, signal: AbortSignal) => {
    const evolved = await projectEvolutionCell.current?.resolveApprovedInput(scope, revision, ctx)
    if (signal.aborted) throw new RunServiceError('DEADLINE_EXCEEDED', 'the normal run input validation was cancelled', { cause: signal.reason })
    return evolved ?? approvedInputs.resolve(scope, revision, ctx, signal)
  }
  const prepareComputeInput = createCoreProjectComputeInput({ blobs: blobStore, authoring, snapshots: taskInputSnapshotStore,
    schemas: schemaSource, operations: compute.registry, approvedInput: compute.approvedInput, validator: taskParameterValidator(createAjv()), validateBase: resolveApprovedInput })
  projectEvolutionCell.current ??= createProjectEvolutionWorkflow({ projects: projectStore, store: projectEvolutionStore, mappings: projectMappingStore,
    mappingService: projectMappingService, documents: projectDocumentStore, catalogue: packCatalogue, schemas: schemaSource, jobs: state.jobStore,
    facts: projectFacts.materialization, candidates: candidateStore, publications: publicationStore, publishedSource: publishedProjectDatasetSource,
    readiness: projectReadinessStore, records: projectRecordStore, profiles: profileStore,
    input: { writer: gatewayComposition.artifacts, reader: scopedOriginals, instances: instanceReviewStore },
    instances: { createRecord: (scope, projectId, input, ctx) => instanceIdentity.identity.createRecord(scope, projectId, input, ctx) },
    dataset: { writer: projectDatasetAdapter, query: projectDatasetAdapter },
    previousInput: { archive: (scope, revision, ctx) => approvedInputs.resolve(scope, revision, ctx),
      validate: (scope, revision, ref, ctx, plan) => approvedInputs.validateCaptured(scope, revision, ref, ctx, undefined, plan) },
    targetIdentityMapping: (_scope, projectId, definitionRef, ctx) => projectApi.targetIdentityMapping(projectId, definitionRef, ctx),
  }).service
  const projectApi = createCoreProjectApi({ projects: projectStore, documents: projectDocumentStore, jobs: state.jobStore, readiness: projectReadinessStore,
    catalogue: packCatalogue, profiles: profileResolver, schemas: schemaSource, tasks: taskBindingStore, operations: compute.registry,
    computeOperationRef: compute.primary.operationRef, availableCapabilities: resolvedCapabilitiesFrom(componentRecords), resultSchemaRef: CORE_TYPED_RESULT_SCHEMA_REF,
    blobs: blobStore, parses: parseStore, structured: structuredStore, authoring, identity: instanceIdentity, facts: projectFacts.materialization, evolutions: projectEvolutionStore, selectors: semanticTasks, termLabels, computeInputConfigured: true, publications: publicationStore, documentSetFor: structuredImports.documentSet })
  const resolveRunRequest = createCoreRunRequestResolver({ projects: projectStore, runs: runStore, bindings: runExecutionBindingStore, tasks: taskBindingStore,
    inputs: { ...approvedInputs, resolve: (scope, revision, ctx, signal) => resolveApprovedInput(scope, revision, ctx, signal ?? new AbortController().signal) },
    prepareComputeInput, authoring, reader: scopedOriginals, now: () => hostClock().toISOString() })
  const projectStructuredImportService = structuredImports.imports
  // A manifest is only served as *verified* when the table-verification receipt it names actually
  // exists. Otherwise the reader refuses to render it as a formal table (TABLE_UNVERIFIED) instead
  // of trusting the stored ref alone.
  const verifiedTableManifests: VerifiedTableManifestSource = createCoreVerifiedTableSource({ answers: answerStore, runs: runStore,
    tables: tableArtifactStore, receipts: tableVerificationStore, blobs: blobStore })
  const sourceViews = createCoreSourceViewReader({ answers: answerStore, evidence: evidenceStore, runs: runStore, manifests: workflowStore,
    executionBindings: runExecutionBindingStore, blobs: blobStore, parses: parseStore, ingestion: structuredStore, projects: projectStore,
    documents: projectDocumentStore, instances: instanceReviewStore, candidates: candidateStore, records: projectRecordStore, mappings: projectMappingStore,
    datasets: projectDatasetAdapter, publications: publicationStore, computeInvocations: computeInvocationStore, computeResults: computeResultStore, computeBindings: computeOutputBindingsStore,
    tasks: taskBindingStore, taskInputs: taskInputSnapshotStore, verifiedTables: verifiedTableManifests, tablePages: tableArtifactStore, tableReceipts: tableVerificationStore,
    provenance: provenanceRead.provenance,
    publishedRuleReplay: () => new ArchivedRulePremiseReplayVerifier({ materialization: materializationStore, publications: publicationStore,
      evidence: evidenceStore, artifacts: blobStore, projects: projectStore, projectDocuments: projectDocumentStore, records: projectRecordStore,
      candidates: candidateStore, identity: identityStore, documentParses: parseStore, documentSpans: documentSpanReader,
      structuredSources: structuredPremiseSources, structuredClauses: structuredClauseSources, publishedRules: packRuleReader, readMode: 'published_snapshot' }),
  })
  const tableArtifactReadService = new TableArtifactReadService({ manifests: verifiedTableManifests, pages: tableArtifactStore, progress: tableArtifactStore })
  const verifiedResultReadService = new VerifiedResultReadService({
    answers: answerStore,
    results: { getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx), readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx) },
    tables: verifiedTableManifests,
  })
  const verifiedResultExportService = new VerifiedResultExportService({ reads: verifiedResultReadService, answers: answerStore, tables: verifiedTableManifests })
  const resultHistoryService = new ResultHistoryService({ answers: answerStore, bindings: runExecutionBindingStore, history: answerStore })
  const candidateSourceStore = new PostgresCandidateSourceStore(database)
  const candidateSourceResearch = options.webSearch === undefined ? undefined : new WebResearchService({
    webSearch: options.webSearch,
    ingestion: new CandidateSourceIngestionService({ artifacts: createBlobArtifactWriter(blobStore), sources: candidateSourceStore }),
  })
  const candidateSourceReview = new CandidateSourceReviewService({ sources: candidateSourceStore, retractions: candidateSourceStore })
  const sourceAdmissionPorts = createSourceAdmissionPorts({ blobs: blobStore, objectStore, registry: artifactRegistry, parses: parseStore, structured: structuredStore })
  const sourceAdmissionService = new WorkspaceSourceAdmissionService({
    sources: candidateSourceStore,
    workspaces: state.workspaceStore,
    documentSets: new ArtifactGroundingDocumentSetReader(blobStore),
    content: sourceAdmissionPorts.content,
    parser: sourceAdmissionPorts.parser,
    writer: sourceAdmissionPorts.writer,
    admissions: new PostgresSourceAdmissionStore(database),
    jobs: state.jobStore,
  })
  const controller = host.controller
  if (controller === undefined) throw new CoreCapabilityError('the Core controller is not mounted')

  // Model-connection catalogue / assignment / selection (design §5.3, A-R09/A-R10). The stores,
  // credential custodian and binding service are shared with the runtime assembly (built once in
  // infrastructure), so a run's fixed binding names exactly the connection this catalogue holds.
  const aiSettings = {
    connections: new ModelConnectionService({
      connections: state.modelConnectionStore,
      credentials: state.modelCredentialCustodian,
      assignments: state.modelAssignmentStore,
      probe: createCoreModelProbe({ credentials: state.modelCredentialCustodian }),
    }),
    assignments: new ModelAssignmentService({
      assignments: state.modelAssignmentStore,
      connections: state.modelConnectionStore,
      targets: state.modelTargetDirectory,
    }),
    selection: state.modelSelectionService,
    bindings: state.modelBindingService,
  }
  const dependencies: CoreApiDependencies = {
    database,
    scopeRef,
    examples,
    aiSettings,
    readScenarioProfile,
    profileRefsByScenario,
    profileSpecsByScenario,
    modelCapabilities: { generation: modelCapabilities.generationEnabled, decision: modelCapabilities.decisionEnabled },
    availableTasksByScenario,
    allowLocalOperator: options.allowLocalOperator ?? false,
    api: {
      runs: {
        service: runs,
        progress: runProgress,
        submissionMode: 'durable',
        resolveRequest: resolveRunRequest,
        validateSubmission: (input, ctx) => runValidation(input, ctx),
        dispatch: {
          enqueue: async (runId, logicalActionId, ctx) => dispatchStore.enqueue({ runId, logicalActionId }, ctx),
          cancelRun: (runId, ctx) => workflowDispatchWorker.cancelRun(runId, ctx),
        },
      },
      jobs: { service: jobService },
      workbench: { profiles: profileResolver, sources, components: componentStore },
      decisions: { service: identityService, candidates: candidateStore, documents: parseStore },
      publications: { service: semanticPublication },
      industryWorkspaces: { service: industryWorkspaceService },
      answers: { reader: controller, result: verifiedResultReadService, tables: tableArtifactReadService, exporter: verifiedResultExportService, history: resultHistoryService },
      evidence: { service: provenanceRead.provenance },
      history: { service: provenanceRead.history },
      packs: { catalogue: packCatalogue, packExports: packExportService, packUpgrades: packUpgradeService, publication: industryAssetPublicationService },
      assetCandidates: { generation: definitionGenerationService },
      candidateSources: { sources: candidateSourceStore, review: candidateSourceReview, retractions: candidateSourceStore,
        admissions: sourceAdmissionService, ...(candidateSourceResearch === undefined ? {} : { research: candidateSourceResearch }) },
      definitionEditing: { service: definitionEditingService },
      ruleActionCandidates: { service: ruleActionCandidateService, generation: ruleActionGenerationService, bindingContext: actionBindingContext },
      competencyQuestions: { service: competencyQuestions.service, uploadSource: competencyQuestions.uploadSource },
      instanceReviews: { service: instanceReviewService, identity: instanceIdentity.identity, identityContext: instanceIdentity.identityContext },
      projects: { service: projectService, mappings: projectMappingService, afterMappingConfirmed: projectApi.afterMappingConfirmed, dataset: projectDatasetService, evolution: projectEvolutionCell.current },
      projectDocuments: { service: projectDocumentIndexService },
      syntheticValidation: { exampleService: syntheticExampleService, validationService: industryValidationService, bindingContext: actionBindingContext },
    },
    registerRoutes: (api, authenticate) => {
      authoring.register(api, authenticate)
      projectApi.register(api, authenticate)
      executionPreview.current?.register(api, authenticate)
      packExecutionProfiles?.register(api, authenticate)
      registerCoreSourceViewRoutes(api, { reader: sourceViews, authenticate, contextFor: (auth, traceId) => createRequestToolContext({ ...auth, traceId, runId: randomUUID() }) })
      registerCoreImportRoute({ app: api, authenticate, scopeRef, examples, service: jobService, objectStore, registry: artifactRegistry, generationEnabled: modelCapabilities.generationEnabled })
      registerCoreRelationNavigationRoute({ app: api, authenticate, examples, publications: publicationStore, identity: identityStore })
      registerModelConnectionRoutes(api, { ...aiSettings, authenticate, webPort: Number(process.env['CORE_WEB_PORT'] ?? '5174') })
      registerProjectImportRoute(api, { authenticate, scopeRef, service: projectStructuredImportService })
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }

  return { dependencies }
}

/** Keep the injected import agent type available to callers that hint `projectStructuredImports`. */
export type { createCoreStructuredImportWorkflow }
