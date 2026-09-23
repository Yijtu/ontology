import type {
  FeedbackKind,
  Rfc3339UtcTimestamp,
  RevisionString,
  Uuid,
} from '@ontology/contracts'

/**
 * A request to record feedback. The feedback id is pre-allocated by the caller (the HTTP
 * composition root) so the request-scoped trusted context can name the resource, mirroring
 * `CreateRunInput`.
 */
export interface RecordFeedbackInput {
  readonly feedbackId: Uuid
  readonly runId: Uuid
  /** The published answer the feedback is about, when it targets one. */
  readonly answerId?: Uuid
  readonly kind: FeedbackKind
  readonly rating?: number
  readonly comment?: string
  readonly idempotencyKey: string
}

/**
 * The read-back projection of one feedback entry. It deliberately omits the idempotency key and
 * request digest (internal claim bookkeeping) and carries no capability, permission or budget
 * field, so a reader cannot mistake feedback for anything but data.
 */
export interface FeedbackView {
  readonly feedbackId: Uuid
  readonly runId: Uuid
  readonly answerId?: Uuid
  readonly kind: FeedbackKind
  readonly rating?: number
  readonly comment?: string
  readonly submittedBy: string
  readonly sequence: RevisionString
  readonly occurredAt: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
}
