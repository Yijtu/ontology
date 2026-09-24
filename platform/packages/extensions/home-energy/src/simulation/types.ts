import type {
  DataMode,
  DomainResultStatus,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  VersionRef,
} from '@ontology/contracts'
import type { EnergyInputSnapshot, SamplingType } from '../input'

/**
 * Pure energy simulation contracts (SPEC E3–E5, C3/C4; ADR-11, INV-08/INV-10).
 *
 * The simulator checks one candidate trajectory (`PlanTrajectory`) against a normalised,
 * content-addressed input snapshot and the declared device/grid/tariff/reserve parameters.
 * It owns the deterministic domain computation — storage recursion, AC-side energy balance,
 * cost and every physical constraint — and returns a typed domain result.
 *
 * Boundary rules made structural:
 *   - time, configuration and the plan are explicit inputs; there is no ambient clock, no
 *     randomness and no I/O, so the same request always yields the same result;
 *   - a violated constraint is reported as a per-slot `ConstraintViolation`, never a generic
 *     failure and never a probability;
 *   - an unsupported topology or a missing key parameter is an explicit status, never a
 *     defaulted run;
 *   - input and output mark synthetic/observed/forecast and simulation/live explicitly, so a
 *     simulation is never presented as a live device state.
 */

export const SIMULATION_VERSION = '1.0.0'

/**
 * Numeric discipline is stated, not implied: values are computed in IEEE-754 double and only
 * rounded when reported. The tolerance set is carried into the result so a reader can see the
 * exact thresholds a verdict was decided against.
 */
export const NUMERIC_POLICY = 'ieee754-double-compute;decimal-rounded-report'

/** Fixed algorithm identity, so a stored result can always name the code that produced it. */
export const ENERGY_SIMULATOR_ALGORITHM: VersionRef = {
  id: 'home-energy.simulator',
  version: SIMULATION_VERSION,
  digest: `sha256:ceb10cf00299bf2968fa9a239a9703b3c63d366e5bf8a6ec454861e2041acb3b`,
}

export interface SimulationTolerance {
  readonly version: string
  /** Maximum absolute energy-balance residual per slot, in kWh. */
  readonly energyBalanceKwh: number
  /** Slack allowed when comparing an energy against a capacity/reserve limit, in kWh. */
  readonly capacityKwh: number
  /** Slack allowed when comparing a power against a device/grid limit, in kW. */
  readonly powerKw: number
  /** Slack allowed when comparing an efficiency against the declared device efficiency. */
  readonly efficiency: number
  /** Slack allowed when comparing a computed cost against a declared cost, in currency. */
  readonly cost: number
  /** Decimal places used only when reporting computed values. */
  readonly reportingDecimals: number
}

export const DEFAULT_SIMULATION_TOLERANCE: SimulationTolerance = {
  version: '1.0.0',
  energyBalanceKwh: 1e-9,
  capacityKwh: 1e-9,
  powerKw: 1e-9,
  efficiency: 1e-9,
  cost: 1e-9,
  reportingDecimals: 9,
}

/**
 * Supported topology: one household, one equivalent storage, AC-side equivalent energy flow.
 * Any other topology (DC-coupled, multi-inverter, V2G, unknown) is out of the first controlled
 * model and is refused explicitly instead of being approximated by graph reachability.
 */
export type SupportedTopologyKind = 'ac_coupled_single_storage'

export interface SupportedTopology {
  readonly kind: SupportedTopologyKind
  readonly storageDeviceRef: string
  readonly inverterRef: string
  readonly gridConnectionRef: string
}

export type UnsupportedTopologyKind = 'dc_coupled' | 'multi_inverter' | 'v2g' | 'unknown'

export interface UnsupportedTopology {
  readonly kind: UnsupportedTopologyKind
  readonly detail: string
}

export type TopologyDeclaration = SupportedTopology | UnsupportedTopology

/**
 * Declared battery parameters (SPEC E3). Every field is optional here so a genuinely missing
 * parameter is *missing*, not silently defaulted: an absent required field makes the request
 * `insufficient_data`, and an unknown capability is never assumed `true`. `initialEnergyKwh` is
 * explicit because a missing initial state must not become 0.
 */
export interface BatterySpecDeclaration {
  readonly deviceRef: string
  readonly specSource: 'vendor_specification' | 'synthetic_assumption'
  readonly supportedSocMappingRef?: string
  readonly energyCapacityKwh?: number
  readonly minEnergyKwh?: number
  readonly maxEnergyKwh?: number
  readonly chargePowerLimitKw?: number
  readonly dischargePowerLimitKw?: number
  readonly chargeEfficiency?: number
  readonly dischargeEfficiency?: number
  readonly initialEnergyKwh?: number
  readonly gridChargingAllowed?: boolean
  readonly exportAllowed?: boolean
  readonly islandingSupported?: boolean
  /** Optional linear degradation cost per AC-side kWh throughput. Unmodelled when absent. */
  readonly degradationCostPerKwh?: number
}

export interface GridSpec {
  readonly connectionRef: string
  readonly importPowerLimitKw?: number
  readonly exportPowerLimitKw?: number
}

/** A bound, already-normalised series: the caller names the measurement point and sampling type. */
export interface SeriesBinding {
  readonly measurementPointRef: string
  readonly samplingType: SamplingType
}

export interface TariffPriceSlot {
  readonly purchasePricePerKwh?: number
  readonly exportPricePerKwh?: number
}

export interface TariffBinding {
  readonly tariffRef: VersionRef
  readonly currency: string
  /** One entry per slot; a missing price makes the request `insufficient_data`. Negative allowed. */
  readonly prices: readonly TariffPriceSlot[]
}

export interface ReserveConstraint {
  readonly reserveEnergyKwh: number
  /** Half-open slot range [windowStartSlot, windowEndSlot). */
  readonly windowStartSlot: number
  readonly windowEndSlot: number
  readonly source: 'user_preference' | 'device_hard_constraint'
  readonly severity: 'hard' | 'soft'
  /** When true, the reserve is a backup target that needs islanding support to be honoured. */
  readonly requiresIslanding: boolean
}

/** One AC-side battery action. Charge/discharge are non-negative kW setpoints. */
export interface PlanStep {
  readonly slotIndex: number
  readonly chargeKw: number
  readonly dischargeKw: number
  /** Optional efficiency the plan assumed; checked against the declared device efficiency. */
  readonly assumedChargeEfficiency?: number
  readonly assumedDischargeEfficiency?: number
}

export interface PlanTrajectory {
  readonly planRef: ResourceRef
  readonly algorithmVersion: VersionRef
  readonly steps: readonly PlanStep[]
}

export interface EnergySimulationRequest {
  readonly snapshot: EnergyInputSnapshot
  /** Simulation only. `live` is not a supported execution mode and is refused at runtime. */
  readonly executionMode: 'simulation'
  readonly topology: TopologyDeclaration
  readonly battery: BatterySpecDeclaration
  readonly grid: GridSpec
  readonly load: readonly SeriesBinding[]
  readonly pv: readonly SeriesBinding[]
  readonly tariff: TariffBinding
  readonly reserves: readonly ReserveConstraint[]
  readonly plan: PlanTrajectory
  readonly tolerance: SimulationTolerance
  readonly assumptions: readonly string[]
}

export type SimulationStatus =
  | 'feasible'
  | 'infeasible'
  | 'insufficient_data'
  | 'unsupported_topology'

export type SimulationConstraintKind =
  | 'capacity'
  | 'power'
  | 'efficiency'
  | 'charge_discharge_exclusivity'
  | 'grid_import_export_exclusivity'
  | 'grid_import_limit'
  | 'export_limit'
  | 'grid_charging'
  | 'backup_reserve'
  | 'islanding'

export interface ConstraintViolation {
  readonly constraint: SimulationConstraintKind
  /** The exact offending slot; never a generic failure. */
  readonly slotIndex: number
  readonly detail: string
  readonly observed: number
  readonly limit: number
  readonly unit: string
}

export type SimulationMissingReason =
  | 'missing_battery_parameter'
  | 'missing_load_series'
  | 'missing_pv_series'
  | 'missing_tariff_price'
  | 'missing_plan_step'
  | 'missing_slot_value'
  | 'forecast_expired'

export interface SimulationMissingInput {
  readonly reason: SimulationMissingReason
  readonly detail: string
  readonly slotIndex?: number
  readonly measurementPointRef?: string
  readonly parameter?: string
}

export interface SamplingMarker {
  readonly measurementPointRef: string
  readonly role: 'load' | 'pv'
  readonly samplingType: SamplingType
  readonly synthetic: boolean
}

export interface SimulationIntervalResult {
  readonly slotIndex: number
  readonly startUtc: Rfc3339UtcTimestamp
  readonly endUtc: Rfc3339UtcTimestamp
  readonly loadKw: number
  readonly pvAvailableKw: number
  readonly pvUsedKw: number
  readonly chargeKw: number
  readonly dischargeKw: number
  readonly gridImportKw: number
  readonly gridExportKw: number
  readonly curtailmentKw: number
  readonly energyStartKwh: number
  readonly energyEndKwh: number
  /** LHS − RHS of the AC-side balance; must stay within `tolerance.energyBalanceKwh`. */
  readonly energyBalanceResidualKwh: number
  readonly purchasePricePerKwh?: number
  readonly exportPricePerKwh?: number
  readonly importCost: number
  readonly exportRevenue: number
  readonly degradationCost: number
}

export interface SimulationCosts {
  readonly currency: string
  readonly importCost: number
  readonly exportRevenue: number
  readonly netCost: number
  readonly degradationCost: number
  readonly degradationModelled: boolean
  readonly totalCost: number
}

export interface ReserveMargin {
  readonly reserveKwh: number
  readonly windowStartSlot: number
  readonly windowEndSlot: number
  readonly minimumEnergyKwh: number
  readonly marginKwh: number
  readonly satisfied: boolean
  readonly severity: 'hard' | 'soft'
}

export interface SimulationResult {
  readonly status: SimulationStatus
  /** C4: a domain status. `infeasible` is a successful computation result, not a platform error. */
  readonly domainStatus: DomainResultStatus
  readonly optimality: 'not_claimed'
  readonly executionMode: 'simulation'
  readonly liveSupported: false
  readonly simulationVersion: string
  readonly numericPolicy: string
  readonly algorithmVersion: VersionRef
  readonly inputDataMode: DataMode
  readonly inputManifestHash: Sha256Digest
  readonly snapshotRef: ResourceRef
  readonly tolerance: SimulationTolerance
  readonly topology: TopologyDeclaration
  readonly assumptions: readonly string[]
  readonly samplingMarkers: readonly SamplingMarker[]
  readonly missingInputs: readonly SimulationMissingInput[]
  readonly unsupportedReasons: readonly string[]
  readonly violations: readonly ConstraintViolation[]
  readonly intervals: readonly SimulationIntervalResult[]
  readonly costs: SimulationCosts
  readonly reserveMargins: readonly ReserveMargin[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly resultDigest: Sha256Digest
}

/**
 * The replaceable energy simulation port (SPEC E1). It is a pure, synchronous domain
 * interface: no port, no credential and no injected I/O. `LOCAL-046` registers an
 * implementation of this port as a `ComputePort` operation; the planner (`LOCAL-045`) consumes
 * it to check candidate trajectories.
 */
export interface EnergySimulatorPort {
  simulate(request: EnergySimulationRequest): SimulationResult
}
