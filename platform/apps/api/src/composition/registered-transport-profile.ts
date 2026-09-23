import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type { ProfileRef, ResolvedProfile, SemanticQueryPlan, SourceObjectRef, SourceRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { defineSemanticMapping, InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'

export const TRANSPORT_PROFILE_REF: ProfileRef = { id: 'transport-government-local', version: '1.0.0' }
export const TRANSPORT_TASK_ID = 'transport.inspection-list'
const SOURCE: SourceRef = { namespace: 'transport-government.synthetic', sourceId: 'facility-snapshot-v1' }
const OBJECT: SourceObjectRef = { sourceRef: SOURCE, objectPath: 'road_facilities' }
const rows = [
  ['bridge-n-01', 'north', 1],
  ['bridge-n-02', 'north', 0],
  ['tunnel-s-01', 'south', 1],
] as const
const relation: RegisteredRelation = {
  relation: 'road_facilities', objectRef: OBJECT, schemaRevision: 'synthetic-road-facilities@1.0.0',
  columns: [
    { name: 'facility_key', type: 'string' },
    { name: 'district_code', type: 'string' },
    { name: 'condition_code', type: 'integer' },
  ],
}
const mapping = defineSemanticMapping('transport.facility-inspection-mapping', '1.0.0', {
  dialect: 'duckdb', objects: [{
    conceptId: 'road_facility', sourceObjectRef: OBJECT, schema: 'main', relation: 'road_facilities', relationKind: 'table', estimatedRows: rows.length,
    fields: [
      { fieldRef: 'facility_id', column: 'facility_key', valueType: 'string', identityKey: true },
      { fieldRef: 'district', column: 'district_code', valueType: 'string' },
      { fieldRef: 'inspection_state', column: 'condition_code', valueType: 'enum', valueMap: [
        { physical: 1, canonical: 'needs_inspection' }, { physical: 0, canonical: 'clear' },
      ] },
    ],
  }], links: [],
})

export interface LocalTransportProfile {
  readonly profileRef: ProfileRef
  readonly resolvedProfile: ResolvedProfile
  readonly query: DuckDbQueryAdapter
  readonly mappings: InMemorySemanticMappingRegistry
  readonly sourceRefs: readonly SourceRef[]
  planForDistrict(district: string): SemanticQueryPlan
  close(): void
}

export async function createLocalTransportProfile(refs: { readonly runtimeRef: VersionRef; readonly policyRef: VersionRef; readonly industryRef: VersionRef; readonly tenantId: string; readonly spaceId: string }): Promise<LocalTransportProfile> {
  const query = new DuckDbQueryAdapter({ relations: [relation], catalogSchemaRevision: 'synthetic-road-facilities@1.0.0', consistency: 'immutable' })
  try { await query.start(); await query.materialiseRelation('road_facilities', rows) } catch (error) { query.close(); throw error }
  const mappings = new InMemorySemanticMappingRegistry([mapping])
  const snapshotHash = sha256DigestOf(`${TRANSPORT_PROFILE_REF.id}@${TRANSPORT_PROFILE_REF.version}:${mapping.mappingRef.digest}`)
  const resolvedProfile: ResolvedProfile = {
    industryRef: refs.industryRef,
    mappingRefs: [{ ...mapping.mappingRef, role: 'catalog', sourceObjectRef: OBJECT, schemaRevision: 'synthetic-road-facilities@1.0.0' }],
    runtimeRef: refs.runtimeRef,
    backendBindings: { facilities: { role: 'catalog', adapterRef: { id: 'data-duckdb', version: '1.0.0', digest: sha256DigestOf('data-duckdb@1.0.0') }, capabilityNames: ['structured_query.execute'], scopeRef: { tenantId: refs.tenantId, spaceId: refs.spaceId }, mappingRef: mapping.mappingRef.id } },
    modelBindings: {}, toolBindings: [{ toolId: 'data_query', enabled: true, maxCallsPerRun: 2 }], computeBindings: [], policyRef: refs.policyRef,
    resolvedVersions: [refs.industryRef, refs.runtimeRef, refs.policyRef, mapping.mappingRef], resolvedCapabilities: [], explicitDegradations: [], snapshotHash, resolvedAt: new Date().toISOString(),
  }
  return {
    profileRef: TRANSPORT_PROFILE_REF, resolvedProfile, query, mappings, sourceRefs: [SOURCE],
    planForDistrict(district) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(district)) throw new Error('district must be a lower-case registered district key')
      return { mode: 'semantic', concepts: ['road_facility'], fields: ['facility_id', 'district', 'inspection_state'], links: [], filters: [{ fieldRef: 'district', op: 'eq', values: [district] }, { fieldRef: 'inspection_state', op: 'eq', values: ['needs_inspection'] }], orderBy: [{ fieldRef: 'facility_id', direction: 'asc' }], limit: 100, mappingVersion: mapping.mappingRef }
    },
    close: () => query.close(),
  }
}
