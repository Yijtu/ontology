import { JobService } from '@ontology/application'
import { ControlPostgresDatabase, PostgresJobStore } from '@ontology/adapter-control-postgres'
import type { JobStore } from '@ontology/contracts'

export interface JobServiceCompositionOptions {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * Explicit wiring for the job service. The composition root owns the pool and injects it into
 * the PostgreSQL job store; the application layer never imports the driver. Background quota
 * is a separate injected port and is not created here.
 */
export interface JobServiceComposition {
  readonly database: ControlPostgresDatabase
  readonly store: JobStore
  readonly service: JobService
  close(): Promise<void>
}

export function createPostgresJobStore(database: ControlPostgresDatabase): JobStore {
  return new PostgresJobStore(database)
}

export function createPostgresJobService(options: JobServiceCompositionOptions): JobServiceComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresJobStore(database)
  const service = new JobService({
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  return {
    database,
    store,
    service,
    close: () => database.close(),
  }
}
