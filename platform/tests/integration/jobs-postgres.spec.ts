import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { JobService, JobWorker, OutboxDispatcher } from '@ontology/application'
import type { JobPublicationRequest, JobStageAdvance, ScopeRef, ToolContext } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import {
  ManualClock,
  PUBLICATION_VERSION,
  RecordingOutboxConsumer,
  createBudgetHarness,
  newJobInput,
  pipelineHandlers,
} from '../unit/job-fixtures'
import type { BudgetHarness } from '../unit/job-fixtures'
import { MIGRATIONS_DIR, createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let store: PostgresJobStore

interface TestContext {
  readonly scopeRef: ScopeRef
  readonly editor: ToolContext
  readonly viewer: ToolContext
  readonly clock: ManualClock
  readonly service: JobService
  readonly budget: BudgetHarness
}

/** Fresh tenant/space, clock, service and budget per test, so the reclaimer never sees another test's jobs. */
async function newContext(prefix: string): Promise<TestContext> {
  const scope = await createJobScope(harness.adminClient, prefix)
  const clock = new ManualClock()
  const budget = createBudgetHarness()
  const service = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  return {
    scopeRef: scope.scopeRef,
    editor: toolContext(scope.tenantId, scope.spaceId, ['data-editor'], `${prefix}-editor`),
    viewer: toolContext(scope.tenantId, scope.spaceId, ['scoped-reader'], `${prefix}-viewer`),
    clock,
    service,
    budget,
  }
}

function workerFor(
  context: TestContext,
  jobStore: PostgresJobStore,
  handlers: ReturnType<typeof pipelineHandlers>,
  workerId = 'pg-worker',
): JobWorker {
  return new JobWorker({
    store: jobStore,
    handlers,
    budget: context.budget.budget,
    now: context.clock.now,
    newId: () => randomUUID(),
    workerId,
  })
}

/** Fails once, after the store method committed, to simulate a worker crash. */
class FaultInjectingJobStore extends PostgresJobStore {
  failNextPublish = false
  failNextAdvance = false

  override async publishJob(
    ...args: Parameters<PostgresJobStore['publishJob']>
  ): ReturnType<PostgresJobStore['publishJob']> {
    const result = await super.publishJob(...args)
    if (this.failNextPublish) {
      this.failNextPublish = false
      throw new Error('simulated crash after publication commit')
    }
    return result
  }

  override async advanceStage(
    ...args: Parameters<PostgresJobStore['advanceStage']>
  ): ReturnType<PostgresJobStore['advanceStage']> {
    const result = await super.advanceStage(...args)
    if (this.failNextAdvance) {
      this.failNextAdvance = false
      throw new Error('simulated crash after stage checkpoint')
    }
    return result
  }
}

async function countRows(table: string, jobId: string): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE job_id = $1`,
    [jobId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresJobStore(database)
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('migration 012', () => {
  it('enables RLS on every job table and keeps tenant/space in the primary keys', async () => {
    const unprotected = await harness.adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('jobs', 'job_attempts', 'job_stage_checkpoints', 'job_publications', 'job_outbox')
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await harness.adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.jobs', 'agent_platform.job_attempts', 'agent_platform.job_outbox'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.jobs')).toEqual(['tenant_id', 'space_id', 'job_id'])
    expect(byTable.get('agent_platform.job_attempts')).toEqual([
      'tenant_id',
      'space_id',
      'job_id',
      'attempt_id',
    ])
    expect(byTable.get('agent_platform.job_outbox')).toEqual(['tenant_id', 'space_id', 'outbox_id'])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: harness.adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('012_jobs_outbox.sql')
  })
})

describe('idempotency against a real database', () => {
  it('reuses the logical job for the same key and payload, and rejects a changed pipeline version', async () => {
    const context = await newContext('pg-idem')
    const key = `pg-idem-${randomUUID()}`
    const input = newJobInput({ idempotencyKey: key })
    const first = await context.service.createJob(input, context.editor)
    const second = await context.service.createJob({ ...input, jobId: randomUUID() }, context.editor)
    expect(second.jobId).toBe(first.jobId)

    await expect(
      context.service.createJob(
        {
          jobId: randomUUID(),
          kind: input.kind,
          sourceRef: input.sourceRef,
          ...(input.documentRef === undefined ? {} : { documentRef: input.documentRef }),
          pipelineVersion: '9.9.9',
          idempotencyKey: key,
        },
        context.editor,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 })
  })

  it('reuses the content-derived logical identity under a different key', async () => {
    const context = await newContext('pg-logical')
    const documentRef = `pg-doc-${randomUUID()}`
    const first = await context.service.createJob(
      newJobInput({ idempotencyKey: `pg-a-${randomUUID()}`, documentRef }),
      context.editor,
    )
    const second = await context.service.createJob(
      newJobInput({ idempotencyKey: `pg-b-${randomUUID()}`, documentRef }),
      context.editor,
    )
    expect(second.jobId).toBe(first.jobId)
  })

  it('hides a job from another tenant', async () => {
    const context = await newContext('pg-isolation')
    const other = await createJobScope(harness.adminClient, 'pg-other')
    const otherEditor = toolContext(other.tenantId, other.spaceId, ['data-editor'], 'other-editor')
    const created = await context.service.createJob(newJobInput(), context.editor)
    const leaked = await store.getJob(other.scopeRef, created.jobId, otherEditor)
    expect(leaked).toBeUndefined()
  })
})

describe('lease reclaim and exactly-once publication', () => {
  it('reclaims an attempt that crashed after publication and never publishes twice', async () => {
    const context = await newContext('pg-crash')
    const faultStore = new FaultInjectingJobStore(database)
    const input = newJobInput()
    await context.service.createJob(input, context.editor)

    const handlers = pipelineHandlers({ publish: true })
    faultStore.failNextPublish = true
    const crashingWorker = workerFor(context, faultStore, handlers, 'pg-crash-worker')
    await expect(crashingWorker.runOnce(context.scopeRef, context.editor)).rejects.toThrow(
      /simulated crash/,
    )

    const afterCrash = await store.getJob(context.scopeRef, input.jobId, context.editor)
    expect(afterCrash?.stage).toBe('published')
    expect(await countRows('job_publications', input.jobId)).toBe(1)
    expect(await countRows('job_outbox', input.jobId)).toBe(1)

    // Let the crashed attempt's lease expire, then reclaim.
    context.clock.advance(5 * 60_000)
    const recoveringWorker = workerFor(context, faultStore, handlers, 'pg-recover-worker')
    const result = await recoveringWorker.runOnce(context.scopeRef, context.editor)
    expect(result.disposition).toBe('stopped')
    expect(result.reclaimedAttemptId).toBeDefined()

    expect(await countRows('job_publications', input.jobId)).toBe(1)
    expect(await countRows('job_outbox', input.jobId)).toBe(1)

    const attempts = await store.listAttempts(context.scopeRef, input.jobId, context.editor)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['abandoned', 'succeeded'])

    // Re-publishing the same key is a no-op even when called directly.
    const publication: JobPublicationRequest = {
      publicationId: randomUUID(),
      publicationKey: `document-version:${input.jobId}`,
      versionRef: PUBLICATION_VERSION,
      publishedAt: context.clock.now(),
      outbox: {
        outboxId: randomUUID(),
        topic: 'semantic.publication.committed',
        payload: { jobId: input.jobId },
        idempotencyKey: `job-publication:${input.jobId}:document-version:${input.jobId}`,
        availableAt: context.clock.now(),
        createdAt: context.clock.now(),
      },
    }
    const again = await store.publishJob(context.scopeRef, input.jobId, publication, context.editor)
    expect(again.created).toBe(false)
    expect(await countRows('job_publications', input.jobId)).toBe(1)
  })

  it('resumes from the last committed checkpoint after a mid-stage crash', async () => {
    const context = await newContext('pg-midstage')
    const faultStore = new FaultInjectingJobStore(database)
    const input = newJobInput()
    await context.service.createJob(input, context.editor)

    faultStore.failNextAdvance = true
    const crashingWorker = workerFor(context, faultStore, pipelineHandlers(), 'pg-mid-crash')
    await expect(crashingWorker.runOnce(context.scopeRef, context.editor)).rejects.toThrow(
      /simulated crash/,
    )

    const afterCrash = await store.getJob(context.scopeRef, input.jobId, context.editor)
    expect(afterCrash?.stage).toBe('parsed')

    context.clock.advance(5 * 60_000)
    const recoveringWorker = workerFor(context, faultStore, pipelineHandlers(), 'pg-mid-recover')
    const result = await recoveringWorker.runOnce(context.scopeRef, context.editor)
    expect(result.disposition).toBe('stopped')
    const done = await store.getJob(context.scopeRef, input.jobId, context.editor)
    expect(done?.stage).toBe('awaiting_review')
    expect(await countRows('job_publications', input.jobId)).toBe(0)
  })

  it('never reclaims a job that is waiting on a human decision', async () => {
    const context = await newContext('pg-human')
    const input = newJobInput()
    await context.service.createJob(input, context.editor)
    await workerFor(context, store, pipelineHandlers(), 'pg-human').runOnce(context.scopeRef, context.editor)
    const waiting = await store.getJob(context.scopeRef, input.jobId, context.editor)
    expect(waiting?.stage).toBe('awaiting_review')

    context.clock.advance(60 * 60_000)
    const lease = await store.acquireLease(
      context.scopeRef,
      { workerId: 'pg-reclaimer', now: context.clock.now(), leaseDurationMs: 30_000 },
      context.editor,
    )
    expect(lease).toBeUndefined()
  })
})

describe('transactional outbox against a real database', () => {
  it('delivers a committed message and is idempotent on re-dispatch', async () => {
    const context = await newContext('pg-outbox')
    const input = newJobInput()
    await context.service.createJob(input, context.editor)
    const lease = await store.acquireLease(
      context.scopeRef,
      { workerId: 'pg-outbox', now: context.clock.now(), leaseDurationMs: 30_000 },
      context.editor,
    )
    if (lease === undefined) throw new Error('expected a lease')
    const advance: JobStageAdvance = {
      stage: 'parsed',
      counts: { total: 1, processed: 1, failed: 0, skipped: 0 },
      completedAt: context.clock.now(),
      outbox: {
        outboxId: randomUUID(),
        topic: 'job.stage.parsed',
        payload: { jobId: input.jobId },
        idempotencyKey: `job-stage:${input.jobId}:parsed`,
        availableAt: context.clock.now(),
        createdAt: context.clock.now(),
      },
    }
    await store.advanceStage(
      context.scopeRef,
      input.jobId,
      lease.attempt.attemptId,
      advance,
      context.editor,
    )

    // The state change and its outbox row committed together; dispatch happens later.
    const consumer = new RecordingOutboxConsumer()
    const dispatcher = new OutboxDispatcher({ store, consumer, now: context.clock.now })
    expect(await dispatcher.dispatchOnce(context.scopeRef, context.editor)).toBe(1)
    expect(consumer.seenKeys).toEqual([`job-stage:${input.jobId}:parsed`])

    // A duplicate delivery is harmless to the idempotent consumer.
    const pending = await store.listPendingOutbox(
      context.scopeRef,
      10,
      context.clock.now(),
      context.editor,
    )
    expect(pending).toEqual([])
    expect(await dispatcher.dispatchOnce(context.scopeRef, context.editor)).toBe(0)

    const marked = await harness.adminClient.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM agent_platform.job_outbox WHERE idempotency_key = $1`,
      [`job-stage:${input.jobId}:parsed`],
    )
    expect(marked.rows[0]?.state).toBe('dispatched')
    expect(marked.rows[0]?.attempts).toBe(1)
  })
})

describe('retry against a real database', () => {
  it('replays a retry idempotently after the job advanced, and refuses a fresh retry on a non-failed job', async () => {
    const context = await newContext('pg-retry')
    const input = newJobInput()
    await context.service.createJob(input, context.editor)
    await workerFor(
      context,
      store,
      pipelineHandlers({ failAt: 'extracted' }),
      'pg-retry-fail',
    ).runOnce(context.scopeRef, context.editor)
    const failed = await store.getJob(context.scopeRef, input.jobId, context.editor)
    if (failed === undefined) throw new Error('failed job missing')
    expect(failed.stage).toBe('failed')

    const retryKey = `pg-retry-${randomUUID()}`
    const firstRetry = await context.service.retryJob(
      {
        jobId: input.jobId,
        failedStage: 'extracted',
        idempotencyKey: retryKey,
        expectedRevision: failed.revision,
      },
      context.editor,
    )
    expect(firstRetry.attemptCount).toBe(2)

    await workerFor(context, store, pipelineHandlers(), 'pg-retry-resume').runOnce(
      context.scopeRef,
      context.editor,
    )
    const done = await store.getJob(context.scopeRef, input.jobId, context.editor)
    expect(done?.stage).toBe('awaiting_review')

    const replayed = await context.service.retryJob(
      {
        jobId: input.jobId,
        failedStage: 'extracted',
        idempotencyKey: retryKey,
        expectedRevision: failed.revision,
      },
      context.editor,
    )
    expect(replayed.attemptCount).toBe(2)
    expect(await store.listAttempts(context.scopeRef, input.jobId, context.editor)).toHaveLength(2)

    await expect(
      context.service.retryJob(
        {
          jobId: input.jobId,
          failedStage: 'extracted',
          idempotencyKey: `pg-retry-${randomUUID()}`,
          expectedRevision: done?.revision,
        },
        context.editor,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

describe('error counting and background budget separation', () => {
  it('counts processed items, records a classified error and does not touch the online run ledger', async () => {
    const context = await newContext('pg-error')
    const input = newJobInput()
    await context.service.createJob(input, context.editor)

    const runLedgerId = randomUUID()
    await context.budget.service.openLedger({ ledgerId: runLedgerId, kind: 'run' }, context.editor)
    const runBefore = await context.budget.service.remaining(runLedgerId, context.editor)

    await workerFor(
      context,
      store,
      pipelineHandlers({ failAt: 'extracted', useQuota: true }),
      'pg-error-worker',
    ).runOnce(context.scopeRef, context.editor)

    const view = await context.service.getJob(input.jobId, context.viewer)
    expect(view.stage).toBe('failed')
    expect(view.failedStage).toBe('extracted')
    expect(view.counts.total).toBe(2)
    expect(view.counts.processed).toBe(2)
    expect(view.lastError?.code).toBe('SOURCE_UNAVAILABLE')
    expect(view.attempts).toHaveLength(1)
    expect(view.attempts[0]?.error?.code).toBe('SOURCE_UNAVAILABLE')

    // Three stages reserved and settled against the job's own background ledger.
    const jobLedger = await context.budget.store.getLedger(context.scopeRef, input.jobId, context.editor)
    expect(jobLedger?.kind).toBe('background')
    expect(jobLedger?.consumed.modelTokens).toBe(30)
    const runAfter = await context.budget.service.remaining(runLedgerId, context.editor)
    expect(runAfter).toEqual(runBefore)
  })
})
