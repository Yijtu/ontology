import type { UntrustedFeedbackContextItem } from '@ontology/contracts'
import type { FeedbackView } from './types'

/**
 * Project feedback into a model context.
 *
 * Feedback is user/execution data, not an instruction. This projection therefore stamps every
 * item with the literal `trust: 'untrusted-data'` marker and only copies the data fields; it
 * never emits a tool id, a permission, an allowed resource or a budget, so feedback can never
 * change the tool catalogue, widen a permission or alter a budget. A consumer that renders the
 * comment into a prompt must keep the marker and must not act on the comment as a command.
 */
export function feedbackToUntrustedContext(
  entries: readonly FeedbackView[],
): readonly UntrustedFeedbackContextItem[] {
  return entries.map((entry) => ({
    trust: 'untrusted-data',
    source: 'user-feedback',
    feedbackId: entry.feedbackId,
    runId: entry.runId,
    ...(entry.answerId === undefined ? {} : { answerId: entry.answerId }),
    kind: entry.kind,
    ...(entry.rating === undefined ? {} : { rating: entry.rating }),
    ...(entry.comment === undefined ? {} : { comment: entry.comment }),
    occurredAt: entry.occurredAt,
  }))
}
