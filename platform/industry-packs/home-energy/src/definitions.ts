import type { StandardProvenance } from '@ontology/contracts'
import type {
  HomeEnergyAttributeDefinition,
  HomeEnergyDefinitionContent,
  HomeEnergyIdentityScopeDefinition,
  HomeEnergyObjectDefinition,
  HomeEnergyRelationDefinition,
  HomeEnergyRuleConstraintDefinition,
} from './types'

/**
 * The `home-energy` industry-core declaration (SPEC E1–E3, §7; ADR-10, INV-03).
 *
 * It defines site, device, measurement point (sensor), load coverage, price, observed and
 * forecast series, constraint and plan semantics. It carries no SDK, library, Home
 * Assistant address, credential, physical column name, customer instance or executable
 * script; the concrete source naming/units are aligned only through a customer mapping.
 *
 * The model keeps four distinctions explicit, because conflating them is a correctness
 * bug, not a formatting choice:
 *   - `device` (a physical asset) vs `sensor` (a measurement point that monitors a device)
 *   - `power` (kW, an instantaneous rate) vs `energy` (kWh, an accumulated amount)
 *   - `forecast` (issued before its target window) vs `observed` (recorded after the fact)
 *   - device specifications vs measured quantities (a sensor never declares device specs)
 */

export const HOME_ENERGY_NAMESPACE = 'home-energy'
export const HOME_ENERGY_DEFINITION_ID = 'home-energy.core'
export const HOME_ENERGY_DEFINITION_VERSION = '0.1.0'

const IEC_PROVENANCE: StandardProvenance = {
  standardRef: {
    id: 'iec-61850-7-420',
    version: '2.0.0',
    digest: `sha256:${'1'.repeat(64)}`,
  },
  provenanceKind: 'international_standard',
  clauseRef: 'IEC 61850-7-420 Ed.2 clause 5',
}

/**
 * FR-31: the parameter semantics in this pack are simulated assumptions, never a real
 * device specification. Labelling them as `synthetic_assumption` is part of the asset, so
 * an exported pack cannot present invented numbers as an official standard.
 */
const SYNTHETIC_PROVENANCE: StandardProvenance = {
  standardRef: {
    id: 'home-energy.synthetic-assumptions',
    version: '0.1.0',
    digest: `sha256:${'2'.repeat(64)}`,
  },
  provenanceKind: 'synthetic_assumption',
  clauseRef: 'hackathon fixture assumptions; no real device specification',
}

export const HOME_ENERGY_STANDARD_PROVENANCE: readonly StandardProvenance[] = [
  IEC_PROVENANCE,
  SYNTHETIC_PROVENANCE,
]

const PROVENANCE: readonly StandardProvenance[] = HOME_ENERGY_STANDARD_PROVENANCE

function object(id: string, displayName: string): HomeEnergyObjectDefinition {
  return {
    kind: 'object',
    id,
    namespace: HOME_ENERGY_NAMESPACE,
    displayName,
    identityScopeId: `${id}_identity`,
    standardProvenance: PROVENANCE,
  }
}

function scope(objectId: string, dimensions: readonly string[]): HomeEnergyIdentityScopeDefinition {
  return {
    kind: 'identity_scope',
    id: `${objectId}_identity`,
    namespace: HOME_ENERGY_NAMESPACE,
    objectId,
    scopeDimensions: dimensions,
    identityAttributeIds: [`${objectId}_native_id`],
    standardProvenance: PROVENANCE,
  }
}

function nativeId(objectId: string): HomeEnergyAttributeDefinition {
  return {
    kind: 'attribute',
    id: `${objectId}_native_id`,
    namespace: HOME_ENERGY_NAMESPACE,
    objectId,
    valueType: 'string',
    cardinality: { min: 1, max: 1 },
    identityKey: true,
    standardProvenance: PROVENANCE,
  }
}

interface AttributeOptions {
  readonly cardinality?: HomeEnergyAttributeDefinition['cardinality']
  readonly unit?: HomeEnergyAttributeDefinition['unit']
  readonly enumValues?: readonly string[]
  readonly referencesObjectId?: string
}

function attribute(
  objectId: string,
  id: string,
  valueType: HomeEnergyAttributeDefinition['valueType'],
  options?: AttributeOptions,
): HomeEnergyAttributeDefinition {
  return {
    kind: 'attribute',
    id,
    namespace: HOME_ENERGY_NAMESPACE,
    objectId,
    valueType,
    cardinality: options?.cardinality ?? { min: 0, max: 1 },
    ...(options?.unit === undefined ? {} : { unit: options.unit }),
    ...(options?.enumValues === undefined ? {} : { enumValues: options.enumValues }),
    ...(options?.referencesObjectId === undefined
      ? {}
      : { referencesObjectId: options.referencesObjectId }),
    standardProvenance: PROVENANCE,
  }
}

function relation(
  id: string,
  fromObjectId: string,
  toObjectId: string,
  max: number | 'unbounded',
): HomeEnergyRelationDefinition {
  return {
    kind: 'relation',
    id,
    namespace: HOME_ENERGY_NAMESPACE,
    fromObjectId,
    toObjectId,
    cardinality: { min: 0, max },
    standardProvenance: PROVENANCE,
  }
}

function rule(
  id: string,
  objectId: string,
  severity: HomeEnergyRuleConstraintDefinition['severity'],
  expression: HomeEnergyRuleConstraintDefinition['expression'],
): HomeEnergyRuleConstraintDefinition {
  return {
    kind: 'rule_constraint',
    id,
    namespace: HOME_ENERGY_NAMESPACE,
    objectId,
    severity,
    expression,
    standardProvenance: PROVENANCE,
  }
}

/** kW is a rate; kWh is an amount. The suffix fixes the only valid unit for each. */
const POWER_UNIT = { unitCode: 'kW', dimension: 'power' } as const
const ENERGY_UNIT = { unitCode: 'kWh', dimension: 'energy' } as const
const PRICE_UNIT = { unitCode: 'CNY/kWh', dimension: 'price' } as const

export const HOME_ENERGY_DEFINITIONS: HomeEnergyDefinitionContent = {
  definitionId: HOME_ENERGY_DEFINITION_ID,
  version: HOME_ENERGY_DEFINITION_VERSION,
  namespace: HOME_ENERGY_NAMESPACE,
  layer: 'industry_core',
  standardProvenance: PROVENANCE,
  objects: [
    object('site', 'Site / Household'),
    object('device', 'Device'),
    object('sensor', 'Measurement Point (Sensor)'),
    object('load_group', 'Load Group'),
    object('tariff', 'Tariff Schedule'),
    object('observation_series', 'Observation Series'),
    object('forecast_series', 'Forecast Series'),
    object('energy_constraint', 'Energy Constraint'),
    object('energy_plan', 'Energy Plan'),
  ],
  attributes: [
    nativeId('site'),
    attribute('site', 'site_time_zone', 'string', { cardinality: { min: 1, max: 1 } }),
    attribute('site', 'metering_boundary', 'string', { cardinality: { min: 1, max: 1 } }),

    nativeId('device'),
    attribute('device', 'device_name', 'string'),
    attribute('device', 'device_kind', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['battery', 'inverter', 'pv_system', 'load_group'],
    }),
    attribute('device', 'rated_power_kw', 'quantity', { unit: POWER_UNIT }),
    attribute('device', 'energy_capacity_kwh', 'quantity', { unit: ENERGY_UNIT }),
    attribute('device', 'grid_charging_allowed', 'boolean'),
    attribute('device', 'export_allowed', 'boolean'),
    attribute('device', 'islanding_supported', 'boolean'),
    attribute('device', 'device_spec_source', 'enum', {
      enumValues: ['vendor_specification', 'synthetic_assumption'],
    }),

    nativeId('sensor'),
    attribute('sensor', 'sensor_metric', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['power', 'energy', 'state_of_charge'],
    }),
    attribute('sensor', 'sensor_unit_code', 'string', { cardinality: { min: 1, max: 1 } }),
    attribute('sensor', 'sensor_direction', 'enum', {
      enumValues: ['import', 'export', 'none'],
    }),
    attribute('sensor', 'monitored_device', 'reference', {
      referencesObjectId: 'device',
    }),
    attribute('sensor', 'coverage_valid_from', 'timestamp'),

    nativeId('load_group'),
    attribute('load_group', 'load_name', 'string', { cardinality: { min: 1, max: 1 } }),
    attribute('load_group', 'is_critical_load', 'boolean'),
    attribute('load_group', 'parent_load_group', 'reference', {
      referencesObjectId: 'load_group',
    }),
    attribute('load_group', 'covered_by_sensor', 'reference', {
      referencesObjectId: 'sensor',
    }),

    nativeId('tariff'),
    attribute('tariff', 'currency_code', 'string', { cardinality: { min: 1, max: 1 } }),
    attribute('tariff', 'region', 'string'),
    attribute('tariff', 'tariff_time_zone', 'string', { cardinality: { min: 1, max: 1 } }),
    attribute('tariff', 'purchase_price', 'quantity', { unit: PRICE_UNIT }),
    attribute('tariff', 'export_price', 'quantity', { unit: PRICE_UNIT }),
    attribute('tariff', 'valid_from', 'timestamp'),
    attribute('tariff', 'valid_to', 'timestamp'),

    nativeId('observation_series'),
    attribute('observation_series', 'observed_metric', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['power', 'energy', 'state_of_charge'],
    }),
    attribute('observation_series', 'observed_unit_code', 'string', {
      cardinality: { min: 1, max: 1 },
    }),
    attribute('observation_series', 'recorded_at', 'timestamp', {
      cardinality: { min: 1, max: 1 },
    }),
    attribute('observation_series', 'quality', 'enum', {
      enumValues: ['good', 'suspect', 'missing'],
    }),
    attribute('observation_series', 'observation_data_mode', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['synthetic', 'observed'],
    }),

    nativeId('forecast_series'),
    attribute('forecast_series', 'forecast_metric', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['power', 'energy', 'state_of_charge'],
    }),
    attribute('forecast_series', 'forecast_unit_code', 'string', {
      cardinality: { min: 1, max: 1 },
    }),
    attribute('forecast_series', 'issued_at', 'timestamp', { cardinality: { min: 1, max: 1 } }),
    attribute('forecast_series', 'target_start', 'timestamp'),
    attribute('forecast_series', 'target_end', 'timestamp'),
    attribute('forecast_series', 'forecast_method', 'string'),
    attribute('forecast_series', 'forecast_data_mode', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['forecast', 'synthetic'],
    }),

    nativeId('energy_constraint'),
    attribute('energy_constraint', 'reserve_energy_kwh', 'quantity', { unit: ENERGY_UNIT }),
    attribute('energy_constraint', 'reserve_window_start', 'timestamp'),
    attribute('energy_constraint', 'reserve_window_end', 'timestamp'),
    attribute('energy_constraint', 'constraint_source', 'enum', {
      enumValues: ['user_preference', 'device_hard_constraint'],
    }),

    nativeId('energy_plan'),
    attribute('energy_plan', 'plan_status', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['feasible', 'infeasible', 'insufficient_data', 'unsupported_topology'],
    }),
    attribute('energy_plan', 'input_manifest_hash', 'string'),
    attribute('energy_plan', 'algorithm', 'string'),
    attribute('energy_plan', 'optimality', 'enum', {
      enumValues: ['not_claimed', 'best_of_tested_candidates'],
    }),
    attribute('energy_plan', 'plan_data_mode', 'enum', {
      cardinality: { min: 1, max: 1 },
      enumValues: ['simulation', 'synthetic'],
    }),
  ],
  relations: [
    relation('site_has_device', 'site', 'device', 'unbounded'),
    relation('site_has_tariff', 'site', 'tariff', 'unbounded'),
    relation('sensor_monitors_device', 'sensor', 'device', 'unbounded'),
    relation('load_group_parent', 'load_group', 'load_group', 'unbounded'),
    relation('load_group_covers_sensor', 'load_group', 'sensor', 'unbounded'),
    relation('plan_honours_constraint', 'energy_plan', 'energy_constraint', 'unbounded'),
  ],
  identityScopes: [
    scope('site', ['source', 'site']),
    scope('device', ['source', 'site', 'device_kind']),
    scope('sensor', ['source', 'site', 'sensor_metric']),
    scope('load_group', ['source', 'site']),
    scope('tariff', ['source', 'region']),
    scope('observation_series', ['source', 'site', 'sensor_metric']),
    scope('forecast_series', ['source', 'site', 'sensor_metric']),
    scope('energy_constraint', ['source', 'site']),
    scope('energy_plan', ['source', 'site']),
  ],
  ruleConstraints: [
    rule('device_rated_power_nonnegative', 'device', 'hard', {
      op: 'range',
      attributeId: 'rated_power_kw',
      min: 0,
    }),
    rule('device_energy_capacity_nonnegative', 'device', 'hard', {
      op: 'range',
      attributeId: 'energy_capacity_kwh',
      min: 0,
    }),
    rule('constraint_reserve_nonnegative', 'energy_constraint', 'hard', {
      op: 'range',
      attributeId: 'reserve_energy_kwh',
      min: 0,
    }),
    rule('load_group_has_measured_coverage', 'load_group', 'soft', {
      op: 'relation',
      relationId: 'load_group_covers_sensor',
    }),
  ],
}
