import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryJobStore, JobService, JobStageFailure, JobWorker, OutboxDispatcher } from '@ontology/application'
import { canAdvanceJobStage, isRunnableJobStage } from '@ontology/contracts'
import type { JobView } from '@ontology/application'
import type { LogicalJobRecord } from '@ontology/contracts'
import {
  EDITOR_A,
  EDITOR_B,
  ManualClock,
  PUBLICATION_VERSION,
  RecordingOutboxConsumer,
  SCOPE_A,
  STRANGER_A,
  VIEWER_A,
  createBudgetHarness,
  newJobInput,
  pipelineHandlers,
} from './job-fixtures'

function harness() {
  const store = new InMemoryJobStore()
  const budget = createBudgetHarness()
  const clock = new ManualClock()
  const service = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  return { store, budget, clock, service }
}

function workerFor(
  store: InMemoryJobStore,
  budget: ReturnType<typeof createBudgetHarness>,
  clock: ManualClock,
  handlers: ReturnType<typeof pipelineHandlers>,
) {
  return new JobWorker({ store, handlers, budget: budget.budget, now: clock.now, newId: () => randomUUID(), workerId: 'w1' })
}

async function runToStop(
  store: InMemoryJobStore,
  budget: ReturnType<typeof createBudgetHarness>,
  clock: ManualClock,
  handlers: ReturnType<typeof pipelineHandlers>,
  jobId: string,
) {
  const worker = workerFor(store, budget, clock, handlers)
  const result = await worker.runOnce(SCOPE_A, EDITOR_A)
  expect(result.jobId).toBe(jobId)
  return result
}

describe('logical job and attempt separation', () => {
  it('runs one attempt through the pipeline to awaiting_review without a second attempt', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    const created = await service.createJob(input, EDITOR_A)
    expect(created.stage).toBe('received')

    const result = await runToStop(store, budget, clock, pipelineHandlers(), input.jobId)
    expect(result.disposition).toBe('stopped')
    expect(result.stage).toBe('awaiting_review')

    const attempts = await store.listAttempts(SCOPE_A, input.jobId, EDITOR_A)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.state).toBe('succeeded')
    const job = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(job?.stage).toBe('awaiting_review')
    expect(job?.attemptCount).toBe(1)
  })

  it('can target one newly created operator job without leasing another queued job', async () => {
    const { store, budget, clock, service } = harness()
    const unrelated = newJobInput({ idempotencyKey: 'unrelated-queued-job-001' })
    const target = newJobInput({ idempotencyKey: 'target-operator-job-001' })
    await service.createJob(unrelated, EDITOR_A)
    await service.createJob(target, EDITOR_A)

    const result = await workerFor(store, budget, clock, pipelineHandlers()).runJob(target.jobId, SCOPE_A, EDITOR_A)
    expect(result.jobId).toBe(target.jobId)
    expect(result.stage).toBe('awaiting_review')
    expect((await store.getJob(SCOPE_A, target.jobId, EDITOR_A))?.stage).toBe('awaiting_review')
    expect((await store.getJob(SCOPE_A, unrelated.jobId, EDITOR_A))?.stage).toBe('received')
  })

  it('retry creates a new attempt of the same logical job and never a new logical job', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers({ failAt: 'extracted' }), input.jobId)

    const failed = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(failed?.stage).toBe('failed')
    expect(failed?.failedStage).toBe('extracted')
    expect(failed?.lastError?.code).toBe('SOURCE_UNAVAILABLE')

    const view = await service.retryJob(
      {
        jobId: input.jobId,
        failedStage: 'extracted',
        idempotencyKey: `retry-${randomUUID()}`,
        expectedRevision: failed?.revision,
      },
      EDITOR_A,
    )
    expect(view.jobId).toBe(input.jobId)
    expect(view.attemptCount).toBe(2)
    expect(view.stage).toBe('extracted')

    // Replaying the same retry key must not create a third attempt.
    const attemptsAfterRetry = await store.listAttempts(SCOPE_A, input.jobId, EDITOR_A)
    expect(attemptsAfterRetry).toHaveLength(2)
    expect(attemptsAfterRetry[1]?.state).toBe('pending')

    await runToStop(store, budget, clock, pipelineHandlers(), input.jobId)
    const done = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(done?.stage).toBe('awaiting_review')
    expect(done?.attemptCount).toBe(2)
  })
})

describe('idempotency key covers input and pipeline version', () => {
  it('reuses the same logical job for the same key and payload', async () => {
    const { service } = harness()
    const input = newJobInput({ idempotencyKey: 'stable-key-0001' })
    const first = await service.createJob(input, EDITOR_A)
    const second = await service.createJob({ ...input, jobId: randomUUID() }, EDITOR_A)
    expect(second.jobId).toBe(first.jobId)
    expect(second.reused).toBe(true)
  })

  it('rejects the same key with a different document payload', async () => {
    const { service } = harness()
    await service.createJob(newJobInput({ idempotencyKey: 'stable-key-0002' }), EDITOR_A)
    await expect(
      service.createJob(
        newJobInput({ idempotencyKey: 'stable-key-0002', documentRef: 'document-2' }),
        EDITOR_A,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 })
  })

  it('rejects the same key with a different pipeline version', async () => {
    const { service } = harness()
    await service.createJob(newJobInput({ idempotencyKey: 'stable-key-0003' }), EDITOR_A)
    await expect(
      service.createJob(
        newJobInput({ idempotencyKey: 'stable-key-0003', pipelineVersion: '2.0.0' }),
        EDITOR_A,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 })
  })

  it('reuses the content-derived logical identity across different keys', async () => {
    const { service } = harness()
    const first = await service.createJob(
      newJobInput({ idempotencyKey: 'logical-key-0001', documentRef: 'shared-doc' }),
      EDITOR_A,
    )
    const second = await service.createJob(
      newJobInput({ idempotencyKey: 'logical-key-0002', documentRef: 'shared-doc' }),
      EDITOR_A,
    )
    expect(second.jobId).toBe(first.jobId)
    expect(second.reused).toBe(true)
  })

  it('creates a new logical job when the pipeline version changes', async () => {
    const { service } = harness()
    const first = await service.createJob(
      newJobInput({ idempotencyKey: 'pipeline-key-0001', documentRef: 'pipeline-doc' }),
      EDITOR_A,
    )
    const second = await service.createJob(
      newJobInput({
        idempotencyKey: 'pipeline-key-0002',
        documentRef: 'pipeline-doc',
        pipelineVersion: '2.0.0',
      }),
      EDITOR_A,
    )
    expect(second.jobId).not.toBe(first.jobId)
  })
})

describe('stage state machine', () => {
  it('advances only along the documented pipeline and to terminal failure', () => {
    expect(canAdvanceJobStage('received', 'parsed')).toBe(true)
    expect(canAdvanceJobStage('validated', 'awaiting_review')).toBe(true)
    expect(canAdvanceJobStage('awaiting_review', 'published')).toBe(true)
    expect(canAdvanceJobStage('received', 'published')).toBe(false)
    expect(canAdvanceJobStage('published', 'received')).toBe(false)
    expect(canAdvanceJobStage('awaiting_review', 'parsed')).toBe(false)
    expect(canAdvanceJobStage('extracted', 'failed')).toBe(true)
    expect(canAdvanceJobStage('received', 'received')).toBe(true)
  })

  it('classifies the runnable stages', () => {
    expect(isRunnableJobStage('received')).toBe(true)
    expect(isRunnableJobStage('validated')).toBe(true)
    expect(isRunnableJobStage('awaiting_review')).toBe(false)
    expect(isRunnableJobStage('published')).toBe(false)
  })
})

describe('lease acquisition, expiry and reclaim', () => {
  it('abandons an expired attempt and reclaims the job with a new attempt', async () => {
    const { store, service, clock } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)

    const first = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w1', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    expect(first?.attempt.attemptNumber).toBe(1)
    expect(first?.reclaimedAttemptId).toBeUndefined()

    // The worker crashes without completing; the lease expires.
    clock.advance(31_000)
    const second = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w2', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    expect(second?.attempt.attemptNumber).toBe(2)
    expect(second?.reclaimedAttemptId).toBe(first?.attempt.attemptId)

    const attempts = await store.listAttempts(SCOPE_A, input.jobId, EDITOR_A)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['abandoned', 'leased'])
    const job = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(job?.abandonedAttemptCount).toBe(1)
  })

  it('never re-runs a job that is waiting on a human decision', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers(), input.jobId)

    clock.advance(10 * 60_000)
    const lease = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w2', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    expect(lease).toBeUndefined()
    const attempts = await store.listAttempts(SCOPE_A, input.jobId, EDITOR_A)
    expect(attempts).toHaveLength(1)
  })

  it('does not auto-retry a failed job without an explicit retry', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers({ failAt: 'parsed' }), input.jobId)

    clock.advance(60 * 60_000)
    const lease = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w2', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    expect(lease).toBeUndefined()
  })
})

describe('transactional outbox', () => {
  it('delivers a message committed before dispatch and treats a duplicate as harmless', async () => {
    const { store, service, clock } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    const lease = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w1', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    if (lease === undefined) throw new Error('expected a lease')
    await store.advanceStage(
      SCOPE_A,
      input.jobId,
      lease.attempt.attemptId,
      {
        stage: 'parsed',
        counts: { total: 1, processed: 1, failed: 0, skipped: 0 },
        completedAt: clock.now(),
        outbox: {
          outboxId: randomUUID(),
          topic: 'job.stage.parsed',
          payload: { jobId: input.jobId },
          idempotencyKey: `job-stage:${input.jobId}:parsed`,
          availableAt: clock.now(),
          createdAt: clock.now(),
        },
      },
      EDITOR_A,
    )

    const consumer = new RecordingOutboxConsumer()
    const dispatcher = new OutboxDispatcher({ store, consumer, now: clock.now })
    // Crash between commit and dispatch: the message is still pending and is delivered later.
    expect(await dispatcher.dispatchOnce(SCOPE_A, EDITOR_A)).toBe(1)
    expect(consumer.seenKeys).toEqual([`job-stage:${input.jobId}:parsed`])

    // A duplicate delivery of the same key is harmless to an idempotent consumer.
    const message = {
      outboxId: randomUUID(),
      jobId: input.jobId,
      topic: 'job.stage.parsed',
      payload: { jobId: input.jobId },
      idempotencyKey: `job-stage:${input.jobId}:parsed`,
      state: 'pending' as const,
      attempts: 0,
      availableAt: clock.now(),
      createdAt: clock.now(),
    }
    await consumer.consume(message)
    expect(consumer.seenKeys).toEqual([`job-stage:${input.jobId}:parsed`])
    expect(await dispatcher.dispatchOnce(SCOPE_A, EDITOR_A)).toBe(0)
  })
})

describe('error counting and query view', () => {
  it('counts processed items and exposes a classified, payload-free error', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers({ failAt: 'extracted' }), input.jobId)

    const view = await service.getJob(input.jobId, VIEWER_A)
    expect(view.stage).toBe('failed')
    expect(view.failedStage).toBe('extracted')
    expect(view.counts.total).toBe(2)
    expect(view.counts.processed).toBe(2)
    expect(view.lastError?.code).toBe('SOURCE_UNAVAILABLE')
    expect(view.lastError?.stage).toBe('extracted')
    // The view carries refs and classified errors, never a document payload.
    expect(JSON.stringify(view)).not.toContain('payload')
    expect(view.attempts).toHaveLength(1)
    expect(view.attempts[0]?.error?.code).toBe('SOURCE_UNAVAILABLE')
  })
})

describe('background and online budget separation', () => {
  it('consumes the background ledger and leaves the online run ledger untouched', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)

    // An online run opens its own `run` ledger in the same shared budget service.
    const runLedgerId = randomUUID()
    await budget.service.openLedger({ ledgerId: runLedgerId, kind: 'run' }, EDITOR_A)
    const runBefore = await budget.service.remaining(runLedgerId, EDITOR_A)

    await runToStop(store, budget, clock, pipelineHandlers({ useQuota: true }), input.jobId)

    // The job opened a distinct `background` ledger and consumed only from it.
    const jobLedger = await budget.store.getLedger(SCOPE_A, input.jobId, EDITOR_A)
    expect(jobLedger?.kind).toBe('background')
    expect(jobLedger?.consumed.modelTokens).toBe(40)
    const runAfter = await budget.service.remaining(runLedgerId, EDITOR_A)
    expect(runAfter).toEqual(runBefore)
  })
})

describe('permissions and tenant isolation', () => {
  it('refuses job creation without the data-editor role', async () => {
    const { service } = harness()
    await expect(service.createJob(newJobInput(), VIEWER_A)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    })
  })

  it('hides a job from another tenant and from an unrelated subject', async () => {
    const { service } = harness()
    const created = await service.createJob(newJobInput(), EDITOR_A)
    await expect(service.getJob(created.jobId, EDITOR_B)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    await expect(service.getJob(created.jobId, STRANGER_A)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('publication exactly-once', () => {
  it('publishes once and re-publishing the same key inserts nothing', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers({ publish: true }), input.jobId)

    const job: LogicalJobRecord | undefined = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(job?.stage).toBe('published')
    expect(job?.publication?.versionRef.digest).toBe(PUBLICATION_VERSION.digest)

    const lease = await store.acquireLease(
      SCOPE_A,
      { workerId: 'w2', now: clock.now(), leaseDurationMs: 30_000 },
      EDITOR_A,
    )
    expect(lease).toBeUndefined()

    const again = await store.publishJob(
      SCOPE_A,
      input.jobId,
      {
        publicationId: randomUUID(),
        publicationKey: `document-version:${input.jobId}`,
        versionRef: PUBLICATION_VERSION,
        publishedAt: clock.now(),
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.publication.committed',
          payload: { jobId: input.jobId },
          idempotencyKey: `job-publication:${input.jobId}:document-version:${input.jobId}`,
          availableAt: clock.now(),
          createdAt: clock.now(),
        },
      },
      EDITOR_A,
    )
    expect(again.created).toBe(false)

    const outbox = await store.listPendingOutbox(SCOPE_A, 10, clock.now(), EDITOR_A)
    expect(outbox).toHaveLength(1)
  })

  it('rejects a different version digest under the same publication key', async () => {
    const { store, service, clock } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    const publicationKey = `document-version:${input.jobId}`
    await store.publishJob(
      SCOPE_A,
      input.jobId,
      {
        publicationId: randomUUID(),
        publicationKey,
        versionRef: PUBLICATION_VERSION,
        publishedAt: clock.now(),
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.publication.committed',
          payload: {},
          idempotencyKey: `pub-a:${input.jobId}`,
          availableAt: clock.now(),
          createdAt: clock.now(),
        },
      },
      EDITOR_A,
    )
    await expect(
      store.publishJob(
        SCOPE_A,
        input.jobId,
        {
          publicationId: randomUUID(),
          publicationKey,
          versionRef: { ...PUBLICATION_VERSION, digest: `sha256:${'b'.repeat(64)}` },
          publishedAt: clock.now(),
          outbox: {
            outboxId: randomUUID(),
            topic: 'semantic.publication.committed',
            payload: {},
            idempotencyKey: `pub-b:${input.jobId}`,
            availableAt: clock.now(),
            createdAt: clock.now(),
          },
        },
        EDITOR_A,
      ),
    ).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT' })
  })
})

describe('retry idempotency and bounded progress', () => {
  it('replays a retry idempotently even after the job advanced past the failed stage', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    await runToStop(store, budget, clock, pipelineHandlers({ failAt: 'extracted' }), input.jobId)
    const failed = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    if (failed === undefined) throw new Error('failed job missing')
    const retryKey = `retry-${randomUUID()}`

    await service.retryJob(
      { jobId: input.jobId, failedStage: 'extracted', idempotencyKey: retryKey, expectedRevision: failed.revision },
      EDITOR_A,
    )
    await runToStop(store, budget, clock, pipelineHandlers(), input.jobId)
    const done = await store.getJob(SCOPE_A, input.jobId, EDITOR_A)
    expect(done?.stage).toBe('awaiting_review')
    expect(done?.attemptCount).toBe(2)

    // Replaying the retry with its original If-Match must not create a third attempt.
    const replayed = await service.retryJob(
      { jobId: input.jobId, failedStage: 'extracted', idempotencyKey: retryKey, expectedRevision: failed.revision },
      EDITOR_A,
    )
    expect(replayed.attemptCount).toBe(2)
    expect(await store.listAttempts(SCOPE_A, input.jobId, EDITOR_A)).toHaveLength(2)
  })

  it('fails a handler that makes no progress instead of retrying it forever', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    const registry = {
      get: (stage: string) =>
        stage === 'received'
          ? {
              stage: 'received' as const,
              run: async () => ({
                nextStage: 'received' as const,
                counts: { total: 0, processed: 0, failed: 0, skipped: 0 },
              }),
            }
          : undefined,
    }
    const worker = new JobWorker({ store, handlers: registry, budget: budget.budget, now: clock.now, newId: () => randomUUID() })
    const result = await worker.runOnce(SCOPE_A, EDITOR_A)
    expect(result.disposition).toBe('failed')
    const view = await service.getJob(input.jobId, VIEWER_A)
    expect(view.stage).toBe('failed')
    expect(view.lastError?.code).toBe('NO_PROGRESS')

    clock.advance(60 * 60_000)
    expect(await store.acquireLease(SCOPE_A, { workerId: 'w2', now: clock.now(), leaseDurationMs: 1000 }, EDITOR_A)).toBeUndefined()
  })

  it('accepts a dataset-only ingestion input', async () => {
    const { service } = harness()
    const created = await service.createJob(
      {
        jobId: randomUUID(),
        kind: 'ingestion',
        sourceRef: 'source-ds',
        datasetRef: 'dataset-1',
        pipelineVersion: '1.0.0',
        idempotencyKey: `dataset-${randomUUID()}`,
      },
      EDITOR_A,
    )
    const view = await service.getJob(created.jobId, EDITOR_A)
    expect(view.datasetRef).toBe('dataset-1')
    expect(view.documentRef).toBeUndefined()
  })
})

describe('stage failure classification', () => {
  it('classifies an unexpected handler error without leaking its message', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    const registry = {
      get: (stage: string) =>
        stage === 'received'
          ? {
              stage: 'received' as const,
              run: async () => {
                throw new Error('secret connection string postgres://user:pass@host/db')
              },
            }
          : undefined,
    }
    const worker = new JobWorker({ store, handlers: registry, budget: budget.budget, now: clock.now, newId: () => randomUUID() })
    await worker.runOnce(SCOPE_A, EDITOR_A)
    const view: JobView = await service.getJob(input.jobId, VIEWER_A)
    expect(view.stage).toBe('failed')
    expect(view.lastError?.code).toBe('INTERNAL_ERROR')
    expect(view.lastError?.message).not.toContain('postgres://')
    expect(JSON.stringify(view)).not.toContain('postgres://')
  })

  it('exposes a classified stage failure unchanged', async () => {
    const { store, budget, clock, service } = harness()
    const input = newJobInput()
    await service.createJob(input, EDITOR_A)
    const registry = {
      get: (stage: string) =>
        stage === 'received'
          ? {
              stage: 'received' as const,
              run: async () => {
                throw new JobStageFailure('DATA_STALE', 'the source snapshot is stale', false)
              },
            }
          : undefined,
    }
    const worker = new JobWorker({ store, handlers: registry, budget: budget.budget, now: clock.now, newId: () => randomUUID() })
    await worker.runOnce(SCOPE_A, EDITOR_A)
    const view = await service.getJob(input.jobId, VIEWER_A)
    expect(view.lastError?.code).toBe('DATA_STALE')
    expect(view.lastError?.message).toBe('the source snapshot is stale')
  })
})
