import type { QueryColumn, SemanticQueryPlan, SourceObjectRef, SourceRef } from '@ontology/contracts'
import {
  defineSemanticMapping,
  type CompilationBudget,
  type SemanticMapping,
} from '@ontology/semantic-engine'

/**
 * Two customer mappings that align the synthetic source data sets to the `home-energy`
 * `observation_series` concept (LOCAL-042, E-01/T003a).
 *
 * The pack declares canonical units (kW / kWh) and canonical field ids; each mapping
 * translates one source's physical columns, unit factors and status encoding into those
 * canonical values. Source A is in W/Wh with a numeric quality code; source B is in
 * kW/kWh with a text quality label. The same semantic query must produce equal normalised
 * results through both, which proves the two data sets are aligned only through mapping.
 */

export const HOME_ENERGY_OBSERVATION_CONCEPT = 'observation_series'

export const HOME_ENERGY_SOURCE_A: SourceRef = {
  namespace: 'home-energy',
  sourceId: 'synthetic-source-a',
}
export const HOME_ENERGY_SOURCE_B: SourceRef = {
  namespace: 'home-energy',
  sourceId: 'synthetic-source-b',
}

export const HOME_ENERGY_OBJECT_A: SourceObjectRef = {
  sourceRef: HOME_ENERGY_SOURCE_A,
  objectPath: 'public.synthetic_observation_a',
}
export const HOME_ENERGY_OBJECT_B: SourceObjectRef = {
  sourceRef: HOME_ENERGY_SOURCE_B,
  objectPath: 'public.synthetic_observation_b',
}

export const HOME_ENERGY_MAPPING_A: SemanticMapping = defineSemanticMapping(
  'home-energy.mapping.source-a',
  '1.0.0',
  {
    dialect: 'postgres',
    objects: [
      {
        conceptId: HOME_ENERGY_OBSERVATION_CONCEPT,
        sourceObjectRef: HOME_ENERGY_OBJECT_A,
        schema: 'public',
        relation: 'synthetic_observation_a',
        relationKind: 'table',
        estimatedRows: 4,
        timeFieldRef: 'recorded_at',
        fields: [
          {
            fieldRef: 'observation_native_id',
            column: 'obs_id',
            valueType: 'string',
            identityKey: true,
          },
          { fieldRef: 'sensor_native_id', column: 'sensor_key', valueType: 'string' },
          { fieldRef: 'recorded_at', column: 'ts', valueType: 'timestamp' },
          {
            fieldRef: 'power_kw',
            column: 'power_w',
            valueType: 'quantity',
            unit: { unitCode: 'kW', dimension: 'power' },
            unitFactor: 1000,
          },
          {
            fieldRef: 'energy_kwh',
            column: 'energy_wh',
            valueType: 'quantity',
            unit: { unitCode: 'kWh', dimension: 'energy' },
            unitFactor: 1000,
          },
          {
            fieldRef: 'quality',
            column: 'quality_code',
            valueType: 'enum',
            valueMap: [
              { physical: 1, canonical: 'good' },
              { physical: 0, canonical: 'suspect' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

export const HOME_ENERGY_MAPPING_B: SemanticMapping = defineSemanticMapping(
  'home-energy.mapping.source-b',
  '2.0.0',
  {
    dialect: 'postgres',
    objects: [
      {
        conceptId: HOME_ENERGY_OBSERVATION_CONCEPT,
        sourceObjectRef: HOME_ENERGY_OBJECT_B,
        schema: 'public',
        relation: 'synthetic_observation_b',
        relationKind: 'table',
        estimatedRows: 4,
        timeFieldRef: 'recorded_at',
        fields: [
          {
            fieldRef: 'observation_native_id',
            column: 'reading_id',
            valueType: 'string',
            identityKey: true,
          },
          { fieldRef: 'sensor_native_id', column: 'sensor_id', valueType: 'string' },
          { fieldRef: 'recorded_at', column: 'recorded_at', valueType: 'timestamp' },
          {
            fieldRef: 'power_kw',
            column: 'active_power_kw',
            valueType: 'quantity',
            unit: { unitCode: 'kW', dimension: 'power' },
            unitFactor: 1,
          },
          {
            fieldRef: 'energy_kwh',
            column: 'interval_energy_kwh',
            valueType: 'quantity',
            unit: { unitCode: 'kWh', dimension: 'energy' },
            unitFactor: 1,
          },
          {
            fieldRef: 'quality',
            column: 'quality_label',
            valueType: 'enum',
            valueMap: [
              { physical: 'OK', canonical: 'good' },
              { physical: 'BAD', canonical: 'suspect' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

/** The concept/field query both mappings must answer identically. */
export function homeEnergyObservationQuery(mapping: SemanticMapping): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [HOME_ENERGY_OBSERVATION_CONCEPT],
    fields: ['sensor_native_id', 'recorded_at', 'power_kw', 'energy_kwh', 'quality'],
    links: [],
    filters: [{ fieldRef: 'quality', op: 'eq', values: ['good'] }],
    orderBy: [
      { fieldRef: 'sensor_native_id', direction: 'asc' },
      { fieldRef: 'recorded_at', direction: 'asc' },
    ],
    limit: 100,
    mappingVersion: mapping.mappingRef,
  }
}

export const HOME_ENERGY_COMPILE_BUDGET: CompilationBudget = {
  maxRows: 1000,
  maxBytes: 1_048_576,
  maxJoinFanout: 1000,
}

export const HOME_ENERGY_EXPECTED_COLUMNS: readonly QueryColumn[] = [
  { name: 'sensor_native_id', type: 'string' },
  { name: 'recorded_at', type: 'timestamp' },
  { name: 'power_kw', type: 'decimal' },
  { name: 'energy_kwh', type: 'decimal' },
  { name: 'quality', type: 'string' },
]

/** The normalised result, in canonical kW/kWh and canonical quality labels. */
export const HOME_ENERGY_EXPECTED_ROWS: readonly (readonly unknown[])[] = [
  ['sensor-garage', '2026-01-01T00:15:00.000Z', '2.0000000000', '3.0000000000', 'good'],
  ['sensor-living', '2026-01-01T00:00:00.000Z', '3.5000000000', '5.2500000000', 'good'],
  ['sensor-living', '2026-01-01T00:15:00.000Z', '4.0000000000', '6.0000000000', 'good'],
]
