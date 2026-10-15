import type { AppView } from './components/App'

const CORE_VIEWS = ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence', 'models']
const HISTORY_INDEX = 'ontologyWorkbenchIndex'

/** The two top-level work objects of the knowledge workbench (design §1.1/§1.5). */
export type WorkbenchAssistant = 'ontology' | 'business'

export interface AssistantTab {
  readonly assistant: WorkbenchAssistant
  /** Product page id used in the `tab` query parameter. */
  readonly tab: string
  /** The existing surface that currently hosts the product page. */
  readonly view: AppView
}

/**
 * Product page → hosting view. The workbench shell owns the navigation scheme; later frontend
 * nodes replace a hosting view with a dedicated surface without changing the query contract.
 * Legacy `view=` deep links keep working because the view stays the routing key.
 */
export const ASSISTANT_TABS: readonly AssistantTab[] = [
  { assistant: 'ontology', tab: 'overview', view: 'ontology' },
  { assistant: 'ontology', tab: 'sources', view: 'jobs' },
  { assistant: 'ontology', tab: 'assets', view: 'definitions' },
  { assistant: 'ontology', tab: 'review', view: 'review' },
  { assistant: 'ontology', tab: 'validation', view: 'packages' },
  { assistant: 'ontology', tab: 'versions', view: 'packages' },
  { assistant: 'business', tab: 'overview', view: 'projects' },
  { assistant: 'business', tab: 'data', view: 'projects' },
  { assistant: 'business', tab: 'review', view: 'instances' },
  { assistant: 'business', tab: 'tasks', view: 'business' },
  { assistant: 'business', tab: 'history', view: 'evidence' },
]

const DEFAULT_TAB: Readonly<Record<WorkbenchAssistant, string>> = { ontology: 'overview', business: 'overview' }

/** The workbench a legacy view belongs to, or undefined for the shell-level surfaces. */
export function assistantOfView(view: AppView): WorkbenchAssistant | undefined {
  const match = ASSISTANT_TABS.find((entry) => entry.view === view)
  return match?.assistant
}

/** The product tab a legacy view currently hosts (first mapping wins). */
export function tabOfView(view: AppView): string | undefined {
  const match = ASSISTANT_TABS.find((entry) => entry.view === view)
  return match?.tab
}

export function viewOfAssistantTab(assistant: WorkbenchAssistant, tab: string | undefined): AppView {
  const requested = tab ?? DEFAULT_TAB[assistant]
  const match = ASSISTANT_TABS.find((entry) => entry.assistant === assistant && entry.tab === requested)
  if (match !== undefined) return match.view
  return ASSISTANT_TABS.find((entry) => entry.assistant === assistant && entry.tab === DEFAULT_TAB[assistant])?.view ?? 'start'
}

/** Startup, deep links and browser traversal must interpret the same URL as the same surface. */
export function resolveAppView(params: URLSearchParams, contributions: readonly { readonly view: string }[], fallback: AppView = 'start'): AppView {
  const requested = params.get('view')
  if (requested !== null && (CORE_VIEWS.includes(requested) || contributions.some((entry) => entry.view === requested))) return requested
  const assistant = params.get('assistant')
  if (assistant === 'ontology' || assistant === 'business') return viewOfAssistantTab(assistant, params.get('tab') ?? undefined)
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
