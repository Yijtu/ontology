import type { BudgetRemaining, PublishedAnswer, RunState, SseEventType } from '@ontology/contracts'
import { isPublicSseEvent } from '../api/query'
import type { QueryRunView, RunAnswerResult, RunEvent, RunScopeView } from '../api/query'
import type { WorkbenchError } from './workbench'

/**
 * The business query reducer. It renders exactly one of the five explicit states at a time
 * (`loading`/`empty`/`not_configured`/`failure`/`permission_denied`, plus `ready`), and it
 * classifies every finished run into one of the five observable outcomes. Crucially, it only
 * accepts the eight public SSE names (C6.1): an event outside that set — for example a
 * hypothetical `unverified_answer.delta` carrying draft text — is recorded as rejected and
 * never becomes progress or an answer.
 */
export type QueryPhase =
  | 'loading'
  | 'empty'
  | 'not_configured'
  | 'failure'
  | 'permission_denied'
  | 'ready'

export type QueryOutcome =
  | 'pending'
  | 'normal'
  | 'limited'
  | 'gap'
  | 'conflict'
  | 'tool_failure'
  | 'cancelled'

export interface ClarificationView {
  readonly clarificationId: string
  readonly questionType: string
  readonly questionRef?: { readonly id: string; readonly version: string }
  readonly revision: string
}

export interface ProgressEntry {
  readonly id: string
  readonly event: SseEventType
  readonly label: string
  readonly detail?: string
  readonly occurredAt?: string
}

export interface QueryState {
  readonly phase: QueryPhase
  readonly scope: RunScopeView | undefined
  readonly run: QueryRunView | undefined
  readonly budget: BudgetRemaining | undefined
  readonly events: readonly ProgressEntry[]
  readonly lastEventId: string | undefined
  readonly clarification: ClarificationView | undefined
  readonly answer: PublishedAnswer | undefined
  readonly answerState: 'none' | 'in_progress' | 'published' | 'unavailable'
  readonly outcome: QueryOutcome
  readonly error: WorkbenchError | undefined
  readonly notice: string | undefined
  readonly busy: boolean
  readonly streamState: 'idle' | 'open' | 'closed' | 'error'
  /** Event names outside the public surface that were received and deliberately dropped. */
  readonly rejectedEvents: readonly string[]
}

export type QueryEvent =
  | { readonly type: 'scopeLoadStarted' }
  | { readonly type: 'scopeLoaded'; readonly scope: RunScopeView }
  | { readonly type: 'askStarted' }
  | { readonly type: 'runLoaded'; readonly run: QueryRunView }
  | { readonly type: 'runEvents'; readonly events: readonly RunEvent[] }
  | { readonly type: 'answerLoaded'; readonly result: RunAnswerResult }
  | { readonly type: 'cancelled'; readonly run: QueryRunView }
  | { readonly type: 'clarificationAnswered' }
  | { readonly type: 'streamState'; readonly state: QueryState['streamState'] }
  | { readonly type: 'busy' }
  | { readonly type: 'idle' }
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'permissionDenied'; readonly error: WorkbenchError }
  | { readonly type: 'notConfigured'; readonly error: WorkbenchError }
  | { readonly type: 'failed'; readonly error: WorkbenchError }
  | { readonly type: 'reset' }

export function initialQueryState(): QueryState {
  return {
    phase: 'loading',
    scope: undefined,
    run: undefined,
    budget: undefined,
    events: [],
    lastEventId: undefined,
    clarification: undefined,
    answer: undefined,
    answerState: 'none',
    outcome: 'pending',
    error: undefined,
    notice: undefined,
    busy: false,
    streamState: 'idle',
    rejectedEvents: [],
  }
}

const GAP_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_DATA',
  'DATA_STALE',
  'SNAPSHOT_UNAVAILABLE',
])
const CONFLICT_CODES: ReadonlySet<string> = new Set(['DATA_CONFLICT', 'VERIFICATION_FAILED'])

function outcomeForFailure(code: string | undefined): QueryOutcome {
  if (code !== undefined && GAP_CODES.has(code)) return 'gap'
  if (code !== undefined && CONFLICT_CODES.has(code)) return 'conflict'
  return 'tool_failure'
}

function progressEntry(
  event: SseEventType,
  label: string,
  data: Readonly<Record<string, unknown>>,
  detail?: string,
): ProgressEntry {
  const occurredAt = typeof data['occurredAt'] === 'string' ? data['occurredAt'] : undefined
  return {
    id: '',
    event,
    label,
    ...(detail === undefined ? {} : { detail }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  }
}

function eventLabel(event: SseEventType, data: Readonly<Record<string, unknown>>): ProgressEntry {
  switch (event) {
    case 'run.state':
      return progressEntry(
        event,
        `运行状态：${typeof data['state'] === 'string' ? data['state'] : '已更新'}`,
        data,
      )
    case 'plan.summary':
      return progressEntry(
        event,
        '已生成执行计划',
        data,
        Array.isArray(data['toolIds']) ? data['toolIds'].join(', ') : undefined,
      )
    case 'tool.started':
      return progressEntry(
        event,
        `开始调用工具 ${typeof data['toolId'] === 'string' ? data['toolId'] : ''}`.trim(),
        data,
      )
    case 'tool.completed':
      return progressEntry(
        event,
        `工具完成 ${typeof data['toolId'] === 'string' ? data['toolId'] : ''}`.trim(),
        data,
      )
    case 'evidence.available':
      return progressEntry(
        event,
        `已获得证据 ${Array.isArray(data['evidenceRefs']) ? data['evidenceRefs'].length : 0} 条`,
        data,
      )
    case 'clarification.required':
      return progressEntry(event, '需要澄清', data)
    case 'answer.published':
      return progressEntry(event, '已发布核验答案', data)
    case 'run.failed':
      return progressEntry(event, '运行失败', data, failureCode(data))
  }
}

function failureCode(data: Readonly<Record<string, unknown>>): string | undefined {
  const error = data['error']
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : undefined
}

function clarificationFrom(data: Readonly<Record<string, unknown>>, revision: string): ClarificationView | undefined {
  const clarificationId = data['clarificationId']
  if (typeof clarificationId !== 'string') return undefined
  const questionType = typeof data['questionType'] === 'string' ? data['questionType'] : 'clarification'
  const questionRef = data['questionRef']
  if (typeof questionRef === 'object' && questionRef !== null) {
    const record = questionRef as Record<string, unknown>
    const id = record['id']
    const version = record['version']
    if (typeof id === 'string' && typeof version === 'string') {
      return { clarificationId, questionType, questionRef: { id, version }, revision }
    }
  }
  return { clarificationId, questionType, revision }
}

function answerOutcome(data: Readonly<Record<string, unknown>>): QueryOutcome {
  const kind = data['publicationKind']
  const limitations = data['limitations']
  if (kind === 'history_limited') return 'limited'
  if (Array.isArray(limitations) && limitations.length > 0) return 'limited'
  return 'normal'
}

export function queryReducer(state: QueryState, event: QueryEvent): QueryState {
  switch (event.type) {
    case 'scopeLoadStarted':
      return { ...state, phase: 'loading', busy: true }
    case 'scopeLoaded':
      return { ...state, scope: event.scope, phase: 'empty', busy: false }
    case 'askStarted':
      return {
        ...state,
        busy: true,
        error: undefined,
        notice: undefined,
        outcome: 'pending',
        rejectedEvents: [],
      }
    case 'runLoaded': {
      const sameRun = state.run?.runId === event.run.runId
      return {
        ...state,
        phase: 'ready',
        run: event.run,
        busy: false,
        streamState: state.streamState === 'idle' ? 'open' : state.streamState,
        budget: event.run.budget ?? state.budget,
        scope: event.run.scope ?? state.scope,
        // A refresh must not clobber a terminal outcome already learned from the event
        // stream (for example a conflict code that the run state alone cannot express).
        outcome: sameRun && state.outcome !== 'pending' ? state.outcome : outcomeFromRun(event.run),
      }
    }
    case 'runEvents':
      return applyEvents(state, event.events)
    case 'answerLoaded':
      return applyAnswer(state, event.result)
    case 'cancelled':
      return {
        ...state,
        phase: 'ready',
        run: event.run,
        outcome: 'cancelled',
        busy: false,
        notice: '已取消运行；迟到的结果不会恢复运行或发布答案。',
      }
    case 'clarificationAnswered':
      return { ...state, clarification: undefined, busy: true, notice: '已提交澄清，沿用同一预算继续。' }
    case 'streamState':
      return { ...state, streamState: event.state }
    case 'busy':
      return { ...state, busy: true }
    case 'idle':
      return { ...state, busy: false }
    case 'notice':
      return { ...state, notice: event.message, busy: false }
    case 'permissionDenied':
      return { ...state, phase: 'permission_denied', error: event.error, busy: false }
    case 'notConfigured':
      return { ...state, phase: 'not_configured', error: event.error, busy: false }
    case 'failed':
      return { ...state, phase: 'failure', error: event.error, busy: false }
    case 'reset':
      return initialQueryState()
  }
}

function outcomeFromRun(run: QueryRunView): QueryOutcome {
  if (run.state === 'cancelled' || run.state === 'cancelling') return 'cancelled'
  if (run.state === 'blocked') return 'gap'
  if (run.state === 'failed') return 'tool_failure'
  if (run.state === 'published') return 'normal'
  return 'pending'
}

function applyEvents(state: QueryState, incoming: readonly RunEvent[]): QueryState {
  const rejected = [...state.rejectedEvents]
  const entries = [...state.events]
  const seen = new Set(entries.map((entry) => entry.id))
  let clarification = state.clarification
  let outcome = state.outcome
  let answerState = state.answerState
  let lastEventId = state.lastEventId

  for (const event of incoming) {
    if (event.id !== '' && seen.has(event.id)) continue
    if (!isPublicSseEvent(event.event)) {
      // Defence in depth: an event outside the public surface (a draft delta, an internal
      // framework event) is never progress and never an answer.
      if (!rejected.includes(event.event)) rejected.push(event.event)
      continue
    }
    if (event.id !== '') {
      seen.add(event.id)
      lastEventId = event.id
    }
    entries.push({ ...eventLabel(event.event, event.data), id: event.id })
    if (event.event === 'clarification.required') {
      clarification = clarificationFrom(event.data, state.run?.revision ?? '0')
    }
    if (event.event === 'run.state' && event.data['state'] === 'collecting') {
      clarification = undefined
    }
    if (event.event === 'answer.published') {
      outcome = answerOutcome(event.data)
      answerState = 'published'
    }
    if (event.event === 'run.failed') {
      outcome = outcomeForFailure(failureCode(event.data))
      answerState = 'unavailable'
    }
  }

  return {
    ...state,
    events: entries,
    lastEventId,
    clarification,
    answerState,
    outcome,
    rejectedEvents: rejected,
  }
}

function applyAnswer(state: QueryState, result: RunAnswerResult): QueryState {
  switch (result.kind) {
    case 'published':
      return {
        ...state,
        answer: result.answer,
        answerState: 'published',
        outcome:
          result.answer.publicationKind === 'history_limited' || result.answer.limitations.length > 0
            ? 'limited'
            : 'normal',
      }
    case 'in_progress':
      return { ...state, answerState: 'in_progress' }
    case 'unavailable':
      return {
        ...state,
        answerState: 'unavailable',
        outcome: state.outcome === 'pending' ? 'gap' : state.outcome,
      }
  }
}

/** True while the run is still advancing and the UI should keep the stream open. */
export function isRunActive(state: RunState): boolean {
  return state !== 'published' && state !== 'cancelled' && state !== 'failed'
}
