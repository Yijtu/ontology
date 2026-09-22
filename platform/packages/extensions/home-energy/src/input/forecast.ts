import type {
  ForecastPort,
  ResourceRef,
  Rfc3339UtcTimestamp,
  TimeWindow,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { EnergyMetric, ForecastSeriesInput, RawTelemetryPoint } from './types'

/**
 * Forecast reading through the canonical `ForecastPort` (C3, SPEC E1).
 *
 * The normaliser never reaches a forecast backend directly. This helper resolves bounded
 * forecasts through the injected port and preserves the fields a historical snapshot must keep:
 * when the forecast was issued, the window it targets, the method and its assumptions, the
 * producing model version and the exact source snapshot.
 *
 * `asOf` is the evaluation clock. The port must not return a forecast issued after it; the pure
 * normaliser re-checks `issuedAt` so a misbehaving backend still cannot leak the future into a
 * historical snapshot.
 */

export interface ForecastReadSpec {
  readonly measurementPointRef: string
  readonly entityRef: ResourceRef
  readonly metric: EnergyMetric
  /** The half-open window the forecast targets. */
  readonly targetWindow: TimeWindow
  readonly mappingVersion: VersionRef
  readonly expectedUnit?: string
}

export async function readForecastSeries(
  forecast: ForecastPort,
  specs: readonly ForecastReadSpec[],
  asOf: Rfc3339UtcTimestamp,
  ctx: ToolContext,
): Promise<readonly ForecastSeriesInput[]> {
  const results: ForecastSeriesInput[] = []
  for (const spec of specs) {
    const response = await forecast.readForecast(
      {
        entityRef: spec.entityRef,
        metric: spec.metric,
        targetWindow: spec.targetWindow,
        asOf,
        maxPoints: 100_000,
        ...(spec.expectedUnit === undefined ? {} : { expectedUnit: spec.expectedUnit }),
      },
      ctx,
    )
    const points: RawTelemetryPoint[] = response.points.map((point) => ({
      timestamp: point.targetTime,
      ...(point.value === undefined ? {} : { value: Number(point.value.amount) }),
      quality: point.quality,
    }))
    results.push({
      measurementPointRef: spec.measurementPointRef,
      metric: spec.metric,
      unit: response.unit,
      issuedAt: response.issuedAt,
      targetInterval: response.targetWindow,
      method: response.method,
      assumptions: [...response.assumptions],
      modelVersion: response.modelVersion,
      points,
      sourceRef: response.snapshot.sourceRef,
      sourceSnapshot: response.snapshot,
      mappingVersion: spec.mappingVersion,
    })
  }
  return results
}
