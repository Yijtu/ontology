import { FeedbackService } from '@ontology/application'
import type { FeedbackStore } from '@ontology/contracts'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresFeedbackStore,
  PostgresRunStore,
} from '@ontology/adapter-control-postgres'

export interface FeedbackServiceComposition {
  readonly store: FeedbackStore
  readonly service: FeedbackService
}

export function createPostgresFeedbackStore(database: ControlPostgresDatabase): FeedbackStore {
  return new PostgresFeedbackStore(database)
}

/**
 * Explicit wiring for the feedback service. The composition root owns the pool and injects it
 * into the feedback store, the control ledger and the run/answer readers; the application layer
 * never imports an adapter or a driver. Feedback is read-only with respect to runs and answers,
 * so the run store and answer store are injected only for visibility checks.
 */
export function createPostgresFeedbackService(
  database: ControlPostgresDatabase,
): FeedbackServiceComposition {
  const store = createPostgresFeedbackStore(database)
  const service = new FeedbackService({
    store,
    control: new ControlPostgresRepository(database),
    runs: new PostgresRunStore(database),
    answers: new PostgresAnswerStore(database),
  })
  return { store, service }
}
