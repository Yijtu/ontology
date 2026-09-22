import type { DataMode, Sha256Digest } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../input'
import type { EnergyInputSnapshot } from '../input'
import type {
  BatterySpecDeclaration,
  GridSpec,
  PlanTrajectory,
  ReserveConstraint,
  SeriesBinding,
  SimulationTolerance,
  TariffBinding,
  TopologyDeclaration,
} from '../simulation'
import type { TerminalEnergyValuation } from '../planning'
import { EnergyComputeError } from './errors'

/**
 * The bounded, content-addressed input bundle a home-energy compute operation reads through
 * its scoped artifact reader (C3). It carries the normalised input snapshot plus the declared
 * device/topology/tariff/reserve parameters and (for simulate/metrics) a plan. It is written
 * by the service layer from approved, versioned source data — never by the model — and the
 * blob store verifies its digest on read, so the handler trusts exactly the approved bytes.
 *
 * The bundle is explicit about its data mode: a compute input is synthetic/observed/forecast
 * data used for a simulation. `live` is never accepted (INV-10, ADR-12).
 */

export const ENERGY_OPERATION_INPUT_KIND = 'home-energy.operation-input'
export const ENERGY_OPERATION_INPUT_VERSION = '1.0.0'
export const ENERGY_OPERATION_INPUT_MEDIA_TYPE =
  'application/vnd.ontology.energy-operation-input+json'

export type EnergyOperationInput = {
  readonly kind: typeof ENERGY_OPERATION_INPUT_KIND
  readonly version: string
  readonly dataMode: DataMode
  readonly snapshot: EnergyInputSnapshot
  readonly topology: TopologyDeclaration
  readonly battery: BatterySpecDeclaration
  readonly grid: GridSpec
  readonly load: readonly SeriesBinding[]
  readonly pv: readonly SeriesBinding[]
  readonly tariff: TariffBinding
  readonly reserves: readonly ReserveConstraint[]
  readonly tolerance: SimulationTolerance
  readonly assumptions: readonly string[]
  readonly plan?: PlanTrajectory
  readonly terminalEnergyValuation?: TerminalEnergyValuation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodeEnergyOperationInput(input: EnergyOperationInput): Uint8Array {
  return new TextEncoder().encode(canonicalJson(input))
}

export function energyOperationInputDigest(input: EnergyOperationInput): Sha256Digest {
  return sha256DigestOf(encodeEnergyOperationInput(input))
}

/**
 * Parse an archived operation input. The essential discriminants and required sub-objects are
 * checked at the boundary; the content digest was already verified by the blob store, so the
 * remaining fields are trusted as written by the encoder.
 */
export function decodeEnergyOperationInput(bytes: Uint8Array): EnergyOperationInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new EnergyComputeError('INVALID_INPUT', 'the operation input is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed) || parsed.kind !== ENERGY_OPERATION_INPUT_KIND) {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      `the operation input must declare kind=${ENERGY_OPERATION_INPUT_KIND}`,
    )
  }
  if (!isRecord(parsed.snapshot) || !isRecord(parsed.battery) || !isRecord(parsed.tariff)) {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      'the operation input is missing the snapshot, battery or tariff declaration',
    )
  }
  if (!Array.isArray(parsed.load) || !Array.isArray(parsed.pv) || !Array.isArray(parsed.reserves)) {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      'the operation input must declare its load, pv and reserve series',
    )
  }
  return parsed as EnergyOperationInput
}

export function requirePlan(input: EnergyOperationInput, operationId: string): PlanTrajectory {
  if (input.plan === undefined) {
    throw new EnergyComputeError(
      'MISSING_PLAN',
      `${operationId} requires a plan in its input bundle`,
    )
  }
  return input.plan
}

export function assertSimulationOnly(input: EnergyOperationInput, operationId: string): void {
  if (input.dataMode === 'live') {
    throw new EnergyComputeError(
      'LIVE_NOT_SUPPORTED',
      `${operationId} is simulation-only; a live input bundle is refused`,
    )
  }
}
