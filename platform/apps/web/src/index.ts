/**
 * @ontology/app-web — the browser configuration workbench.
 *
 * It talks to the API over HTTP only (`WorkbenchClient`) and never imports a server
 * package. Exported so tests can render the real components against a real API fixture.
 */
export { Workbench } from './components/Workbench'
export type { WorkbenchProps } from './components/Workbench'
export { App } from './components/App'
export type { AppProps, AppView, CoreAppView } from './components/App'
export { GuideHome } from './components/GuideHome'
export type { GuideCard, GuideHomeProps, GuideStep } from './components/GuideHome'
export { deriveProjectBinding, isMappingRef as isProjectMappingRef } from './project-binding'
export { JobProgressPanel } from './components/JobProgressPanel'
export type { JobProgressPanelProps } from './components/JobProgressPanel'
export { CandidateReviewPanel } from './components/CandidateReviewPanel'
export type { CandidateReviewPanelProps } from './components/CandidateReviewPanel'
export { CoreImportPanel } from './components/CoreImportPanel'
export type { CoreImportPanelProps } from './components/CoreImportPanel'
export { QueryPanel } from './components/QueryPanel'
export type { QueryContextField, QueryPanelProps } from './components/QueryPanel'
export { EvidencePanel } from './components/EvidencePanel'
export type { EvidencePanelProps } from './components/EvidencePanel'
export { EnergyPlanPanel } from './components/EnergyPlanPanel'
export type { EnergyPlanPanelProps } from './components/EnergyPlanPanel'
export { Datum } from './components/Datum'
export type { DatumMode, DatumProps } from './components/Datum'
export {
  buildComparison,
  constraintGapsOf,
  DEFAULT_BACKUP_REQUIREMENT_KWH,
  DEFAULT_WEATHER_SCENARIO,
  energyReducer,
  initialEnergyState,
} from './state/energy'
export type {
  ConstraintGap,
  EnergyEvent,
  EnergyPhase,
  EnergyPlanComparison,
  EnergyPlanVersion,
  EnergyState,
  SourceChange,
} from './state/energy'
export {
  asExecutionRecord,
  asPlanResult,
  asScenarioDescriptor,
  asSimulationDetail,
  asSimulationRecord,
  isWeatherScenario,
  WEATHER_SCENARIOS,
} from './api/energy'
export type {
  CreateScenarioRequest,
  EnergySourceView,
  ExecutionRecordView,
  PlanCandidateView,
  PlanComparisonView,
  PlanResultView,
  RequestExecutionRequest,
  RequestSimulationInput,
  ScenarioDescriptor,
  ScenarioSeriesDescriptor,
  SimulationDetailView,
  SimulationRecordView,
  WeatherScenario,
} from './api/energy'
export { evidenceReducer, initialEvidenceState } from './state/evidence'
export type {
  AssertionComparison,
  ComparisonChange,
  EvidenceEvent,
  EvidencePhase,
  EvidenceState,
} from './state/evidence'
export { dependencyQuery, historyFingerprint, optionalTimeQuery } from './api/provenance'
export type {
  AssertionVersion,
  DependencyDirection,
  DependencyGraphView,
  DependencyNodeView,
  DependencyPage,
  DependencyTraversalRequest,
  EvidenceDependencyDirection,
  EvidenceDependencyEdge,
  EvidenceReadQuery,
  HistoricalAssertionView,
  HistoryPage,
  ObjectHistoryQuery,
  ObjectHistoryView,
  ProvenanceEvidenceView,
  ProvenancePremiseGroupView,
  ProvenanceSourceView,
  SourceReReadability,
} from './api/provenance'
export { initialQueryState, isRunActive, queryReducer } from './state/query'
export type {
  ClarificationView,
  ProgressEntry,
  QueryEvent,
  QueryOutcome,
  QueryPhase,
  QueryState,
} from './state/query'
export { WorkbenchClient } from './api/client'
export { PUBLIC_SSE_EVENTS, isPublicSseEvent } from './api/client'
export type {
  ActivateProfileRequest,
  BoundRunView,
  CancelRunRequest,
  CandidateDetailView,
  CandidateFilter,
  CandidateReviewRecord,
  CandidateReviewRequest,
  CandidateSourceView,
  CandidateSpanSource,
  CandidateSummary,
  ComponentFilter,
  CoreImportRequest,
  CoreImportResult,
  CoreDeploymentInfo,
  CoreDeploymentScenario,
  CreateIngestionRequest,
  CreateJobResponse,
  CreateRunRequest,
  CreateRunView,
  DegradationView,
  IdentityDecisionRequest,
  IdentityDecisionView,
  JobAttemptView,
  JobPublicationView,
  JobView,
  PublishProfileRequest,
  PublishSemanticsRequest,
  PublishedStatement,
  QueryRunView,
  RegisterSourceRequest,
  RespondToClarificationRequest,
  RetryJobRequest,
  RetryJobResponse,
  RunAnswerResult,
  RunEvent,
  RunEventHandlers,
  RunEventStream,
  RunEventStreamFactory,
  RunProgressView,
  RunScopeView,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  StatementRevisionRequest,
  WorkbenchClientOptions,
} from './api/client'
export { ApiError, toApiFailure } from './api/errors'
export type { ApiFailure } from './api/errors'
export { initialWorkbenchState, workbenchReducer } from './state/workbench'
export type {
  WorkbenchError,
  WorkbenchEvent,
  WorkbenchPhase,
  WorkbenchState,
} from './state/workbench'
export { initialReviewState, reviewReducer, selectionStillPresent } from './state/review'
export type { ReviewError, ReviewEvent, ReviewPhase, ReviewState } from './state/review'
export { NARROW_MAX_WIDTH, viewportOf } from './components/useViewport'
export type { Viewport } from './components/useViewport'
export { AssistantShell, ASSISTANT_DEFINITIONS } from './components/AssistantShell'
export type {
  AssistantDefinition,
  AssistantId,
  AssistantModuleDeclarations,
  AssistantShellProps,
} from './components/AssistantShell'
export { ScenarioErrorBoundary } from './components/ScenarioErrorBoundary'
export type { ScenarioErrorBoundaryProps } from './components/ScenarioErrorBoundary'
export { OntologyWorkspacePanel, EMPTY_CREATE_FIELDS, boundaryOf, validateCreateFields } from './components/OntologyWorkspacePanel'
export type { OntologyWorkspacePanelProps, WorkspaceCreateFields } from './components/OntologyWorkspacePanel'
export {
  DefinitionWorkbenchPanel,
  buildEditedPayload,
  candidateDetailLabel,
  candidateSourceLabel,
  editFieldsOf,
  isCandidateStale,
  parseJsonText,
} from './components/DefinitionWorkbenchPanel'
export type {
  DefinitionEditFields,
  DefinitionWorkbenchPanelProps,
  JsonParseResult,
} from './components/DefinitionWorkbenchPanel'
export { definitionGuard } from './api/definitions'
export type {
  ActionCandidateDraft,
  CandidateLifecycleView,
  DefinitionCandidateFilter,
  EditActionCandidateRequest,
  EditDefinitionCandidateRequest,
  EditRuleCandidateRequest,
  EnableRuleActionCandidateRequest,
  KeepDefinitionsSeparateRequest,
  MergeDefinitionCandidatesRequest,
  RecordUnsupportedRuleRequest,
  RejectDefinitionCandidateRequest,
  RuleActionCandidateFilter,
  RuleActionCandidateView,
  RuleCandidateDraft,
  ValidateDefinitionsRequest,
} from './api/definitions'
export { WorkspaceSourcesPanel } from './components/WorkspaceSourcesPanel'
export type {
  SupportedSourceType,
  WorkspaceSource,
  WorkspaceSourcesPanelProps,
} from './components/WorkspaceSourcesPanel'
export { webWorkspaceIdentity } from './workspace-identity'
export type { WorkspaceIdentity } from './workspace-identity'
export type {
  AppendIndustryWorkspaceDraftRequest,
  AssetDraftRef,
  CreateIndustryWorkspaceRequest,
  EditIndustryWorkspaceRequest,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceWriteView,
} from './api/workspaces'
export { ScenarioModuleRegistry, isLegalUiCapabilityMetadata } from './mount/registry'
export type { MountContext, ScenarioMount } from './mount/registry'
export type {
  FrontendScenarioModule,
  ScenarioDraftStore,
  ScenarioExporter,
  ScenarioFieldChange,
  ScenarioModuleView,
  ScenarioParameterProps,
  ScenarioResultProps,
  ScenarioTaskEntry,
  ScenarioVerifiedResult,
} from './mount/contract'
export { createScenarioRegistry, registerBuiltInScenarioModules } from './scenarios/composition'
export { InstanceReviewPanel } from './components/InstanceReviewPanel'
export type { InstanceReviewPanelProps } from './components/InstanceReviewPanel'
export {
  PackagePublicationPanel,
  coveredCaseKinds,
  expectationSummary,
  gateLabel,
  publicationBlocked,
} from './components/PackagePublicationPanel'
export type { PackageMountBinding, PackagePublicationPanelProps } from './components/PackagePublicationPanel'
export {
  isIndustryValidationReportView,
  isPackCapabilityStatusView,
  isPackExportBundleView,
  isPublishedPackResult,
  isSyntheticExampleSetView,
  isVersionRef as isPackageVersionRef,
  SYNTHETIC_CASE_KINDS,
  SYNTHETIC_CASE_KIND_LABELS,
} from './api/package-publication'
export type {
  IndustryValidationGate,
  IndustryValidationIssueView,
  IndustryValidationReportView,
  PackCapabilityStatusView,
  PackExportBundleView,
  PackVersionDiffView,
  PublishedPackResultView,
  PublishPackRequest,
  RunValidationRequest,
  SyntheticCaseKind,
  SyntheticCaseView,
  SyntheticExampleSetView,
  SyntheticExpectationView,
  ValidationSurfaceGateView,
} from './api/package-publication'
export { ProjectWorkspacePanel } from './components/ProjectWorkspacePanel'
export type {
  ProjectBinding,
  ProjectSourceCandidate,
  ProjectSourceColumn,
  ProjectSourceField,
  ProjectSourceObject,
  ProjectWorkspacePanelProps,
} from './components/ProjectWorkspacePanel'
export {
  isIndustryPackSummary,
  isImportMappingVersion,
  isMappingPreview,
  isProjectDatasetStatus,
  isProjectDocumentIndexStatus,
  isProjectEvolutionView,
  isProjectReadinessView,
  isProjectRecord,
  isProjectRecordPageView,
  isProjectRecordVersion,
  isProjectRevision,
  isProjectRevisionView,
  isReadinessProjection,
} from './api/projects'
export type {
  ColumnMappingRequestView,
  CreateProjectRequest,
  IndustryPackSummary,
  MountProjectPackRequest,
  ProjectDatasetStatusView,
  ProjectDocumentIndexState,
  ProjectDocumentIndexStatusView,
  ProjectEvolutionView,
  ProjectReadinessView,
  ProjectRecordPageView,
  ProjectRevisionView,
} from './api/projects'
export {
  isInstanceConfirmationEvent,
  isInstanceConfirmationOutcome,
  isInstanceRecordView,
} from './api/instances'
export type {
  ConfirmInstanceFieldsRequest,
  CreateInstanceFieldInput,
  CreateInstanceRecordRequest,
  CreateInstanceRelationInput,
  EditInstanceFieldRequest,
  InstanceConfirmationEvent,
  InstanceConfirmationOutcomeView,
  InstanceFieldDecisionInput,
  InstanceIdentityDecisionRequest,
  InstanceRecordFilter,
  InstanceRevisionRequest,
} from './api/instances'
export {
  createWorkbenchResultSource,
  isColumnDescriptor,
  isDigest as isResultDigest,
  isResourceRef as isResultResourceRef,
  isTablePageReadView,
  isVerifiedResultView,
  isVersionRef as isResultVersionRef,
} from './api/results'
export type {
  ResultSource,
  ResultSourceClient,
  VerifiedResultLoad,
  VerifiedResultView,
  VerifiedTablePageView,
  VerifiedTableSummary,
} from './api/results'
export { ResultWorkbenchPanel } from './components/ResultWorkbenchPanel'
export type { ResultWorkbenchPanelProps, ResultWorkbenchTab } from './components/ResultWorkbenchPanel'
export { BusinessWorkbenchPanel } from './components/BusinessWorkbenchPanel'
export type {
  BusinessUnavailableTask,
  BusinessViewTask,
  BusinessWorkbenchPanelProps,
  ParameterChangePreview,
} from './components/BusinessWorkbenchPanel'
export { classifyPublicError, publicRecoveryLabel } from './state/public-errors'
export type { PublicErrorFamily, PublicFailure, PublicRecovery } from './state/public-errors'
export { PublicEmptyState, PublicStateNotice } from './components/PublicStateNotice'
export type { PublicEmptyStateProps, PublicStateNoticeProps } from './components/PublicStateNotice'

export { Button, Panel, Field, StatusBadge, StateFeedback, DataTable, Drawer } from './components/ui'
export type { AppViewContext, AppViewContribution } from './components/App'
export { bootstrapProject, importProjectFile, readProjectSources, readProjectTasks, isProjectSourceCatalogue, isProjectTaskCatalogue } from './api/project-workbench'
export type { ProjectBootstrapView, ProjectSourceCatalogue, ProjectNativeSource, NativeSourceTable, ProjectCanonicalObject, ProjectTaskItem, ProjectTaskCatalogue, StructuredProjectImportView } from './api/project-workbench'
export { readAnswerSource, isAnswerSourceView, isSourceLocator, isProvenanceView, sameSourceLocator } from './api/source-views'
export type { AnswerSourceView, AnswerSourceLoader } from './api/source-views'
export { TaskRunForm } from './components/project/TaskRunForm'
export { PublishedAnswerBody } from './components/PublishedAnswerBody'
export type { PublishedAnswerBodyProps, PublishedAnswerLabelKind } from './components/PublishedAnswerBody'
export { instanceValueDraft, normalizedInstanceValue } from './components/project/InstanceValueEditor'
export { ProjectFileImport } from './components/project/ProjectFileImport'
export { ProjectEvolutionPanel } from './components/project/ProjectEvolutionPanel'
export { stageProjectFacts } from './api/project-facts'
export type { StagedProjectCandidate } from './api/project-facts'
export { readEvolutionTarget, startProjectEvolution, readProjectEvolution, operateProjectEvolution, isProjectEvolutionRecord } from './api/project-evolution'
