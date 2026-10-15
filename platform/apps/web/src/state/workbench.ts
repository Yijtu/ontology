import type {
  ActiveProfileRecord,
  ComponentVersionRecord,
  PreflightResult,
  SourceBindingRecord,
} from '@ontology/contracts'

/**
 * The five explicit workbench states. `not_configured` is not an error: the profile
 * resolved but required capabilities are missing, so it is a distinct, actionable state.
 * `permission_denied` is separated from `failure` so the UI never tells an operator to
 * "retry" when the real answer is "you lack the role".
 */
export type WorkbenchPhase =
  | 'loading'
  | 'empty'
  | 'not_configured'
  | 'failure'
  | 'permission_denied'
  | 'ready'

export interface WorkbenchError {
  readonly code: string
  readonly message: string
  readonly traceId?: string
  readonly reasons?: readonly string[]
  /** HTTP status when the failure came from the API; kept so the public notice can classify it. */
  readonly status?: number
  /** The server's retryability hint; a non-retryable family never offers a retry entry. */
  readonly retryable?: boolean
  readonly missingCapabilities?: readonly unknown[]
}

export interface WorkbenchState {
  readonly phase: WorkbenchPhase
  readonly components: readonly ComponentVersionRecord[]
  readonly sources: readonly SourceBindingRecord[]
  readonly preflight?: PreflightResult
  readonly active?: ActiveProfileRecord
  readonly error?: WorkbenchError
  readonly conflict?: WorkbenchError | undefined
  readonly notice?: string | undefined
  readonly busy: boolean
}

export type WorkbenchEvent =
  | { readonly type: 'loadStarted' }
  | {
      readonly type: 'loaded'
      readonly components: readonly ComponentVersionRecord[]
      readonly sources: readonly SourceBindingRecord[]
    }
  | { readonly type: 'permissionDenied'; readonly error: WorkbenchError }
  | { readonly type: 'failed'; readonly error: WorkbenchError }
  | { readonly type: 'busy' }
  | { readonly type: 'sourcesRefreshed'; readonly sources: readonly SourceBindingRecord[] }
  | { readonly type: 'activeLoaded'; readonly active: ActiveProfileRecord }
  | { readonly type: 'preflightCompleted'; readonly result: PreflightResult }
  | { readonly type: 'notConfigured'; readonly error: WorkbenchError }
  | { readonly type: 'activated'; readonly active: ActiveProfileRecord }
  | { readonly type: 'conflict'; readonly error: WorkbenchError }

export function initialWorkbenchState(): WorkbenchState {
  return { phase: 'loading', components: [], sources: [], busy: false }
}

export function workbenchReducer(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  switch (event.type) {
    case 'loadStarted':
      return { ...state, phase: 'loading', busy: true }
    case 'loaded':
      return {
        ...state,
        phase: event.components.length === 0 ? 'empty' : 'ready',
        components: event.components,
        sources: event.sources,
        busy: false,
      }
    case 'busy':
      return { ...state, busy: true }
    case 'sourcesRefreshed':
      // A probe changes a source's status, not the profile state; the phase is preserved.
      return { ...state, sources: event.sources, busy: false }
    case 'activeLoaded':
      return { ...state, active: event.active }
    case 'permissionDenied':
      return { ...state, phase: 'permission_denied', error: event.error, busy: false }
    case 'failed':
      return { ...state, phase: 'failure', error: event.error, busy: false }
    case 'preflightCompleted':
      return {
        ...state,
        phase: event.result.status === 'resolved' ? 'ready' : 'not_configured',
        preflight: event.result,
        conflict: undefined,
        notice: undefined,
        busy: false,
      }
    case 'notConfigured':
      return { ...state, phase: 'not_configured', error: event.error, busy: false }
    case 'activated':
      return {
        ...state,
        phase: 'ready',
        active: event.active,
        conflict: undefined,
        notice: `已激活 ${event.active.profileRef.id}@${event.active.profileRef.version}（修订 ${event.active.revision}）`,
        busy: false,
      }
    case 'conflict':
      // A stale revision is never silently overwritten: the previous activation stands and
      // the operator must refresh and retry.
      return { ...state, phase: 'ready', conflict: event.error, busy: false }
  }
}
