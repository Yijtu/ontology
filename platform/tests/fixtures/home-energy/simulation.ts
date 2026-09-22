import type {
  DataMode,
  ResourceRef,
  Rfc3339UtcTimestamp,
  TimeWindow,
} from '@ontology/contracts'
import {
  DEFAULT_SIMULATION_TOLERANCE,
  canonicalJson,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type {
  BatterySpecDeclaration,
  EnergyInputSnapshot,
  EnergySimulationRequest,
  NormalizedPoint,
  NormalizedSeries,
  PlanStep,
  PlanTrajectory,
  SamplingType,
  SeriesBinding,
  SimulationTolerance,
  TariffBinding,
  TopologyDeclaration,
} from '@ontology/extension-home-energy'
import { HOME_ENERGY_INPUT_VERSIONS, digestOf, versionRef } from './energy-input'

/**
 * Synthetic fixtures for the pure energy simulator (LOCAL-044).
 *
 * Every snapshot is explicitly marked `synthetic`, every series states its sampling type
 * (observed/forecast/simulated), and every device parameter is declared as a simulated
 * assumption — no real device specification, price or live data appears here. The load/PV
 * values are hand-checked so a test can recompute the storage recursion and balance by hand.
 */

export const SIM_LOAD_MEASUREMENT_POINT = 'mp-load'
export const SIM_PV_MEASUREMENT_POINT = 'mp-pv'
export const SIM_SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: digestOf('a'),
  kind: 'dataset',
}

const SOURCE_REF = { namespace: 'home-energy.synthetic', sourceId: 'simulation-fixture' }

function timestampAt(start: Rfc3339UtcTimestamp, slotIndex: number, slotMinutes: number): Rfc3339UtcTimestamp {
  return new Date(Date.parse(start) + slotIndex * slotMinutes * 60_000).toISOString()
}

function pointsFor(
  values: readonly (number | undefined)[],
  start: Rfc3339UtcTimestamp,
  slotMinutes: number,
): readonly NormalizedPoint[] {
  return values.map((value, slotIndex) => ({
    slotIndex,
    timestamp: timestampAt(start, slotIndex, slotMinutes),
    ...(value === undefined ? {} : { value }),
    quality: value === undefined ? 'missing' : 'good',
    status: value === undefined ? 'missing' : 'ok',
  }))
}

function seriesFor(options: {
  readonly measurementPointRef: string
  readonly values: readonly (number | undefined)[]
  readonly samplingType: SamplingType
  readonly start: Rfc3339UtcTimestamp
  readonly slotMinutes: number
  readonly timeZone: string
  readonly horizon: TimeWindow
}): NormalizedSeries {
  const sourceSnapshotRef = {
    sourceRef: SOURCE_REF,
    schemaVersion: '1.0.0',
    asOf: options.horizon.end,
    consistency: 'repeatable_read' as const,
    resultDigest: digestOf('e'),
  }
  const base = {
    measurementPointRef: options.measurementPointRef,
    metric: 'power' as const,
    unit: 'kW',
    timeZone: options.timeZone,
    slotMinutes: options.slotMinutes,
    samplingType: options.samplingType,
    semantics: 'instantaneous' as const,
    points: pointsFor(options.values, options.start, options.slotMinutes),
    sourceRef: SOURCE_REF,
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
    sourceSnapshot: sourceSnapshotRef,
  }
  return options.samplingType === 'forecast'
    ? {
        ...base,
        issuedAt: options.horizon.start,
        validityWindow: options.horizon,
        method: 'fixture-persistence',
        assumptions: ['synthetic fixture'],
      }
    : base
}

export interface SimulationSnapshotOptions {
  readonly slotMinutes: number
  readonly loadKw: readonly (number | undefined)[]
  readonly pvKw: readonly (number | undefined)[]
  readonly start?: Rfc3339UtcTimestamp
  readonly timeZone?: string
  readonly dataMode?: DataMode
  readonly loadSampling?: SamplingType
  readonly pvSampling?: SamplingType
}

/** Build a content-addressed LOCAL-043-shaped snapshot directly from per-slot kW arrays. */
export function simulationSnapshot(options: SimulationSnapshotOptions): EnergyInputSnapshot {
  const slotCount = options.loadKw.length
  const start = options.start ?? '2026-01-01T00:00:00.000Z'
  const timeZone = options.timeZone ?? 'UTC'
  const horizon: TimeWindow = {
    start,
    end: timestampAt(start, slotCount, options.slotMinutes),
  }
  const series: NormalizedSeries[] = [
    seriesFor({
      measurementPointRef: SIM_LOAD_MEASUREMENT_POINT,
      values: options.loadKw,
      samplingType: options.loadSampling ?? 'observed',
      start,
      slotMinutes: options.slotMinutes,
      timeZone,
      horizon,
    }),
    seriesFor({
      measurementPointRef: SIM_PV_MEASUREMENT_POINT,
      values: options.pvKw,
      samplingType: options.pvSampling ?? 'forecast',
      start,
      slotMinutes: options.slotMinutes,
      timeZone,
      horizon,
    }),
  ]
  const manifest = {
    normalizationVersion: '1.0.0',
    siteRef: SIM_SITE_REF,
    evaluationClock: horizon.end,
    horizon,
    timeZone,
    slotMinutes: options.slotMinutes,
    slotCount,
    dataMode: options.dataMode ?? 'synthetic',
    versions: HOME_ENERGY_INPUT_VERSIONS,
    coverage: {
      additive: [SIM_LOAD_MEASUREMENT_POINT, SIM_PV_MEASUREMENT_POINT],
      redundant: [],
      conflicts: [],
    },
    sourceWatermarks: [],
    missingInputs: [],
    series,
  }
  const digest = sha256DigestOf(new TextEncoder().encode(canonicalJson(manifest)))
  return {
    snapshotRef: {
      id: '99999999-2222-4333-8444-555555555555',
      version: '1.0.0',
      digest,
      kind: 'artifact',
    },
    digest,
    mediaType: 'application/vnd.ontology.energy-input-snapshot+json',
    manifest,
  }
}

export const SIM_LOAD_BINDING: SeriesBinding = {
  measurementPointRef: SIM_LOAD_MEASUREMENT_POINT,
  samplingType: 'observed',
}

export const SIM_PV_BINDING: SeriesBinding = {
  measurementPointRef: SIM_PV_MEASUREMENT_POINT,
  samplingType: 'forecast',
}

export const SIM_BATTERY: BatterySpecDeclaration = {
  deviceRef: 'battery-1',
  specSource: 'synthetic_assumption',
  energyCapacityKwh: 10,
  minEnergyKwh: 1,
  maxEnergyKwh: 10,
  chargePowerLimitKw: 5,
  dischargePowerLimitKw: 5,
  chargeEfficiency: 0.9,
  dischargeEfficiency: 0.9,
  initialEnergyKwh: 5,
  gridChargingAllowed: true,
  exportAllowed: true,
  islandingSupported: false,
}

export const SIM_TOPOLOGY: TopologyDeclaration = {
  kind: 'ac_coupled_single_storage',
  storageDeviceRef: 'battery-1',
  inverterRef: 'inverter-1',
  gridConnectionRef: 'grid-1',
}

export function tariffFor(
  slotCount: number,
  purchasePricePerKwh: number,
  exportPricePerKwh: number,
): TariffBinding {
  return {
    tariffRef: versionRef('home-energy.tariff.sim', '1.0.0', '3'),
    currency: 'CNY',
    prices: Array.from({ length: slotCount }, () => ({ purchasePricePerKwh, exportPricePerKwh })),
  }
}

export function planFor(slotCount: number, steps: readonly PlanStep[] = []): PlanTrajectory {
  const bySlot = new Map(steps.map((step) => [step.slotIndex, step]))
  const resolved: PlanStep[] = Array.from({ length: slotCount }, (_unused, slotIndex) => {
    return bySlot.get(slotIndex) ?? { slotIndex, chargeKw: 0, dischargeKw: 0 }
  })
  return {
    planRef: {
      id: '88888888-2222-4333-8444-555555555555',
      version: '1.0.0',
      digest: digestOf('8'),
      kind: 'artifact',
    },
    algorithmVersion: versionRef('home-energy.planner.fixture', '1.0.0', '9'),
    steps: resolved,
  }
}

export interface SimulationRequestOverrides {
  readonly snapshot?: EnergyInputSnapshot
  readonly topology?: TopologyDeclaration
  /** Full replacement, used when a test must omit a declared parameter entirely. */
  readonly batterySpec?: BatterySpecDeclaration
  readonly battery?: Partial<BatterySpecDeclaration>
  readonly grid?: EnergySimulationRequest['grid']
  readonly load?: readonly SeriesBinding[]
  readonly pv?: readonly SeriesBinding[]
  readonly tariff?: TariffBinding
  readonly reserves?: EnergySimulationRequest['reserves']
  readonly plan?: PlanTrajectory
  readonly tolerance?: SimulationTolerance
  readonly assumptions?: readonly string[]
}

/** A 4-slot / 15-minute request with hand-checkable values, overridable per test. */
export function simulationRequest(
  overrides: SimulationRequestOverrides = {},
): EnergySimulationRequest {
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
    plan: overrides.plan ?? planFor(slotCount),
    tolerance: overrides.tolerance ?? DEFAULT_SIMULATION_TOLERANCE,
    assumptions: overrides.assumptions ?? ['synthetic fixture scenario'],
  }
}
