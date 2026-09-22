import type { CandidateReviewRecord, PublishedStatement, StatementRevisionRecord } from '@ontology/contracts'
import type {
  CandidateDetailView,
  CandidateSourceView,
  CandidateSummary,
  IdentityDecisionView,
} from '../api/review'
import type { WorkbenchPhase } from './workbench'

/**
 * The candidate-review surface reuses the same five explicit phases as the workbench, so an
 * operator sees one vocabulary: `loading`, `empty`, `not_configured`, `failure`,
 * `permission_denied` and `ready`. `conflict` is a separate field rather than a phase: a
 * stale revision (409) must not hide the data the operator was looking at.
 */
export type ReviewPhase = WorkbenchPhase

export interface ReviewError {
  readonly code: string
  readonly message: string
  readonly traceId?: string
  readonly reasons?: readonly string[]
}

export interface ReviewState {
  readonly phase: ReviewPhase
  readonly candidates: readonly CandidateSummary[]
  readonly selected?: CandidateDetailView | undefined
  readonly decisions: readonly IdentityDecisionView[]
  readonly reviews: readonly CandidateReviewRecord[]
  readonly source?: CandidateSourceView | undefined
  /** An explicit source state: absent means "not requested", the union says why it failed. */
  readonly sourceError?: ReviewError | undefined
  /** The published statement for the selected candidate, when one exists. */
  readonly statement?: PublishedStatement | undefined
  /** Every revision of that statement, oldest first, so the prior basis stays readable. */
  readonly revisions: readonly StatementRevisionRecord[]
  readonly statementError?: ReviewError | undefined
  readonly error?: ReviewError | undefined
  readonly conflict?: ReviewError | undefined
  readonly notice?: string | undefined
  readonly busy: boolean
}

export type ReviewEvent =
  | { readonly type: 'loadStarted' }
  | { readonly type: 'loaded'; readonly candidates: readonly CandidateSummary[] }
  | { readonly type: 'failed'; readonly error: ReviewError }
  | { readonly type: 'permissionDenied'; readonly error: ReviewError }
  | { readonly type: 'notConfigured'; readonly error: ReviewError }
  | { readonly type: 'busy' }
  | {
      readonly type: 'candidateLoaded'
      readonly candidate: CandidateDetailView
      readonly decisions: readonly IdentityDecisionView[]
      readonly reviews: readonly CandidateReviewRecord[]
    }
  | { readonly type: 'sourceLoaded'; readonly source: CandidateSourceView }
  | { readonly type: 'sourceFailed'; readonly error: ReviewError }
  | {
      readonly type: 'statementLoaded'
      readonly statement: PublishedStatement | undefined
      readonly revisions: readonly StatementRevisionRecord[]
    }
  | { readonly type: 'statementFailed'; readonly error: ReviewError }
  | {
      readonly type: 'decided'
      readonly candidate: CandidateDetailView
      readonly decisions: readonly IdentityDecisionView[]
    }
  | { readonly type: 'reviewed'; readonly reviews: readonly CandidateReviewRecord[] }
  | { readonly type: 'published'; readonly notice: string }
  | {
      readonly type: 'revised'
      readonly statement: PublishedStatement
      readonly revisions: readonly StatementRevisionRecord[]
      readonly notice: string
    }
  | { readonly type: 'conflict'; readonly error: ReviewError }
  | { readonly type: 'notice'; readonly message: string }

export function initialReviewState(): ReviewState {
  return { phase: 'loading', candidates: [], decisions: [], reviews: [], revisions: [], busy: false }
}

export function reviewReducer(state: ReviewState, event: ReviewEvent): ReviewState {
  switch (event.type) {
    case 'loadStarted':
      return { ...state, phase: 'loading', busy: true }
    case 'loaded':
      return {
        ...state,
        phase: event.candidates.length === 0 ? 'empty' : 'ready',
        candidates: event.candidates,
        busy: false,
      }
    case 'busy':
      return { ...state, busy: true }
    case 'permissionDenied':
      return { ...state, phase: 'permission_denied', error: event.error, busy: false }
    case 'notConfigured':
      return { ...state, phase: 'not_configured', error: event.error, busy: false }
    case 'failed':
      return { ...state, phase: 'failure', error: event.error, busy: false }
    case 'candidateLoaded':
      // Selecting a candidate clears any prior conflict/notice and the previous candidate's
      // source, so a stale excerpt can never appear next to a new candidate.
      return {
        ...state,
        phase: 'ready',
        selected: event.candidate,
        decisions: event.decisions,
        reviews: event.reviews,
        source: undefined,
        sourceError: undefined,
        statement: undefined,
        revisions: [],
        statementError: undefined,
        conflict: undefined,
        notice: undefined,
        error: undefined,
        busy: false,
      }
    case 'sourceLoaded':
      return { ...state, source: event.source, sourceError: undefined, busy: false }
    case 'sourceFailed':
      // A source failure does not replace the candidate: the reviewer still sees the
      // candidate and an explicit "the source could not be opened" state beside it.
      return { ...state, source: undefined, sourceError: event.error, busy: false }
    case 'statementLoaded':
      return {
        ...state,
        statement: event.statement,
        revisions: event.revisions,
        statementError: undefined,
        busy: false,
      }
    case 'statementFailed':
      return { ...state, statement: undefined, revisions: [], statementError: event.error, busy: false }
    case 'decided':
      return {
        ...state,
        selected: event.candidate,
        decisions: event.decisions,
        conflict: undefined,
        notice: `已记录裁决（修订 ${event.candidate.decisionRevision}）`,
        busy: false,
      }
    case 'reviewed':
      return { ...state, reviews: event.reviews, conflict: undefined, busy: false }
    case 'published':
      return { ...state, conflict: undefined, notice: event.notice, busy: false }
    case 'revised':
      return {
        ...state,
        statement: event.statement,
        revisions: event.revisions,
        conflict: undefined,
        notice: event.notice,
        busy: false,
      }
    case 'conflict':
      // A 409 is never silently applied: the prior read stands and the operator must refresh.
      return { ...state, conflict: event.error, busy: false }
    case 'notice':
      return { ...state, notice: event.message, busy: false }
  }
}

/** True when a candidate list update no longer contains the selected candidate. */
export function selectionStillPresent(
  candidates: readonly CandidateSummary[],
  selected: CandidateDetailView | undefined,
): boolean {
  if (selected === undefined) return true
  return candidates.some((candidate) => candidate.candidateId === selected.candidateId)
}
