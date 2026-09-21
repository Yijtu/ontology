import type {
  BudgetLedgerPort,
  JobErrorInfo,
  JobStageAdvance,
  JobStore,
  LogicalJobRecord,
  PipelineStage,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { isRunnableJobStage, isStopJobStage } from '@ontology/contracts'
import { JobStageFailure } from './errors'
import type {
  JobPublicationIntent,
  JobStageHandlerRegistry,
  JobWorkerResult,
} from './types'

export interface JobWorkerDependencies {
  readonly store: JobStore
  readonly handlers: JobStageHandlerRegistry
  /**
   * Shared budget ledger. The worker opens a `background` ledger per job, so an import job's
   * quota is a different ledger from every online run's (SPEC §9).
   */
  readonly budget: BudgetLedgerPort
  readonly workerId?: string
  readonly leaseDurationMs?: number
  readonly now?: () => string
  readonly newId?: () => string
}

const DEFAULT_LEASE_DURATION_MS = 60_000
const MAX_STAGE_ADVANCES_PER_ATTEMPT = 32

function safeErrorMessage(error: unknown): JobErrorInfo['message'] {
  if (error instanceof JobStageFailure) return error.message
  return 'the stage handler failed'
}

function classifyFailure(error: unknown, stage: PipelineStage, occurredAt: string): JobErrorInfo {
  if (error instanceof JobStageFailure) {
    return {
      code: error.code,
      stage,
      message: error.message,
      retryable: error.retryable,
      occurredAt,
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    stage,
    message: safeErrorMessage(error),
    retryable: false,
    occurredAt,
  }
}

/**
 * The background worker (D6). It claims one lease at a time, runs the stage handlers
 * checkpoint-by-checkpoint and stops at `awaiting_review`/`published`/terminal stages.
 *
 * A crashed worker leaves a `leased`/`running` attempt behind; after the lease expires
 * `acquireLease` abandons it and a new attempt resumes from the last committed stage
 * checkpoint. Stage checkpoints and publication are idempotent, so a resumed attempt cannot
 * double-apply a stage or publish twice. A job waiting on a human is never claimed.
 */
export class JobWorker {
  readonly #store: JobStore
  readonly #handlers: JobStageHandlerRegistry
  readonly #budget: BudgetLedgerPort
  readonly #workerId: string
  readonly #leaseDurationMs: number
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: JobWorkerDependencies) {
    this.#store = dependencies.store
    this.#handlers = dependencies.handlers
    this.#budget = dependencies.budget
    this.#workerId = dependencies.workerId ?? 'worker'
    this.#leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** Claim and process at most one unit of work. */
  async runOnce(scopeRef: ScopeRef, ctx: ToolContext): Promise<JobWorkerResult> {
    const lease = await this.#store.acquireLease(
      scopeRef,
      { workerId: this.#workerId, now: this.#now(), leaseDurationMs: this.#leaseDurationMs },
      ctx,
    )
    if (lease === undefined) return { disposition: 'idle' }

    let job = lease.job
    const attempt = lease.attempt
    // A background ledger is opened once per claimed job; `ensureLedger` is idempotent, so a
    // reclaimed attempt reuses the same ledger rather than resetting the budget.
    const ledger = await this.#budget.openLedger(
      { ledgerId: job.jobId, kind: 'background', runId: job.jobId },
      ctx,
    )
    const reclaimed =
      lease.reclaimedAttemptId === undefined
        ? {}
        : { reclaimedAttemptId: lease.reclaimedAttemptId }

    let advances = 0
    for (;;) {
      if (isStopJobStage(job.stage)) {
        await this.#complete(scopeRef, job, attempt.attemptId, ctx)
        return {
          disposition: 'stopped',
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          stage: job.stage,
          ...reclaimed,
        }
      }
      if (!isRunnableJobStage(job.stage)) {
        // Defensive: an unknown non-runnable stage is finalised rather than looped on.
        await this.#complete(scopeRef, job, attempt.attemptId, ctx)
        return {
          disposition: 'stopped',
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          stage: job.stage,
          ...reclaimed,
        }
      }

      const handler = this.#handlers.get(job.stage)
      if (handler === undefined) {
        const error: JobErrorInfo = {
          code: 'INTERNAL_ERROR',
          stage: job.stage,
          message: `no stage handler is registered for ${job.stage}`,
          retryable: false,
          occurredAt: this.#now(),
        }
        const failed = await this.#store.failAttempt(
          scopeRef,
          job.jobId,
          attempt.attemptId,
          { error, failedAt: error.occurredAt },
          ctx,
        )
        return {
          disposition: 'failed',
          jobId: failed.jobId,
          attemptId: attempt.attemptId,
          stage: error.stage,
          ...reclaimed,
        }
      }

      const controller = new AbortController()
      let outcome
      try {
        outcome = await handler.run({
          job,
          attempt,
          budget: this.#budget,
          ledgerId: ledger.ledgerId,
          ctx,
          signal: controller.signal,
        })
      } catch (error) {
        const info = classifyFailure(error, job.stage, this.#now())
        const failed = await this.#store.failAttempt(
          scopeRef,
          job.jobId,
          attempt.attemptId,
          { error: info, failedAt: info.occurredAt },
          ctx,
        )
        return {
          disposition: 'failed',
          jobId: failed.jobId,
          attemptId: attempt.attemptId,
          stage: info.stage,
          ...reclaimed,
        }
      }

      if (outcome.publication !== undefined) {
        await this.#publish(scopeRef, job, outcome.publication, ctx)
      }

      const advance: JobStageAdvance = {
        stage: outcome.nextStage,
        counts: outcome.counts,
        completedAt: this.#now(),
        ...(outcome.outbox === undefined ? {} : { outbox: outcome.outbox }),
      }
      const updated = await this.#store.advanceStage(
        scopeRef,
        job.jobId,
        attempt.attemptId,
        advance,
        ctx,
      )
      const progressed = updated.stage !== job.stage
      job = updated
      advances += 1

      if (isStopJobStage(job.stage)) {
        await this.#complete(scopeRef, job, attempt.attemptId, ctx)
        return {
          disposition: 'stopped',
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          stage: job.stage,
          ...reclaimed,
        }
      }
      if (!progressed) {
        // The handler made no progress: fail with NO_PROGRESS instead of leaving a runnable
        // job that the reclaimer would retry forever (SPEC §8: retries must be bounded).
        const info: JobErrorInfo = {
          code: 'NO_PROGRESS',
          stage: job.stage,
          message: 'the stage handler made no progress',
          retryable: false,
          occurredAt: this.#now(),
        }
        const failed = await this.#store.failAttempt(
          scopeRef,
          job.jobId,
          attempt.attemptId,
          { error: info, failedAt: info.occurredAt },
          ctx,
        )
        return {
          disposition: 'failed',
          jobId: failed.jobId,
          attemptId: attempt.attemptId,
          stage: info.stage,
          ...reclaimed,
        }
      }
      if (advances >= MAX_STAGE_ADVANCES_PER_ATTEMPT) {
        // The bound is per attempt; the committed checkpoints let a later attempt continue.
        await this.#complete(scopeRef, job, attempt.attemptId, ctx)
        return {
          disposition: 'advanced',
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          stage: job.stage,
          ...reclaimed,
        }
      }
    }
  }

  /** Drain the queue for one scope, up to `maxAttempts` claims. Returns the number processed. */
  async runUntilIdle(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    maxAttempts = 100,
  ): Promise<number> {
    let processed = 0
    for (let index = 0; index < maxAttempts; index += 1) {
      const result = await this.runOnce(scopeRef, ctx)
      if (result.disposition === 'idle') break
      processed += 1
    }
    return processed
  }

  async #publish(
    scopeRef: ScopeRef,
    job: LogicalJobRecord,
    intent: JobPublicationIntent,
    ctx: ToolContext,
  ): Promise<void> {
    const now = this.#now()
    await this.#store.publishJob(
      scopeRef,
      job.jobId,
      {
        publicationId: this.#newId(),
        publicationKey: intent.publicationKey,
        versionRef: intent.versionRef,
        publishedAt: now,
        outbox: {
          outboxId: this.#newId(),
          topic: intent.outboxTopic,
          payload: intent.outboxPayload,
          idempotencyKey: `job-publication:${job.jobId}:${intent.publicationKey}`,
          availableAt: now,
          createdAt: now,
        },
      },
      ctx,
    )
  }

  async #complete(
    scopeRef: ScopeRef,
    job: LogicalJobRecord,
    attemptId: Uuid,
    ctx: ToolContext,
  ): Promise<LogicalJobRecord> {
    return this.#store.completeAttempt(
      scopeRef,
      job.jobId,
      attemptId,
      { finalStage: job.stage, completedAt: this.#now() },
      ctx,
    )
  }
}
