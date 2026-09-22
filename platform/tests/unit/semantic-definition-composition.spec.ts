import { describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresSemanticDefinitionStore,
} from '@ontology/adapter-control-postgres'
import {
  createPostgresSemanticDefinitionService,
  createPostgresSemanticDefinitionStore,
} from '@ontology/app-api'
import type { SemanticDefinitionStore } from '@ontology/contracts'
import { SemanticDefinitionService } from '@ontology/semantic-engine'

/**
 * The composition root must be able to build the real persistence path from a pool. The
 * pool is never connected here — construction is lazy — so this stays a wiring test and
 * the real-database acceptance lives in the integration suite.
 */
const CONNECTION_STRING = 'postgresql://unused:unused@127.0.0.1:1/unused'

describe('semantic definition composition', () => {
  it('adapts a control-database pool into the SemanticDefinitionStore port', async () => {
    const database = new ControlPostgresDatabase({ connectionString: CONNECTION_STRING, maxPoolSize: 1 })
    const store: SemanticDefinitionStore = createPostgresSemanticDefinitionStore(database)

    expect(store).toBeInstanceOf(PostgresSemanticDefinitionStore)
    expect(typeof store.findVersion).toBe('function')
    expect(typeof store.listVersions).toBe('function')
    expect(typeof store.insertVersion).toBe('function')
    expect(typeof store.listEvents).toBe('function')
    expect(typeof store.bindData).toBe('function')
    expect(typeof store.findBinding).toBe('function')

    await database.close()
  })

  it('wires pool -> store -> definition service', async () => {
    const composition = createPostgresSemanticDefinitionService({
      connectionString: CONNECTION_STRING,
      maxPoolSize: 1,
    })

    const port: SemanticDefinitionStore = composition.store
    expect(port).toBeInstanceOf(PostgresSemanticDefinitionStore)
    expect(composition.service).toBeInstanceOf(SemanticDefinitionService)
    expect(composition.database).toBeInstanceOf(ControlPostgresDatabase)

    await composition.close()
  })
})
