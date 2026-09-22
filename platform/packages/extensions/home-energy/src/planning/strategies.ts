import { round } from '../simulation'
import type {
  BatterySpecDeclaration,
  PlanStep,
  ReserveConstraint,
  SimulationTolerance,
  TariffBinding,
} from '../simulation'
import { EnergyPlannerError } from './errors'
import type { CandidateStrategyKind, CandidateUnavailability } from './types'

/**
 * Bounded, deterministic candidate strategy generation (SPEC E5).
 *
 * Every generator walks the horizon in slot order, tracking stored energy with the same storage
 * recursion the simulator uses, and clamps every charge/discharge setpoint to the declared power
 * limits and the remaining capacity. A generator never emits a negative setpoint and never charges
 * and discharges in the same slot. It also never lowers a user reserve: a hard reserve is applied
 * as a floor the plan may not discharge below, and when the floor is unreachable the plan is simply
 * infeasible — the requirement is left exactly as the user declared it.
 *
 * No model, network, clock or randomness is reachable from here.
 */

/** The numeric battery parameters a generator needs. Missing parameters are a typed error. */
export interface BatteryNumbers {
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
}

function requireNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new EnergyPlannerError(
      'INVALID_ARGUMENT',
      `battery parameter ${name} is required to generate a candidate plan; it is never defaulted`,
    )
  }
  return value
}

function requireBoolean(value: boolean | undefined, name: string): boolean {
  if (value === undefined) {
    throw new EnergyPlannerError(
      'INVALID_ARGUMENT',
      `battery capability ${name} is required to generate a candidate plan; unknown is never assumed true`,
    )
  }
  return value
}

export function resolveBatteryNumbers(battery: BatterySpecDeclaration): BatteryNumbers {
  return {
    energyCapacityKwh: requireNumber(battery.energyCapacityKwh, 'energy_capacity_kwh'),
    minEnergyKwh: requireNumber(battery.minEnergyKwh, 'min_energy_kwh'),
    maxEnergyKwh: requireNumber(battery.maxEnergyKwh, 'max_energy_kwh'),
    chargePowerLimitKw: requireNumber(battery.chargePowerLimitKw, 'charge_power_limit_kw'),
    dischargePowerLimitKw: requireNumber(battery.dischargePowerLimitKw, 'discharge_power_limit_kw'),
    chargeEfficiency: requireNumber(battery.chargeEfficiency, 'charge_efficiency'),
    dischargeEfficiency: requireNumber(battery.dischargeEfficiency, 'discharge_efficiency'),
    initialEnergyKwh: requireNumber(battery.initialEnergyKwh, 'initial_energy_kwh'),
    gridChargingAllowed: requireBoolean(battery.gridChargingAllowed, 'grid_charging_allowed'),
    exportAllowed: requireBoolean(battery.exportAllowed, 'export_allowed'),
    islandingSupported: requireBoolean(battery.islandingSupported, 'islanding_supported'),
  }
}

export function purchasePricesOf(
  tariff: TariffBinding,
  slotCount: number,
): readonly (number | undefined)[] {
  return Array.from({ length: slotCount }, (_unused, index) => tariff.prices[index]?.purchasePricePerKwh)
}

function priceSpread(prices: readonly (number | undefined)[]): number | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const price of prices) {
    if (price === undefined) return undefined
    if (price < min) min = price
    if (price > max) max = price
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined
  return max - min
}

/**
 * A strategy is only generated when the device and the data actually allow it. `price_window`
 * needs grid charging and a real purchase-price spread; the reason is reported, never silently
 * substituted by a different strategy.
 */
export function strategyAvailability(
  strategy: CandidateStrategyKind,
  battery: BatterySpecDeclaration,
  prices: readonly (number | undefined)[],
  tolerance: SimulationTolerance,
): CandidateUnavailability | undefined {
  if (strategy !== 'price_window') return undefined
  if (battery.gridChargingAllowed !== true) {
    return {
      strategy,
      reason: 'grid_charging_not_allowed',
      detail:
        'price_window shifts grid purchase into cheap windows, which requires a device that declares grid_charging_allowed',
    }
  }
  if (prices.some((price) => price === undefined)) {
    return {
      strategy,
      reason: 'missing_tariff_prices',
      detail: 'price_window requires a complete purchase-price series; a missing price is never defaulted',
    }
  }
  const spread = priceSpread(prices)
  if (spread === undefined || spread <= tolerance.cost) {
    return {
      strategy,
      reason: 'no_price_spread',
      detail: 'price_window requires at least two distinct purchase prices; a flat tariff has nothing to shift',
    }
  }
  return undefined
}

/** The floor a plan may not discharge below: the device minimum plus every active hard reserve. */
export function reserveFloorAt(
  reserves: readonly ReserveConstraint[],
  slotIndex: number,
  minEnergyKwh: number,
): number {
  let floor = minEnergyKwh
  for (const reserve of reserves) {
    if (
      reserve.severity === 'hard' &&
      slotIndex >= reserve.windowStartSlot &&
      slotIndex < reserve.windowEndSlot
    ) {
      if (reserve.reserveEnergyKwh > floor) floor = reserve.reserveEnergyKwh
    }
  }
  return floor
}

/** A hard reserve that starts later must be reached before its window opens, so charge ahead. */
function reserveAheadTarget(
  reserves: readonly ReserveConstraint[],
  slotIndex: number,
  minEnergyKwh: number,
): number {
  let target = minEnergyKwh
  for (const reserve of reserves) {
    if (reserve.severity === 'hard' && reserve.windowStartSlot > slotIndex) {
      if (reserve.reserveEnergyKwh > target) target = reserve.reserveEnergyKwh
    }
  }
  return target
}

export interface StrategyContext {
  readonly slotCount: number
  readonly deltaHours: number
  readonly loadKw: readonly number[]
  readonly pvAvailableKw: readonly number[]
  readonly purchasePrices: readonly (number | undefined)[]
  readonly battery: BatteryNumbers
  readonly reserves: readonly ReserveConstraint[]
  readonly cheapThreshold: number
  readonly expensiveThreshold: number
}

interface StepDesire {
  readonly chargeKw: number
  readonly dischargeKw: number
}

interface AppliedStep {
  readonly step: PlanStep
  readonly energyKwh: number
}

const ENERGY_EPSILON = 1e-12

/** Clamp one desired action to the device limits and the remaining capacity, then advance energy. */
function applyDesire(
  slotIndex: number,
  energyKwh: number,
  desire: StepDesire,
  battery: BatteryNumbers,
  floorKwh: number,
  deltaHours: number,
): AppliedStep {
  const headroomKwh = battery.maxEnergyKwh - energyKwh
  const maxChargeByEnergyKw =
    headroomKwh <= 0 ? 0 : headroomKwh / (battery.chargeEfficiency * deltaHours)
  const chargeKw = round(
    Math.max(0, Math.min(desire.chargeKw, battery.chargePowerLimitKw, maxChargeByEnergyKw)),
    9,
  )

  const availableKwh = energyKwh - floorKwh
  const maxDischargeByEnergyKw =
    availableKwh <= 0 ? 0 : (availableKwh * battery.dischargeEfficiency) / deltaHours
  const dischargeKw = round(
    Math.max(0, Math.min(desire.dischargeKw, battery.dischargePowerLimitKw, maxDischargeByEnergyKw)),
    9,
  )

  const nextEnergyKwh =
    energyKwh +
    battery.chargeEfficiency * chargeKw * deltaHours -
    (dischargeKw * deltaHours) / battery.dischargeEfficiency

  return {
    step: { slotIndex, chargeKw, dischargeKw },
    energyKwh: nextEnergyKwh,
  }
}

function buildSteps(
  context: StrategyContext,
  desireAt: (slotIndex: number, energyKwh: number) => StepDesire,
  floorAt: (slotIndex: number) => number = (slotIndex) =>
    reserveFloorAt(context.reserves, slotIndex, context.battery.minEnergyKwh),
): readonly PlanStep[] {
  const steps: PlanStep[] = []
  let energyKwh = context.battery.initialEnergyKwh
  for (let slotIndex = 0; slotIndex < context.slotCount; slotIndex += 1) {
    const applied = applyDesire(
      slotIndex,
      energyKwh,
      desireAt(slotIndex, energyKwh),
      context.battery,
      floorAt(slotIndex),
      context.deltaHours,
    )
    steps.push(applied.step)
    energyKwh = applied.energyKwh
  }
  return steps
}

function selfConsumptionDesire(context: StrategyContext, slotIndex: number): StepDesire {
  const loadKw = context.loadKw[slotIndex] ?? 0
  const pvKw = context.pvAvailableKw[slotIndex] ?? 0
  const surplusKw = pvKw - loadKw
  if (surplusKw > 0) return { chargeKw: surplusKw, dischargeKw: 0 }
  return { chargeKw: 0, dischargeKw: -surplusKw }
}

function reserveFirstDesire(
  context: StrategyContext,
  slotIndex: number,
  energyKwh: number,
): StepDesire {
  const loadKw = context.loadKw[slotIndex] ?? 0
  const pvKw = context.pvAvailableKw[slotIndex] ?? 0
  const floorKwh = reserveFloorAt(context.reserves, slotIndex, context.battery.minEnergyKwh)
  const targetKwh = Math.max(
    floorKwh,
    reserveAheadTarget(context.reserves, slotIndex, context.battery.minEnergyKwh),
  )

  if (energyKwh < targetKwh - ENERGY_EPSILON) {
    const neededKwh = targetKwh - energyKwh
    const neededKw = neededKwh / (context.battery.chargeEfficiency * context.deltaHours)
    const surplusKw = Math.max(0, pvKw - loadKw)
    const chargeKw = context.battery.gridChargingAllowed
      ? neededKw
      : Math.min(neededKw, surplusKw)
    return { chargeKw, dischargeKw: 0 }
  }

  const surplusKw = pvKw - loadKw
  if (surplusKw > 0) return { chargeKw: surplusKw, dischargeKw: 0 }
  return { chargeKw: 0, dischargeKw: -surplusKw }
}

function priceWindowDesire(
  context: StrategyContext,
  slotIndex: number,
  energyKwh: number,
): StepDesire {
  const loadKw = context.loadKw[slotIndex] ?? 0
  const pvKw = context.pvAvailableKw[slotIndex] ?? 0
  const floorKwh = reserveFloorAt(context.reserves, slotIndex, context.battery.minEnergyKwh)

  if (energyKwh < floorKwh - ENERGY_EPSILON) {
    const neededKwh = floorKwh - energyKwh
    const neededKw = neededKwh / (context.battery.chargeEfficiency * context.deltaHours)
    return { chargeKw: neededKw, dischargeKw: 0 }
  }

  const price = context.purchasePrices[slotIndex]
  if (price === undefined) return { chargeKw: 0, dischargeKw: 0 }
  if (price <= context.cheapThreshold) {
    return { chargeKw: context.battery.chargePowerLimitKw, dischargeKw: 0 }
  }
  if (price >= context.expensiveThreshold) {
    return { chargeKw: 0, dischargeKw: Math.max(0, loadKw - pvKw) }
  }

  const surplusKw = pvKw - loadKw
  if (surplusKw > 0) return { chargeKw: surplusKw, dischargeKw: 0 }
  return { chargeKw: 0, dischargeKw: 0 }
}

export function generateStrategyPlan(
  strategy: CandidateStrategyKind,
  context: StrategyContext,
): readonly PlanStep[] {
  switch (strategy) {
    case 'self_consumption':
      return buildSteps(context, (slotIndex) => selfConsumptionDesire(context, slotIndex))
    case 'reserve_first':
      return buildSteps(
        context,
        (slotIndex, energyKwh) => reserveFirstDesire(context, slotIndex, energyKwh),
        (slotIndex) =>
          Math.max(
            reserveFloorAt(context.reserves, slotIndex, context.battery.minEnergyKwh),
            reserveAheadTarget(context.reserves, slotIndex, context.battery.minEnergyKwh),
          ),
      )
    case 'price_window':
      return buildSteps(context, (slotIndex, energyKwh) =>
        priceWindowDesire(context, slotIndex, energyKwh),
      )
    default:
      throw new EnergyPlannerError(
        'PLAN_GENERATION_FAILED',
        `strategy ${String(strategy)} is not a supported bounded strategy`,
      )
  }
}
