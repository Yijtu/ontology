import { AnswerStoreError, FeedbackStoreError, RunStoreError, isToolContext } from '@ontology/contracts'
import type {
  AnswerStorePort,
  ControlRepository,
  FeedbackRecord,
  FeedbackStore,
  PublishedAnswer,
  RunRecord,
  RunStore,
  ScopeRef,
  ToolContext,
  UntrustedFeedbackContextItem,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { FeedbackServiceError } from './errors'
import { feedbackToUntrustedContext } from './model-context'
import type { FeedbackView, RecordFeedbackInput } from './types'

export interface FeedbackServiceDependencies {
  /** Append-only feedback persistence. */
  readonly store: FeedbackStore
  /** Durable, monotonic, idempotent event ledger (C1/D2); feedback appends reuse it. */
  readonly control: ControlRepository
  /** Run records; used only to prove the run is visible in scope, never to change it. */
  readonly runs: RunStore
  /** Published answers; used only to validate an answer reference, never to publish. */
  readonly answers: AnswerStorePort
  readonly now?: () => string
}

const OPERATOR_ROLES: readonly string[] = ['operator', 'platform-admin']
const READER_ROLES: readonly string[] = ['scoped-reader', 'operator', 'platform-admin']
const MIN_RATING = 1
const MAX_RATING = 5
const MAX_COMMENT_LENGTH = 4000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new FeedbackServiceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new FeedbackServiceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertFeedbackWriter(run: RunRecord, ctx: ToolContext): void {
  if (run.ownerSubjectId === ctx.principal.subjectId) return
  if (OPERATOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new FeedbackServiceError('FORBIDDEN', 'only the run owner or an operator may submit feedback')
}

function assertFeedbackReader(run: RunRecord, ctx: ToolContext): void {
  if (run.ownerSubjectId === ctx.principal.subjectId) return
  if (READER_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new FeedbackServiceError('FORBIDDEN', 'only the run owner or a scoped reader may read feedback')
}

function mapRunError(error: unknown): never {
  if (error instanceof RunStoreError) {
    if (error.code === 'SCOPE_MISMATCH') {
      throw new FeedbackServiceError('SCOPE_MISMATCH', error.message, { cause: error })
    }
    throw new FeedbackServiceError('STORAGE_FAILURE', error.message, { cause: error })
  }
  throw error
}

function mapAnswerError(error: unknown): never {
  if (error instanceof AnswerStoreError) {
    if (error.code === 'SCOPE_MISMATCH') {
      throw new FeedbackServiceError('SCOPE_MISMATCH', error.message, { cause: error })
    }
    throw new FeedbackServiceError('STORAGE_FAILURE', error.message, { cause: error })
  }
  throw error
}

function mapFeedbackStoreError(error: unknown): never {
  if (error instanceof FeedbackStoreError) {
    if (error.code === 'SCOPE_MISMATCH') {
      throw new FeedbackServiceError('SCOPE_MISMATCH', error.message, { cause: error })
    }
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      throw new FeedbackServiceError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
    }
    throw new FeedbackServiceError('STORAGE_FAILURE', error.message, { cause: error })
  }
  throw error
}

function toView(record: FeedbackRecord): FeedbackView {
  return {
    feedbackId: record.feedbackId,
    runId: record.runId,
    ...(record.answerId === undefined ? {} : { answerId: record.answerId }),
    kind: record.kind,
    ...(record.rating === undefined ? {} : { rating: record.rating }),
    ...(record.comment === undefined ? {} : { comment: record.comment }),
    submittedBy: record.submittedBy,
    sequence: record.sequence,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
  }
}

/**
 * Feedback collection (US-022, FR-30; SPEC D2/D7.4, INV-09).
 *
 * It records user/execution feedback append-only and reads it back by run or by answer. It is
 * deliberately narrow: it reads the run and the published answer to prove they exist in scope,
 * but it never writes a run state, never publishes and never touches a budget, so feedback
 * cannot become a publication or privilege-escalation bypass (INV-09). The untrusted-data
 * projection (`feedbackToUntrustedContext`) is the only way feedback may enter a model context.
 */
export class FeedbackService {
  readonly #store: FeedbackStore
  readonly #control: ControlRepository
  readonly #runs: RunStore
  readonly #answers: AnswerStorePort
  readonly #now: () => string

  constructor(dependencies: FeedbackServiceDependencies) {
    this.#store = dependencies.store
    this.#control = dependencies.control
    this.#runs = dependencies.runs
    this.#answers = dependencies.answers
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async recordFeedback(input: RecordFeedbackInput, ctx: ToolContext): Promise<FeedbackView> {
    const scopeRef = scopeOf(ctx)
    this.#validate(input)

    const run = await this.#requireRun(scopeRef, input.runId, ctx)
    assertFeedbackWriter(run, ctx)

    if (input.answerId !== undefined) {
      await this.#requireAnswer(input.runId, input.answerId, ctx)
    }

    const requestDigest = sha256DigestOf(
      canonicalJson({
        runId: input.runId,
        answerId: input.answerId ?? null,
        kind: input.kind,
        rating: input.rating ?? null,
        comment: input.comment ?? null,
      }),
    )

    const existing = await this.#findExisting(scopeRef, input.idempotencyKey, ctx)
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw new FeedbackServiceError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different feedback payload',
        )
      }
      return toView(existing)
    }

    const occurredAt = this.#now()
    const feedbackId = input.feedbackId
    let sequence: string
    try {
      const appended = await this.#control.appendEvent(
        {
          scopeRef,
          streamRef: `feedback:${input.runId}`,
          payloadDigest: sha256DigestOf(
            canonicalJson({
              feedbackId,
              runId: input.runId,
              answerId: input.answerId ?? null,
              kind: input.kind,
              rating: input.rating ?? null,
              comment: input.comment ?? null,
            }),
          ),
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      )
      sequence = appended.recordedSeq
    } catch (error) {
      throw new FeedbackServiceError(
        'STORAGE_FAILURE',
        `could not append feedback ${feedbackId} to the control ledger`,
        { cause: error },
      )
    }

    let stored: FeedbackRecord
    try {
      const result = await this.#store.append(
        scopeRef,
        {
          feedbackId,
          runId: input.runId,
          ...(input.answerId === undefined ? {} : { answerId: input.answerId }),
          kind: input.kind,
          ...(input.rating === undefined ? {} : { rating: input.rating }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          submittedBy: ctx.principal.subjectId,
          sequence,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          occurredAt,
        },
        ctx,
      )
      stored = result.feedback
    } catch (error) {
      mapFeedbackStoreError(error)
    }
    return toView(stored)
  }

  async listByRun(runId: Uuid, ctx: ToolContext): Promise<FeedbackView[]> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    assertFeedbackReader(run, ctx)
    const records = await this.#list(() => this.#store.listByRun(scopeRef, runId, ctx))
    return records.map(toView)
  }

  async listByAnswer(runId: Uuid, answerId: Uuid, ctx: ToolContext): Promise<FeedbackView[]> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#requireRun(scopeRef, runId, ctx)
    assertFeedbackReader(run, ctx)
    const records = await this.#list(() => this.#store.listByAnswer(scopeRef, runId, answerId, ctx))
    return records.map(toView)
  }

  /**
   * The only sanctioned way feedback may enter a model context: every item is explicitly marked
   * untrusted data and carries no tool/permission/budget field.
   */
  toUntrustedModelContext(
    entries: readonly FeedbackView[],
  ): readonly UntrustedFeedbackContextItem[] {
    return feedbackToUntrustedContext(entries)
  }

  #validate(input: RecordFeedbackInput): void {
    if (!isNonEmptyString(input.feedbackId)) {
      throw new FeedbackServiceError('INVALID_ARGUMENT', 'feedbackId must be a non-empty uuid')
    }
    if (!isNonEmptyString(input.runId)) {
      throw new FeedbackServiceError('INVALID_ARGUMENT', 'runId must be a non-empty uuid')
    }
    if (
      !isNonEmptyString(input.idempotencyKey) ||
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 256
    ) {
      throw new FeedbackServiceError(
        'INVALID_ARGUMENT',
        'Idempotency-Key must be a string between 8 and 256 characters',
      )
    }
    if (
      input.rating !== undefined &&
      (!Number.isInteger(input.rating) || input.rating < MIN_RATING || input.rating > MAX_RATING)
    ) {
      throw new FeedbackServiceError(
        'INVALID_ARGUMENT',
        `rating must be an integer between ${MIN_RATING} and ${MAX_RATING}`,
      )
    }
    if (input.comment !== undefined) {
      if (!isNonEmptyString(input.comment) || input.comment.length > MAX_COMMENT_LENGTH) {
        throw new FeedbackServiceError(
          'INVALID_ARGUMENT',
          `comment must be a non-empty string of at most ${MAX_COMMENT_LENGTH} characters`,
        )
      }
    }
  }

  async #requireRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<RunRecord> {
    let run: RunRecord | undefined
    try {
      run = await this.#runs.getRun(scopeRef, runId, ctx)
    } catch (error) {
      mapRunError(error)
    }
    if (run === undefined) {
      throw new FeedbackServiceError('RUN_NOT_FOUND', `run ${runId} is not visible in this scope`)
    }
    return run
  }

  async #requireAnswer(runId: Uuid, answerId: Uuid, ctx: ToolContext): Promise<void> {
    let answer: PublishedAnswer | undefined
    try {
      answer = await this.#answers.findByRun(runId, ctx)
    } catch (error) {
      mapAnswerError(error)
    }
    if (answer === undefined || answer.answerId !== answerId) {
      throw new FeedbackServiceError(
        'ANSWER_NOT_FOUND',
        `answer ${answerId} is not the published answer of run ${runId}`,
      )
    }
  }

  async #findExisting(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<FeedbackRecord | undefined> {
    try {
      return await this.#store.findByIdempotencyKey(scopeRef, idempotencyKey, ctx)
    } catch (error) {
      mapFeedbackStoreError(error)
    }
  }

  async #list(load: () => Promise<FeedbackRecord[]>): Promise<FeedbackRecord[]> {
    try {
      return await load()
    } catch (error) {
      mapFeedbackStoreError(error)
    }
  }
}
