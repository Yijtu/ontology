import type {
  ResourceRef,
  TelemetryAggregation,
  TelemetryPort,
  TimeWindow,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type {
  EnergyMetric,
  ObservationSeriesInput,
  RawTelemetryPoint,
  SeriesSemantics,
} from './types'

/**
 * Observation reading through the canonical `TelemetryPort` (C3).
 *
 * The normaliser never opens a database connection. This helper resolves bounded series through
 * the injected telemetry port, keeping the source snapshot (read time, watermark, consistency)
 * that the result must carry. `readSeries` already bounds the read by the requested window and
 * quality; the pure normaliser then applies the as-of filter and the declared conversions.
 */

export interface ObservationReadSpec {
  readonly measurementPointRef: string
  readonly entityRef: ResourceRef
  readonly metric: EnergyMetric
  readonly semantics: SeriesSemantics
  readonly window: TimeWindow
  readonly mappingVersion: VersionRef
  readonly expectedUnit?: string
}

/** Interval series sum their samples inside a slot; instantaneous/cumulative take the last read. */
function aggregationFor(semantics: SeriesSemantics): TelemetryAggregation {
  return semantics === 'interval' ? 'sum' : 'last'
}

export async function readObservationSeries(
  telemetry: TelemetryPort,
  specs: readonly ObservationReadSpec[],
  ctx: ToolContext,
): Promise<readonly ObservationSeriesInput[]> {
  const results: ObservationSeriesInput[] = []
  for (const spec of specs) {
    const response = await telemetry.readSeries(
      {
        entityRef: spec.entityRef,
        metric: spec.metric,
        window: spec.window,
        aggregation: aggregationFor(spec.semantics),
        maxPoints: 100_000,
        ...(spec.expectedUnit === undefined ? {} : { expectedUnit: spec.expectedUnit }),
      },
      ctx,
    )
    const points: RawTelemetryPoint[] = response.points.map((point) => ({
      timestamp: point.timestamp,
      ...(point.value === undefined ? {} : { value: Number(point.value.amount) }),
      quality: point.quality,
    }))
    results.push({
      measurementPointRef: spec.measurementPointRef,
      metric: spec.metric,
      semantics: spec.semantics,
      unit: response.unit,
      points,
      sourceRef: response.snapshot.sourceRef,
      sourceSnapshot: response.snapshot,
      mappingVersion: spec.mappingVersion,
    })
  }
  return results
}
