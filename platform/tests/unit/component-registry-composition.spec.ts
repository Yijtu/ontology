import { describe, expect, it } from 'vitest'
import { ComponentRegistry } from '@ontology/application'
import {
  ControlPostgresDatabase,
  PostgresComponentRegistryStore,
} from '@ontology/adapter-control-postgres'
import {
  createPostgresComponentRegistry,
  createPostgresComponentRegistryStore,
} from '@ontology/app-api'
import type { ComponentRegistryStore } from '@ontology/contracts'
import { FakeBlobPort, canonicalManifestValidator } from './component-registry-fixtures'

/**
 * The composition root must be able to build the real persistence path from a pool. The
 * pool is never connected here — construction is lazy — so this stays a wiring test and
 * the real-database acceptance lives in the integration suite.
 */
const CONNECTION_STRING = 'postgresql://unused:unused@127.0.0.1:1/unused'

describe('component registry composition', () => {
  it('adapts a control-database pool into the ComponentRegistryStore port', async () => {
    const database = new ControlPostgresDatabase({ connectionString: CONNECTION_STRING, maxPoolSize: 1 })
    const store: ComponentRegistryStore = createPostgresComponentRegistryStore(database)

    expect(store).toBeInstanceOf(PostgresComponentRegistryStore)
    expect(typeof store.findVersion).toBe('function')
    expect(typeof store.listVersions).toBe('function')
    expect(typeof store.insertVersion).toBe('function')
    expect(typeof store.applyTransition).toBe('function')
    expect(typeof store.listActiveReferences).toBe('function')
    expect(typeof store.acquireActiveReference).toBe('function')
    expect(typeof store.releaseActiveReference).toBe('function')
    expect(typeof store.listLifecycleEvents).toBe('function')

    await database.close()
  })

  it('wires pool -> store -> registry service', async () => {
    const composition = createPostgresComponentRegistry({
      connectionString: CONNECTION_STRING,
      maxPoolSize: 1,
      artifacts: new FakeBlobPort(),
      validator: canonicalManifestValidator(),
    })

    const port: ComponentRegistryStore = composition.store
    expect(port).toBeInstanceOf(PostgresComponentRegistryStore)
    expect(composition.registry).toBeInstanceOf(ComponentRegistry)
    expect(composition.database).toBeInstanceOf(ControlPostgresDatabase)

    await composition.close()
  })
})
