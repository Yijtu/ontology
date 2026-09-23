import { DuckDbQueryAdapter, DATA_DUCKDB_ADAPTER_REF } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type {
  ProfileRef,
  ResolvedProfile,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceRef,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { defineSemanticMapping, InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'

/**
 * Disposable local customer profiles. These rows are explicitly synthetic; a real source
 * connector can replace their import without changing the semantic query contract.
 * The long layout is normalized before its read-only relation is registered. Neither
 * raw metric codes nor physical column names escape the deployment-side mappings.
 */
const PROFILE_WIDE: ProfileRef = { id: 'home-energy-demo-wide', version: '1.0.0' }
const PROFILE_LONG: ProfileRef = { id: 'home-energy-demo-long', version: '1.0.0' }
const SOURCE_WIDE: SourceRef = { namespace: 'home-energy.synthetic', sourceId: 'soc-wide-v1' }
const SOURCE_LONG_RAW: SourceRef = { namespace: 'home-energy.synthetic', sourceId: 'soc-long-raw-v1' }
const SOURCE_LONG: SourceRef = { namespace: 'home-energy.synthetic', sourceId: 'soc-long-normalized-v1' }
const OBJECT_WIDE: SourceObjectRef = { sourceRef: SOURCE_WIDE, objectPath: 'soc_readings_wide' }
const OBJECT_LONG_RAW: SourceObjectRef = { sourceRef: SOURCE_LONG_RAW, objectPath: 'soc_metrics_long' }
const OBJECT_LONG: SourceObjectRef = { sourceRef: SOURCE_LONG, objectPath: 'soc_readings_long_normalized' }

const WIDE_ROWS = [
  ['synthetic-home-1', '2026-01-01T00:00:00Z', 40],
  ['synthetic-home-1', '2026-01-01T00:15:00Z', 50],
  ['synthetic-home-2', '2026-01-01T00:15:00Z', 80],
] as const

const LONG_ROWS = [
  ['synthetic-home-1', '2026-01-01T00:00:00Z', 'BATTERY_SOC_BP', 4000, 'bp'],
  ['synthetic-home-1', '2026-01-01T00:00:00Z', 'BATTERY_TEMP_C', 22, 'C'],
  ['synthetic-home-1', '2026-01-01T00:15:00Z', 'BATTERY_SOC_BP', 5000, 'bp'],
  ['synthetic-home-1', '2026-01-01T00:15:00Z', 'BATTERY_TEMP_C', 23, 'C'],
  ['synthetic-home-2', '2026-01-01T00:15:00Z', 'BATTERY_SOC_BP', 8000, 'bp'],
] as const

const relations: RegisteredRelation[] = [
  {
    relation: 'soc_readings_wide', objectRef: OBJECT_WIDE, schemaRevision: 'synthetic-wide@1',
    columns: [
      { name: 'site_key', type: 'string' },
      { name: 'sample_utc', type: 'timestamp' },
      { name: 'soc_percent', type: 'decimal' },
    ],
    physicalTypes: { sample_utc: 'TIMESTAMP', soc_percent: 'DECIMAL(10,2)' },
  },
  {
    relation: 'soc_metrics_long', objectRef: OBJECT_LONG_RAW, schemaRevision: 'synthetic-long-raw@1',
    columns: [
      { name: 'asset_id', type: 'string' },
      { name: 'time_utc', type: 'timestamp' },
      { name: 'metric_code', type: 'string' },
      { name: 'number_value', type: 'decimal' },
      { name: 'unit_code', type: 'string' },
    ],
    physicalTypes: { time_utc: 'TIMESTAMP', number_value: 'DECIMAL(12,2)' },
  },
  {
    relation: 'soc_readings_long_normalized', objectRef: OBJECT_LONG, schemaRevision: 'synthetic-long-normalized@1',
    columns: [
      { name: 'asset_id', type: 'string' },
      { name: 'time_utc', type: 'timestamp' },
      { name: 'soc_basis_points', type: 'decimal' },
    ],
    physicalTypes: { time_utc: 'TIMESTAMP', soc_basis_points: 'DECIMAL(12,2)' },
  },
]

function normalizeLongRows(): (string | number)[][] {
  const selected = new Map<string, (string | number)[]>()
  for (const [site, time, code, value, unit] of LONG_ROWS) {
    if (code !== 'BATTERY_SOC_BP') continue
    if (unit !== 'bp' || !Number.isFinite(value) || value < 0 || value > 10_000) {
      throw new Error('synthetic long SOC has an invalid unit or range')
    }
    const key = `${site}\u0000${time}`
    if (selected.has(key)) throw new Error('synthetic long SOC has a duplicate site/time observation')
    selected.set(key, [site, time, value])
  }
  if (selected.size === 0) throw new Error('synthetic long SOC has no recognized measurements')
  return [...selected.values()]
}

function mappingFor(id: string, objectRef: SourceObjectRef, relation: string, siteColumn: string, timeColumn: string, socColumn: string, factor: number) {
  return defineSemanticMapping(`${id}.soc-mapping`, '1.0.0', {
    dialect: 'duckdb',
    objects: [{
      conceptId: 'battery_soc_reading', sourceObjectRef: objectRef,
      schema: 'main', relation, relationKind: 'table', estimatedRows: 3,
      timeFieldRef: 'recorded_at',
      fields: [
        { fieldRef: 'site_ref', column: siteColumn, valueType: 'string' as const, identityKey: true },
        { fieldRef: 'recorded_at', column: timeColumn, valueType: 'timestamp' as const },
        { fieldRef: 'soc_percent', column: socColumn, valueType: 'quantity' as const,
          unit: { unitCode: '%', dimension: 'percentage' }, unitFactor: factor },
      ],
    }],
    links: [],
  })
}

const MAPPING_WIDE = mappingFor(PROFILE_WIDE.id, OBJECT_WIDE, 'soc_readings_wide', 'site_key', 'sample_utc', 'soc_percent', 1)
const MAPPING_LONG = mappingFor(PROFILE_LONG.id, OBJECT_LONG, 'soc_readings_long_normalized', 'asset_id', 'time_utc', 'soc_basis_points', 100)

export interface LocalStructuredProfile {
  readonly profileRef: ProfileRef
  readonly resolvedProfile: ResolvedProfile
  readonly sourceRefs: readonly SourceRef[]
  readonly maxRows: number
  planForSite(siteRef: string): SemanticQueryPlan
}

export interface LocalStructuredProfiles {
  readonly query: DuckDbQueryAdapter
  readonly mappings: InMemorySemanticMappingRegistry
  readonly profiles: readonly LocalStructuredProfile[]
  resolveToolAccess(profileRef: ProfileRef): { sourceRefs: readonly SourceRef[]; maxRows: number } | undefined
  close(): void
}

/** Compose two deployments against one canonical SOC concept and one query operation. */
export async function createLocalStructuredProfiles(refs: {
  tenantId: string
  spaceId: string
  runtimeRef: VersionRef
  policyRef: VersionRef
  industryRef: VersionRef
}): Promise<LocalStructuredProfiles> {
  const query = new DuckDbQueryAdapter({
    relations, catalogSchemaRevision: 'synthetic-soc@1', consistency: 'immutable',
    defaultLimits: { maxRows: 100, maxBytes: 65_536, maxDurationMs: 5_000 },
  })
  try {
    await query.start()
    await query.materialiseRelation('soc_readings_wide', WIDE_ROWS)
    await query.materialiseRelation('soc_metrics_long', LONG_ROWS)
    await query.materialiseRelation('soc_readings_long_normalized', normalizeLongRows())
  } catch (error) {
    query.close()
    throw error
  }

  const build = (
    profileRef: ProfileRef, mapping: typeof MAPPING_WIDE, objectRef: SourceObjectRef,
  ): LocalStructuredProfile => {
    const snapshotHash = sha256DigestOf(`${profileRef.id}@${profileRef.version}:${mapping.mappingRef.digest}:synthetic-soc@1`)
    const resolvedProfile: ResolvedProfile = {
      industryRef: refs.industryRef,
      mappingRefs: [{ ...mapping.mappingRef, role: 'telemetry', sourceObjectRef: objectRef, schemaRevision: 'synthetic-soc@1' }],
      runtimeRef: refs.runtimeRef,
      backendBindings: { telemetry: {
        role: 'telemetry', adapterRef: DATA_DUCKDB_ADAPTER_REF,
        capabilityNames: ['structured_query.execute'],
        scopeRef: { tenantId: refs.tenantId, spaceId: refs.spaceId },
        mappingRef: mapping.mappingRef.id,
      } },
      modelBindings: {}, toolBindings: [{ toolId: 'data_query', enabled: true, maxCallsPerRun: 2 }],
      computeBindings: [], policyRef: refs.policyRef,
      resolvedVersions: [refs.industryRef, refs.runtimeRef, refs.policyRef, mapping.mappingRef, DATA_DUCKDB_ADAPTER_REF],
      resolvedCapabilities: [], explicitDegradations: [], snapshotHash,
      resolvedAt: new Date().toISOString(),
    }
    return {
      profileRef, resolvedProfile, sourceRefs: [objectRef.sourceRef], maxRows: 100,
      planForSite(siteRef): SemanticQueryPlan {
        if (siteRef.length === 0 || siteRef.length > 128) throw new Error('siteRef must have 1–128 characters')
        return {
          mode: 'semantic', concepts: ['battery_soc_reading'],
          fields: ['site_ref', 'soc_percent'], links: [],
          filters: [{ fieldRef: 'site_ref', op: 'eq', values: [siteRef] }],
          aggregation: { kind: 'avg', fieldRefs: ['soc_percent'], groupBy: ['site_ref'] },
          orderBy: [], limit: 1,
          mappingVersion: mapping.mappingRef,
        }
      },
    }
  }
  const profiles = [build(PROFILE_WIDE, MAPPING_WIDE, OBJECT_WIDE), build(PROFILE_LONG, MAPPING_LONG, OBJECT_LONG)]
  return {
    query, mappings: new InMemorySemanticMappingRegistry([MAPPING_WIDE, MAPPING_LONG]), profiles,
    resolveToolAccess(profileRef) {
      const found = profiles.find((profile) => profile.profileRef.id === profileRef.id && profile.profileRef.version === profileRef.version)
      return found === undefined ? undefined : { sourceRefs: found.sourceRefs, maxRows: found.maxRows }
    },
    close() { query.close() },
  }
}
