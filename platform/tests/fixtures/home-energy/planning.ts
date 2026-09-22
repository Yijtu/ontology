import { DEFAULT_SIMULATION_TOLERANCE } from '@ontology/extension-home-energy'
import type {
  BatterySpecDeclaration,
  CandidateStrategyKind,
  EnergyPlanRequest,
  EnergySimulationRequest,
  GridSpec,
  JevStrategyScore,
  ReserveConstraint,
  SeriesBinding,
  SimulationTolerance,
  TariffBinding,
  TerminalEnergyValuation,
  TopologyDeclaration,
} from '@ontology/extension-home-energy'
import { versionRef } from './energy-input'
import {
  SIM_BATTERY,
  SIM_LOAD_BINDING,
  SIM_PV_BINDING,
  SIM_TOPOLOGY,
  simulationSnapshot,
  tariffFor,
} from './simulation'

/**
 * Synthetic fixtures for the pure energy planner (LOCAL-045).
 *
 * They reuse the LOCAL-044 snapshot/battery/tariff builders so the planner and the simulator are
 * driven by exactly the same inputs. Every value is explicitly synthetic and every device parameter
 * is a declared simulated assumption — no real device specification, price or live data appears.
 */

/** A purchase-price series with distinct cheap and expensive windows for `price_window`. */
export function varyingTariff(
  purchasePrices: readonly number[],
  exportPricePerKwh = 0.4,
): TariffBinding {
  return {
    tariffRef: versionRef('home-energy.tariff.planning', '1.0.0', '3'),
    currency: 'CNY',
    prices: purchasePrices.map((purchasePricePerKwh) => ({
      purchasePricePerKwh,
      exportPricePerKwh,
    })),
  }
}

export interface PlanningRequestOverrides {
  readonly snapshot?: EnergyPlanRequest['snapshot']
  readonly topology?: TopologyDeclaration
  /** Full replacement, used when a test must omit a declared parameter entirely. */
  readonly batterySpec?: BatterySpecDeclaration
  readonly battery?: Partial<BatterySpecDeclaration>
  readonly grid?: GridSpec
  readonly load?: readonly SeriesBinding[]
  readonly pv?: readonly SeriesBinding[]
  readonly tariff?: TariffBinding
  readonly reserves?: readonly ReserveConstraint[]
  readonly tolerance?: SimulationTolerance
  readonly assumptions?: readonly string[]
  readonly strategyWhitelist?: readonly CandidateStrategyKind[]
  readonly terminalEnergyValuation?: TerminalEnergyValuation
  readonly jevStrategyScores?: readonly JevStrategyScore[]
}

/** A 4-slot / 15-minute planning request with hand-checkable values, overridable per test. */
export function planningRequest(overrides: PlanningRequestOverrides = {}): EnergyPlanRequest {
  const snapshot =
    overrides.snapshot ??
    simulationSnapshot({
      slotMinutes: 15,
      loadKw: [1, 1, 1, 1],
      pvKw: [4, 4, 0, 0],
    })
  const slotCount = snapshot.manifest.slotCount
  return {
    snapshot,
    executionMode: 'simulation',
    topology: overrides.topology ?? SIM_TOPOLOGY,
    battery: overrides.batterySpec ?? { ...SIM_BATTERY, ...overrides.battery },
    grid: overrides.grid ?? { connectionRef: 'grid-1' },
    load: overrides.load ?? [SIM_LOAD_BINDING],
    pv: overrides.pv ?? [SIM_PV_BINDING],
    tariff: overrides.tariff ?? tariffFor(slotCount, 1.0, 0.4),
    reserves: overrides.reserves ?? [],
    tolerance: overrides.tolerance ?? DEFAULT_SIMULATION_TOLERANCE,
    assumptions: overrides.assumptions ?? ['synthetic fixture scenario'],
    ...(overrides.strategyWhitelist === undefined
      ? {}
      : { strategyWhitelist: overrides.strategyWhitelist }),
    ...(overrides.terminalEnergyValuation === undefined
      ? {}
      : { terminalEnergyValuation: overrides.terminalEnergyValuation }),
    ...(overrides.jevStrategyScores === undefined
      ? {}
      : { jevStrategyScores: overrides.jevStrategyScores }),
  }
}

/** The idle simulation request for the same input, used to prove baseline/candidate parity. */
export function idleSimulationRequest(
  request: EnergyPlanRequest,
): Omit<EnergySimulationRequest, 'plan'> {
  return {
    snapshot: request.snapshot,
    executionMode: 'simulation',
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
  }
}
