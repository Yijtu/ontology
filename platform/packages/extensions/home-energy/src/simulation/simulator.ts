import type { DomainResultStatus, ResourceRef, Rfc3339UtcTimestamp } from '@ontology/contracts'
import type { EnergyInputSnapshot, NormalizedSeries } from '../input'
import { canonicalJson, sha256DigestOf } from '../input/snapshot'
import { dispatchSlot } from './dispatch'
import { EnergySimulationError } from './errors'
import { inRange, round } from './tolerance'
import {
  ENERGY_SIMULATOR_ALGORITHM,
  NUMERIC_POLICY,
  SIMULATION_VERSION,
  type BatterySpecDeclaration,
  type ConstraintViolation,
  type EnergySimulationRequest,
  type EnergySimulatorPort,
  type PlanStep,
  type ReserveConstraint,
  type ReserveMargin,
  type SamplingMarker,
  type SeriesBinding,
  type SimulationCosts,
  type SimulationIntervalResult,
  type SimulationMissingInput,
  type SimulationResult,
  type SimulationStatus,
  type SimulationTolerance,
} from './types'

/**
 * The pure energy simulator (SPEC E4–E5; ADR-11, INV-08/INV-10).
 *
 * It checks one candidate trajectory against a normalised LOCAL-043 snapshot and returns a typed
 * domain result. It holds no port, credential, filesystem handle or clock: `simulate` is a pure,
 * synchronous function of its request, so the same request always yields the same result and the
 * same `resultDigest`. Purity is structural — the module imports only `@ontology/contracts`, its
 * sibling pure helpers and the already-audited pure snapshot helpers (canonical JSON + SHA-256);
 * no I/O is reachable.
 */

const REQUIRED_BATTERY_PARAMETERS: readonly (readonly [keyof BatterySpecDeclaration, string])[] = [
  ['energyCapacityKwh', 'energy_capacity_kwh'],
  ['minEnergyKwh', 'min_energy_kwh'],
  ['maxEnergyKwh', 'max_energy_kwh'],
  ['chargePowerLimitKw', 'charge_power_limit_kw'],
  ['dischargePowerLimitKw', 'discharge_power_limit_kw'],
  ['chargeEfficiency', 'charge_efficiency'],
  ['dischargeEfficiency', 'discharge_efficiency'],
  ['initialEnergyKwh', 'initial_energy_kwh'],
  ['gridChargingAllowed', 'grid_charging_allowed'],
  ['exportAllowed', 'export_allowed'],
  ['islandingSupported', 'islanding_supported'],
]

interface ResolvedBattery {
  readonly deviceRef: string
  readonly specSource: 'vendor_specification' | 'synthetic_assumption'
  readonly energyCapacityKwh: number
  readonly minEnergyKwh: number
  readonly maxEnergyKwh: number
  readonly chargePowerLimitKw: number
  readonly dischargePowerLimitKw: number
  readonly chargeEfficiency: number
  readonly dischargeEfficiency: number
  readonly initialEnergyKwh: number
  readonly gridChargingAllowed: boolean
  readonly exportAllowed: boolean
  readonly islandingSupported: boolean
  readonly degradationCostPerKwh?: number
}

/**
 * Refuse a live execution mode at runtime. The request type already says `simulation`; this guard
 * means a deserialised body claiming `live` is rejected with a typed error instead of running.
 */
export function assertSimulationMode(value: unknown): 'simulation' {
  if (value !== 'simulation') {
    throw new EnergySimulationError(
      'LIVE_MODE_UNSUPPORTED',
      `execution mode ${JSON.stringify(value)} is not supported; only simulation is a pure operation`,
    )
  }
  return 'simulation'
}

function domainStatusOf(status: SimulationStatus): DomainResultStatus {
  switch (status) {
    case 'feasible':
      return 'known'
    case 'infeasible':
      return 'infeasible'
    case 'insufficient_data':
      return 'unknown'
    case 'unsupported_topology':
      return 'not_applicable'
  }
}

function findSeries(
  seriesList: readonly NormalizedSeries[],
  binding: SeriesBinding,
): NormalizedSeries | undefined {
  const matches = seriesList.filter(
    (series) =>
      series.measurementPointRef === binding.measurementPointRef &&
      series.samplingType === binding.samplingType &&
      (series.metric === 'power' || series.metric === 'energy'),
  )
  return matches.find((series) => series.metric === 'power') ?? matches.find((series) => series.metric === 'energy')
}

/** Per-slot average power in kW. A `power` series is already kW; an `energy` series is divided by Δt. */
function seriesToSlots(
  series: NormalizedSeries,
  slotCount: number,
  deltaHours: number,
): (number | undefined)[] {
  const out: (number | undefined)[] = Array.from({ length: slotCount }, () => undefined)
  for (const point of series.points) {
    if (point.slotIndex < 0 || point.slotIndex >= slotCount) continue
    if (point.value === undefined || point.status === 'missing' || point.status === 'unknown') {
      out[point.slotIndex] = undefined
      continue
    }
    out[point.slotIndex] = series.metric === 'energy' ? point.value / deltaHours : point.value
  }
  return out
}

interface BoundSlots {
  readonly perSlot: readonly (number | undefined)[]
  readonly contributors: readonly string[]
  readonly missingRefs: readonly string[]
}

function sumBindings(
  seriesList: readonly NormalizedSeries[],
  bindings: readonly SeriesBinding[],
  slotCount: number,
  deltaHours: number,
): BoundSlots {
  const perSlot: (number | undefined)[] = Array.from({ length: slotCount }, () => undefined)
  const missing = Array.from({ length: slotCount }, () => false)
  const contributors: string[] = []
  const missingRefs: string[] = []
  for (const binding of bindings) {
    const series = findSeries(seriesList, binding)
    if (series === undefined) {
      missingRefs.push(binding.measurementPointRef)
      continue
    }
    contributors.push(binding.measurementPointRef)
    const slots = seriesToSlots(series, slotCount, deltaHours)
    for (let index = 0; index < slotCount; index += 1) {
      const value = slots[index]
      if (value === undefined) {
        missing[index] = true
      } else {
        perSlot[index] = (perSlot[index] ?? 0) + value
      }
    }
  }
  for (let index = 0; index < slotCount; index += 1) {
    if (missing[index] === true) perSlot[index] = undefined
  }
  return { perSlot, contributors, missingRefs }
}

function collectSlotStarts(
  seriesList: readonly NormalizedSeries[],
  slotCount: number,
): readonly (Rfc3339UtcTimestamp | undefined)[] {
  const starts: (Rfc3339UtcTimestamp | undefined)[] = Array.from(
    { length: slotCount },
    () => undefined,
  )
  for (const series of seriesList) {
    for (const point of series.points) {
      if (point.slotIndex < 0 || point.slotIndex >= slotCount) continue
      if (starts[point.slotIndex] === undefined) starts[point.slotIndex] = point.timestamp
    }
  }
  return starts
}

function endTimestamp(startUtc: Rfc3339UtcTimestamp, slotMinutes: number): Rfc3339UtcTimestamp {
  const ms = Date.parse(startUtc)
  if (!Number.isFinite(ms)) return startUtc
  return new Date(ms + slotMinutes * 60_000).toISOString()
}

function buildSamplingMarkers(
  snapshot: EnergyInputSnapshot,
  load: readonly SeriesBinding[],
  pv: readonly SeriesBinding[],
): readonly SamplingMarker[] {
  const synthetic = snapshot.manifest.dataMode === 'synthetic'
  const markers: SamplingMarker[] = []
  const add = (bindings: readonly SeriesBinding[], role: 'load' | 'pv'): void => {
    for (const binding of bindings) {
      const series = findSeries(snapshot.manifest.series, binding)
      markers.push({
        measurementPointRef: binding.measurementPointRef,
        role,
        samplingType: series?.samplingType ?? binding.samplingType,
        synthetic,
      })
    }
  }
  add(load, 'load')
  add(pv, 'pv')
  return markers
}

function collectBatteryMissing(
  battery: BatterySpecDeclaration,
  missing: SimulationMissingInput[],
): void {
  for (const [key, label] of REQUIRED_BATTERY_PARAMETERS) {
    if (battery[key] === undefined) {
      missing.push({
        reason: 'missing_battery_parameter',
        parameter: label,
        detail: `battery parameter ${label} was not declared; it is never defaulted`,
      })
    }
  }
}

function resolveBattery(battery: BatterySpecDeclaration): ResolvedBattery {
  const energyCapacityKwh = battery.energyCapacityKwh
  const minEnergyKwh = battery.minEnergyKwh
  const maxEnergyKwh = battery.maxEnergyKwh
  const chargePowerLimitKw = battery.chargePowerLimitKw
  const dischargePowerLimitKw = battery.dischargePowerLimitKw
  const chargeEfficiency = battery.chargeEfficiency
  const dischargeEfficiency = battery.dischargeEfficiency
  const initialEnergyKwh = battery.initialEnergyKwh
  const gridChargingAllowed = battery.gridChargingAllowed
  const exportAllowed = battery.exportAllowed
  const islandingSupported = battery.islandingSupported
  if (
    energyCapacityKwh === undefined ||
    minEnergyKwh === undefined ||
    maxEnergyKwh === undefined ||
    chargePowerLimitKw === undefined ||
    dischargePowerLimitKw === undefined ||
    chargeEfficiency === undefined ||
    dischargeEfficiency === undefined ||
    initialEnergyKwh === undefined ||
    gridChargingAllowed === undefined ||
    exportAllowed === undefined ||
    islandingSupported === undefined
  ) {
    // Defensive: callers must run `collectBatteryMissing` first.
    throw new EnergySimulationError('INVALID_ARGUMENT', 'battery declaration is incomplete')
  }
  if (energyCapacityKwh < 0) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'energy_capacity_kwh must be non-negative')
  }
  if (minEnergyKwh < 0 || maxEnergyKwh < minEnergyKwh || maxEnergyKwh > energyCapacityKwh) {
    throw new EnergySimulationError(
      'INVALID_DECLARATION',
      'min/max energy must satisfy 0 <= min <= max <= energy_capacity_kwh',
    )
  }
  if (chargePowerLimitKw < 0 || dischargePowerLimitKw < 0) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'power limits must be non-negative')
  }
  if (!(chargeEfficiency > 0 && chargeEfficiency <= 1)) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'charge_efficiency must lie in (0, 1]')
  }
  if (!(dischargeEfficiency > 0 && dischargeEfficiency <= 1)) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'discharge_efficiency must lie in (0, 1]')
  }
  if (!Number.isFinite(initialEnergyKwh)) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'initial_energy_kwh must be finite')
  }
  if (battery.degradationCostPerKwh !== undefined && battery.degradationCostPerKwh < 0) {
    throw new EnergySimulationError('INVALID_DECLARATION', 'degradation_cost_per_kwh must be non-negative')
  }
  return {
    deviceRef: battery.deviceRef,
    specSource: battery.specSource,
    energyCapacityKwh,
    minEnergyKwh,
    maxEnergyKwh,
    chargePowerLimitKw,
    dischargePowerLimitKw,
    chargeEfficiency,
    dischargeEfficiency,
    initialEnergyKwh,
    gridChargingAllowed,
    exportAllowed,
    islandingSupported,
    ...(battery.degradationCostPerKwh === undefined
      ? {}
      : { degradationCostPerKwh: battery.degradationCostPerKwh }),
  }
}

interface PlanCoverage {
  readonly bySlot: readonly (PlanStep | undefined)[]
  readonly missingSlots: readonly number[]
}

function resolvePlanCoverage(
  steps: readonly PlanStep[],
  slotCount: number,
): PlanCoverage {
  const bySlot: (PlanStep | undefined)[] = Array.from({ length: slotCount }, () => undefined)
  for (const step of steps) {
    if (!Number.isInteger(step.slotIndex) || step.slotIndex < 0 || step.slotIndex >= slotCount) {
      throw new EnergySimulationError(
        'PLAN_SLOT_OUT_OF_RANGE',
        `plan step slot ${step.slotIndex} is outside [0, ${slotCount})`,
      )
    }
    if (bySlot[step.slotIndex] !== undefined) {
      throw new EnergySimulationError(
        'DUPLICATE_PLAN_STEP',
        `plan declares slot ${step.slotIndex} more than once`,
      )
    }
    bySlot[step.slotIndex] = step
  }
  const missingSlots: number[] = []
  for (let index = 0; index < slotCount; index += 1) {
    if (bySlot[index] === undefined) missingSlots.push(index)
  }
  return { bySlot, missingSlots }
}

function emptyCosts(currency: string, degradationModelled: boolean): SimulationCosts {
  return {
    currency,
    importCost: 0,
    exportRevenue: 0,
    netCost: 0,
    degradationCost: 0,
    degradationModelled,
    totalCost: 0,
  }
}

interface ResultBase {
  readonly status: SimulationStatus
  readonly domainStatus: DomainResultStatus
  readonly executionMode: 'simulation'
  readonly liveSupported: false
  readonly simulationVersion: string
  readonly numericPolicy: string
  readonly algorithmVersion: typeof ENERGY_SIMULATOR_ALGORITHM
  readonly inputDataMode: EnergyInputSnapshot['manifest']['dataMode']
  readonly inputManifestHash: string
  readonly snapshotRef: ResourceRef
  readonly tolerance: SimulationTolerance
  readonly topology: EnergySimulationRequest['topology']
  readonly assumptions: readonly string[]
  readonly samplingMarkers: readonly SamplingMarker[]
  readonly missingInputs: readonly SimulationMissingInput[]
  readonly unsupportedReasons: readonly string[]
  readonly violations: readonly ConstraintViolation[]
  readonly intervals: readonly SimulationIntervalResult[]
  readonly costs: SimulationCosts
  readonly reserveMargins: readonly ReserveMargin[]
  readonly evidenceRefs: readonly ResourceRef[]
}

function finalize(base: ResultBase): SimulationResult {
  const digest = sha256DigestOf(new TextEncoder().encode(canonicalJson(base)))
  return { ...base, optimality: 'not_claimed', resultDigest: digest }
}

interface ReserveTracker {
  readonly constraint: ReserveConstraint
  minimumEnergyKwh: number
  minimumSlotIndex: number
}

export class EnergySimulator implements EnergySimulatorPort {
  simulate(request: EnergySimulationRequest): SimulationResult {
    assertSimulationMode(request.executionMode)
    const snapshot = request.snapshot
    const manifest = snapshot.manifest
    const slotCount = manifest.slotCount
    const deltaHours = manifest.slotMinutes / 60
    const tolerance = request.tolerance
    const decimals = tolerance.reportingDecimals

    const samplingMarkers = buildSamplingMarkers(snapshot, request.load, request.pv)
    const degradationModelled = request.battery.degradationCostPerKwh !== undefined

    const baseOf = (
      status: SimulationStatus,
      extra: Partial<
        Pick<
          ResultBase,
          | 'missingInputs'
          | 'unsupportedReasons'
          | 'violations'
          | 'intervals'
          | 'costs'
          | 'reserveMargins'
          | 'assumptions'
        >
      >,
    ): ResultBase => ({
      status,
      domainStatus: domainStatusOf(status),
      executionMode: 'simulation',
      liveSupported: false,
      simulationVersion: SIMULATION_VERSION,
      numericPolicy: NUMERIC_POLICY,
      algorithmVersion: ENERGY_SIMULATOR_ALGORITHM,
      inputDataMode: manifest.dataMode,
      inputManifestHash: snapshot.digest,
      snapshotRef: snapshot.snapshotRef,
      tolerance,
      topology: request.topology,
      assumptions: extra.assumptions ?? request.assumptions,
      samplingMarkers,
      missingInputs: extra.missingInputs ?? [],
      unsupportedReasons: extra.unsupportedReasons ?? [],
      violations: extra.violations ?? [],
      intervals: extra.intervals ?? [],
      costs: extra.costs ?? emptyCosts(request.tariff.currency, degradationModelled),
      reserveMargins: extra.reserveMargins ?? [],
      evidenceRefs: [snapshot.snapshotRef],
    })

    // 1. Topology is validated before any data is read: an out-of-scope topology is refused, not
    //    approximated by generic graph reachability.
    if (request.topology.kind !== 'ac_coupled_single_storage') {
      return finalize(
        baseOf('unsupported_topology', { unsupportedReasons: [request.topology.detail] }),
      )
    }

    const missing: SimulationMissingInput[] = []

    // A populated forecast series is not usable if its declared validity misses this
    // scenario horizon. This check also protects direct, already-normalised inputs that
    // did not pass through NormalizeEnergyInput.
    const horizonStart = Date.parse(manifest.horizon.start)
    const horizonEnd = Date.parse(manifest.horizon.end)
    const evaluationClock = Date.parse(manifest.evaluationClock)
    for (const series of manifest.series) {
      if (series.samplingType !== 'forecast') continue
      const issuedAt = series.issuedAt === undefined ? Number.NaN : Date.parse(series.issuedAt)
      const validFrom = series.validityWindow === undefined ? Number.NaN : Date.parse(series.validityWindow.start)
      const validTo = series.validityWindow === undefined ? Number.NaN : Date.parse(series.validityWindow.end)
      if (!Number.isFinite(issuedAt) || !Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
        !Number.isFinite(horizonStart) || !Number.isFinite(horizonEnd) || !Number.isFinite(evaluationClock) ||
        issuedAt > evaluationClock || validFrom > horizonStart || validTo < horizonEnd) {
        missing.push({
          reason: 'forecast_expired', measurementPointRef: series.measurementPointRef,
          detail: `forecast ${series.measurementPointRef} is not valid for the complete planning horizon; refresh its issued/validity window before planning`,
        })
      }
    }

    // 2. Bind load and PV; a missing binding, a missing series or a missing slot value is explicit.
    if (request.load.length === 0) {
      missing.push({
        reason: 'missing_load_series',
        detail: 'no load measurement point was bound; a missing load is never treated as zero',
      })
    }
    if (request.pv.length === 0) {
      missing.push({
        reason: 'missing_pv_series',
        detail: 'no PV measurement point was bound; provide an explicit zero series instead of omitting it',
      })
    }
    const loadBound = sumBindings(manifest.series, request.load, slotCount, deltaHours)
    const pvBound = sumBindings(manifest.series, request.pv, slotCount, deltaHours)
    for (const ref of loadBound.missingRefs) {
      missing.push({
        reason: 'missing_load_series',
        measurementPointRef: ref,
        detail: `no normalised load series matches measurement point ${ref}`,
      })
    }
    for (const ref of pvBound.missingRefs) {
      missing.push({
        reason: 'missing_pv_series',
        measurementPointRef: ref,
        detail: `no normalised PV series matches measurement point ${ref}`,
      })
    }
    for (let index = 0; index < slotCount; index += 1) {
      if (loadBound.perSlot[index] === undefined) {
        missing.push({
          reason: 'missing_slot_value',
          slotIndex: index,
          detail: `load is unknown for slot ${index}`,
        })
      }
      if (pvBound.perSlot[index] === undefined) {
        missing.push({
          reason: 'missing_slot_value',
          slotIndex: index,
          detail: `PV availability is unknown for slot ${index}`,
        })
      }
    }

    // 3. Missing key battery parameters.
    collectBatteryMissing(request.battery, missing)

    // 4. Missing tariff prices. A negative price is a valid input and is never zeroed.
    if (request.tariff.prices.length !== slotCount) {
      missing.push({
        reason: 'missing_tariff_price',
        detail: `tariff declares ${request.tariff.prices.length} price slots but the horizon has ${slotCount}`,
      })
    } else {
      const exportPriceRequired = request.battery.exportAllowed === true
      for (let index = 0; index < slotCount; index += 1) {
        const priceSlot = request.tariff.prices[index]
        if (priceSlot?.purchasePricePerKwh === undefined) {
          missing.push({
            reason: 'missing_tariff_price',
            slotIndex: index,
            detail: `purchase price is missing for slot ${index}; it is never defaulted to zero`,
          })
        }
        if (exportPriceRequired && priceSlot?.exportPricePerKwh === undefined) {
          missing.push({
            reason: 'missing_tariff_price',
            slotIndex: index,
            detail: `export price is missing for slot ${index} while export is allowed`,
          })
        }
      }
    }

    // 5. The plan must cover every slot; a partial plan is not silently completed.
    const coverage = resolvePlanCoverage(request.plan.steps, slotCount)
    for (const slotIndex of coverage.missingSlots) {
      missing.push({
        reason: 'missing_plan_step',
        slotIndex,
        detail: `plan does not declare slot ${slotIndex}`,
      })
    }

    if (missing.length > 0) {
      return finalize(baseOf('insufficient_data', { missingInputs: missing }))
    }

    // 6. Declarations are now complete; a present-but-invalid value is a typed error.
    const spec = resolveBattery(request.battery)
    const slotStarts = collectSlotStarts(manifest.series, slotCount)

    const violations: ConstraintViolation[] = []
    const intervals: SimulationIntervalResult[] = []
    let importCostTotal = 0
    let exportRevenueTotal = 0
    let degradationCostTotal = 0

    const trackers: ReserveTracker[] = request.reserves.map((constraint) => ({
      constraint,
      minimumEnergyKwh: Number.POSITIVE_INFINITY,
      minimumSlotIndex: constraint.windowStartSlot,
    }))

    let energy = spec.initialEnergyKwh
    if (!inRange(energy, spec.minEnergyKwh, spec.maxEnergyKwh, tolerance.capacityKwh)) {
      violations.push({
        constraint: 'capacity',
        slotIndex: 0,
        detail: 'initial energy lies outside the declared [min, max] capacity',
        observed: energy,
        limit: energy < spec.minEnergyKwh ? spec.minEnergyKwh : spec.maxEnergyKwh,
        unit: 'kWh',
      })
    }

    for (let index = 0; index < slotCount; index += 1) {
      const step = coverage.bySlot[index]
      const loadKw = loadBound.perSlot[index]
      const pvAvailableKw = pvBound.perSlot[index]
      if (step === undefined || loadKw === undefined || pvAvailableKw === undefined) {
        throw new EnergySimulationError('INVALID_ARGUMENT', `slot ${index} was not fully resolved`)
      }
      if (!Number.isFinite(step.chargeKw) || !Number.isFinite(step.dischargeKw)) {
        throw new EnergySimulationError(
          'INVALID_ARGUMENT',
          `plan slot ${index} declares a non-finite power setpoint`,
        )
      }

      // A negative setpoint is not a physical trajectory: it is clamped to zero for the flows and
      // reported as a power violation that names the slot.
      const chargeKw = step.chargeKw < 0 ? 0 : step.chargeKw
      const dischargeKw = step.dischargeKw < 0 ? 0 : step.dischargeKw
      if (step.chargeKw < -tolerance.powerKw) {
        violations.push({
          constraint: 'power',
          slotIndex: index,
          detail: 'charge setpoint is below zero',
          observed: step.chargeKw,
          limit: 0,
          unit: 'kW',
        })
      }
      if (step.dischargeKw < -tolerance.powerKw) {
        violations.push({
          constraint: 'power',
          slotIndex: index,
          detail: 'discharge setpoint is below zero',
          observed: step.dischargeKw,
          limit: 0,
          unit: 'kW',
        })
      }
      if (chargeKw > spec.chargePowerLimitKw + tolerance.powerKw) {
        violations.push({
          constraint: 'power',
          slotIndex: index,
          detail: 'charge setpoint exceeds the declared charge power limit',
          observed: chargeKw,
          limit: spec.chargePowerLimitKw,
          unit: 'kW',
        })
      }
      if (dischargeKw > spec.dischargePowerLimitKw + tolerance.powerKw) {
        violations.push({
          constraint: 'power',
          slotIndex: index,
          detail: 'discharge setpoint exceeds the declared discharge power limit',
          observed: dischargeKw,
          limit: spec.dischargePowerLimitKw,
          unit: 'kW',
        })
      }
      if (chargeKw > tolerance.powerKw && dischargeKw > tolerance.powerKw) {
        violations.push({
          constraint: 'charge_discharge_exclusivity',
          slotIndex: index,
          detail: 'the plan charges and discharges in the same slot',
          observed: Math.min(chargeKw, dischargeKw),
          limit: 0,
          unit: 'kW',
        })
      }
      if (
        step.assumedChargeEfficiency !== undefined &&
        Math.abs(step.assumedChargeEfficiency - spec.chargeEfficiency) > tolerance.efficiency
      ) {
        violations.push({
          constraint: 'efficiency',
          slotIndex: index,
          detail: 'the plan assumes a charge efficiency that differs from the declared device efficiency',
          observed: step.assumedChargeEfficiency,
          limit: spec.chargeEfficiency,
          unit: 'ratio',
        })
      }
      if (
        step.assumedDischargeEfficiency !== undefined &&
        Math.abs(step.assumedDischargeEfficiency - spec.dischargeEfficiency) > tolerance.efficiency
      ) {
        violations.push({
          constraint: 'efficiency',
          slotIndex: index,
          detail: 'the plan assumes a discharge efficiency that differs from the declared device efficiency',
          observed: step.assumedDischargeEfficiency,
          limit: spec.dischargeEfficiency,
          unit: 'ratio',
        })
      }

      const flows = dispatchSlot({
        loadKw,
        pvAvailableKw,
        chargeKw,
        dischargeKw,
        exportAllowed: spec.exportAllowed,
      })

      const gridToChargeKw = chargeKw - flows.pvToChargeKw
      if (!spec.gridChargingAllowed && gridToChargeKw > tolerance.powerKw) {
        violations.push({
          constraint: 'grid_charging',
          slotIndex: index,
          detail: 'grid charging is not allowed but the plan draws grid energy to charge',
          observed: gridToChargeKw,
          limit: 0,
          unit: 'kW',
        })
      }
      if (!spec.exportAllowed && flows.dischargeExportKw > tolerance.powerKw) {
        violations.push({
          constraint: 'export_limit',
          slotIndex: index,
          detail: 'battery discharge exceeds load while export is not allowed',
          observed: flows.dischargeExportKw,
          limit: 0,
          unit: 'kW',
        })
      }
      if (
        request.grid.exportPowerLimitKw !== undefined &&
        flows.gridExportKw > request.grid.exportPowerLimitKw + tolerance.powerKw
      ) {
        violations.push({
          constraint: 'export_limit',
          slotIndex: index,
          detail: 'grid export exceeds the declared export power limit',
          observed: flows.gridExportKw,
          limit: request.grid.exportPowerLimitKw,
          unit: 'kW',
        })
      }
      if (
        request.grid.importPowerLimitKw !== undefined &&
        flows.gridImportKw > request.grid.importPowerLimitKw + tolerance.powerKw
      ) {
        violations.push({
          constraint: 'grid_import_limit',
          slotIndex: index,
          detail: 'grid import exceeds the declared import power limit',
          observed: flows.gridImportKw,
          limit: request.grid.importPowerLimitKw,
          unit: 'kW',
        })
      }
      if (flows.gridImportKw > tolerance.powerKw && flows.gridExportKw > tolerance.powerKw) {
        violations.push({
          constraint: 'grid_import_export_exclusivity',
          slotIndex: index,
          detail: 'grid import and export are both positive in one slot',
          observed: Math.min(flows.gridImportKw, flows.gridExportKw),
          limit: 0,
          unit: 'kW',
        })
      }

      const energyStartKwh = energy
      const energyEndKwh =
        energyStartKwh +
        spec.chargeEfficiency * chargeKw * deltaHours -
        (dischargeKw * deltaHours) / spec.dischargeEfficiency
      energy = energyEndKwh

      if (energyEndKwh < spec.minEnergyKwh - tolerance.capacityKwh) {
        violations.push({
          constraint: 'capacity',
          slotIndex: index,
          detail: 'energy falls below the declared minimum',
          observed: energyEndKwh,
          limit: spec.minEnergyKwh,
          unit: 'kWh',
        })
      }
      if (energyEndKwh > spec.maxEnergyKwh + tolerance.capacityKwh) {
        violations.push({
          constraint: 'capacity',
          slotIndex: index,
          detail: 'energy rises above the declared maximum',
          observed: energyEndKwh,
          limit: spec.maxEnergyKwh,
          unit: 'kWh',
        })
      }

      for (const tracker of trackers) {
        const { windowStartSlot, windowEndSlot } = tracker.constraint
        if (index >= windowStartSlot && index < windowEndSlot) {
          const candidate = Math.min(energyStartKwh, energyEndKwh)
          if (candidate < tracker.minimumEnergyKwh) {
            tracker.minimumEnergyKwh = candidate
            tracker.minimumSlotIndex = index
          }
        }
      }

      const priceSlot = request.tariff.prices[index]
      const purchasePrice = requirePrice(priceSlot?.purchasePricePerKwh, index, 'purchase')
      const exportPrice = requirePrice(priceSlot?.exportPricePerKwh, index, 'export')
      const importCost = flows.gridImportKw * purchasePrice * deltaHours
      const exportRevenue = flows.gridExportKw * exportPrice * deltaHours
      const throughputKwh = (chargeKw + dischargeKw) * deltaHours
      const degradationCost =
        spec.degradationCostPerKwh === undefined ? 0 : throughputKwh * spec.degradationCostPerKwh
      importCostTotal += importCost
      exportRevenueTotal += exportRevenue
      degradationCostTotal += degradationCost

      const startUtc = slotStarts[index] ?? manifest.horizon.start
      const balanceResidualKwh =
        flows.pvUsedKw + flows.gridImportKw + dischargeKw - (loadKw + chargeKw + flows.gridExportKw)

      intervals.push({
        slotIndex: index,
        startUtc,
        endUtc: endTimestamp(startUtc, manifest.slotMinutes),
        loadKw: round(loadKw, decimals),
        pvAvailableKw: round(pvAvailableKw, decimals),
        pvUsedKw: round(flows.pvUsedKw, decimals),
        chargeKw: round(chargeKw, decimals),
        dischargeKw: round(dischargeKw, decimals),
        gridImportKw: round(flows.gridImportKw, decimals),
        gridExportKw: round(flows.gridExportKw, decimals),
        curtailmentKw: round(flows.curtailmentKw, decimals),
        energyStartKwh: round(energyStartKwh, decimals),
        energyEndKwh: round(energyEndKwh, decimals),
        energyBalanceResidualKwh: round(balanceResidualKwh, decimals),
        ...(priceSlot?.purchasePricePerKwh === undefined
          ? {}
          : { purchasePricePerKwh: priceSlot.purchasePricePerKwh }),
        ...(priceSlot?.exportPricePerKwh === undefined
          ? {}
          : { exportPricePerKwh: priceSlot.exportPricePerKwh }),
        importCost: round(importCost, decimals),
        exportRevenue: round(exportRevenue, decimals),
        degradationCost: round(degradationCost, decimals),
      })
    }

    const reserveMargins: ReserveMargin[] = []
    for (const tracker of trackers) {
      const { constraint } = tracker
      const minimumEnergyKwh = tracker.minimumEnergyKwh
      const marginKwh = minimumEnergyKwh - constraint.reserveEnergyKwh
      const satisfied = minimumEnergyKwh >= constraint.reserveEnergyKwh - tolerance.capacityKwh
      reserveMargins.push({
        reserveKwh: constraint.reserveEnergyKwh,
        windowStartSlot: constraint.windowStartSlot,
        windowEndSlot: constraint.windowEndSlot,
        minimumEnergyKwh: round(minimumEnergyKwh, decimals),
        marginKwh: round(marginKwh, decimals),
        satisfied,
        severity: constraint.severity,
      })
      if (constraint.severity === 'hard' && !satisfied) {
        violations.push({
          constraint: 'backup_reserve',
          slotIndex: tracker.minimumSlotIndex,
          detail: 'stored energy falls below the declared backup reserve',
          observed: minimumEnergyKwh,
          limit: constraint.reserveEnergyKwh,
          unit: 'kWh',
        })
      }
      if (constraint.requiresIslanding && spec.islandingSupported !== true) {
        violations.push({
          constraint: 'islanding',
          slotIndex: constraint.windowStartSlot,
          detail:
            'the reserve requires islanding support, which the device does not declare; outage supply is not promised',
          observed: 0,
          limit: 1,
          unit: 'boolean',
        })
      }
    }

    const netCost = importCostTotal - exportRevenueTotal
    const costs: SimulationCosts = {
      currency: request.tariff.currency,
      importCost: round(importCostTotal, decimals),
      exportRevenue: round(exportRevenueTotal, decimals),
      netCost: round(netCost, decimals),
      degradationCost: round(degradationCostTotal, decimals),
      degradationModelled,
      totalCost: round(netCost + degradationCostTotal, decimals),
    }

    const status: SimulationStatus = violations.length === 0 ? 'feasible' : 'infeasible'
    const assumptions =
      spec.specSource === 'synthetic_assumption'
        ? [...request.assumptions, 'device parameters are declared synthetic assumptions']
        : request.assumptions
    return finalize(baseOf(status, { violations, intervals, costs, reserveMargins, assumptions }))
  }
}

function requirePrice(
  value: number | undefined,
  slotIndex: number,
  kind: 'purchase' | 'export',
): number {
  if (value === undefined) {
    throw new EnergySimulationError(
      'INVALID_ARGUMENT',
      `missing ${kind} price for slot ${slotIndex} reached the cost computation`,
    )
  }
  return value
}
