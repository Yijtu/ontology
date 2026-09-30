export {
  createPostgresComponentRegistry,
  createPostgresComponentRegistryStore,
} from './composition/component-registry'
export type { ComponentRegistryComposition, ComponentRegistryCompositionOptions } from './composition/component-registry'
export {
  createPostgresSemanticDefinitionService,
  createPostgresSemanticDefinitionStore,
} from './composition/semantic-definition-store'
export type {
  SemanticDefinitionComposition,
  SemanticDefinitionCompositionOptions,
} from './composition/semantic-definition-store'
export {
  createPostgresProfileResolver,
  createPostgresProfileStore,
} from './composition/profile-resolver'
export type {
  ProfileResolverComposition,
  ProfileResolverCompositionOptions,
} from './composition/profile-resolver'
export {
  createPostgresSourceRegistry,
  createPostgresSourceStore,
  createStaticProbeAdapterResolver,
} from './composition/source-registry'
export type {
  SourceRegistryComposition,
  SourceRegistryCompositionOptions,
} from './composition/source-registry'
export {
  SecretResolutionError,
  createEnvSecretResolver,
  envVarNameOf,
} from './composition/secret-resolver'
export type { EnvSecretResolverOptions, SecretResolutionErrorCode } from './composition/secret-resolver'
export {
  createPostgresRunService,
  createPostgresRunStore,
} from './composition/run-service'
export type { RunServiceComposition, RunServiceCompositionOptions } from './composition/run-service'
export {
  createPostgresFeedbackService,
  createPostgresFeedbackStore,
} from './composition/feedback-service'
export type { FeedbackServiceComposition } from './composition/feedback-service'
export {
  createPostgresJobService,
  createPostgresJobStore,
} from './composition/job-service'
export type { JobServiceComposition, JobServiceCompositionOptions } from './composition/job-service'
export { createBlobArtifactWriter, createToolGatewayComposition } from './composition/tool-gateway'
export type {
  ToolGatewayComposition,
  ToolGatewayCompositionOptions,
} from './composition/tool-gateway'
export { CoreExampleLoaderError, loadCoreExamples } from './composition/core-example-loader'
export type {
  CoreExampleLoaderErrorCode,
  CoreExamplePhysicalMapping,
  CoreExampleScenario,
  CoreExampleSourceFile,
  LoadCoreExamplesOptions,
  LoadedCoreExamples,
} from './composition/core-example-loader'
export {
  createEnergyComputeConfig,
  createScopedBlobReader,
  createSimulationJobPort,
} from './composition/energy-compute'
export type { EnergyComputeCompositionOptions } from './composition/energy-compute'
export {
  SimulationSurfaceError,
  createEnergySimulationSurface,
  createSimulationExecutionSurface,
} from './composition/energy-simulation'
export type {
  EnergySimulationCompositionOptions,
  ExecutionSurface,
  RequestSimulationInput,
  SimulationDetailView,
  SimulationRecordView,
  SimulationSurface,
} from './composition/energy-simulation'
export {
  MAX_BACKUP_REQUIREMENT_KWH,
  WEATHER_SCENARIOS,
  buildSyntheticScenarioInput,
  createSyntheticScenarioCatalog,
  isWeatherScenario,
  scenarioDescriptorOf,
} from './composition/home-energy-scenario'
export type {
  ScenarioCatalog,
  ScenarioDescriptor,
  ScenarioRequest,
  ScenarioSeriesDescriptor,
  WeatherScenario,
} from './composition/home-energy-scenario'
export { createToolHandlerSet } from './composition/tool-handlers'
export type { ToolHandlerSetOptions } from './composition/tool-handlers'
export { createApiServer, createJobApi, createRunApi } from './http/app'
export type { ProjectDocumentRouteDependencies, ProjectDocumentService } from './http/project-documents'
export type { ApiServerOptions } from './http/app'
export { CORE_TYPED_RESULT_SCHEMA_REF, createCoreLocalComposition, createDuckDbSnapshot } from './composition/core-local-composition'
export type { CoreLocalComposition, CoreLocalCompositionOptions } from './composition/core-local-composition'
export {
  CORE_MOUNTED_TASK_KINDS,
  coreScenarioTaskBindings,
  coreTaskBindingRef,
  mountCoreTaskBindings,
} from './composition/core-task-bindings'
export { createCoreApi, startCoreApi } from './core-main'
export type { CoreApiDependencies } from './core-main'
export { registerRunRoutes } from './http/server'
export type { AuthenticatedRequest, RequestAuthenticator, RunApiOptions, RunDispatchHooks } from './http/server'
export { RunProgressService } from './http/run-progress'
export type {
  DegradationView,
  RunProgressDependencies,
  RunProgressReader,
  RunProgressSubject,
  RunProgressView,
  RunScopeView,
} from './http/run-progress'
export { registerJobRoutes } from './http/jobs'
export type { JobApiOptions, JobRouteDependencies } from './http/jobs'
export { registerAssetCandidateRoutes } from './http/asset-candidates'
export { registerDefinitionEditingRoutes } from './http/definition-editing'
export type { DefinitionEditingRouteDependencies } from './http/definition-editing'
export { registerRuleActionCandidateRoutes } from './http/rule-action-candidates'
export type { RuleActionCandidateRouteDependencies } from './http/rule-action-candidates'
export { registerSyntheticValidationRoutes } from './http/synthetic-validation'
export type { SyntheticValidationRouteDependencies } from './http/synthetic-validation'
export { registerProjectRoutes } from './http/projects'
export type { ProjectRouteDependencies } from './http/projects'
export type { AssetCandidateRouteDependencies } from './http/asset-candidates'
export { registerWorkbenchRoutes } from './http/workbench'
export type { WorkbenchApiOptions, WorkbenchRouteDependencies } from './http/workbench'
export { registerDecisionRoutes } from './http/decisions'
export { detailOf } from './http/decisions'
export type {
  CandidateDetailView,
  CandidateSourceView,
  CandidateSpanSource,
  CandidateSummary,
  DecisionRouteDependencies,
  EntityCandidateDetail,
  RelationCandidateDetail,
  RuleCandidateDetail,
  RuleUnhandledCandidateDetail,
} from './http/decisions'
export { registerPublicationRoutes } from './http/publication'
export type { PublicationRouteDependencies } from './http/publication'
export { registerPackRoutes } from './http/packs'
export type { PackApiOptions, PackRouteDependencies } from './http/packs'
export { registerEvidenceRoutes } from './http/evidence'
export type { EvidenceReadSurface, EvidenceRouteDependencies } from './http/evidence'
export { registerHistoryRoutes } from './http/history'
export type { HistoryReadSurface, HistoryRouteDependencies } from './http/history'
export { registerAnswerRoutes } from './http/answers'
export type { AnswerReader, AnswerResultReader, AnswerRouteDependencies, AnswerTableReader } from './http/answers'
export { registerFeedbackRoutes } from './http/feedback'
export type { FeedbackRouteDependencies, FeedbackWriter } from './http/feedback'
export { registerSimulationRoutes } from './http/simulations'
export type { SimulationRouteDependencies } from './http/simulations'
export { createPostgresProvenanceRead } from './composition/provenance-read'
export type {
  ProvenanceReadComposition,
  ProvenanceReadCompositionOptions,
} from './composition/provenance-read'
export { createRequestToolContext } from './http/context'
export type { RequestToolContextInput } from './http/context'
export { formatSseFrame, SSE_HEADERS } from './http/sse'
export { failureBody, isClassifiedError, isRetryable } from './http/errors'
export type { ApiFailureBody, ClassifiedApiError } from './http/errors'
export {
  CapabilityNotConfiguredError,
  ForbiddenError,
  InvalidRequestFieldError,
  installErrorHandler,
  readRevisionHeader,
  scopeRefFor,
} from './http/shared'
