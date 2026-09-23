import { canonicalJson, sha256DigestOf } from '@ontology/extension-home-energy'
import type { EnergyOperationInput, NormalizedPoint, NormalizedSeries } from '@ontology/extension-home-energy'
import { buildSyntheticScenarioInput } from '../composition/home-energy-scenario'

export type SyntheticTelemetryProfile = 'home-energy-demo-wide' | 'home-energy-demo-long'

interface LongMetricRow {
  readonly site_key: string
  readonly metric_code: 'LOAD_POWER_KW' | 'PV_POWER_KW'
  readonly time_utc: string
  readonly number_value: number
  readonly quality: 'good'
}

/**
 * Local fixture adapter for two intentionally different physical layouts. The long-form
 * profile performs an explicit metric-code/time/value pivot before yielding canonical series;
 * source and mapping revisions remain visible in the energy snapshot and evidence.
 */
export function buildSyntheticTelemetryInput(input: {
  readonly profileId: SyntheticTelemetryProfile
  readonly backupRequirementKwh: number
  readonly weatherScenario: 'sunny' | 'overcast' | 'storm'
}): EnergyOperationInput {
  const base = buildSyntheticScenarioInput({ backupRequirementKwh: input.backupRequirementKwh, weatherScenario: input.weatherScenario })
  const original = base.snapshot.manifest.series
  const sourceId = input.profileId === 'home-energy-demo-wide' ? 'synthetic-wide-v1' : 'synthetic-long-v1'
  const mappingRef = { id: `${input.profileId}.mapping`, version: '1.0.0', digest: sha256DigestOf(new TextEncoder().encode(`${input.profileId}.mapping@1.0.0`)) }
  let series: readonly NormalizedSeries[]

  if (input.profileId === 'home-energy-demo-wide') {
    series = original.map((entry) => ({
      ...entry,
      sourceRef: { namespace: 'home-energy.synthetic', sourceId },
      mappingVersion: mappingRef,
      sourceSnapshot: { ...entry.sourceSnapshot, sourceRef: { namespace: 'home-energy.synthetic', sourceId }, schemaVersion: 'wide-telemetry@1.0.0' },
    }))
  } else {
    const rows: LongMetricRow[] = original.flatMap((entry) => entry.points.map((point) => ({
      site_key: 'synthetic-home-1',
      metric_code: entry.measurementPointRef === 'mp-pv' ? 'PV_POWER_KW' : 'LOAD_POWER_KW',
      time_utc: point.timestamp,
      number_value: point.value ?? (() => { throw new Error('long-form telemetry contains a missing numeric value') })(),
      quality: 'good',
    })))
    const rowsDigest = sha256DigestOf(new TextEncoder().encode(canonicalJson(rows)))
    series = original.map((entry) => {
      const code = entry.measurementPointRef === 'mp-pv' ? 'PV_POWER_KW' : 'LOAD_POWER_KW'
      const mappedPoints: readonly NormalizedPoint[] = rows
        .filter((row) => row.metric_code === code)
        .map((row, slotIndex) => ({ slotIndex, timestamp: row.time_utc, value: row.number_value, quality: row.quality, status: 'ok' }))
      return {
        ...entry,
        points: mappedPoints,
        sourceRef: { namespace: 'home-energy.synthetic', sourceId },
        mappingVersion: mappingRef,
        sourceSnapshot: { ...entry.sourceSnapshot, sourceRef: { namespace: 'home-energy.synthetic', sourceId }, schemaVersion: 'long-metric-rows@1.0.0', resultDigest: rowsDigest },
      }
    })
  }

  const manifest = { ...base.snapshot.manifest, series }
  const digest = sha256DigestOf(new TextEncoder().encode(canonicalJson(manifest)))
  return { ...base, snapshot: { ...base.snapshot, digest, snapshotRef: { ...base.snapshot.snapshotRef, digest }, manifest } }
}
