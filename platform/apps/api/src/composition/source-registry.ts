import { SourceRegistry } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSourceStore,
} from '@ontology/adapter-control-postgres'
import type {
  SecretResolver,
  SourceProbeAdapter,
  SourceProbeAdapterResolver,
  SourceStore,
  VersionRef,
} from '@ontology/contracts'
import { createEnvSecretResolver } from './secret-resolver'

export interface SourceRegistryCompositionOptions {
  readonly connectionString: string
  /**
   * Server-side secret resolution. Never returns a serializable secret value. Defaults to
   * the environment-backed resolver, so a deployment resolves a `secretRef` by variable
   * name from its own process environment instead of any repository configuration.
   */
  readonly secrets?: SecretResolver
  /** The probe targets the composition root has registered; LOCAL-012/013 supply the real ones. */
  readonly adapters: readonly SourceProbeAdapter[]
  readonly maxPoolSize?: number
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * Explicit wiring for source registration and probing. The composition root owns the pool
 * and injects it into the store and the control repository; the secret resolver and probe
 * adapters are supplied by the caller, so the application layer never imports an adapter.
 */
export interface SourceRegistryComposition {
  readonly database: ControlPostgresDatabase
  readonly store: SourceStore
  readonly registry: SourceRegistry
  close(): Promise<void>
}

function adapterKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

/**
 * Resolver over the adapters the composition root explicitly registered. There is no
 * dynamic loading and no network download: an unknown ref simply does not resolve.
 */
export function createStaticProbeAdapterResolver(
  adapters: readonly SourceProbeAdapter[],
): SourceProbeAdapterResolver {
  const byRef = new Map(adapters.map((adapter) => [adapterKey(adapter.adapterRef), adapter]))
  return {
    resolve: (adapterRef) => Promise.resolve(byRef.get(adapterKey(adapterRef))),
  }
}

/** Exposed on its own so a caller can inject the port and a test can assert it satisfies `SourceStore`. */
export function createPostgresSourceStore(database: ControlPostgresDatabase): SourceStore {
  return new PostgresSourceStore(database)
}

export function createPostgresSourceRegistry(
  options: SourceRegistryCompositionOptions,
): SourceRegistryComposition {
  const database = new ControlPostgresDatabase({
    connectionString: options.connectionString,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
  })
  const store = createPostgresSourceStore(database)
  const registry = new SourceRegistry({
    control: new ControlPostgresRepository(database),
    store,
    secrets: options.secrets ?? createEnvSecretResolver(),
    adapters: createStaticProbeAdapterResolver(options.adapters),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  return {
    database,
    store,
    registry,
    close: () => database.close(),
  }
}
