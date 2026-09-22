import type { DataMode } from '@ontology/contracts'

/**
 * Two synthetic home-energy observation data sets (LOCAL-042).
 *
 * Both describe the same logical measurements but use different physical naming and
 * units. They are aligned only through the customer mappings in `./mappings`; the pack
 * itself never sees a physical column name or a source unit. Every data set is explicitly
 * marked synthetic, and the device parameters are simulated assumptions — no real device
 * specification is written here.
 */

export interface SyntheticDatasetMetadata {
  readonly datasetId: string
  readonly dataMode: DataMode
  readonly synthetic: true
  readonly sourceNaming: string
  readonly sourceUnits: {
    readonly power: string
    readonly energy: string
    readonly timestamp: string
  }
  readonly deviceSpecsAreSimulatedAssumptions: true
  readonly note: string
}

export const SYNTHETIC_DATASET_A_METADATA: SyntheticDatasetMetadata = {
  datasetId: 'home-energy.synthetic.source-a',
  dataMode: 'synthetic',
  synthetic: true,
  sourceNaming: 'source A: obs_id / sensor_key / ts / power_w / energy_wh / quality_code',
  sourceUnits: { power: 'W', energy: 'Wh', timestamp: 'RFC3339 UTC' },
  deviceSpecsAreSimulatedAssumptions: true,
  note: 'Synthetic fixture. Device ratings are simulated assumptions, not a real device specification.',
}

export const SYNTHETIC_DATASET_B_METADATA: SyntheticDatasetMetadata = {
  datasetId: 'home-energy.synthetic.source-b',
  dataMode: 'synthetic',
  synthetic: true,
  sourceNaming:
    'source B: reading_id / sensor_id / recorded_at / active_power_kw / interval_energy_kwh / quality_label',
  sourceUnits: { power: 'kW', energy: 'kWh', timestamp: 'RFC3339 UTC' },
  deviceSpecsAreSimulatedAssumptions: true,
  note: 'Synthetic fixture. Device ratings are simulated assumptions, not a real device specification.',
}

/** One logical observation, in canonical units (kW, kWh). */
export interface LogicalObservation {
  readonly observationId: string
  readonly sensorNativeId: string
  readonly recordedAt: string
  readonly powerKw: number
  readonly energyKwh: number
  readonly quality: 'good' | 'suspect'
}

export const LOGICAL_OBSERVATIONS: readonly LogicalObservation[] = [
  {
    observationId: 'o1',
    sensorNativeId: 'sensor-living',
    recordedAt: '2026-01-01T00:00:00Z',
    powerKw: 3.5,
    energyKwh: 5.25,
    quality: 'good',
  },
  {
    observationId: 'o2',
    sensorNativeId: 'sensor-living',
    recordedAt: '2026-01-01T00:15:00Z',
    powerKw: 4.0,
    energyKwh: 6.0,
    quality: 'good',
  },
  {
    observationId: 'o3',
    sensorNativeId: 'sensor-garage',
    recordedAt: '2026-01-01T00:00:00Z',
    powerKw: 1.25,
    energyKwh: 2.5,
    quality: 'suspect',
  },
  {
    observationId: 'o4',
    sensorNativeId: 'sensor-garage',
    recordedAt: '2026-01-01T00:15:00Z',
    powerKw: 2.0,
    energyKwh: 3.0,
    quality: 'good',
  },
]

export type PhysicalRow = readonly (string | number)[] | readonly (string | number | null)[]

/** Source A physical rows: watts, watt-hours, numeric quality code. */
export function sourceARows(): readonly PhysicalRow[] {
  return LOGICAL_OBSERVATIONS.map((observation) => [
    observation.observationId,
    observation.sensorNativeId,
    observation.recordedAt,
    observation.powerKw * 1000,
    observation.energyKwh * 1000,
    observation.quality === 'good' ? 1 : 0,
  ])
}

/** Source B physical rows: kilowatts, kilowatt-hours, text quality label. */
export function sourceBRows(): readonly PhysicalRow[] {
  return LOGICAL_OBSERVATIONS.map((observation) => [
    observation.observationId,
    observation.sensorNativeId,
    observation.recordedAt,
    observation.powerKw,
    observation.energyKwh,
    observation.quality === 'good' ? 'OK' : 'BAD',
  ])
}
