/**
 * @ontology/app-web — the browser configuration workbench.
 *
 * It talks to the API over HTTP only (`WorkbenchClient`) and never imports a server
 * package. Exported so tests can render the real components against a real API fixture.
 */
export { Workbench } from './components/Workbench'
export type { WorkbenchProps } from './components/Workbench'
export { App } from './components/App'
export type { AppProps, AppView } from './components/App'
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
