/**
 * @ontology/app-web — the browser configuration workbench.
 *
 * It talks to the API over HTTP only (`WorkbenchClient`) and never imports a server
 * package. Exported so tests can render the real components against a real API fixture.
 */
export { Workbench } from './components/Workbench'
export type { WorkbenchProps } from './components/Workbench'
export { WorkbenchClient } from './api/client'
export type {
  ActivateProfileRequest,
  BoundRunView,
  ComponentFilter,
  PublishProfileRequest,
  RegisterSourceRequest,
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
export { NARROW_MAX_WIDTH, viewportOf } from './components/useViewport'
export type { Viewport } from './components/useViewport'
