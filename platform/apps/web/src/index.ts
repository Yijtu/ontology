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
export { WorkbenchClient } from './api/client'
export type {
  ActivateProfileRequest,
  BoundRunView,
  CandidateDetailView,
  CandidateFilter,
  CandidateReviewRecord,
  CandidateReviewRequest,
  CandidateSourceView,
  CandidateSpanSource,
  CandidateSummary,
  ComponentFilter,
  CreateIngestionRequest,
  CreateJobResponse,
  IdentityDecisionRequest,
  IdentityDecisionView,
  JobAttemptView,
  JobPublicationView,
  JobView,
  PublishProfileRequest,
  PublishSemanticsRequest,
  PublishedStatement,
  RegisterSourceRequest,
  RetryJobRequest,
  RetryJobResponse,
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
