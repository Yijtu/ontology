import { ProfileResolver } from '@ontology/application'
import type { ProfileSpecValidator } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
  PostgresProfileStore,
} from '@ontology/adapter-control-postgres'
import type { IndustryManifestSource, ProfileStore } from '@ontology/contracts'

export interface ProfileResolverCompositionOptions {
  readonly connectionString: string
  /** Declarative industry manifests resolved by reference; the composition root owns them. */
  readonly industry: IndustryManifestSource
  /** Canonical ProfileSpec validator built from the published schema bundle. */
  readonly validator: ProfileSpecValidator
  readonly maxPoolSize?: number
  readonly now?: () => string
}

/**
 * Explicit wiring for the profile resolver. The composition root owns the pool and
 * injects it into the store and the control repository; the industry manifest source is
 * supplied by the caller so the application layer never imports an industry pack. There is
 * no service locator and no module-level mutable state, so two tenants/spaces can never
 * share an accidental scope.
 */
export interface ProfileResolverComposition {
  readonly database: ControlPostgresDatabase
  readonly store: ProfileStore
  readonly resolver: ProfileResolver
  close(): Promise<void>
}

/**
 * Exposed on its own so a caller can inject the port directly, and so a test can assert the
 * adapter satisfies `ProfileStore` without building the whole resolver.
 */
export function createPostgresProfileStore(database: ControlPostgresDatabase): ProfileStore {
  return new PostgresProfileStore(database)
}

export function createPostgresProfileResolver(
  options: ProfileResolverCompositionOptions,
): ProfileResolverComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresProfileStore(database)
  const resolver = new ProfileResolver({
    control: new ControlPostgresRepository(database),
    store,
    registry: new PostgresComponentRegistryStore(database),
    industry: options.industry,
    validator: options.validator,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return {
    database,
    store,
    resolver,
    close: () => database.close(),
  }
}
