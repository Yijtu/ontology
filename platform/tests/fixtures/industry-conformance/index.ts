import type {
  QueryColumn,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceRef,
} from '@ontology/contracts'
import { AUTOMOTIVE_NAMESPACE } from '@ontology/industry-pack-automotive'
import { TRANSPORT_GOVERNMENT_NAMESPACE } from '@ontology/industry-pack-transport-government'
import { defineSemanticMapping, type SemanticMapping } from '@ontology/semantic-engine'

/**
 * Shared fixtures for the V03-043 two-industry / two-mapping / two-backend conformance suite.
 *
 * Two synthetic industries — `transport-government` (road facility condition) and `automotive`
 * (EV charging availability) — each declare a concept, a physical relation and an independent
 * golden result. Neither industry name, physical column nor threshold lives in the generic
 * packages: everything is injected through the same confirmed-mapping seam that home-energy
 * uses, so the same `data_query` contract serves both without an industry branch.
 *
 * The transport concept is described by two physical mappings with different column names,
 * different status encodings and different source objects, so the canonical result must be
 * equal while each result's source locates its own physical object. A PostgreSQL mirror of the
 * first transport mapping lets the same semantic mapping run on both business SQL backends.
 */

export const INDUSTRY_SCHEMA_REVISION = 'industry-conformance@1'

export interface IndustryDataset {
  readonly namespace: string
  readonly conceptId: string
  readonly source: SourceRef
  readonly object: SourceObjectRef
  readonly relation: string
  readonly physicalColumns: readonly QueryColumn[]
  readonly physicalRows: readonly (readonly (string | number)[])[]
  readonly outputColumns: readonly QueryColumn[]
  readonly goldenRows: readonly (readonly unknown[])[]
  readonly mapping: SemanticMapping
}

// --------------------------------------------------------------------------------------------
// industry 1 — transport-government: road facility condition
// --------------------------------------------------------------------------------------------

export const TRANSPORT_NAMESPACE = TRANSPORT_GOVERNMENT_NAMESPACE
export const TRANSPORT_CONCEPT = 'road_facility'

export const TRANSPORT_SOURCE_A: SourceRef = {
  namespace: TRANSPORT_NAMESPACE,
  sourceId: 'facility-warehouse-a',
}
export const TRANSPORT_SOURCE_B: SourceRef = {
  namespace: TRANSPORT_NAMESPACE,
  sourceId: 'facility-warehouse-b',
}
export const TRANSPORT_OBJECT_A: SourceObjectRef = {
  sourceRef: TRANSPORT_SOURCE_A,
  objectPath: 'road_facilities',
}
export const TRANSPORT_OBJECT_B: SourceObjectRef = {
  sourceRef: TRANSPORT_SOURCE_B,
  objectPath: 'road_facilities_b',
}

export const TRANSPORT_RELATION_A = 'road_facilities'
export const TRANSPORT_RELATION_B = 'road_facilities_b'

/** The single semantic output of the road-facility concept, independent of the mapping. */
export const TRANSPORT_OUTPUT_COLUMNS: readonly QueryColumn[] = [
  { name: 'facility_id', type: 'string' },
  { name: 'district', type: 'string' },
  { name: 'condition', type: 'string' },
]

export const TRANSPORT_COLUMNS_A: readonly QueryColumn[] = [
  { name: 'facility_key', type: 'string' },
  { name: 'district_code', type: 'string' },
  { name: 'condition_code', type: 'integer' },
]

export const TRANSPORT_COLUMNS_B: readonly QueryColumn[] = [
  { name: 'facility_no', type: 'string' },
  { name: 'region_name', type: 'string' },
  { name: 'condition_text', type: 'string' },
]

/** Naming A: integer status code, `*_code` columns. */
export const TRANSPORT_ROWS_A: readonly (readonly (string | number)[])[] = [
  ['bridge-1', 'north', 1],
  ['tunnel-2', 'south', 0],
  ['viaduct-3', 'north', 0],
]

/** Naming B: text status label, different column names, a different source object. */
export const TRANSPORT_ROWS_B: readonly (readonly (string | number)[])[] = [
  ['bridge-1', 'north', 'inspect'],
  ['tunnel-2', 'south', 'ok'],
  ['viaduct-3', 'north', 'ok'],
]

/**
 * The independent golden result: facilities in the `north` district, ordered by id. Derived
 * from the business meaning (only `north` facilities), not read back from either mapping.
 */
export const TRANSPORT_GOLDEN_ROWS: readonly (readonly unknown[])[] = [
  ['bridge-1', 'north', 'needs_inspection'],
  ['viaduct-3', 'north', 'clear'],
]

export const TRANSPORT_MAPPING_A: SemanticMapping = defineSemanticMapping(
  'transport.facility.mapping-a',
  '1.0.0',
  {
    dialect: 'duckdb',
    objects: [
      {
        conceptId: TRANSPORT_CONCEPT,
        sourceObjectRef: TRANSPORT_OBJECT_A,
        schema: 'main',
        relation: TRANSPORT_RELATION_A,
        relationKind: 'table',
        estimatedRows: TRANSPORT_ROWS_A.length,
        fields: [
          { fieldRef: 'facility_id', column: 'facility_key', valueType: 'string', identityKey: true },
          { fieldRef: 'district', column: 'district_code', valueType: 'string' },
          {
            fieldRef: 'condition',
            column: 'condition_code',
            valueType: 'enum',
            valueMap: [
              { physical: 1, canonical: 'needs_inspection' },
              { physical: 0, canonical: 'clear' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

export const TRANSPORT_MAPPING_B: SemanticMapping = defineSemanticMapping(
  'transport.facility.mapping-b',
  '2.0.0',
  {
    dialect: 'duckdb',
    objects: [
      {
        conceptId: TRANSPORT_CONCEPT,
        sourceObjectRef: TRANSPORT_OBJECT_B,
        schema: 'main',
        relation: TRANSPORT_RELATION_B,
        relationKind: 'table',
        estimatedRows: TRANSPORT_ROWS_B.length,
        fields: [
          { fieldRef: 'facility_id', column: 'facility_no', valueType: 'string', identityKey: true },
          { fieldRef: 'district', column: 'region_name', valueType: 'string' },
          {
            fieldRef: 'condition',
            column: 'condition_text',
            valueType: 'enum',
            valueMap: [
              { physical: 'inspect', canonical: 'needs_inspection' },
              { physical: 'ok', canonical: 'clear' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

// --------------------------------------------------------------------------------------------
// industry 2 — automotive: EV charging availability
// --------------------------------------------------------------------------------------------

export const AUTOMOTIVE_CONCEPT = 'charging_station'
export const AUTOMOTIVE_SOURCE: SourceRef = {
  namespace: AUTOMOTIVE_NAMESPACE,
  sourceId: 'charging-warehouse',
}
export const AUTOMOTIVE_OBJECT: SourceObjectRef = {
  sourceRef: AUTOMOTIVE_SOURCE,
  objectPath: 'charging_stations',
}
export const AUTOMOTIVE_RELATION = 'charging_stations'

export const AUTOMOTIVE_OUTPUT_COLUMNS: readonly QueryColumn[] = [
  { name: 'station_id', type: 'string' },
  { name: 'network', type: 'string' },
  { name: 'availability', type: 'string' },
]

export const AUTOMOTIVE_COLUMNS: readonly QueryColumn[] = [
  { name: 'station_key', type: 'string' },
  { name: 'network_code', type: 'string' },
  { name: 'availability_code', type: 'integer' },
]

export const AUTOMOTIVE_ROWS: readonly (readonly (string | number)[])[] = [
  ['ev-1', 'north', 1],
  ['ev-2', 'north', 0],
  ['ev-3', 'south', 1],
]

/** The independent automotive golden result: available stations, ordered by id. */
export const AUTOMOTIVE_GOLDEN_ROWS: readonly (readonly unknown[])[] = [
  ['ev-1', 'north', 'available'],
  ['ev-3', 'south', 'available'],
]

export const AUTOMOTIVE_MAPPING: SemanticMapping = defineSemanticMapping(
  'automotive.station.mapping',
  '1.0.0',
  {
    dialect: 'duckdb',
    objects: [
      {
        conceptId: AUTOMOTIVE_CONCEPT,
        sourceObjectRef: AUTOMOTIVE_OBJECT,
        schema: 'main',
        relation: AUTOMOTIVE_RELATION,
        relationKind: 'table',
        estimatedRows: AUTOMOTIVE_ROWS.length,
        fields: [
          { fieldRef: 'station_id', column: 'station_key', valueType: 'string', identityKey: true },
          { fieldRef: 'network', column: 'network_code', valueType: 'string' },
          {
            fieldRef: 'availability',
            column: 'availability_code',
            valueType: 'enum',
            valueMap: [
              { physical: 1, canonical: 'available' },
              { physical: 0, canonical: 'occupied' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

// --------------------------------------------------------------------------------------------
// two business SQL backends — the same transport mapping mirrored to PostgreSQL
// --------------------------------------------------------------------------------------------

export const BUSINESS_PG_SCHEMA = 'business'
export const BUSINESS_PG_RELATION = 'road_facilities'
export const TRANSPORT_OBJECT_PG: SourceObjectRef = {
  sourceRef: TRANSPORT_SOURCE_A,
  objectPath: `${BUSINESS_PG_SCHEMA}.${BUSINESS_PG_RELATION}`,
}

/** The same concepts/fields/value maps as {@link TRANSPORT_MAPPING_A}, rendered for PostgreSQL. */
export const TRANSPORT_MAPPING_A_PG: SemanticMapping = defineSemanticMapping(
  'transport.facility.mapping-a',
  '1.0.0-pg',
  {
    dialect: 'postgres',
    objects: [
      {
        conceptId: TRANSPORT_CONCEPT,
        sourceObjectRef: TRANSPORT_OBJECT_PG,
        schema: BUSINESS_PG_SCHEMA,
        relation: BUSINESS_PG_RELATION,
        relationKind: 'table',
        estimatedRows: TRANSPORT_ROWS_A.length,
        fields: [
          { fieldRef: 'facility_id', column: 'facility_key', valueType: 'string', identityKey: true },
          { fieldRef: 'district', column: 'district_code', valueType: 'string' },
          {
            fieldRef: 'condition',
            column: 'condition_code',
            valueType: 'enum',
            valueMap: [
              { physical: 1, canonical: 'needs_inspection' },
              { physical: 0, canonical: 'clear' },
            ],
          },
        ],
      },
    ],
    links: [],
  },
)

// --------------------------------------------------------------------------------------------
// semantic plans — identical for every physical mapping of a concept
// --------------------------------------------------------------------------------------------

export function facilityPlan(mapping: SemanticMapping): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [TRANSPORT_CONCEPT],
    fields: ['facility_id', 'district', 'condition'],
    links: [],
    filters: [{ fieldRef: 'district', op: 'eq', values: ['north'] }],
    orderBy: [{ fieldRef: 'facility_id', direction: 'asc' }],
    limit: 100,
    mappingVersion: mapping.mappingRef,
  }
}

export function automotivePlan(mapping: SemanticMapping): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: [AUTOMOTIVE_CONCEPT],
    fields: ['station_id', 'network', 'availability'],
    links: [],
    filters: [{ fieldRef: 'availability', op: 'eq', values: ['available'] }],
    orderBy: [{ fieldRef: 'station_id', direction: 'asc' }],
    limit: 100,
    mappingVersion: mapping.mappingRef,
  }
}

/**
 * The semantic content of a mapping, ignoring the dialect and the physical binding. Two
 * mappings with the same fingerprint describe the same business data the same way; only the
 * backend-specific identifiers differ.
 */
export function semanticFingerprint(mapping: SemanticMapping): string {
  return JSON.stringify({
    objects: mapping.objects.map((object) => ({
      conceptId: object.conceptId,
      fields: object.fields.map((field) => ({
        fieldRef: field.fieldRef,
        valueType: field.valueType,
        unit: field.unit ?? null,
        unitFactor: field.unitFactor ?? 1,
        valueMap: field.valueMap ?? [],
        identityKey: field.identityKey === true,
      })),
    })),
    links: mapping.links,
  })
}

export const TRANSPORT_DATASET: IndustryDataset = {
  namespace: TRANSPORT_NAMESPACE,
  conceptId: TRANSPORT_CONCEPT,
  source: TRANSPORT_SOURCE_A,
  object: TRANSPORT_OBJECT_A,
  relation: TRANSPORT_RELATION_A,
  physicalColumns: TRANSPORT_COLUMNS_A,
  physicalRows: TRANSPORT_ROWS_A,
  outputColumns: TRANSPORT_OUTPUT_COLUMNS,
  goldenRows: TRANSPORT_GOLDEN_ROWS,
  mapping: TRANSPORT_MAPPING_A,
}

export const AUTOMOTIVE_DATASET: IndustryDataset = {
  namespace: AUTOMOTIVE_NAMESPACE,
  conceptId: AUTOMOTIVE_CONCEPT,
  source: AUTOMOTIVE_SOURCE,
  object: AUTOMOTIVE_OBJECT,
  relation: AUTOMOTIVE_RELATION,
  physicalColumns: AUTOMOTIVE_COLUMNS,
  physicalRows: AUTOMOTIVE_ROWS,
  outputColumns: AUTOMOTIVE_OUTPUT_COLUMNS,
  goldenRows: AUTOMOTIVE_GOLDEN_ROWS,
  mapping: AUTOMOTIVE_MAPPING,
}
