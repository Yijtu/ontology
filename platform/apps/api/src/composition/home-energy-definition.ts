import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { ControlPostgresRepository, PostgresSemanticDefinitionStore } from '@ontology/adapter-control-postgres'
import { createRequestToolContext } from '../http/context'
import { SemanticDefinitionService } from '@ontology/semantic-engine'
import type { SemanticDefinitionVersion } from '@ontology/contracts'
import { HOME_ENERGY_DEFINITIONS } from '@ontology/industry-pack-home-energy'

/** Publishes the immutable home-energy declaration used by the A4 instance navigator. */
export async function ensureHomeEnergyDefinition(input: {
  readonly database: ControlPostgresDatabase
  readonly tenantId: string
  readonly spaceId: string
}): Promise<SemanticDefinitionVersion> {
  const principal = { tenantId: input.tenantId, subjectId: 'local-product-bootstrap', roles: ['platform-admin'], scopes: ['semantic:publish'], authEpoch: 1 }
  const ctx = createRequestToolContext({ principal, spaceId: input.spaceId, runId: globalThis.crypto.randomUUID(), traceId: 'home-energy-definition-bootstrap' })
  const service = new SemanticDefinitionService({ control: new ControlPostgresRepository(input.database), store: new PostgresSemanticDefinitionStore(input.database) })
  return service.publish({ scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, ...HOME_ENERGY_DEFINITIONS }, ctx)
}
