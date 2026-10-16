import { join } from 'node:path'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { DATA_DUCKDB_ADAPTER_REF, DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { DATA_POSTGRES_ADAPTER_REF, PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { PostgresKeywordIndexStore } from '@ontology/adapter-search-bm25'
import { ControlPostgresDatabase, PostgresExecutionConnectionSnapshotStore, PostgresExecutionModelBindingStore, PostgresExecutionToolBindingStore, PostgresModelAssignmentStore, PostgresModelConnectionStore, PostgresToolAssignmentStore, PostgresToolConnectionStore, PostgresToolSettingsMigrationStore } from '@ontology/adapter-control-postgres'
import { ExecutionModelBindingService, ExecutionToolBindingService, ModelAssignmentService, ModelConnectionService, ModelSelectionService, ProfileResolver, ProjectDataMaterializationService, SourceRegistry, StoreBackedIndustryManifestSource, ToolAssignmentService, ToolConnectionService, ToolSelectionService } from '@ontology/application'
import { definitionVersionDigest, projectIndustrySchema, PublishedProjectDatasetSource, SemanticDefinitionService } from '@ontology/semantic-engine'
import { canonicalJson, sha256DigestOf } from '@ontology/core'
import type { IndustrySchemaSource, ProfileRef, ProfileSpec, ScopeRef, ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { EXTRACTION_RESPONSE_SCHEMA_REF, parseModelCandidates, TBOX_RESPONSE_SCHEMA_REF, parseDefinitionCandidateOutput, RULE_ACTION_RESPONSE_SCHEMA_REF, parseRuleActionCandidateOutput } from '@ontology/application'
import type { JobWorkerLoop } from '@ontology/app-worker'
import type { WorkflowController } from '@ontology/application'
import type { createCoreApprovedInput } from './core-approved-input'
import type { createCoreExecutionPreview } from './core-execution-preview'
import type { CoreLocalCompositionOptions } from './core-local-composition'
import { COMPONENT_VERSION, WORKER_RUN_ID } from './core-constants'
import { CoreCapabilityError } from './core-errors'
import { sameVersionRef, sourceKey } from './core-composition-shared'
import { createAjv, profileValidator, terminologySourceFor } from './core-validators'
import { componentRecord, industrySourceFor, profileSpecFor, registerComponents, registerProfiles, scenarioComponentRecords, scenarioForIndustryRef, schemasByScenario, sourceRefsOf, workerContext } from './core-component-registration'
import type { CoreModelComponentRefs } from './core-template-plan-resolver'
import { componentRef } from './core-component-ref'
import { createCoreControlStores } from './core-control-stores'
import { createCoreModelEvidenceRecorders } from './model-evidence'
import { createCoreDecisionStateRefProvider } from './decision-state-reference'
import { createCoreJevActualStateResolver } from './jev-actual-state'
import { createCoreModelCapabilityFactory } from './core-model-capabilities'
import { createEnvSecretResolver } from './secret-resolver'
import { LocalModelCredentialCustodian } from './core-model-credential-custodian'
import { createModelTargetDirectory } from './core-model-target-directory'
import {
  catalogueModelComponentRecords,
  createExecutionModelBindingRuntime,
  createRunModelBinder,
  modelConnectionComponentRef,
} from './core-execution-model-binding'
import { createCoreModelProbe } from './core-model-probe'
import { CoreModelSettingsMigration } from './core-model-settings-migration'
import { CoreLocalModelSettings } from './core-local-model-settings'
import { LocalToolCredentialCustodian } from './core-tool-credential-custodian'
import { CoreToolSettingsMigration } from './core-tool-settings-migration'
import type { EffectiveModelSelection } from '@ontology/contracts'
import type { JevFallbackPolicy } from '@ontology/adapter-model-jev'
import { createPostgresSourceStore, createStaticProbeAdapterResolver } from './source-registry'
import { emptyCoreExamples } from './core-example-loader'
import { defaultCoreComputeRegistration } from './core-compute-registration'
import { exampleComputeArtifact } from './example-compute-artifact'
import { mountCoreTaskBindings } from './core-task-bindings'

const JEV_FALLBACK_POLICIES: ReadonlySet<string> = new Set([
  'deterministic', 'generative_classification', 'clarify', 'reject',
])

/** JEV keeps its existing execution behaviour policy; the catalogue never edits it (design §5.3). */
function jevFallbackPolicyOf(env: Readonly<Record<string, string | undefined>>): JevFallbackPolicy {
  const value = env['CORE_JEV_FALLBACK_POLICY']?.trim()
  if (value === undefined || value.length === 0) return 'reject'
  if (!JEV_FALLBACK_POLICIES.has(value)) {
    throw new CoreCapabilityError('CORE_JEV_FALLBACK_POLICY must be deterministic, generative_classification, clarify or reject')
  }
  return value as JevFallbackPolicy
}

/** A stable, non-secret reason for why a deployment-level model capability is not available. */
function unavailableReasonFor(selection: EffectiveModelSelection): string | undefined {
  switch (selection.state) {
    case 'available':
      return undefined
    case 'disabled':
      return '模型连接已停用'
    case 'blocked':
      switch (selection.blockedReason) {
        case 'CREDENTIAL_MISSING':
          return '模型连接缺少凭据'
        case 'MODEL_DISABLED':
          return '模型连接已停用'
        case 'MODEL_CAPABILITY_MISMATCH':
          return '模型连接不支持该能力'
        case 'MODEL_BINDING_REVOKED':
          return '模型绑定已被撤销'
        default:
          return '模型连接不可用'
      }
    default:
      return '未配置模型连接'
  }
}

/** Mutable host state shared across the assembly phases and used by start/close. */
export interface CoreAssemblyHost {
  dispatchAbort?: AbortController
  jobLoopAbort?: AbortController
  jobLoop?: JobWorkerLoop
  jobLoopPromise?: Promise<void>
  dispatchWorkerPromise?: Promise<void>
  activeRunIds: Set<Uuid>
  controller?: WorkflowController
}

/**
 * Phase A: database, object store, every control store, the model/source capability factories and
 * the mounted example component/profile set. It performs no run-side wiring, so later phases only
 * consume what it returns (plus the mutable `host` and the forward-reference holders).
 */
export async function assembleInfrastructure(options: CoreLocalCompositionOptions, cleanup: (() => Promise<void>)[]) {
  const database = new ControlPostgresDatabase({
    connectionString: options.databaseUrl,
    maxPoolSize: 16,
    applicationName: 'ontology-core-local-api',
    connectionTimeoutMs: 5_000,
  })
  cleanup.unshift(() => database.close())
  const host: CoreAssemblyHost = { activeRunIds: new Set<Uuid>() }

  await database.queryUnscoped('SELECT 1')
  const objectStore = new FileSystemObjectStore(options.objectDirectory)
  await objectStore.init()
  const artifactRegistry = new PostgresArtifactRegistry({ connectionString: options.databaseUrl, maxPoolSize: 8 })
  cleanup.unshift(() => artifactRegistry.close())
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry: artifactRegistry })
  const parseStore = new PostgresDocumentParseStore({ connectionString: options.databaseUrl, maxPoolSize: 8, applicationName: 'ontology-core-local-document-parser' })
  cleanup.unshift(() => parseStore.close())
  const structuredStore = new PostgresStructuredIngestionStore({ connectionString: options.databaseUrl, maxPoolSize: 4, applicationName: 'ontology-core-local-structured-ingestion' })
  cleanup.unshift(() => structuredStore.close())
  const keywordIndexStore = new PostgresKeywordIndexStore({ connectionString: options.databaseUrl, maxPoolSize: 8, applicationName: 'ontology-core-local-bm25' })
  cleanup.unshift(() => keywordIndexStore.close())

  const scopeRef = options.scopeRef
  const examples = options.examples ?? emptyCoreExamples()
  const compute = options.compute ?? defaultCoreComputeRegistration({ artifact: exampleComputeArtifact, version: COMPONENT_VERSION })
  const hostClock = options.clock ?? (() => new Date())
  const allSourceRefs = [...new Map(examples.scenarios.flatMap(sourceRefsOf).map((ref) => [sourceKey(ref), ref])).values()]
  const profileContext = workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-bootstrap-profile'), hostClock)
  const stores = createCoreControlStores(database, blobStore)
  const modelEnvironment: Readonly<Record<string, string | undefined>> = {
    ...(options.modelEnvironment ?? process.env),
    CORE_ENABLE_MODELS: options.modelsEnabled === true ? 'true' : 'false',
    CORE_ENABLE_JEV: options.jevEnabled === true ? 'true' : 'false',
  }
  const modelEvidence = createCoreModelEvidenceRecorders({ evidence: stores.evidenceStore, blobs: blobStore, scopeRef })
  const decisionStateRefProvider = createCoreDecisionStateRefProvider({ objectStore, artifactRegistry, references: stores.decisionStateReferences, scopeRef })
  const jevStateResolver = createCoreJevActualStateResolver({ blobStore, stateRefAuthorizer: { isApproved: (input, ctx) => stores.decisionStateReferences.isApproved(scopeRef, input, ctx) } })
  const extractionSchemaValidator = {
    async validate(schemaRef: VersionRef, candidate: unknown) {
      if (sameVersionRef(schemaRef, EXTRACTION_RESPONSE_SCHEMA_REF)) {
        try { parseModelCandidates(canonicalJson(candidate)); return { valid: true } }
        catch { return { valid: false, errors: ['extraction response did not match the registered candidate contract'] } }
      }
      if (sameVersionRef(schemaRef, TBOX_RESPONSE_SCHEMA_REF)) {
        try { parseDefinitionCandidateOutput(canonicalJson(candidate)); return { valid: true } }
        catch { return { valid: false, errors: ['definition candidate response did not match the registered generator contract'] } }
      }
      if (sameVersionRef(schemaRef, RULE_ACTION_RESPONSE_SCHEMA_REF)) {
        try { parseRuleActionCandidateOutput(canonicalJson(candidate)); return { valid: true } }
        catch { return { valid: false, errors: ['rule/action response did not match the registered generator contract'] } }
      }
      return { valid: false, errors: ['unknown model response schema'] }
    },
  }
  const modelCapabilities = createCoreModelCapabilityFactory({
    env: modelEnvironment,
    secrets: createEnvSecretResolver({ env: modelEnvironment }),
    budget: stores.budget,
    generationEvidence: modelEvidence.generation,
    decisionEvidence: modelEvidence.decision,
    decisionStateResolver: jevStateResolver,
    schemaValidator: extractionSchemaValidator,
  })
  const schemaSource: IndustrySchemaSource = { getSchema: async (scope, ref, ctx) => {
    const version = await stores.definitionStore.findVersionByRef(scope, ref, ctx)
    if (version !== undefined && definitionVersionDigest(version) !== ref.digest) throw new CoreCapabilityError('the stored definition declaration failed its exact immutable body digest')
    return version === undefined ? undefined : projectIndustrySchema(version)
  } }
  const semanticDefinitions = new SemanticDefinitionService({ control: stores.control, store: stores.definitionStore })
  const projectDatasetAdapter = options.projectDataset === undefined
    ? new DuckDbProjectDatasetAdapter({ instancePath: join(options.objectDirectory, 'project-dataset.duckdb') })
    : new PostgresProjectDatasetAdapter(options.projectDataset)
  cleanup.unshift(async () => { await projectDatasetAdapter.close() })
  const publishedProjectDatasetSource = new PublishedProjectDatasetSource({ publications: stores.publicationStore, identity: stores.identityStore,
    records: stores.projectRecordStore, mappings: stores.projectMappingStore, projectDocuments: stores.projectDocumentStore,
    definition: async (scope, ref, ctx) => stores.definitionStore.findVersionByRef(scope, ref, ctx),
  })
  const projectEvolutionCell: { current?: import('@ontology/application').ProjectEvolutionService | undefined } = { current: options.projectEvolution }
  const normalApprovedInputs: { current?: ReturnType<typeof createCoreApprovedInput> } = {}
  const evolutionGuard = { assertActiveRebuild: (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevisionRef, ctx: ToolContext) => projectEvolutionCell.current?.assertActiveRebuild(scope, revision, ctx) ?? Promise.resolve(false), resolveActiveSnapshot: (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevisionRef, objectId: string, ctx: ToolContext) => projectEvolutionCell.current?.resolveActiveSnapshot(scope, revision, objectId, ctx) ?? Promise.resolve(undefined) }
  const projectDatasetService = new ProjectDataMaterializationService({
    projects: stores.projectStore, publishedSource: publishedProjectDatasetSource, readiness: stores.projectReadinessStore,
    schemaSource, writer: projectDatasetAdapter, query: projectDatasetAdapter, evolution: evolutionGuard,
  })
  const profileValidatorImpl = profileValidator(createAjv())
  const industrySource = new StoreBackedIndustryManifestSource({ store: stores.publishedPackStore, fallback: industrySourceFor(examples.scenarios) })
  const profileResolver = new ProfileResolver({ control: stores.control, store: stores.profileStore, registry: stores.componentStore, industry: industrySource, validator: profileValidatorImpl })
  const sources = new SourceRegistry({ control: stores.control, store: createPostgresSourceStore(database), secrets: createEnvSecretResolver(), adapters: createStaticProbeAdapterResolver([]) })

  // Execution model binding (design §5.3): the shared catalogue/binding stores, the credential
  // custodian and the per-execution capability provider. The catalogue admin services are built
  // here so the one-time migration can run *before* the deployment projection and component
  // registration read the model directory.
  const modelConnectionStore = new PostgresModelConnectionStore(database)
  const modelAssignmentStore = new PostgresModelAssignmentStore(database)
  const modelBindingStore = new PostgresExecutionModelBindingStore(database)
  // The immutable execution-config snapshots a binding pins (S02). One store serves the tool and
  // model catalogues; a run is built from the pinned snapshot, never from today's catalogue row.
  const executionSnapshotStore = new PostgresExecutionConnectionSnapshotStore(database)
  const modelCredentialCustodian = new LocalModelCredentialCustodian({ objectDirectory: options.objectDirectory })
  const modelTargetDirectory = createModelTargetDirectory({ workspaces: stores.workspaceStore, projects: stores.projectStore })
  const modelSelectionService = new ModelSelectionService({
    assignments: modelAssignmentStore,
    connections: modelConnectionStore,
    targets: modelTargetDirectory,
  })
  const modelBindingService = new ExecutionModelBindingService({
    bindings: modelBindingStore,
    resolver: modelSelectionService,
    connections: modelConnectionStore,
    snapshots: executionSnapshotStore,
  })
  const jevFallbackPolicy = jevFallbackPolicyOf(modelEnvironment)
  const modelBindingRuntime = createExecutionModelBindingRuntime({
    scopeRef,
    bindings: modelBindingStore,
    connections: modelConnectionStore,
    credentials: modelCredentialCustodian,
    snapshots: executionSnapshotStore,
    isUsable: (executionId, capability, ctx) => modelBindingService.isUsable(executionId, capability, ctx),
    capabilityDependencies: {
      budget: stores.budget,
      generationEvidence: modelEvidence.generation,
      decisionEvidence: modelEvidence.decision,
      decisionStateResolver: jevStateResolver,
      schemaValidator: extractionSchemaValidator,
      jevFallbackPolicy,
    },
  })
  const runModelBinder = createRunModelBinder({
    selection: modelSelectionService,
    bindings: modelBindingService,
    // A run accept is a system action: the binder uses a host-minted editor context, never the
    // requesting business user's roles, so a business user cannot widen which model is selected.
    serverContext: (runId) => workerContext(scopeRef, allSourceRefs, runId, sha256DigestOf(`core-run-model-binding:${runId}`), hostClock),
  })

  // The catalogue admin services, shared with the deployment so a binding always names the exact
  // connection this catalogue holds.
  const aiSettings = {
    connections: new ModelConnectionService({
      connections: modelConnectionStore,
      credentials: modelCredentialCustodian,
      assignments: modelAssignmentStore,
      probe: createCoreModelProbe({ credentials: modelCredentialCustodian }),
    }),
    assignments: new ModelAssignmentService({
      assignments: modelAssignmentStore,
      connections: modelConnectionStore,
      targets: modelTargetDirectory,
    }),
    selection: modelSelectionService,
    bindings: modelBindingService,
  }

  // The one-time legacy-settings bridge runs on the normal start path *before* the deployment
  // projection is read, so an env/local generation config becomes a catalogue connection first
  // (design §5.3 step ①–⑦). A deployment that passes its own `modelSettings` shares that instance.
  const modelSettings = options.modelSettings ?? new CoreLocalModelSettings({
    objectDirectory: options.objectDirectory,
    scopeRef,
    environment: modelEnvironment,
  })
  const modelSettingsMigration = new CoreModelSettingsMigration({
    settings: modelSettings,
    connections: aiSettings.connections,
    assignments: aiSettings.assignments,
    environment: modelEnvironment,
  })
  await modelSettingsMigration.migrate()

  // Tool connections (design §9): a separate catalogue from model connections. It shares the model
  // target directory (same target scope shape) and the local custody boundary, but keeps its own
  // stores, credential namespace and per-tool assignment. The optional probe is wired by R02, so a
  // deployment without it still lists/edits connections and fails testing closed.
  const toolConnectionStore = new PostgresToolConnectionStore(database)
  const toolAssignmentStore = new PostgresToolAssignmentStore(database)
  const toolBindingStore = new PostgresExecutionToolBindingStore(database)
  const toolCredentialCustodian = new LocalToolCredentialCustodian({ objectDirectory: options.objectDirectory })
  const toolSelectionService = new ToolSelectionService({
    assignments: toolAssignmentStore,
    connections: toolConnectionStore,
    targets: modelTargetDirectory,
  })
  const toolBindingService = new ExecutionToolBindingService({
    bindings: toolBindingStore,
    resolver: toolSelectionService,
    connections: toolConnectionStore,
    snapshots: executionSnapshotStore,
  })
  const toolSettings = {
    connections: new ToolConnectionService({
      connections: toolConnectionStore,
      credentials: toolCredentialCustodian,
      assignments: toolAssignmentStore,
    }),
    assignments: new ToolAssignmentService({
      assignments: toolAssignmentStore,
      connections: toolConnectionStore,
      targets: modelTargetDirectory,
    }),
    selection: toolSelectionService,
    bindings: toolBindingService,
  }
  // The one-time legacy `CORE_WEB_SEARCH_*` bridge runs on the normal start path *before* the
  // deployment reads tool capabilities, so an old compat-gateway deployment becomes a catalogue
  // connection first. Once the marker is written the environment is no longer a second truth.
  const toolSettingsMigrationStore = new PostgresToolSettingsMigrationStore(database)
  const toolSettingsMigration = new CoreToolSettingsMigration({
    connections: toolSettings.connections,
    assignments: toolSettings.assignments,
    scopeRef,
    objectDirectory: options.objectDirectory,
    environment: modelEnvironment,
    migrationStore: toolSettingsMigrationStore,
  })
  await toolSettingsMigration.migrate()

  // The deployment capability projection and the startup model component registration are derived
  // from the actual model directory, never a static env flag (design §5.3). An empty directory
  // degrades explicitly to "not configured" with a reason; a named-but-broken connection is
  // `blocked` (also not available), so an unavailable ability always carries an honest cause.
  const projectionContext = workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-model-projection'), hostClock)
  const catalogueConnections = await modelConnectionStore.listConnections(scopeRef, {}, projectionContext)
  const generationSelection = await modelSelectionService.resolve(scopeRef, { scope: { kind: 'space' }, capability: 'generation' }, projectionContext)
  const decisionSelection = await modelSelectionService.resolve(scopeRef, { scope: { kind: 'space' }, capability: 'decision_jev' }, projectionContext)
  const deploymentModelCapabilities = {
    generation: generationSelection.state === 'available',
    decision: decisionSelection.state === 'available',
    generationReason: unavailableReasonFor(generationSelection),
    decisionReason: unavailableReasonFor(decisionSelection),
  }
  const coreModelRefs: CoreModelComponentRefs = {
    ...(generationSelection.state === 'available' && generationSelection.connectionSummary !== undefined
      ? { generation: modelConnectionComponentRef(generationSelection.connectionSummary) } : {}),
    ...(decisionSelection.state === 'available' && decisionSelection.connectionSummary !== undefined
      ? { decision: modelConnectionComponentRef(decisionSelection.connectionSummary) } : {}),
  }

  // Model components are registered from the catalogue so a run's fixed binding names a component
  // this deployment actually registered; the env-based refs are no longer registered statically.
  const componentRecords = [...scenarioComponentRecords(examples.scenarios, new Date().toISOString(), compute),
    ...catalogueModelComponentRecords(catalogueConnections, hostClock().toISOString()),
    componentRecord({ kind: 'compute_extension', ref: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'), capabilityNames: ['evidence.rule_derivation'], entrypoint: '@ontology/semantic-engine', now: hostClock().toISOString() }),
    ...(options.projectDataset === undefined ? [] : [componentRecord({ kind: 'data_backend', ref: DATA_POSTGRES_ADAPTER_REF, capabilityNames: ['structured_query'], entrypoint: '@ontology/adapter-data-postgres', now: hostClock().toISOString() })]),
  ]
  const bootstrapProfileSpecsByScenario = Object.fromEntries(examples.scenarios.map((scenario) => [scenario.scenarioId, profileSpecFor(scenario, DATA_DUCKDB_ADAPTER_REF, compute)]))
  await registerComponents(stores.componentStore, componentRecords, compute, scopeRef, profileContext, blobStore)
  await registerProfiles(profileResolver, examples.scenarios, scopeRef, profileContext, bootstrapProfileSpecsByScenario)

  const profileRefsByScenario: Record<string, ProfileRef> = {}
  const profileSpecsByScenario: Record<string, ProfileSpec> = {}
  const availableTasksByScenario: Record<string, readonly string[]> = {}
  for (const mountedScenario of examples.scenarios) {
    const active = await profileResolver.getActiveProfile(scopeRef, mountedScenario.profileRef.id, profileContext)
    const activeProfileRef = active?.profileRef ?? mountedScenario.profileRef
    const record = await profileResolver.getProfileVersion({ scopeRef, profileRef: activeProfileRef }, profileContext)
    const selectedScenario = scenarioForIndustryRef(examples.scenarios, record.spec.industryRef)
    if (selectedScenario === undefined) throw new CoreCapabilityError(`active profile ${activeProfileRef.id}@${activeProfileRef.version} pins an unmounted industry package`)
    profileRefsByScenario[mountedScenario.scenarioId] = activeProfileRef
    profileSpecsByScenario[mountedScenario.scenarioId] = record.spec
    availableTasksByScenario[mountedScenario.scenarioId] = schemasByScenario([selectedScenario])[selectedScenario.scenarioId] ?? []
  }
  for (const scenario of examples.scenarios) {
    const published = await semanticDefinitions.publish(scenario.definitionDraft, profileContext)
    if (published.ref.digest !== scenario.definitionRef.digest) throw new Error(`published definition digest differs from mounted scenario ${scenario.scenarioId}`)
  }
  await mountCoreTaskBindings(stores.taskBindingStore, examples.scenarios, scopeRef, profileContext, compute.primary)

  const terminology = terminologySourceFor(examples.scenarios, stores.publishedPackStore, stores.definitionStore, stores.componentStore)
  const executionPreview: { current?: ReturnType<typeof createCoreExecutionPreview> } = {}

  return {
    database, cleanup, host, objectStore, artifactRegistry, blobStore, parseStore, structuredStore, keywordIndexStore,
    scopeRef, examples, compute, hostClock, allSourceRefs, profileContext,
    control: stores.control, componentStore: stores.componentStore, profileStore: stores.profileStore, runStore: stores.runStore,
    jobStore: stores.jobStore, workspaceStore: stores.workspaceStore, candidateStore: stores.candidateStore, assetCandidateStore: stores.assetCandidateStore,
    ruleActionCandidateStore: stores.ruleActionCandidateStore, ruleActionGenerationStore: stores.ruleActionGenerationStore,
    definitionEditingStore: stores.definitionEditingStore, instanceReviewStore: stores.instanceReviewStore, syntheticExampleSetStore: stores.syntheticExampleSetStore,
    validationReportStore: stores.validationReportStore, scopedOriginals: stores.scopedOriginals, publishedPackStore: stores.publishedPackStore,
    projectStore: stores.projectStore, projectReadinessStore: stores.projectReadinessStore, projectMappingStore: stores.projectMappingStore,
    projectDocumentStore: stores.projectDocumentStore, projectRecordStore: stores.projectRecordStore, taskBindingStore: stores.taskBindingStore,
    taskInputSnapshotStore: stores.taskInputSnapshotStore, runExecutionBindingStore: stores.runExecutionBindingStore,
    taskFinalizationReceiptStore: stores.taskFinalizationReceiptStore, identityStore: stores.identityStore, publicationStore: stores.publicationStore,
    definitionStore: stores.definitionStore, publishedPackRules: stores.publishedPackRules, packRuleReader: stores.packRuleReader,
    workflowStore: stores.workflowStore, planReceiptStore: stores.planReceiptStore, evidenceStore: stores.evidenceStore,
    materializationStore: stores.materializationStore, decisionStateReferences: stores.decisionStateReferences, answerStore: stores.answerStore,
    dispatchStore: stores.dispatchStore, budget: stores.budget,
    modelEnvironment, modelEvidence, decisionStateRefProvider, jevStateResolver, extractionSchemaValidator, modelCapabilities,
    modelConnectionStore, modelAssignmentStore, modelBindingStore, modelCredentialCustodian, modelTargetDirectory,
    modelSelectionService, modelBindingService, modelBindingRuntime, runModelBinder, aiSettings,
    modelSettings, modelSettingsMigration, deploymentModelCapabilities,
    toolConnectionStore, toolAssignmentStore, toolBindingStore, toolCredentialCustodian,
    toolSelectionService, toolBindingService, toolSettings, toolSettingsMigration, toolSettingsMigrationStore,
    executionSnapshotStore,
    schemaSource, semanticDefinitions, projectDatasetAdapter, publishedProjectDatasetSource, projectEvolutionCell, normalApprovedInputs,
    evolutionGuard, projectDatasetService, profileResolver, sources, coreModelRefs, componentRecords, bootstrapProfileSpecsByScenario,
    profileRefsByScenario, profileSpecsByScenario, availableTasksByScenario, terminology, executionPreview,
  }
}
