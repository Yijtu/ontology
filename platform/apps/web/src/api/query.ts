import type {
  BudgetRemaining,
  CreateRunContext,
  ProfileRef,
  PublishedAnswer,
  RevisionString,
  RunPreferences,
  RunState,
  Sha256Digest,
  SseEventType,
  VersionRef,
} from '@ontology/contracts'

/**
 * The business query surface (C6). It is the only shape the browser uses for the
 * ask/progress/clarify workflow, and it deliberately mirrors the server's sanitised
 * projection: a run carries the shared budget and the resolved scenario scope, never a
 * resolved secret and never an unverified draft.
 */
export interface CreateRunRequest {
  readonly profileRef: ProfileRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly projectId?: string
  readonly task?: { readonly bindingRef: VersionRef; readonly arguments: Readonly<Record<string, unknown>> }
}

export interface CreateRunView {
  readonly runId: string
  readonly state: RunState
  readonly eventsUrl: string
  readonly resolvedProfileHash: Sha256Digest
}

export interface DegradationView {
  readonly capability: string
  readonly reason: string
  readonly fallback: string
}

/**
 * The resolved scenario scope. The ask form offers only `toolIds`; web search is offered
 * only when `webSearchEnabled`; domains are only the `allowedDomains` the server approves.
 */
export interface RunScopeView {
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly webSearchEnabled: boolean
  readonly toolIds: readonly string[]
  readonly allowedDomains: readonly string[]
  readonly explicitDegradations: readonly DegradationView[]
}

export interface RunProgressView {
  readonly budget?: BudgetRemaining
  readonly scope?: RunScopeView
}

export interface QueryRunView {
  readonly runId: string
  readonly state: RunState
  readonly revision: RevisionString
  readonly ownerSubjectId: string
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly createdAt: string
  readonly updatedAt: string
  readonly pendingClarificationId?: string
  readonly cancelReason?: string
  readonly budget?: BudgetRemaining
  readonly scope?: RunScopeView
}

export interface RespondToClarificationRequest {
  readonly clarificationId: string
  readonly typedResponse: Readonly<Record<string, unknown>>
  readonly expectedRevision: RevisionString
}

export interface CancelRunRequest {
  readonly reason: string
  readonly expectedRevision: RevisionString
}

/**
 * The answer read is a discriminated union: `in_progress` (202) is explicitly not an
 * answer, and `unavailable` (404) is a terminal run with no verified answer. Neither is
 * ever rendered as an answer body.
 */
export type RunAnswerResult =
  | { readonly kind: 'published'; readonly answer: PublishedAnswer }
  | { readonly kind: 'in_progress'; readonly state: RunState }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }

/** Runtime-validate a server-provided run state instead of trusting a type assertion. */
export const RUN_STATES: readonly RunState[] = [
  'created',
  'preflight',
  'collecting',
  'drafting',
  'verifying',
  'published',
  'awaiting_input',
  'cancelling',
  'cancelled',
  'blocked',
  'failed',
]

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value)
}

/** The known public SSE names (C6.1). No `unverified_answer.delta` exists on this surface. */
export const PUBLIC_SSE_EVENTS: readonly SseEventType[] = [
  'run.state',
  'plan.summary',
  'tool.started',
  'tool.completed',
  'evidence.available',
  'clarification.required',
  'answer.published',
  'run.failed',
]

export function isPublicSseEvent(value: string): value is SseEventType {
  return (PUBLIC_SSE_EVENTS as readonly string[]).includes(value)
}

export interface RunEvent {
  readonly id: string
  readonly event: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface RunEventHandlers {
  onEvent(event: RunEvent): void
  onError(error: unknown): void
  onOpen?(): void
}

export interface RunEventStream {
  close(): void
}

/**
 * Opens the run's SSE stream. It is injectable so the jsdom tests can push persisted and
 * adversarial frames without a browser EventSource; the default implementation uses the
 * real `EventSource` and the browser's own `Last-Event-ID` reconnect.
 */
export type RunEventStreamFactory = (
  url: string,
  lastEventId: string | undefined,
  handlers: RunEventHandlers,
) => RunEventStream

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRunEventData(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

interface SseMessage {
  readonly data: string
  readonly lastEventId: string
}

/** Narrow a DOM `Event` to the SSE message shape without trusting a type assertion. */
function sseMessageOf(event: Event): SseMessage | undefined {
  if (!('data' in event) || !('lastEventId' in event)) return undefined
  const data = event.data
  const lastEventId = event.lastEventId
  if (typeof data !== 'string' || typeof lastEventId !== 'string') return undefined
  return { data, lastEventId }
}

/** The default factory: a real EventSource that de-duplicates on the persisted event id. */
export function defaultRunEventStreamFactory(
  url: string,
  lastEventId: string | undefined,
  handlers: RunEventHandlers,
): RunEventStream {
  const EventSourceCtor = (globalThis as { EventSource?: typeof EventSource }).EventSource
  if (EventSourceCtor === undefined) {
    handlers.onError(new Error('EventSource is not available in this environment'))
    return { close: () => undefined }
  }
  const target = lastEventId === undefined ? url : `${url}?lastEventId=${encodeURIComponent(lastEventId)}`
  const source = new EventSourceCtor(target)
  const seen = new Set<string>()
  const dispatch = (type: string, message: SseMessage) => {
    const id = message.lastEventId
    if (id !== '' && seen.has(id)) return
    if (id !== '') seen.add(id)
    handlers.onEvent({ id, event: type, data: parseRunEventData(message.data) })
  }
  source.onopen = () => handlers.onOpen?.()
  source.onerror = (event) => handlers.onError(event)
  for (const name of PUBLIC_SSE_EVENTS) {
    source.addEventListener(name, (event) => {
      const message = sseMessageOf(event)
      if (message !== undefined) dispatch(name, message)
    })
  }
  return { close: () => source.close() }
}
