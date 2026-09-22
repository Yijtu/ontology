import { DocumentParseStageHandler, JobWorker, OutboxDispatcher } from '@ontology/application'
import type { JobStageHandler, JobStageHandlerRegistry, OutboxConsumer } from '@ontology/application'
import { ControlPostgresDatabase, PostgresJobStore } from '@ontology/adapter-control-postgres'
import type {
  BudgetLedgerPort,
  DocumentParserPort,
  JobStore,
  PipelineStage,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'

export interface JobWorkerCompositionOptions {
  readonly connectionString: string
  /** Parse/extract/review handlers are owned by later nodes; they arrive by injection. */
  readonly handlers: JobStageHandlerRegistry
  /** Shared budget ledger; the worker opens a `background` ledger per job (SPEC §9). */
  readonly budget: BudgetLedgerPort
  readonly outboxConsumer: OutboxConsumer
  readonly workerId?: string
  readonly leaseDurationMs?: number
  readonly maxPoolSize?: number
  readonly now?: () => string
  readonly newId?: () => string
}

export interface JobWorkerComposition {
  readonly database: ControlPostgresDatabase
  readonly store: JobStore
  readonly worker: JobWorker
  readonly dispatcher: OutboxDispatcher
  close(): Promise<void>
}

/**
 * Explicit wiring for the background worker process. The composition root owns the pool; the
 * application worker never imports the driver. The outbox consumer is injected and must be
 * idempotent, because dispatch is at-least-once.
 */
export function createPostgresJobWorker(
  options: JobWorkerCompositionOptions,
): JobWorkerComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store: JobStore = new PostgresJobStore(database)
  const worker = new JobWorker({
    store,
    handlers: options.handlers,
    budget: options.budget,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  const dispatcher = new OutboxDispatcher({
    store,
    consumer: options.outboxConsumer,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return {
    database,
    store,
    worker,
    dispatcher,
    close: () => database.close(),
  }
}

export interface IngestionHandlerRegistryOptions {
  /** The real document parser (LOCAL-023) that backs the `received → parsed` stage. */
  readonly parser: DocumentParserPort
  /** The `parsed → extracted → validated` handlers owned by the extraction pipeline. */
  readonly downstream: readonly JobStageHandler[]
}

/**
 * Wire the real `received → parsed` stage (the document parser) together with the downstream
 * extraction stages into one worker registry, so a `POST /ingestions` job runs end to end
 * inside the worker. The composition root supplies the concrete parser; the handler itself
 * depends only on the `DocumentParserPort` contract.
 */
export function createIngestionHandlerRegistry(
  options: IngestionHandlerRegistryOptions,
): JobStageHandlerRegistry {
  const byStage = new Map<PipelineStage, JobStageHandler>()
  byStage.set('received', new DocumentParseStageHandler({ parser: options.parser }))
  for (const handler of options.downstream) byStage.set(handler.stage, handler)
  return { get: (stage) => byStage.get(stage) }
}

/** One unit of work: the trusted tenant/space scope plus its server-minted tool context. */
export interface WorkerScope {
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
}

export interface WorkerLoopOptions {
  readonly worker: JobWorker
  readonly dispatcher: OutboxDispatcher
  readonly scopes: () => Promise<readonly WorkerScope[]>
  readonly intervalMs?: number
  readonly maxIterations?: number
  readonly onError?: (error: unknown) => void
}

/**
 * Minimal polling loop for the worker process. It processes jobs first and then drains the
 * outbox for each scope. `tick` is exposed so tests drive one iteration deterministically
 * instead of waiting on a timer.
 */
export class JobWorkerLoop {
  readonly #worker: JobWorker
  readonly #dispatcher: OutboxDispatcher
  readonly #scopes: () => Promise<readonly WorkerScope[]>
  readonly #intervalMs: number
  readonly #maxIterations: number
  readonly #onError: (error: unknown) => void
  #stopped = true

  constructor(options: WorkerLoopOptions) {
    this.#worker = options.worker
    this.#dispatcher = options.dispatcher
    this.#scopes = options.scopes
    this.#intervalMs = options.intervalMs ?? 1_000
    this.#maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY
    this.#onError = options.onError ?? (() => undefined)
  }

  async tick(): Promise<{ processed: number; dispatched: number }> {
    let processed = 0
    let dispatched = 0
    const scopes = await this.#scopes()
    for (const scope of scopes) {
      processed += await this.#worker.runUntilIdle(scope.scopeRef, scope.ctx)
      dispatched += await this.#dispatcher.dispatchOnce(scope.scopeRef, scope.ctx)
    }
    return { processed, dispatched }
  }

  async start(): Promise<void> {
    this.#stopped = false
    for (let iteration = 0; iteration < this.#maxIterations && !this.#stopped; iteration += 1) {
      try {
        await this.tick()
      } catch (error) {
        this.#onError(error)
      }
      if (this.#stopped) break
      await new Promise((resolve) => setTimeout(resolve, this.#intervalMs))
    }
  }

  stop(): void {
    this.#stopped = true
  }
}
