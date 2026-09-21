import type { JobStore, ScopeRef, ToolContext } from '@ontology/contracts'
import type { OutboxConsumer } from './types'

export interface OutboxDispatcherDependencies {
  readonly store: JobStore
  /** Idempotent consumer keyed by `message.idempotencyKey`. */
  readonly consumer: OutboxConsumer
  readonly batchSize?: number
  readonly now?: () => string
}

const DEFAULT_BATCH_SIZE = 50

/**
 * Transactional-outbox dispatcher (SPEC D6/§8).
 *
 * Messages are written in the same transaction as the state change that produced them, so a
 * crash between commit and dispatch cannot lose them: they are still `pending` and a later
 * dispatch delivers them. Delivery is at-least-once — a crash after `consume` but before
 * `markOutboxDispatched` re-delivers the message — so the consumer is required to dedupe on
 * `idempotencyKey`. A duplicate dispatch is therefore harmless.
 */
export class OutboxDispatcher {
  readonly #store: JobStore
  readonly #consumer: OutboxConsumer
  readonly #batchSize: number
  readonly #now: () => string

  constructor(dependencies: OutboxDispatcherDependencies) {
    this.#store = dependencies.store
    this.#consumer = dependencies.consumer
    this.#batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** Deliver one batch. Returns the number of messages consumed. */
  async dispatchOnce(scopeRef: ScopeRef, ctx: ToolContext): Promise<number> {
    const messages = await this.#store.listPendingOutbox(
      scopeRef,
      this.#batchSize,
      this.#now(),
      ctx,
    )
    let dispatched = 0
    for (const message of messages) {
      await this.#consumer.consume(message, ctx)
      await this.#store.markOutboxDispatched(scopeRef, message.outboxId, this.#now(), ctx)
      dispatched += 1
    }
    return dispatched
  }
}
