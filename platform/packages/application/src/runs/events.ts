import type { RunState, RuntimeEvent, SseEventType } from '@ontology/contracts'

/**
 * The run state machine (D7/SPEC §4.1) and the mapping from the fixed runtime event union
 * (C2) to the public SSE surface (C6.1).
 *
 * The mapping is deliberately narrow: `checkpoint_ready` has **no** public SSE event,
 * because a checkpoint is runtime-private (D7/SPEC §4.3). `collection_complete` maps to
 * `run.state` — never to `answer.published` — because it only means a draft may be
 * attempted, not that the answer passed verification. There is no mapping to
 * `unverified_answer.delta`; that name is not even a member of `SseEventType`.
 */

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'published',
  'cancelled',
  'failed',
])

/**
 * `cancelled` and `failed` are reachable from every non-terminal state: a runtime may report
 * either at any point, and the platform must accept the terminal transition rather than
 * silently ignore it. Nothing is reachable from a terminal state, which is what makes a
 * cancelled run impossible to revive.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['preflight', 'collecting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  preflight: ['collecting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  collecting: ['drafting', 'collecting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  drafting: ['verifying', 'collecting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  verifying: ['published', 'drafting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  published: [],
  awaiting_input: ['collecting', 'drafting', 'awaiting_input', 'cancelling', 'blocked', 'cancelled', 'failed'],
  cancelling: ['cancelled', 'failed'],
  cancelled: [],
  blocked: ['collecting', 'drafting', 'awaiting_input', 'cancelling', 'cancelled', 'failed'],
  failed: [],
}

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

export interface PublicEventDraft {
  readonly type: SseEventType
  readonly data: Readonly<Record<string, unknown>>
}

export interface RuntimeEventProjection {
  /** The run state after the event, or `undefined` when the event does not change state. */
  readonly nextState: RunState | undefined
  /** The public SSE event, or `undefined` for runtime-private events. */
  readonly publicEvent: PublicEventDraft | undefined
  /** Set when the event carries a clarification the run now waits on. */
  readonly pendingClarificationId: string | undefined
}

function planSummaryData(event: Extract<RuntimeEvent, { type: 'plan_proposed' }>): Record<string, unknown> {
  return { planRef: event.planRef, stepCount: event.stepCount, toolIds: event.toolIds }
}

/**
 * Project one runtime event. The returned data is a sanitised subset: it carries no full
 * tool result body, no secret and no unverified draft text.
 */
export function projectRuntimeEvent(event: RuntimeEvent): RuntimeEventProjection {
  switch (event.type) {
    case 'plan_proposed':
      return {
        nextState: 'collecting',
        publicEvent: { type: 'plan.summary', data: planSummaryData(event) },
        pendingClarificationId: undefined,
      }
    case 'step_started':
      return {
        nextState: 'collecting',
        publicEvent: {
          type: 'tool.started',
          data: { stepId: event.stepId, toolId: event.toolId, attempt: event.attempt },
        },
        pendingClarificationId: undefined,
      }
    case 'evidence_added':
      return {
        nextState: 'collecting',
        publicEvent: { type: 'evidence.available', data: { evidenceRefs: event.evidenceRefs } },
        pendingClarificationId: undefined,
      }
    case 'clarification_requested':
      return {
        nextState: 'awaiting_input',
        publicEvent: {
          type: 'clarification.required',
          data: {
            clarificationId: event.clarificationId,
            questionRef: event.questionRef,
            questionType: event.questionType,
          },
        },
        pendingClarificationId: event.clarificationId,
      }
    case 'collection_complete':
      return {
        nextState: 'drafting',
        // A draft may be attempted; this is explicitly not a published answer.
        publicEvent: {
          type: 'run.state',
          data: { draftAllowed: event.draftAllowed, evidenceCount: event.evidenceCount },
        },
        pendingClarificationId: undefined,
      }
    case 'checkpoint_ready':
      // Runtime-private: the public handle is exposed through the run record, never as a
      // business SSE event.
      return { nextState: undefined, publicEvent: undefined, pendingClarificationId: undefined }
    case 'cancelled':
      return {
        nextState: 'cancelled',
        publicEvent: {
          type: 'run.state',
          data: { reason: event.reason, abandonedAttempts: event.abandonedAttempts },
        },
        pendingClarificationId: undefined,
      }
    case 'failed':
      return {
        nextState: 'failed',
        publicEvent: { type: 'run.failed', data: { error: event.error } },
        pendingClarificationId: undefined,
      }
  }
}
