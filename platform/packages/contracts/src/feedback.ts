import type {
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * User/execution feedback (US-022, FR-30, SPEC D2/D7.4, INV-09).
 *
 * Feedback is **data only**: it is recorded append-only through the control store, it can be
 * read back by run or by answer, and it can never change a run's state, publish an answer,
 * widen a permission or touch a budget. If it is ever placed into a model context it must be
 * carried as an explicitly untrusted data item (`UntrustedFeedbackContextItem`), never as an
 * instruction or a capability.
 *
 * The types live in `contracts` so an adapter can implement `FeedbackStore` while depending on
 * `contracts` alone (SPEC §2: adapters → contracts). The application layer receives the port
 * by construction injection and never imports an adapter or a driver.
 */

export type FeedbackKind = 'answer_usefulness' | 'sql_correctness' | 'gap' | 'conflict'

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  'answer_usefulness',
  'sql_correctness',
  'gap',
  'conflict',
]

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return FEEDBACK_KINDS.some((kind) => kind === value)
}

/** The immutable content of one feedback entry. */
export interface NewFeedbackRecord {
  readonly feedbackId: Uuid
  readonly runId: Uuid
  /** The published answer the feedback is about, when it targets one. */
  readonly answerId?: Uuid
  readonly kind: FeedbackKind
  /** Optional 1..5 usefulness/correctness score; absent means unrated. */
  readonly rating?: number
  /** Free-text comment. It is opaque data, never parsed as an instruction. */
  readonly comment?: string
  readonly submittedBy: string
  /** The durable ledger sequence allocated by `ControlRepository.appendEvent`. */
  readonly sequence: RevisionString
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly occurredAt: Rfc3339UtcTimestamp
}

export interface FeedbackRecord extends NewFeedbackRecord {
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type FeedbackStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FEEDBACK_PERSIST_FAILED'

export class FeedbackStoreError extends Error {
  readonly code: FeedbackStoreErrorCode

  constructor(code: FeedbackStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FeedbackStoreError'
    this.code = code
  }
}

export interface FeedbackAppendResult {
  readonly feedback: FeedbackRecord
  readonly inserted: boolean
}

/**
 * Append-only persistence for feedback. There is deliberately no update or delete method:
 * history is never rewritten. `append` is idempotent per `(tenant, space, idempotency_key)`;
 * a replayed key with a different payload is a `FeedbackStoreError('IDEMPOTENCY_CONFLICT')`.
 */
export interface FeedbackStore {
  findByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<FeedbackRecord | undefined>
  append(
    scopeRef: ScopeRef,
    record: NewFeedbackRecord,
    ctx: ToolContext,
  ): Promise<FeedbackAppendResult>
  listByRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<FeedbackRecord[]>
  listByAnswer(
    scopeRef: ScopeRef,
    runId: Uuid,
    answerId: Uuid,
    ctx: ToolContext,
  ): Promise<FeedbackRecord[]>
}

/**
 * Feedback explicitly marked as untrusted data for a model context. The literal `trust` marker
 * is the contract: a consumer cannot mistake the comment for an instruction, and the shape
 * carries no tool catalogue, permission or budget field, so feedback cannot widen any of them.
 */
export interface UntrustedFeedbackContextItem {
  readonly trust: 'untrusted-data'
  readonly source: 'user-feedback'
  readonly feedbackId: Uuid
  readonly runId: Uuid
  readonly answerId?: Uuid
  readonly kind: FeedbackKind
  readonly rating?: number
  readonly comment?: string
  readonly occurredAt: Rfc3339UtcTimestamp
}
