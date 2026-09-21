import { ProfileResolver, RunService } from '@ontology/application'
import type { ProfileSpecValidator, RunProfileBinder } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
  PostgresProfileStore,
  PostgresRunStore,
} from '@ontology/adapter-control-postgres'
import type { IndustryManifestSource, RunStore } from '@ontology/contracts'

export interface RunServiceCompositionOptions {
  readonly connectionString: string
  /** Declarative industry manifests resolved by reference; the composition root owns them. */
  readonly industry: IndustryManifestSource
  /** Canonical ProfileSpec validator built from the published schema bundle. */
  readonly validator: ProfileSpecValidator
  readonly maxPoolSize?: number
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * Explicit wiring for the run service. The composition root owns the pool and injects it
 * into the run store, the profile store and the control repository; the industry manifest
 * source and validator are supplied by the caller, so the application layer never imports an
 * industry pack, a schema library or a driver. There is no service locator and no
 * module-level mutable state.
 */
export interface RunServiceComposition {
  readonly database: ControlPostgresDatabase
  readonly store: RunStore
  readonly resolver: ProfileResolver
  readonly service: RunService
  close(): Promise<void>
}

export function createPostgresRunStore(database: ControlPostgresDatabase): RunStore {
  return new PostgresRunStore(database)
}

export function createPostgresRunService(
  options: RunServiceCompositionOptions,
): RunServiceComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresRunStore(database)
  const control = new ControlPostgresRepository(database)
  const resolver = new ProfileResolver({
    control,
    store: new PostgresProfileStore(database),
    registry: new PostgresComponentRegistryStore(database),
    industry: options.industry,
    validator: options.validator,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  // Binding a run to a profile is a read-only resolution, not an editing action: the
  // resolver exposes it separately from publish/preflight/activate.
  const profiles: RunProfileBinder = {
    bindProfileForRun: (profileRef, scopeRef, ctx) => resolver.bindRunProfile(profileRef, scopeRef, ctx),
  }
  const service = new RunService({
    store,
    control,
    profiles,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  return {
    database,
    store,
    resolver,
    service,
    close: () => database.close(),
  }
}
