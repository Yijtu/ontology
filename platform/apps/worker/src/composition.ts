import {
  DocumentParseStageHandler,
  JobWorker,
  OutboxDispatcher,
  ParsedStageDispatcher,
  StructuredDocumentParseStageHandler,
  isStructuredIngestionRef,
} from '@ontology/application'
import type {
  JobStageContext,
  JobStageHandler,
  JobStageHandlerRegistry,
  JobStageOutcome,
  OutboxConsumer,
  RunService,
} from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresJobStore,
  PostgresMaterializationStore,
} from '@ontology/adapter-control-postgres'
import { IncrementalMaterializer, PublishedSemanticSource } from '@ontology/semantic-engine'
import type { MaterializationFaultInjection } from '@ontology/semantic-engine'
import type {
  BudgetLedgerPort,
  DocumentParserPort,
  IdentityDecisionStore,
  JobStore,
  PipelineStage,
  ScopeRef,
  StructuredIngestionPort,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  controlRecordSequence,
  MaterializationOutboxConsumer,
} from './materialization-consumer'
import type { MaterializationPublicationView } from './materialization-consumer'
import type { SimulationRunGuard } from './simulation-stage'

export interface MaterializationWorkerOptions {
  /** The published read view (the real `PostgresSemanticPublicationStore` in production). */
  readonly publications: MaterializationPublicationView
  /** The adjudicated identity reader; published entity attributes are never trusted without it. */
  readonly identity: Pick<IdentityDecisionStore, 'latestReadRevision' | 'readPublishedBindings'>
  /** Optional run/profile schema pin. Multi-version scopes are incomplete without this pin. */
  readonly definitionRef?: VersionRef
  /** Above this many affected rules a change is conservatively deferred with a dirty scope. */
  readonly maxFanout?: number
  /** Test-only seam: run before the projection commit so a fault can leave the fence open. */
  readonly faultInjection?: MaterializationFaultInjection
  readonly streamRef?: string
}

export interface JobWorkerCompositionOptions {
  readonly connectionString: string
  /** Parse/extract/review handlers are owned by later nodes; they arrive by injection. */
  readonly handlers: JobStageHandlerRegistry
  /** Shared budget ledger; the worker opens a `background` ledger per job (SPEC §9). */
  readonly budget: BudgetLedgerPort
  readonly outboxConsumer: OutboxConsumer
  /**
   * Optional semantic-materialisation wiring (LOCAL-069). When present the composition
   * constructs the `IncrementalMaterializer` and registers the materialisation outbox
   * consumer, so a publication opens the invalidation fence and the worker advances the
   * projection asynchronously.
   */
  readonly materialization?: MaterializationWorkerOptions
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
  /** Present when the composition was given `materialization` options. */
  readonly materializer?: IncrementalMaterializer
  readonly materializationConsumer?: MaterializationOutboxConsumer
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

  const materialization = options.materialization
  let materializer: IncrementalMaterializer | undefined
  let materializationConsumer: MaterializationOutboxConsumer | undefined
  let consumer = options.outboxConsumer
  if (materialization !== undefined) {
    const materializationStore = new PostgresMaterializationStore(database)
    materializer = new IncrementalMaterializer({
      publishedSource: new PublishedSemanticSource(materialization.publications, {
        identity: materialization.identity,
        ...(materialization.definitionRef === undefined ? {} : { definitionRef: materialization.definitionRef }),
      }),
      materialization: materializationStore,
      ...(materialization.maxFanout === undefined ? {} : { maxFanout: materialization.maxFanout }),
      ...(materialization.faultInjection === undefined
        ? {}
        : { faultInjection: materialization.faultInjection }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    })
    materializationConsumer = new MaterializationOutboxConsumer({
      materializer,
      publications: materialization.publications,
      sequence: controlRecordSequence(
        new ControlPostgresRepository(database),
        materialization.streamRef,
      ),
      outbox: store,
      materialization: materializationStore,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    })
    consumer = new TopicOutboxConsumerRouter([materializationConsumer], options.outboxConsumer)
  }

  const dispatcher = new OutboxDispatcher({
    store,
    consumer,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return {
    database,
    store,
    worker,
    dispatcher,
    ...(materializer === undefined ? {} : { materializer }),
    ...(materializationConsumer === undefined ? {} : { materializationConsumer }),
    close: () => database.close(),
  }
}

/** A consumer that owns a fixed set of outbox topics. */
export interface TopicOutboxConsumer extends OutboxConsumer {
  readonly topics: readonly string[]
}

/**
 * Route each outbox message to the consumer that owns its topic. Messages whose topic no
 * registered consumer claims fall through to the injected consumer, so adding the
 * materialisation topics never hides a message from the existing worker wiring.
 */
export class TopicOutboxConsumerRouter implements OutboxConsumer {
  readonly #byTopic: ReadonlyMap<string, OutboxConsumer>
  readonly #fallback: OutboxConsumer

  constructor(routed: readonly TopicOutboxConsumer[], fallback: OutboxConsumer) {
    const byTopic = new Map<string, OutboxConsumer>()
    for (const consumer of routed) {
      for (const topic of consumer.topics) byTopic.set(topic, consumer)
    }
    this.#byTopic = byTopic
    this.#fallback = fallback
  }

  async consume(message: Parameters<OutboxConsumer['consume']>[0], ctx: ToolContext): Promise<void> {
    const consumer = this.#byTopic.get(message.topic) ?? this.#fallback
    await consumer.consume(message, ctx)
  }
}

export interface IngestionHandlerRegistryOptions {
  /** The real document parser (LOCAL-023) that backs the text/PDF `received → parsed` stage. */
  readonly parser: DocumentParserPort
  /**
   * The structured ingestion port (V03-005 parser + row reconciliation). When present, a
   * `structured_ingestion` document reference runs it instead of the text/PDF parser.
   */
  readonly structured?: StructuredIngestionPort
  /**
   * The structured `parsed → extracted` handler (V03-007). When present, the `parsed` stage
   * routes a `structured_extraction` document reference to it instead of the text/PDF chunk
   * handler, so a structured ingestion job runs end to end inside the worker.
   */
  readonly structuredExtraction?: JobStageHandler
  /** The `parsed → extracted → validated` handlers owned by the extraction pipeline. */
  readonly downstream: readonly JobStageHandler[]
}

/**
 * Route a `received` claim by the job's opaque input reference kind. A reference that names a
 * structured ingestion runs the structured stage; everything else keeps the historical
 * text/PDF path, so the existing ingestion jobs are unchanged.
 */
class ReceivedStageDispatcher implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #text: JobStageHandler
  readonly #structured: JobStageHandler

  constructor(text: JobStageHandler, structured: JobStageHandler) {
    this.#text = text
    this.#structured = structured
  }

  run(context: JobStageContext): Promise<JobStageOutcome> {
    return isStructuredIngestionRef(context.job.documentRef)
      ? this.#structured.run(context)
      : this.#text.run(context)
  }
}

/**
 * Wire the real `received → parsed` stage together with the downstream extraction stages into
 * one worker registry, so a `POST /ingestions` job runs end to end inside the worker. The
 * composition root supplies the concrete parsers; the handlers themselves depend only on the
 * `DocumentParserPort`/`StructuredIngestionPort` contracts.
 */
export function createIngestionHandlerRegistry(
  options: IngestionHandlerRegistryOptions,
): JobStageHandlerRegistry {
  const byStage = new Map<PipelineStage, JobStageHandler>()
  const text = new DocumentParseStageHandler({ parser: options.parser })
  byStage.set(
    'received',
    options.structured === undefined
      ? text
      : new ReceivedStageDispatcher(text, new StructuredDocumentParseStageHandler({ ingestion: options.structured })),
  )
  for (const handler of options.downstream) byStage.set(handler.stage, handler)
  if (options.structuredExtraction !== undefined) {
    const text = byStage.get('parsed')
    if (text === undefined) {
      throw new Error('a structured extraction handler requires a text `parsed` downstream handler')
    }
    byStage.set('parsed', new ParsedStageDispatcher(text, options.structuredExtraction))
  }
  return { get: (stage) => byStage.get(stage) }
}

/**
 * Quarantine a simulation result when its run has already been cancelled. The guard reads the
 * real run state and records a late result as an abandoned attempt, so a durable simulation
 * job that finishes after a cancel can never revive or publish the run (SPEC C5/D7, ADR-12).
 */
export function createSimulationRunGuard(runService: RunService): SimulationRunGuard {
  return {
    async quarantineIfCancelled(runId, input, ctx): Promise<boolean> {
      const run = await runService.getRun(runId, ctx)
      if (run.state !== 'cancelled' && run.state !== 'cancelling') return false
      await runService.recordLateResult(
        runId,
        { attemptId: input.attemptId, reason: input.reason },
        ctx,
      )
      return true
    },
  }
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

  async tick(signal?: AbortSignal): Promise<{ processed: number; dispatched: number }> {
    let processed = 0
    let dispatched = 0
    const scopes = await this.#scopes()
    for (const scope of scopes) {
      if (signalAborted(signal)) break
      processed += await this.#worker.runUntilIdle(scope.scopeRef, scope.ctx, 100, signal)
      if (!signalAborted(signal)) dispatched += await this.#dispatcher.dispatchOnce(scope.scopeRef, scope.ctx)
    }
    return { processed, dispatched }
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.#stopped = false
    for (let iteration = 0; iteration < this.#maxIterations && !this.#stopped && !signalAborted(signal); iteration += 1) {
      try {
        await this.tick(signal)
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

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}
