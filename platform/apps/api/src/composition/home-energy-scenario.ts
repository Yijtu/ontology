import type {
  DataMode,
  ImmutableArtifactWriter,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  SourceRef,
  TimeWindow,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  DEFAULT_SIMULATION_TOLERANCE,
  ENERGY_OPERATION_INPUT_MEDIA_TYPE,
  canonicalJson,
  energyOperationInputDigest,
  encodeEnergyOperationInput,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type {
  BatterySpecDeclaration,
  EnergyInputSnapshot,
  EnergyOperationInput,
  GridSpec,
  NormalizedPoint,
  NormalizedSeries,
  ReserveConstraint,
  SamplingType,
  SeriesBinding,
  TariffBinding,
  TopologyDeclaration,
} from '@ontology/extension-home-energy'

/**
 * The synthetic home-energy scenario catalog (SPEC E1/E3/E7; INV-10, ADR-12).
 *
 * The first implementation has no hardware, no Home Assistant interface and no live meter, so
 * the operator never supplies a power trajectory. The operator names only two *intents* — the
 * backup requirement and the weather scenario — and this catalog builds the bounded,
 * content-addressed `EnergyOperationInput` from a deterministic synthetic profile. Every series
 * states its unit, time zone, slot length and `observed`/`forecast` sampling; the bundle is
 * `dataMode: synthetic` and its assumptions name the scenario. Nothing here is a real device
 * specification, a real tariff or live data, and nothing here can be edited into a device
 * command: it is read-only input for a pure simulation.
 *
 * The built bundle is archived through the injected immutable artifact writer, so the model or
 * UI can only pass back the opaque `inputRef`; the compute handler reads exactly those bytes.
 */

export const WEATHER_SCENARIOS = ['sunny', 'overcast', 'storm'] as const

export type WeatherScenario = (typeof WEATHER_SCENARIOS)[number]

export function isWeatherScenario(value: unknown): value is WeatherScenario {
  return typeof value === 'string' && (WEATHER_SCENARIOS as readonly string[]).includes(value)
}

export const MAX_BACKUP_REQUIREMENT_KWH = 50
export const BATTERY_CAPACITY_KWH = 10

const SLOT_MINUTES = 15
const SLOT_COUNT = 96
/** Local 2026-01-01T00:00 in Asia/Shanghai (+08:00), expressed as the UTC instant. */
const START_UTC: Rfc3339UtcTimestamp = '2025-12-31T16:00:00.000Z'
const LOAD_MEASUREMENT_POINT = 'mp-load'
const PV_MEASUREMENT_POINT = 'mp-pv'
const SOURCE_REF: SourceRef = { namespace: 'home-energy.synthetic', sourceId: 'ui-scenario' }
const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: sha256DigestOf(new TextEncoder().encode('home-energy.ui-scenario.site')),
  kind: 'dataset',
}

function versionRef(id: string, version: string, seed: string): VersionRef {
  return { id, version, digest: sha256DigestOf(new TextEncoder().encode(`${id}@${version}#${seed}`)) }
}

const INPUT_VERSIONS = {
  mapping: versionRef('home-energy.mapping.ui', '1.0.0', '1'),
  deviceSpec: versionRef('home-energy.device.ui', '1.0.0', '2'),
  tariff: versionRef('home-energy.tariff.ui', '1.0.0', '3'),
  userConstraint: versionRef('home-energy.constraints.ui', '1.0.0', '4'),
} as const

export interface ScenarioRequest {
  readonly backupRequirementKwh?: number
  readonly reserveSocPercent?: number
  readonly weatherScenario: WeatherScenario
  readonly timeZone?: string
}

/** One declared series of the scenario: its unit, time base and sampling type, never implicit. */
export interface ScenarioSeriesDescriptor {
  readonly measurementPointRef: string
  readonly role: 'load' | 'pv'
  readonly metric: 'power'
  readonly unit: 'kW'
  readonly samplingType: SamplingType
  readonly sourceRef: SourceRef
  readonly dataMode: DataMode
  readonly firstSlotUtc: Rfc3339UtcTimestamp
  readonly lastSlotUtc: Rfc3339UtcTimestamp
}

/**
 * The bounded, JSON-serialisable scenario the UI may display and reference. It carries the
 * opaque `inputRef` the operator passes back, plus the labels a reader needs (unit, time zone,
 * slot length, sampling) and the two intents that produced it. `inputDigest` is content-addressed:
 * changing the backup requirement or the weather scenario changes it, which is what makes a new
 * plan a genuinely new version rather than a relabelled one.
 */
export interface ScenarioDescriptor {
  readonly inputRef: ResourceRef
  readonly inputDigest: Sha256Digest
  readonly dataMode: DataMode
  readonly timeZone: string
  readonly slotMinutes: number
  readonly slotCount: number
  readonly horizon: TimeWindow
  readonly backupRequirementKwh: number
  readonly reserveSocPercent: number
  readonly weatherScenario: WeatherScenario
  readonly batterySpecSource: BatterySpecDeclaration['specSource']
  readonly series: readonly ScenarioSeriesDescriptor[]
  readonly assumptions: readonly string[]
}

export interface ScenarioCatalog {
  buildScenario(request: ScenarioRequest, ctx: ToolContext): Promise<ScenarioDescriptor>
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function timestampAt(slotIndex: number): Rfc3339UtcTimestamp {
  return new Date(Date.parse(START_UTC) + slotIndex * SLOT_MINUTES * 60_000).toISOString()
}

function hourOf(slotIndex: number): number {
  return (slotIndex * SLOT_MINUTES) / 60
}

/** A deterministic synthetic household load: a small base plus morning/evening peaks. */
function loadKwAt(slotIndex: number): number {
  const hour = hourOf(slotIndex)
  const morning = hour >= 6 && hour < 9 ? 1.4 : 0
  const daytime = hour >= 9 && hour < 17 ? 0.5 : 0
  const evening = hour >= 17 && hour < 22 ? 2.2 : 0
  return round(0.4 + morning + daytime + evening, 3)
}

const WEATHER_FACTOR: Readonly<Record<WeatherScenario, number>> = {
  sunny: 1,
  overcast: 0.35,
  storm: 0.08,
}

/** A deterministic synthetic PV forecast shaped by the named weather scenario. */
function pvKwAt(slotIndex: number, weather: WeatherScenario): number {
  const hour = hourOf(slotIndex)
  if (hour < 6 || hour >= 19) return 0
  const x = (hour - 12.5) / 3.5
  return round(5.2 * Math.exp(-x * x) * WEATHER_FACTOR[weather], 3)
}

/** A deterministic synthetic purchase-price profile with a cheap night and an expensive evening. */
function purchasePriceAt(slotIndex: number): number {
  const hour = hourOf(slotIndex)
  if (hour < 6 || (hour >= 12 && hour < 16)) return 0.3
  if (hour >= 17 && hour < 22) return 1.2
  return 0.65
}

function pointsFor(values: readonly number[]): readonly NormalizedPoint[] {
  return values.map((value, slotIndex) => ({
    slotIndex,
    timestamp: timestampAt(slotIndex),
    value,
    quality: 'good' as const,
    status: 'ok' as const,
  }))
}

function seriesFor(options: {
  readonly measurementPointRef: string
  readonly values: readonly number[]
  readonly samplingType: SamplingType
  readonly timeZone: string
  readonly horizon: TimeWindow
  readonly weather: WeatherScenario
}): NormalizedSeries {
  const base = {
    measurementPointRef: options.measurementPointRef,
    metric: 'power' as const,
    unit: 'kW',
    timeZone: options.timeZone,
    slotMinutes: SLOT_MINUTES,
    samplingType: options.samplingType,
    semantics: 'instantaneous' as const,
    points: pointsFor(options.values),
    sourceRef: SOURCE_REF,
    mappingVersion: INPUT_VERSIONS.mapping,
    sourceSnapshot: {
      sourceRef: SOURCE_REF,
      schemaVersion: '1.0.0',
      asOf: options.horizon.end,
      consistency: 'repeatable_read' as const,
      resultDigest: sha256DigestOf(
        new TextEncoder().encode(`home-energy.ui-scenario.${options.measurementPointRef}`),
      ),
    },
  }
  return options.samplingType === 'forecast'
    ? {
        ...base,
        issuedAt: options.horizon.start,
        validityWindow: options.horizon,
        method: `synthetic-weather:${options.weather}`,
        assumptions: [`weather_scenario=${options.weather}`, 'synthetic scenario forecast'],
      }
    : base
}

const BATTERY: BatterySpecDeclaration = {
  deviceRef: 'battery-1',
  specSource: 'synthetic_assumption',
  energyCapacityKwh: 10,
  minEnergyKwh: 1,
  maxEnergyKwh: 10,
  chargePowerLimitKw: 5,
  dischargePowerLimitKw: 5,
  chargeEfficiency: 0.9,
  dischargeEfficiency: 0.9,
  initialEnergyKwh: 3.5,
  gridChargingAllowed: true,
  exportAllowed: true,
  islandingSupported: false,
}

const TOPOLOGY: TopologyDeclaration = {
  kind: 'ac_coupled_single_storage',
  storageDeviceRef: 'battery-1',
  inverterRef: 'inverter-1',
  gridConnectionRef: 'grid-1',
}

const GRID: GridSpec = { connectionRef: 'grid-1' }

const LOAD_BINDING: SeriesBinding = { measurementPointRef: LOAD_MEASUREMENT_POINT, samplingType: 'observed' }
const PV_BINDING: SeriesBinding = { measurementPointRef: PV_MEASUREMENT_POINT, samplingType: 'forecast' }

function reserveInputs(request: ScenarioRequest): { readonly reserveSocPercent: number; readonly backupRequirementKwh: number } {
  if (request.reserveSocPercent !== undefined) {
    return { reserveSocPercent: request.reserveSocPercent, backupRequirementKwh: BATTERY_CAPACITY_KWH * request.reserveSocPercent / 100 }
  }
  const backupRequirementKwh = request.backupRequirementKwh ?? BATTERY_CAPACITY_KWH * 0.2
  return { backupRequirementKwh, reserveSocPercent: backupRequirementKwh / BATTERY_CAPACITY_KWH * 100 }
}

function scenarioAssumptions(weather: WeatherScenario, backupRequirementKwh: number, reserveSocPercent: number): readonly string[] {
  return [
    'synthetic fixture scenario',
    `weather_scenario=${weather}`,
    `backup_requirement_kwh=${backupRequirementKwh}`,
    `reserve_soc_percent=${reserveSocPercent}`,
    'battery_spec=synthetic_assumption',
    'no_real_device_spec',
    'simulation_only',
  ]
}

function reservesFor(backupRequirementKwh: number): readonly ReserveConstraint[] {
  if (backupRequirementKwh <= 0) return []
  return [
    {
      reserveEnergyKwh: backupRequirementKwh,
      windowStartSlot: 0,
      windowEndSlot: SLOT_COUNT,
      source: 'user_preference',
      severity: 'hard',
      requiresIslanding: false,
    },
  ]
}

/** Build the bounded, content-addressed input bundle for one named scenario. Pure and deterministic. */
export function buildSyntheticScenarioInput(request: ScenarioRequest): EnergyOperationInput {
  const timeZone = request.timeZone ?? 'Asia/Shanghai'
  const weather = request.weatherScenario
  const reserve = reserveInputs(request)
  const loadKw = Array.from({ length: SLOT_COUNT }, (_unused, slotIndex) => loadKwAt(slotIndex))
  const pvKw = Array.from({ length: SLOT_COUNT }, (_unused, slotIndex) => pvKwAt(slotIndex, weather))
  const horizon: TimeWindow = { start: START_UTC, end: timestampAt(SLOT_COUNT) }
  const tariff: TariffBinding = {
    tariffRef: INPUT_VERSIONS.tariff,
    currency: 'CNY',
    prices: Array.from({ length: SLOT_COUNT }, (_unused, slotIndex) => ({
      purchasePricePerKwh: purchasePriceAt(slotIndex),
      exportPricePerKwh: 0.4,
    })),
  }
  const series: readonly NormalizedSeries[] = [
    seriesFor({
      measurementPointRef: LOAD_MEASUREMENT_POINT,
      values: loadKw,
      samplingType: 'observed',
      timeZone,
      horizon,
      weather,
    }),
    seriesFor({
      measurementPointRef: PV_MEASUREMENT_POINT,
      values: pvKw,
      samplingType: 'forecast',
      timeZone,
      horizon,
      weather,
    }),
  ]
  const manifest = {
    normalizationVersion: '1.0.0',
    siteRef: SITE_REF,
    evaluationClock: horizon.end,
    horizon,
    timeZone,
    slotMinutes: SLOT_MINUTES,
    slotCount: SLOT_COUNT,
    dataMode: 'synthetic' as const,
    versions: INPUT_VERSIONS,
    coverage: { additive: [LOAD_MEASUREMENT_POINT, PV_MEASUREMENT_POINT], redundant: [], conflicts: [] },
    sourceWatermarks: [],
    missingInputs: [],
    series,
  }
  const digest = sha256DigestOf(new TextEncoder().encode(canonicalJson(manifest)))
  const snapshot: EnergyInputSnapshot = {
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
  return {
    kind: 'home-energy.operation-input',
    version: '1.0.0',
    dataMode: 'synthetic',
    snapshot,
    topology: TOPOLOGY,
    battery: BATTERY,
    grid: GRID,
    load: [LOAD_BINDING],
    pv: [PV_BINDING],
    tariff,
    reserves: reservesFor(reserve.backupRequirementKwh),
    tolerance: DEFAULT_SIMULATION_TOLERANCE,
    assumptions: scenarioAssumptions(weather, reserve.backupRequirementKwh, reserve.reserveSocPercent),
    // A declared, fixture-only valuation so candidates that end at a different terminal energy
    // can still be compared on one basis (SPEC E5, E-08). It is `fixture_declared`, not a real
    // tariff, and the comparison still refuses an unqualified saving claim without it.
    terminalEnergyValuation: {
      currency: 'CNY',
      valuationPerKwh: 0.5,
      source: 'fixture_declared',
    },
  }
}

function assumptionValue(assumptions: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`
  for (const assumption of assumptions) {
    if (assumption.startsWith(prefix)) return assumption.slice(prefix.length)
  }
  return undefined
}

function roleOf(measurementPointRef: string): 'load' | 'pv' {
  return measurementPointRef === PV_MEASUREMENT_POINT ? 'pv' : 'load'
}

/**
 * Reconstruct the scenario descriptor from an already-decoded input bundle. The GET read uses
 * this so a reader sees the same labels (unit, time, sampling, mode) that produced the plan,
 * derived from the immutable bytes rather than from anything the caller claimed.
 */
export function scenarioDescriptorOf(
  input: EnergyOperationInput,
  inputRef: ResourceRef,
): ScenarioDescriptor {
  const manifest = input.snapshot.manifest
  const weatherValue = assumptionValue(input.assumptions, 'weather_scenario')
  const weather = isWeatherScenario(weatherValue) ? weatherValue : 'sunny'
  const backupValue = assumptionValue(input.assumptions, 'backup_requirement_kwh')
  const backupParsed = backupValue === undefined ? Number.NaN : Number(backupValue)
  const reserve = input.reserves[0]
  const backupRequirementKwh = Number.isFinite(backupParsed)
    ? backupParsed
    : (reserve?.reserveEnergyKwh ?? 0)
  const reserveParsed = Number(assumptionValue(input.assumptions, 'reserve_soc_percent'))
  const reserveSocPercent = Number.isFinite(reserveParsed) ? reserveParsed : backupRequirementKwh / BATTERY_CAPACITY_KWH * 100
  const series = manifest.series.map((entry): ScenarioSeriesDescriptor => {
    const first = entry.points[0]
    const last = entry.points[entry.points.length - 1]
    return {
      measurementPointRef: entry.measurementPointRef,
      role: roleOf(entry.measurementPointRef),
      metric: 'power',
      unit: 'kW',
      samplingType: entry.samplingType,
      sourceRef: entry.sourceRef,
      dataMode: input.dataMode,
      firstSlotUtc: first?.timestamp ?? manifest.horizon.start,
      lastSlotUtc: last?.timestamp ?? manifest.horizon.end,
    }
  })
  return {
    inputRef,
    inputDigest: energyOperationInputDigest(input),
    dataMode: input.dataMode,
    timeZone: manifest.timeZone,
    slotMinutes: manifest.slotMinutes,
    slotCount: manifest.slotCount,
    horizon: manifest.horizon,
    backupRequirementKwh,
    reserveSocPercent,
    weatherScenario: weather,
    batterySpecSource: input.battery.specSource,
    series,
    assumptions: [...input.assumptions],
  }
}

export interface SyntheticScenarioCatalogOptions {
  readonly artifacts: ImmutableArtifactWriter
}

export function createSyntheticScenarioCatalog(
  options: SyntheticScenarioCatalogOptions,
): ScenarioCatalog {
  return {
    async buildScenario(request: ScenarioRequest, ctx: ToolContext): Promise<ScenarioDescriptor> {
      const input = buildSyntheticScenarioInput(request)
      const stored = await options.artifacts.putBytes(
        {
          scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
          content: encodeEnergyOperationInput(input),
          mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE,
        },
        ctx,
      )
      return scenarioDescriptorOf(input, stored.blobRef)
    },
  }
}
