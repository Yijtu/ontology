import { describe, expect, it } from 'vitest'
import { buildSyntheticTelemetryInput } from '../../apps/api/src/scenarios/synthetic-telemetry'

describe('synthetic telemetry profiles', () => {
  it('maps wide and long physical layouts to the same canonical meter series while pinning their sources', () => {
    const wide = buildSyntheticTelemetryInput({ profileId: 'home-energy-demo-wide', backupRequirementKwh: 2, weatherScenario: 'sunny' })
    const long = buildSyntheticTelemetryInput({ profileId: 'home-energy-demo-long', backupRequirementKwh: 2, weatherScenario: 'sunny' })

    expect(wide.snapshot.manifest.series.map((series) => series.points.map((point) => point.value)))
      .toEqual(long.snapshot.manifest.series.map((series) => series.points.map((point) => point.value)))
    expect(wide.snapshot.manifest.series[0]?.sourceRef.sourceId).toBe('synthetic-wide-v1')
    expect(long.snapshot.manifest.series[0]?.sourceRef.sourceId).toBe('synthetic-long-v1')
    expect(wide.snapshot.manifest.series[0]?.mappingVersion.digest)
      .not.toBe(long.snapshot.manifest.series[0]?.mappingVersion.digest)
    expect(long.snapshot.manifest.series[0]?.sourceSnapshot.schemaVersion).toBe('long-metric-rows@1.0.0')
  })
})
