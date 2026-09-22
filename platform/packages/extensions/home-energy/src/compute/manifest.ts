import type {
  CapabilityLimits,
  OperationRegistry,
  OperationRef,
  RegisteredOperation,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../input'
import { ENERGY_PLANNER_ALGORITHM } from '../planning'
import { ENERGY_SIMULATOR_ALGORITHM } from '../simulation'

/**
 * Declarative home-energy compute operation manifest (SPEC E6/E8, C3/C4; ADR-11).
 *
 * The operation ids, versions, typed input schemas, declared capabilities, CPU/row/byte
 * limits and algorithm versions are declared here, once. The composition root turns this
 * manifest into the deployment's `OperationRegistry` and binds each id to a trusted handler;
 * `packages/tool-services` never imports this package, so the binding is injected at the
 * composition root and a model can only reference a registered operation id.
 *
 * The parameters are deliberately tiny: the versioned, bounded input data travels as a
 * read-only artifact reference, never as an unbounded parameter blob. Every schema is
 * `additionalProperties: false`, so there is no `code`, script, file or network field.
 */

export const ENERGY_OPERATION_VERSION = '1' as const

export type EnergyOperationId =
  | 'home-energy.plan'
  | 'home-energy.simulate'
  | 'home-energy.metrics'

export const ENERGY_OPERATION_IDS: readonly EnergyOperationId[] = [
  'home-energy.plan',
  'home-energy.simulate',
  'home-energy.metrics',
]

/** Declared capability names an operation requires (INV-08: declared, not implied). */
export const ENERGY_OPERATION_CAPABILITIES: Readonly<Record<EnergyOperationId, readonly string[]>> = {
  'home-energy.plan': ['home-energy.planning'],
  'home-energy.simulate': ['home-energy.simulation'],
  'home-energy.metrics': ['home-energy.simulation'],
}

export const ENERGY_COMPUTE_HANDLER_REF: VersionRef = {
  id: 'home-energy-compute',
  version: '1.0.0',
  digest: sha256DigestOf(new TextEncoder().encode('home-energy-compute@1.0.0')),
}

const STRATEGY_ENUM = ['self_consumption', 'reserve_first', 'price_window'] as const

const AGGREGATION_ENUM = [
  'energy_import_kwh',
  'energy_export_kwh',
  'energy_load_kwh',
  'energy_pv_used_kwh',
  'net_cost',
  'reserve_min_margin_kwh',
] as const

export type EnergyMetricAggregation = (typeof AGGREGATION_ENUM)[number]

export const ENERGY_METRIC_AGGREGATIONS: readonly EnergyMetricAggregation[] = [...AGGREGATION_ENUM]

const OPERATION_LIMITS: CapabilityLimits = {
  maxRows: 96,
  maxBytes: 262_144,
  maxDurationMs: 2_000,
}

const PLAN_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    strategyWhitelist: {
      type: 'array',
      items: { enum: [...STRATEGY_ENUM] },
      minItems: 1,
      maxItems: STRATEGY_ENUM.length,
      uniqueItems: true,
    },
  },
}

const SIMULATE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const METRICS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['aggregations'],
  properties: {
    aggregations: {
      type: 'array',
      items: { enum: [...AGGREGATION_ENUM] },
      minItems: 1,
      maxItems: AGGREGATION_ENUM.length,
      uniqueItems: true,
    },
    windowStartSlot: { type: 'integer', minimum: 0 },
    windowEndSlot: { type: 'integer', minimum: 0 },
  },
}

const COMPUTATION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['resultKind', 'computation'],
  properties: {
    resultKind: { const: 'computation' },
    computation: {
      type: 'object',
      required: ['operationRef', 'resultRef', 'algorithmVersion', 'domainStatus'],
    },
  },
}

function registeredOperation(input: {
  readonly id: EnergyOperationId
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly algorithm: VersionRef
}): RegisteredOperation {
  return {
    operationRef: { id: input.id, version: ENERGY_OPERATION_VERSION },
    inputSchema: input.inputSchema,
    outputSchema: COMPUTATION_OUTPUT_SCHEMA,
    inputSchemaDigest: sha256DigestOf(new TextEncoder().encode(canonicalJson(input.inputSchema))),
    outputSchemaDigest: sha256DigestOf(new TextEncoder().encode(canonicalJson(COMPUTATION_OUTPUT_SCHEMA))),
    handlerRef: ENERGY_COMPUTE_HANDLER_REF,
    handlerDigest: input.algorithm.digest,
    readOnly: true,
    requiredCapabilities: [...ENERGY_OPERATION_CAPABILITIES[input.id]],
    limits: OPERATION_LIMITS,
    dataMode: 'simulation',
  }
}

export const ENERGY_REGISTERED_OPERATIONS: readonly RegisteredOperation[] = [
  registeredOperation({
    id: 'home-energy.plan',
    inputSchema: PLAN_INPUT_SCHEMA,
    algorithm: ENERGY_PLANNER_ALGORITHM,
  }),
  registeredOperation({
    id: 'home-energy.simulate',
    inputSchema: SIMULATE_INPUT_SCHEMA,
    algorithm: ENERGY_SIMULATOR_ALGORITHM,
  }),
  registeredOperation({
    id: 'home-energy.metrics',
    inputSchema: METRICS_INPUT_SCHEMA,
    algorithm: ENERGY_SIMULATOR_ALGORITHM,
  }),
]

/** The deployment registry the composition root binds; adding an operation is a new version. */
export const ENERGY_OPERATION_REGISTRY: OperationRegistry = {
  namespace: 'home-energy',
  registryVersion: '1.0.0',
  registryDigest: sha256DigestOf(
    new TextEncoder().encode(canonicalJson(ENERGY_REGISTERED_OPERATIONS)),
  ),
  operations: [...ENERGY_REGISTERED_OPERATIONS],
}

/** Resolve a declared operation id to its `OperationRef` at the current version. */
export function energyOperationRef(id: EnergyOperationId): OperationRef {
  return { id, version: ENERGY_OPERATION_VERSION }
}
