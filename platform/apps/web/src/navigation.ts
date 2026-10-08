import type { AppView } from './components/App'

const CORE_VIEWS = ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence']
const HISTORY_INDEX = 'ontologyWorkbenchIndex'

/** Startup and browser traversal must interpret the same URL as the same surface. */
export function resolveAppView(params: URLSearchParams, contributions: readonly { readonly view: string }[], fallback: AppView = 'start'): AppView {
  const requested = params.get('view')
  if (requested !== null && (CORE_VIEWS.includes(requested) || contributions.some((entry) => entry.view === requested))) return requested
  return params.has('run') ? 'workbench' : fallback
}

export function readHistoryIndex(state: unknown): number | undefined {
  if (typeof state !== 'object' || state === null || !(HISTORY_INDEX in state)) return undefined
  const index = state[HISTORY_INDEX]
  return typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined
}

export function indexedHistoryState(index: number): object {
  const previous: unknown = window.history.state
  return { ...(typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {}), [HISTORY_INDEX]: index }
}
