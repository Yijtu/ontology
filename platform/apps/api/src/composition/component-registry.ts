import { ComponentRegistry } from '@ontology/application'
import type { ManifestValidator } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
} from '@ontology/adapter-control-postgres'
import type { BlobPort, ComponentRegistryStore } from '@ontology/contracts'

export interface ComponentRegistryCompositionOptions {
  readonly connectionString: string
  readonly artifacts: BlobPort
  readonly validator: ManifestValidator
  readonly maxPoolSize?: number
  readonly now?: () => string
}

/**
 * Explicit wiring for the component registry. The composition root owns the pool and
 * injects it into the store and the control repository; there is no service locator and
 * no module-level mutable state, so two tenants/runs can never share an accidental scope.
 */
export interface ComponentRegistryComposition {
  readonly database: ControlPostgresDatabase
  readonly store: ComponentRegistryStore
  readonly registry: ComponentRegistry
  close(): Promise<void>
}

/**
 * Adapts the control-database pool owner into the registry persistence port. Exposed on
 * its own so a caller can inject the port directly, and so a test can assert the adapter
 * satisfies `ComponentRegistryStore` without building the whole registry.
 */
export function createPostgresComponentRegistryStore(
  database: ControlPostgresDatabase,
): ComponentRegistryStore {
  return new PostgresComponentRegistryStore(database)
}

export function createPostgresComponentRegistry(
  options: ComponentRegistryCompositionOptions,
): ComponentRegistryComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresComponentRegistryStore(database)
  const registry = new ComponentRegistry({
    control: new ControlPostgresRepository(database),
    store,
    artifacts: options.artifacts,
    validator: options.validator,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return {
    database,
    store,
    registry,
    close: () => database.close(),
  }
}
