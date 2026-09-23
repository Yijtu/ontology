import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import type { ProfileRef, ResolvedProfile, SemanticQueryPlan, SourceObjectRef, SourceRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { defineSemanticMapping, InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'

const EXPECTED_COLUMNS = [
  ['facility_key', 'string'], ['district_code', 'string'], ['condition_code', 'string'],
  ['entity_id', 'string'], ['object_id', 'string'], ['identity_scope_id', 'string'], ['native_id', 'string'],
  ['display_name', 'string'], ['normalized_name', 'string'], ['alias', 'string'], ['alias_normalized', 'string'],
  ['alias_confirmed', 'boolean'], ['alias_valid_from', 'timestamp'], ['alias_valid_to', 'timestamp'],
  ['site', 'string'], ['entity_type', 'string'], ['valid_from', 'timestamp'], ['valid_to', 'timestamp'],
  ['tenant_id', 'string'], ['space_id', 'string'],
] as const

function validIdentifier(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(candidate)) throw new Error('operator SQL schema/table must be lower-case PostgreSQL identifiers')
  return candidate
}

export const OPERATOR_SQL_PROFILE: ProfileRef = { id: 'operator-sql-facilities', version: '1.0.0' }
export const OPERATOR_SQL_SOURCE: SourceRef = { namespace: 'operator.readonly-sql', sourceId: 'primary' }
export const OPERATOR_SQL_DEFINITION_ID = 'operator.transport-facilities'
export const OPERATOR_SQL_NAMESPACE = 'operator-transport'
export const OPERATOR_SQL_IDENTITY_SCOPE = 'facility-key-within-district'
const objectRef: SourceObjectRef = { sourceRef: OPERATOR_SQL_SOURCE, objectPath: 'operator_facilities' }

function mappingFor(schema: string, relation: string) {
  return defineSemanticMapping('operator-sql-facilities.facility-mapping', '1.0.0', {
    dialect: 'postgres', objects: [{
      conceptId: 'road_facility', sourceObjectRef: objectRef, schema, relation, relationKind: 'table', estimatedRows: 100,
      fields: [
        { fieldRef: 'facility_id', column: 'facility_key', valueType: 'string', identityKey: true },
        { fieldRef: 'district', column: 'district_code', valueType: 'string' },
        { fieldRef: 'inspection_state', column: 'condition_code', valueType: 'enum', valueMap: [
          { physical: 'needs_inspection', canonical: 'needs_inspection' }, { physical: 'clear', canonical: 'clear' },
        ] },
        { fieldRef: 'entity_id', column: 'entity_id', valueType: 'string' },
        { fieldRef: 'object_id', column: 'object_id', valueType: 'string' },
        { fieldRef: 'identity_scope_id', column: 'identity_scope_id', valueType: 'string' },
        { fieldRef: 'native_id', column: 'native_id', valueType: 'string' },
        { fieldRef: 'display_name', column: 'display_name', valueType: 'string' },
        { fieldRef: 'normalized_name', column: 'normalized_name', valueType: 'string' },
        { fieldRef: 'alias', column: 'alias', valueType: 'string' },
        { fieldRef: 'alias_normalized', column: 'alias_normalized', valueType: 'string' },
        { fieldRef: 'alias_confirmed', column: 'alias_confirmed', valueType: 'boolean' },
        { fieldRef: 'alias_valid_from', column: 'alias_valid_from', valueType: 'timestamp' },
        { fieldRef: 'alias_valid_to', column: 'alias_valid_to', valueType: 'timestamp' },
        { fieldRef: 'site', column: 'site', valueType: 'string' },
        { fieldRef: 'entity_type', column: 'entity_type', valueType: 'string' },
        { fieldRef: 'valid_from', column: 'valid_from', valueType: 'timestamp' },
        { fieldRef: 'valid_to', column: 'valid_to', valueType: 'timestamp' },
        { fieldRef: 'tenant_id', column: 'tenant_id', valueType: 'string' },
        { fieldRef: 'space_id', column: 'space_id', valueType: 'string' },
      ],
    }], links: [],
  })
}

export interface LocalOperatorSqlProfile {
  readonly profileRef: ProfileRef
  readonly sourceRef: SourceRef
  readonly objectRef: SourceObjectRef
  readonly resolvedProfile: ResolvedProfile
  readonly query: PostgresQueryAdapter
  readonly mappings: InMemorySemanticMappingRegistry
  readonly sourceRefs: readonly SourceRef[]
  readonly maxRows: number
  readonly identityIndexProfile: import('@ontology/semantic-engine').IdentityIndexProfile
  planForDistrict(district: string, scope?: { readonly tenantId: string; readonly spaceId: string }): SemanticQueryPlan
  close(): Promise<void>
}

/** One server-configured SQL source; credentials and physical names never come from HTTP. */
export async function createLocalOperatorSqlProfile(input: {
  readonly connectionString: string
  readonly schema?: string
  readonly relation?: string
  readonly tenantId: string
  readonly spaceId: string
  readonly runtimeRef: VersionRef
  readonly policyRef: VersionRef
  readonly industryRef: VersionRef
  readonly ctx: import('@ontology/contracts').ToolContext
}): Promise<LocalOperatorSqlProfile> {
  const schema = validIdentifier(input.schema, 'public')
  const relation = validIdentifier(input.relation, 'ontology_facilities')
  const businessMapping: BusinessObjectMapping = {
    objectRef, schema, relation, relationKind: 'table', conceptRefs: ['road_facility'],
    columns: EXPECTED_COLUMNS.map(([name, type]) => ({ name, type: type as 'string' | 'boolean' | 'timestamp', semanticFieldRef: name })),
  }
  const database = new BusinessPostgresDatabase({ connectionString: input.connectionString, maxPoolSize: 4, applicationName: 'ontology-operator-readonly-source' })
  const query = new PostgresQueryAdapter({
    database, mappings: [businessMapping], sourceRef: OPERATOR_SQL_SOURCE,
    limits: { maxRows: 250, maxBytes: 262_144, maxDurationMs: 10_000, maxConcurrency: 2 },
  })
  try {
    const catalog = await query.describe({ scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, resourceRefs: [objectRef] }, input.ctx)
    const resource = catalog.resources.find((entry) => entry.objectRef.objectPath === objectRef.objectPath)
    if (resource === undefined) throw new Error('configured read-only SQL view was not visible in the allowlisted catalog')
    const found = new Map(resource.columns.map((column) => [column.name, column.type]))
    for (const [name, expected] of EXPECTED_COLUMNS) {
      if (found.get(name) !== expected) throw new Error(`configured SQL view column ${name} must have type ${expected}`)
    }
    const mapping = mappingFor(schema, relation)
    const schemaScopedRef: SourceObjectRef = { sourceRef: OPERATOR_SQL_SOURCE, objectPath: objectRef.objectPath }
    const resolvedProfile: ResolvedProfile = {
      industryRef: input.industryRef,
      mappingRefs: [{ ...mapping.mappingRef, role: 'catalog', sourceObjectRef: schemaScopedRef, schemaRevision: resource.schemaRevision }],
      runtimeRef: input.runtimeRef,
      backendBindings: { facilities: { role: 'catalog', adapterRef: query.adapterRef, capabilityNames: ['structured_query.execute'], scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, mappingRef: mapping.mappingRef.id } },
      modelBindings: {}, toolBindings: [{ toolId: 'data_query', enabled: true, maxCallsPerRun: 2 }], computeBindings: [], policyRef: input.policyRef,
      resolvedVersions: [input.industryRef, input.runtimeRef, input.policyRef, mapping.mappingRef, query.adapterRef],
      resolvedCapabilities: [], explicitDegradations: [],
      snapshotHash: sha256DigestOf(`${OPERATOR_SQL_PROFILE.id}@${OPERATOR_SQL_PROFILE.version}:${mapping.mappingRef.digest}:${resource.schemaRevision}`),
      resolvedAt: new Date().toISOString(),
    }
    const mappings = new InMemorySemanticMappingRegistry([mapping])
    return {
      profileRef: OPERATOR_SQL_PROFILE, sourceRef: OPERATOR_SQL_SOURCE, objectRef: schemaScopedRef,
      resolvedProfile, query, mappings, sourceRefs: [OPERATOR_SQL_SOURCE], maxRows: 100,
      identityIndexProfile: {
        mappingRef: mapping.mappingRef, conceptId: 'road_facility',
        fields: {
          entityId: 'entity_id', objectId: 'object_id', identityScopeId: 'identity_scope_id', nativeId: 'native_id',
          displayName: 'display_name', normalizedName: 'normalized_name', alias: 'alias', aliasNormalized: 'alias_normalized',
          aliasConfirmed: 'alias_confirmed', aliasValidFrom: 'alias_valid_from', aliasValidTo: 'alias_valid_to',
          site: 'site', entityType: 'entity_type', validFrom: 'valid_from', validTo: 'valid_to', tenantId: 'tenant_id', spaceId: 'space_id',
        },
        dimensionFieldRefs: { district: 'district' },
      },
      planForDistrict(district, scope) {
        if (!/^[a-z][a-z0-9-]{0,63}$/u.test(district)) throw new Error('district must be a registered lower-case district key')
        if (scope === undefined || scope.tenantId !== input.tenantId || scope.spaceId !== input.spaceId) throw new Error('the SQL profile is bound to another tenant/space')
        return { mode: 'semantic', concepts: ['road_facility'], fields: ['facility_id', 'district', 'inspection_state'], links: [], filters: [{ fieldRef: 'district', op: 'eq', values: [district] }, { fieldRef: 'tenant_id', op: 'eq', values: [scope.tenantId] }, { fieldRef: 'space_id', op: 'eq', values: [scope.spaceId] }, { fieldRef: 'inspection_state', op: 'eq', values: ['needs_inspection'] }], orderBy: [{ fieldRef: 'facility_id', direction: 'asc' }], limit: 100, mappingVersion: mapping.mappingRef }
      },
      async close() { await database.close() },
    }
  } catch (error) {
    await database.close()
    throw error
  }
}
