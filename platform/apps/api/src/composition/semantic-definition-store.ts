import { SemanticDefinitionService } from '@ontology/semantic-engine'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSemanticDefinitionStore,
} from '@ontology/adapter-control-postgres'
import type { SemanticDefinitionStore } from '@ontology/contracts'

export interface SemanticDefinitionCompositionOptions {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly now?: () => string
}

/**
 * Explicit wiring for semantic definitions. The composition root owns the pool and
 * injects it into the version store and the control repository; there is no service
 * locator and no module-level mutable state, so two tenants/spaces can never share an
 * accidental scope.
 */
export interface SemanticDefinitionComposition {
  readonly database: ControlPostgresDatabase
  readonly store: SemanticDefinitionStore
  readonly service: SemanticDefinitionService
  close(): Promise<void>
}

/**
 * Adapts the control-database pool owner into the definition persistence port. Exposed on
 * its own so a caller can inject the port directly, and so a test can assert the adapter
 * satisfies `SemanticDefinitionStore` without building the whole service.
 */
export function createPostgresSemanticDefinitionStore(
  database: ControlPostgresDatabase,
): SemanticDefinitionStore {
  return new PostgresSemanticDefinitionStore(database)
}

export function createPostgresSemanticDefinitionService(
  options: SemanticDefinitionCompositionOptions,
): SemanticDefinitionComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresSemanticDefinitionStore(database)
  const service = new SemanticDefinitionService({
    control: new ControlPostgresRepository(database),
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return {
    database,
    store,
    service,
    close: () => database.close(),
  }
}
