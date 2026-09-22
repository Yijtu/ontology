import type { QueryColumn, SemanticQueryPlan, SourceObjectRef, SourceRef } from '@ontology/contracts'
import {
  defineSemanticMapping,
  type CompilationBudget,
  type SemanticMapping,
} from '@ontology/semantic-engine'

/**
 * Shared fixtures for the semantic mapping/query-compilation tests.
 *
 * One logical dataset is described by three physical mappings: two PostgreSQL mappings
 * with different physical column names, different status encodings and different energy
 * units, and one DuckDB mapping. The same semantic query must produce the same normalised
 * result against all three.
 */

export const TENANT = '11111111-1111-4111-8111-111111111111'
export const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export const SOURCE_A: SourceRef = { namespace: 'home-energy', sourceId: 'warehouse-a' }
export const SOURCE_B: SourceRef = { namespace: 'home-energy', sourceId: 'warehouse-b' }
export const SOURCE_C: SourceRef = { namespace: 'home-energy', sourceId: 'duckdb-local' }

export const OBJECT_A: SourceObjectRef = { sourceRef: SOURCE_A, objectPath: 'public.energy_readings_a' }
export const OBJECT_B: SourceObjectRef = { sourceRef: SOURCE_B, objectPath: 'public.energy_readings_b' }
export const OBJECT_C: SourceObjectRef = { sourceRef: SOURCE_C, objectPath: 'energy_readings_c' }
export const METER_A: SourceObjectRef = { sourceRef: SOURCE_A, objectPath: 'public.meters_a' }

export const READING_CONCEPT = 'energy_reading'
export const METER_CONCEPT = 'meter'

export const READING_COLUMNS: readonly QueryColumn[] = [
  { name: 'reading_id', type: 'string' },
  { name: 'meter_id', type: 'string' },
  { name: 'recorded_at', type: 'timestamp' },
  { name: 'energy_kwh', type: 'decimal' },
  { name: 'status', type: 'string' },
]

/** Logical rows: [reading_id, meter_id, recorded_at, energy_kwh, status]. */
export const LOGICAL_ROWS: readonly (readonly [string, string, string, number, string])[] = [
  ['r1', 'm1', '2026-01-01T00:00:00Z', 12.5, 'good'],
  ['r2', 'm1', '2026-01-02T00:00:00Z', 8.25, 'suspect'],
  ['r3', 'm1', '2026-01-03T00:00:00Z', 15.0, 'good'],
  ['r4', 'm2', '2026-01-01T00:00:00Z', 20.0, 'good'],
  ['r5', 'm2', '2026-01-02T00:00:00Z', 9.75, 'suspect'],
  ['r6', 'm3', '2026-01-01T00:00:00Z', 11.0, 'good'],
]

export const MAPPING_A: SemanticMapping = defineSemanticMapping('home-energy.mapping.a', '1.0.0', {
  dialect: 'postgres',
  objects: [
    {
      conceptId: READING_CONCEPT,
      sourceObjectRef: OBJECT_A,
      schema: 'public',
      relation: 'energy_readings_a',
      relationKind: 'table',
      estimatedRows: LOGICAL_ROWS.length,
      timeFieldRef: 'recorded_at',
      fields: [
        { fieldRef: 'reading_id', column: 'reading_id', valueType: 'string', identityKey: true },
        { fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'recorded_at', column: 'recorded_at', valueType: 'timestamp' },
        {
          fieldRef: 'energy_kwh',
          column: 'energy_wh',
          valueType: 'quantity',
          unit: { unitCode: 'kWh', dimension: 'energy' },
          unitFactor: 1000,
        },
        {
          fieldRef: 'status',
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
})

export const MAPPING_B: SemanticMapping = defineSemanticMapping('home-energy.mapping.b', '2.0.0', {
  dialect: 'postgres',
  objects: [
    {
      conceptId: READING_CONCEPT,
      sourceObjectRef: OBJECT_B,
      schema: 'public',
      relation: 'energy_readings_b',
      relationKind: 'table',
      estimatedRows: LOGICAL_ROWS.length,
      timeFieldRef: 'recorded_at',
      fields: [
        { fieldRef: 'reading_id', column: 'reading_id', valueType: 'string', identityKey: true },
        { fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'recorded_at', column: 'recorded_at', valueType: 'timestamp' },
        {
          fieldRef: 'energy_kwh',
          column: 'energy_kwh',
          valueType: 'quantity',
          unit: { unitCode: 'kWh', dimension: 'energy' },
          unitFactor: 1,
        },
        {
          fieldRef: 'status',
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
})

export const MAPPING_C: SemanticMapping = defineSemanticMapping('home-energy.mapping.c', '1.0.0', {
  dialect: 'duckdb',
  objects: [
    {
      conceptId: READING_CONCEPT,
      sourceObjectRef: OBJECT_C,
      schema: 'main',
      relation: 'energy_readings_c',
      relationKind: 'table',
      estimatedRows: LOGICAL_ROWS.length,
      timeFieldRef: 'recorded_at',
      fields: [
        { fieldRef: 'reading_id', column: 'reading_id', valueType: 'string', identityKey: true },
        { fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'recorded_at', column: 'recorded_at', valueType: 'timestamp' },
        {
          fieldRef: 'energy_kwh',
          column: 'energy_kwh',
          valueType: 'quantity',
          unit: { unitCode: 'kWh', dimension: 'energy' },
          unitFactor: 1,
        },
        {
          fieldRef: 'status',
          column: 'status_text',
          valueType: 'enum',
          valueMap: [
            { physical: 'ok', canonical: 'good' },
            { physical: 'bad', canonical: 'suspect' },
          ],
        },
      ],
    },
  ],
  links: [],
})

/** A same-source join with explicit keys, used for the relation-key/scope checks. */
export const MAPPING_JOIN: SemanticMapping = defineSemanticMapping('home-energy.mapping.join', '1.0.0', {
  dialect: 'postgres',
  objects: [
    {
      conceptId: READING_CONCEPT,
      sourceObjectRef: OBJECT_A,
      schema: 'public',
      relation: 'energy_readings_a',
      relationKind: 'table',
      estimatedRows: 6,
      fields: [
        { fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'energy_kwh', column: 'energy_wh', valueType: 'quantity', unitFactor: 1000 },
      ],
    },
    {
      conceptId: METER_CONCEPT,
      sourceObjectRef: METER_A,
      schema: 'public',
      relation: 'meters_a',
      relationKind: 'table',
      estimatedRows: 3,
      fields: [
        { fieldRef: 'meter_key', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'meter_name', column: 'meter_name', valueType: 'string' },
      ],
    },
  ],
  links: [
    {
      linkId: 'reading_meter',
      fromConceptId: READING_CONCEPT,
      toConceptId: METER_CONCEPT,
      fromColumn: 'meter_id',
      toColumn: 'meter_id',
      joinKind: 'inner',
      cardinality: { min: 1, max: 1 },
      scope: { maxFanout: 1 },
    },
  ],
})

/** The same join, but the link names a key column neither endpoint declares. */
export const MAPPING_JOIN_MISSING_KEY: SemanticMapping = defineMappingJoinWithKey('not_a_column')

/** A cross-source link whose fanout exceeds the budget. */
export const MAPPING_CROSS_SOURCE: SemanticMapping = defineSemanticMapping(
  'home-energy.mapping.cross',
  '1.0.0',
  {
    dialect: 'postgres',
    objects: [
      {
        conceptId: READING_CONCEPT,
        sourceObjectRef: OBJECT_A,
        schema: 'public',
        relation: 'energy_readings_a',
        relationKind: 'table',
        estimatedRows: 50_000,
        fields: [{ fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' }],
      },
      {
        conceptId: METER_CONCEPT,
        sourceObjectRef: OBJECT_C,
        schema: 'main',
        relation: 'meters_c',
        relationKind: 'table',
        estimatedRows: 50_000,
        fields: [{ fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' }],
      },
    ],
    links: [
      {
        linkId: 'reading_meter',
        fromConceptId: READING_CONCEPT,
        toConceptId: METER_CONCEPT,
        fromColumn: 'meter_id',
        toColumn: 'meter_id',
        joinKind: 'inner',
        cardinality: { min: 0, max: 'unbounded' },
        scope: { maxFanout: 100_000 },
      },
    ],
  },
)

function defineMappingJoinWithKey(badKey: string): SemanticMapping {
  return defineSemanticMapping('home-energy.mapping.join-bad', '1.0.0', {
    dialect: 'postgres',
    objects: MAPPING_JOIN.objects.map((object) => ({ ...object })),
    links: [
      {
        linkId: 'reading_meter',
        fromConceptId: READING_CONCEPT,
        toConceptId: METER_CONCEPT,
        fromColumn: badKey,
        toColumn: 'meter_id',
        joinKind: 'inner',
        cardinality: { min: 1, max: 1 },
        scope: { maxFanout: 1 },
      },
    ],
  })
}

/** The concept query used by the two-mapping equivalence proof. */
export function semanticPlan(mapping: SemanticMapping): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [READING_CONCEPT],
    fields: ['meter_id', 'recorded_at', 'energy_kwh', 'status'],
    links: [],
    filters: [
      { fieldRef: 'energy_kwh', op: 'gte', values: [10] },
      { fieldRef: 'status', op: 'eq', values: ['good'] },
    ],
    orderBy: [
      { fieldRef: 'meter_id', direction: 'asc' },
      { fieldRef: 'recorded_at', direction: 'asc' },
    ],
    limit: 100,
    mappingVersion: mapping.mappingRef,
  }
}

export const EXPECTED_COLUMNS: readonly QueryColumn[] = [
  { name: 'meter_id', type: 'string' },
  { name: 'recorded_at', type: 'timestamp' },
  { name: 'energy_kwh', type: 'decimal' },
  { name: 'status', type: 'string' },
]

export const EXPECTED_ROWS: readonly (readonly unknown[])[] = [
  ['m1', '2026-01-01T00:00:00.000Z', '12.5000000000', 'good'],
  ['m1', '2026-01-03T00:00:00.000Z', '15.0000000000', 'good'],
  ['m2', '2026-01-01T00:00:00.000Z', '20.0000000000', 'good'],
  ['m3', '2026-01-01T00:00:00.000Z', '11.0000000000', 'good'],
]

export const COMPILE_BUDGET: CompilationBudget = {
  maxRows: 1000,
  maxBytes: 1_048_576,
  maxJoinFanout: 1000,
}

/** Physical rows for each backend, derived from the logical rows. */
export function rowsForMappingA(): readonly (readonly (string | number | null)[])[] {
  return LOGICAL_ROWS.map(([readingId, meterId, recordedAt, kwh, status]) => [
    readingId,
    meterId,
    recordedAt,
    kwh * 1000,
    status === 'good' ? 1 : 0,
  ])
}

export function rowsForMappingB(): readonly (readonly (string | number | null)[])[] {
  return LOGICAL_ROWS.map(([readingId, meterId, recordedAt, kwh, status]) => [
    readingId,
    meterId,
    recordedAt,
    kwh,
    status === 'good' ? 'OK' : 'BAD',
  ])
}

export function rowsForMappingC(): readonly (readonly (string | number | null)[])[] {
  return LOGICAL_ROWS.map(([readingId, meterId, recordedAt, kwh, status]) => [
    readingId,
    meterId,
    recordedAt,
    kwh,
    status === 'good' ? 'ok' : 'bad',
  ])
}
