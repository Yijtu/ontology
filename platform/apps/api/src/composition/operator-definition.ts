import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { PostgresSemanticDefinitionStore } from '@ontology/adapter-control-postgres'
import { ControlPostgresRepository } from '@ontology/adapter-control-postgres'
import { createRequestToolContext } from '../http/context'
import type { IndustrySchema, IndustrySchemaSource, SemanticDefinitionVersion, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { projectIndustrySchema, SemanticDefinitionService } from '@ontology/semantic-engine'
import { sha256DigestOf } from '@ontology/core'
import { OPERATOR_SQL_DEFINITION_ID, OPERATOR_SQL_IDENTITY_SCOPE, OPERATOR_SQL_NAMESPACE } from './registered-operator-sql'

const STANDARD_REF: VersionRef = { id: 'local-controlled-fixture', version: '1.0.0', digest: sha256DigestOf('local-controlled-fixture@1.0.0') }
const provenance = [{ standardRef: STANDARD_REF, provenanceKind: 'synthetic_assumption' as const, clauseRef: 'operator-candidate-contract@1' }]

export async function ensureOperatorFacilityDefinition(input: { readonly database: ControlPostgresDatabase; readonly tenantId: string; readonly spaceId: string }): Promise<SemanticDefinitionVersion> {
  const service = new SemanticDefinitionService({ control: new ControlPostgresRepository(input.database), store: new PostgresSemanticDefinitionStore(input.database) })
  const principal = { tenantId: input.tenantId, subjectId: 'local-product-bootstrap', roles: ['platform-admin'], scopes: ['semantic:publish'], authEpoch: 1 }
  const ctx = createRequestToolContext({ principal, spaceId: input.spaceId, runId: globalThis.crypto.randomUUID(), traceId: 'local-definition-bootstrap' })
  return service.publish({
    scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId },
    definitionId: OPERATOR_SQL_DEFINITION_ID, version: '1.0.0', namespace: OPERATOR_SQL_NAMESPACE,
    layer: 'industry_core', standardProvenance: provenance,
    objects: [{ kind: 'object', id: 'road_facility', namespace: OPERATOR_SQL_NAMESPACE, displayName: 'Road facility', identityScopeId: OPERATOR_SQL_IDENTITY_SCOPE, standardProvenance: provenance }],
    attributes: [
      { kind: 'attribute', id: 'facility_key', namespace: OPERATOR_SQL_NAMESPACE, objectId: 'road_facility', valueType: 'string', cardinality: { min: 1, max: 1 }, identityKey: true, standardProvenance: provenance },
      { kind: 'attribute', id: 'facility_name', namespace: OPERATOR_SQL_NAMESPACE, objectId: 'road_facility', valueType: 'string', cardinality: { min: 1, max: 1 }, standardProvenance: provenance },
      { kind: 'attribute', id: 'district', namespace: OPERATOR_SQL_NAMESPACE, objectId: 'road_facility', valueType: 'string', cardinality: { min: 1, max: 1 }, standardProvenance: provenance },
      { kind: 'attribute', id: 'inspection_state', namespace: OPERATOR_SQL_NAMESPACE, objectId: 'road_facility', valueType: 'enum', cardinality: { min: 1, max: 1 }, enumValues: ['needs_inspection', 'clear'], standardProvenance: provenance },
    ],
    relations: [],
    identityScopes: [{ kind: 'identity_scope', id: OPERATOR_SQL_IDENTITY_SCOPE, namespace: OPERATOR_SQL_NAMESPACE, objectId: 'road_facility', scopeDimensions: ['district'], identityAttributeIds: ['facility_key'], standardProvenance: provenance }],
    ruleConstraints: [],
  }, ctx)
}

export class PostgresIndustrySchemaSource implements IndustrySchemaSource {
  readonly #store: PostgresSemanticDefinitionStore
  readonly #namespaces: readonly string[]
  constructor(database: ControlPostgresDatabase, additionalNamespaces: readonly string[] = []) { this.#store = new PostgresSemanticDefinitionStore(database); this.#namespaces = [...new Set([OPERATOR_SQL_NAMESPACE, ...additionalNamespaces])] }
  async getSchema(scopeRef: ScopeRef, definitionRef: VersionRef, ctx: ToolContext): Promise<IndustrySchema | undefined> {
    for (const namespace of this.#namespaces) {
      const version = await this.#store.findVersion(namespace, definitionRef.id, definitionRef.version, scopeRef, ctx)
      if (version !== undefined && version.ref.digest === definitionRef.digest) return projectIndustrySchema(version)
    }
    return undefined
  }
}
