import type {
  Rfc3339UtcTimestamp,
  SourceRef,
  SourceSnapshot,
  TimeWindow,
  VersionRef,
} from '@ontology/contracts'
import type {
  CoverageDeclaration,
  DeclaredConversionSet,
  InputVersions,
  SocConversionDeclaration,
  SocToEnergyDeclaration,
  UnitConversionDeclaration,
} from '@ontology/extension-home-energy'
import type { SemanticMapping } from '@ontology/semantic-engine'
import {
  HOME_ENERGY_MAPPING_A,
  HOME_ENERGY_MAPPING_B,
  HOME_ENERGY_SOURCE_A,
  HOME_ENERGY_SOURCE_B,
} from './mappings'
import { SYNTHETIC_DATASET_A_METADATA, SYNTHETIC_DATASET_B_METADATA } from './datasets'

/**
 * Shared fixtures for the energy input normalisation (LOCAL-043).
 *
 * The declared conversions are *derived* from the LOCAL-042 customer mappings and the data-set
 * metadata: the mapping declares the canonical unit and the unit factor, the data-set metadata
 * declares the physical source unit. The extension never hardcodes a factor, and an undeclared
 * source unit is refused.
 */

export function digestOf(fill: string): string {
  return `sha256:${fill.repeat(64)}`
}

export function versionRef(id: string, version: string, fill: string): VersionRef {
  return { id, version, digest: digestOf(fill) }
}

export function sourceSnapshot(
  sourceRef: SourceRef,
  readAt: Rfc3339UtcTimestamp,
  asOf: Rfc3339UtcTimestamp,
  fill: string,
): SourceSnapshot {
  return {
    sourceRef,
    schemaVersion: '1.0.0',
    readAt,
    asOf,
    consistency: 'repeatable_read',
    resultDigest: digestOf(fill),
  }
}

export const HOME_ENERGY_INPUT_VERSIONS: InputVersions = {
  mapping: versionRef('home-energy.mapping', '2.0.0', '1'),
  deviceSpec: versionRef('home-energy.device-spec.battery-1', '1.0.0', '2'),
  tariff: versionRef('home-energy.tariff', '1.0.0', '3'),
  userConstraint: versionRef('home-energy.user-constraint', '1.0.0', '4'),
}

/** The model/scenario version a forecast names; a forecast is never version-free. */
export const HOME_ENERGY_FORECAST_MODEL_VERSION: VersionRef = versionRef(
  'home-energy.forecast.persistence',
  '1.0.0',
  '8',
)

function metricOfDimension(dimension: string): 'power' | 'energy' | undefined {
  if (dimension === 'power') return 'power'
  if (dimension === 'energy') return 'energy'
  return undefined
}

interface SourceUnits {
  readonly power: string
  readonly energy: string
}

function unitConversionsFromMapping(
  mapping: SemanticMapping,
  sourceUnits: SourceUnits,
): UnitConversionDeclaration[] {
  const declarations: UnitConversionDeclaration[] = []
  for (const object of mapping.objects) {
    for (const field of object.fields) {
      if (field.unit === undefined) continue
      const metric = metricOfDimension(field.unit.dimension)
      if (metric === undefined) continue
      const sourceUnit = sourceUnits[metric]
      declarations.push({
        conversionRef: mapping.mappingRef,
        metric,
        sourceUnit,
        canonicalUnit: field.unit.unitCode,
        factor: 1 / (field.unitFactor ?? 1),
      })
    }
  }
  return declarations
}

export const SOC_PERCENT_CONVERSION: SocConversionDeclaration = {
  conversionRef: versionRef('home-energy.soc.percent', '1.0.0', '5'),
  sourceUnit: '%',
  canonicalUnit: 'ratio',
  factor: 0.01,
}

export const SOC_RATIO_CONVERSION: SocConversionDeclaration = {
  conversionRef: versionRef('home-energy.soc.ratio', '1.0.0', '6'),
  sourceUnit: 'ratio',
  canonicalUnit: 'ratio',
  factor: 1,
}

export const SOC_TO_ENERGY_BATTERY_1: SocToEnergyDeclaration = {
  conversionRef: versionRef('home-energy.soc-to-energy.battery-1', '1.0.0', '7'),
  deviceRef: 'battery-1',
  energyCapacityKwh: 10,
  factor: 1,
}

/** Conversions aligned only through the two customer mappings plus the declared SOC mappings. */
export function homeEnergyDeclaredConversions(): DeclaredConversionSet {
  return {
    unitConversions: [
      ...unitConversionsFromMapping(HOME_ENERGY_MAPPING_A, SYNTHETIC_DATASET_A_METADATA.sourceUnits),
      ...unitConversionsFromMapping(HOME_ENERGY_MAPPING_B, SYNTHETIC_DATASET_B_METADATA.sourceUnits),
    ],
    socConversions: [SOC_PERCENT_CONVERSION, SOC_RATIO_CONVERSION],
    socToEnergy: [SOC_TO_ENERGY_BATTERY_1],
  }
}

export const SITE_MEASUREMENT_POINT = 'mp-site'
export const LIVING_MEASUREMENT_POINT = 'mp-living'
export const GARAGE_MEASUREMENT_POINT = 'mp-garage'

/**
 * A parent site meter and two sub-circuits. Summing all three double counts the parent; the
 * coverage resolver keeps only the parent additive and marks the children redundant.
 */
export const HOME_ENERGY_COVERAGE: readonly CoverageDeclaration[] = [
  { measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', coverageRef: 'load:site' },
  {
    measurementPointRef: LIVING_MEASUREMENT_POINT,
    metric: 'power',
    coverageRef: 'load:living',
    parentCoverageRef: 'load:site',
  },
  {
    measurementPointRef: GARAGE_MEASUREMENT_POINT,
    metric: 'power',
    coverageRef: 'load:garage',
    parentCoverageRef: 'load:site',
  },
]

/** Two sensors that claim the *same* load: an unresolvable coverage conflict. */
export const HOME_ENERGY_CONFLICTING_COVERAGE: readonly CoverageDeclaration[] = [
  { measurementPointRef: 'mp-a', metric: 'power', coverageRef: 'load:shared' },
  { measurementPointRef: 'mp-b', metric: 'power', coverageRef: 'load:shared' },
]

export const HOME_ENERGY_SOURCE_A_REF: SourceRef = HOME_ENERGY_SOURCE_A
export const HOME_ENERGY_SOURCE_B_REF: SourceRef = HOME_ENERGY_SOURCE_B

/** The 15-minute local day the DST fixtures align against. */
export const SPRING_FORWARD_LOCAL_DATE = '2026-03-29'
export const FALL_BACK_LOCAL_DATE = '2026-10-25'
export const DST_TIME_ZONE = 'Europe/Berlin'

export const OBSERVATION_WINDOW: TimeWindow = {
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-01T01:00:00Z',
}
