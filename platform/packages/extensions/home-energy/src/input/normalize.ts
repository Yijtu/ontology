import type {
  Rfc3339UtcTimestamp,
  SourceSnapshot,
  TelemetryQuality,
  TimeWindow,
} from '@ontology/contracts'
import type { DeclaredConversions } from './conversions'
import { assertNonOverlappingCoverage, resolveCoverage } from './coverage'
import { computeCumulativeIntervals, type CumulativeReading, type SlotBounds } from './cumulative'
import { EnergyInputError } from './errors'
import { alignSlots, slotIndexFor, summarizeAlignment } from './time'
import {
  CANONICAL_UNIT,
  type EnergyInputBundle,
  type EnergyMetric,
  type ForecastSeriesInput,
  type MissingInput,
  type NormalizeEnergyInputRequest,
  type NormalizedEnergyInput,
  type NormalizedPoint,
  type NormalizedPointStatus,
  type NormalizedSeries,
  type ObservationSeriesInput,
  type SeriesSemantics,
  type SourceSnapshotRef,
  type SourceWatermarkRef,
} from './types'

/**
 * The pure energy time-series normaliser (SPEC E2–E4, C3; US-009/016/024).
 *
 * Given bounded, already-read source series and declared conversions, it produces a
 * deterministic normalised input: unit, IANA time zone, slot length and sampling type are stated
 * on every series; cumulative meters are differenced with resets kept explicit; missing/unknown
 * samples stay unknown and are never imputed as zero; parent/sub-circuit coverage is resolved so
 * a parent meter and its children are never summed twice; and a snapshot taken at `T` never
 * includes an observation recorded after `T` or a forecast issued after `T`.
 */

export const NORMALIZATION_VERSION = '1.0.0'

export interface NormalizeEnergyInputDependencies {
  readonly conversions: DeclaredConversions
}

const QUALITY_SEVERITY: Readonly<Record<TelemetryQuality, number>> = {
  good: 0,
  estimated: 1,
  suspect: 2,
  missing: 3,
  unknown: 4,
}

function worstQuality(a: TelemetryQuality, b: TelemetryQuality): TelemetryQuality {
  return QUALITY_SEVERITY[a] >= QUALITY_SEVERITY[b] ? a : b
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function parseTimestamp(timestamp: string): number {
  const ms = Date.parse(timestamp)
  if (!Number.isFinite(ms)) {
    throw new EnergyInputError('INVALID_ARGUMENT', `invalid RFC3339 timestamp: ${timestamp}`)
  }
  return ms
}

/** Project a read snapshot to its stable, reproducible fields (drops the volatile `readAt`). */
function toSnapshotRef(snapshot: SourceSnapshot): SourceSnapshotRef {
  return {
    sourceRef: snapshot.sourceRef,
    schemaVersion: snapshot.schemaVersion,
    ...(snapshot.asOf === undefined ? {} : { asOf: snapshot.asOf }),
    ...(snapshot.watermark === undefined ? {} : { watermark: snapshot.watermark }),
    consistency: snapshot.consistency,
    resultDigest: snapshot.resultDigest,
  }
}

interface BucketedPoint {
  readonly timestamp: Rfc3339UtcTimestamp
  readonly value?: number
  readonly quality: TelemetryQuality
}

interface SlotValue {
  readonly value?: number
  readonly quality: TelemetryQuality
  readonly status: NormalizedPointStatus
}

function classify(value: number | undefined, quality: TelemetryQuality): SlotValue {
  if (value === undefined || quality === 'missing') return { quality: 'missing', status: 'missing' }
  if (quality === 'unknown') return { quality: 'unknown', status: 'unknown' }
  return { value, quality, status: 'ok' }
}

function bucketPoints(
  points: readonly BucketedPoint[],
  slotCount: number,
  horizon: TimeWindow,
  slotMinutes: number,
  include: (timestampMs: number) => boolean,
): readonly (readonly BucketedPoint[] | undefined)[] {
  const groups: BucketedPoint[][] = Array.from({ length: slotCount }, () => [])
  for (const point of points) {
    const timestampMs = parseTimestamp(point.timestamp)
    if (!include(timestampMs)) continue
    const index = slotIndexFor(point.timestamp, horizon, slotMinutes)
    if (index === undefined) continue
    const group = groups[index]
    if (group === undefined) continue
    group.push(point)
  }
  return groups.map((group) => (group.length === 0 ? undefined : group))
}

function toSlotValues(
  groups: readonly (readonly BucketedPoint[] | undefined)[],
  metric: EnergyMetric,
  unit: string,
  semantics: SeriesSemantics,
  conversions: DeclaredConversions,
): readonly (SlotValue | undefined)[] {
  return groups.map((group) => {
    if (group === undefined) return undefined
    const ordered = [...group].sort(
      (left, right) => parseTimestamp(left.timestamp) - parseTimestamp(right.timestamp),
    )
    let quality: TelemetryQuality = 'good'
    for (const point of ordered) {
      quality = worstQuality(quality, point.quality)
    }
    const last = ordered[ordered.length - 1]
    if (last === undefined) return undefined

    if (semantics === 'interval') {
      let sum = 0
      for (const point of ordered) {
        const classified = classify(point.value, point.quality)
        if (classified.status !== 'ok') return classified
        if (point.value === undefined) return { quality: 'missing', status: 'missing' }
        sum += conversions.convert(metric, unit, point.value)
      }
      return { value: round(sum), quality, status: 'ok' }
    }

    const classified = classify(last.value, last.quality)
    if (classified.status !== 'ok' || last.value === undefined) return classified
    return {
      value: round(conversions.convert(metric, unit, last.value)),
      quality: worstQuality(quality, last.quality),
      status: 'ok',
    }
  })
}

function normalizedPointsFromSlots(
  slots: readonly { readonly index: number; readonly startUtc: Rfc3339UtcTimestamp }[],
  values: readonly (SlotValue | undefined)[],
): readonly NormalizedPoint[] {
  return slots.map((slot, index) => {
    const value = values[index]
    if (value === undefined) {
      return { slotIndex: slot.index, timestamp: slot.startUtc, quality: 'missing', status: 'missing' }
    }
    return {
      slotIndex: slot.index,
      timestamp: slot.startUtc,
      ...(value.value === undefined ? {} : { value: value.value }),
      quality: value.quality,
      status: value.status,
    }
  })
}

function normalizedPointsFromCumulative(
  observations: ObservationSeriesInput,
  values: readonly (SlotValue | undefined)[],
  slotBounds: readonly SlotBounds[],
): readonly NormalizedPoint[] {
  const readings: readonly (CumulativeReading | undefined)[] = values.map((value) =>
    value === undefined ? undefined : { ...(value.value === undefined ? {} : { value: value.value }), quality: value.quality },
  )
  const result = computeCumulativeIntervals(
    readings,
    slotBounds,
    observations.resetPolicy ?? 'mark_unknown',
  )
  return result.intervals.map((interval) => ({
    slotIndex: interval.slotIndex,
    timestamp: interval.startUtc,
    ...(interval.value === undefined ? {} : { value: interval.value }),
    quality: interval.quality,
    status: interval.status,
  }))
}

function normalizeObservation(
  observation: ObservationSeriesInput,
  request: NormalizeEnergyInputRequest,
  slotCount: number,
  slotBounds: readonly SlotBounds[],
  evaluationClockMs: number,
  conversions: DeclaredConversions,
): NormalizedSeries {
  const groups = bucketPoints(
    observation.points,
    slotCount,
    request.horizon,
    request.slotMinutes,
    (timestampMs) => timestampMs <= evaluationClockMs,
  )
  const values = toSlotValues(
    groups,
    observation.metric,
    observation.unit,
    observation.semantics,
    conversions,
  )
  const points =
    observation.semantics === 'cumulative'
      ? normalizedPointsFromCumulative(observation, values, slotBounds)
      : normalizedPointsFromSlots(
          slotBounds.map((bounds, index) => ({ index, startUtc: bounds.startUtc })),
          values,
        )
  return {
    measurementPointRef: observation.measurementPointRef,
    metric: observation.metric,
    unit: CANONICAL_UNIT[observation.metric],
    timeZone: request.timeZone,
    slotMinutes: request.slotMinutes,
    samplingType: 'observed',
    semantics: observation.semantics,
    points,
    sourceRef: observation.sourceRef,
    mappingVersion: observation.mappingVersion,
    sourceSnapshot: toSnapshotRef(observation.sourceSnapshot),
  }
}

function forecastSemantics(metric: EnergyMetric): SeriesSemantics {
  return metric === 'energy' ? 'interval' : 'instantaneous'
}

function normalizeForecast(
  forecast: ForecastSeriesInput,
  request: NormalizeEnergyInputRequest,
  slotCount: number,
  slotBounds: readonly SlotBounds[],
  conversions: DeclaredConversions,
): NormalizedSeries {
  const targetStart = parseTimestamp(forecast.targetInterval.start)
  const targetEnd = parseTimestamp(forecast.targetInterval.end)
  const groups = bucketPoints(
    forecast.points,
    slotCount,
    request.horizon,
    request.slotMinutes,
    (timestampMs) => timestampMs >= targetStart && timestampMs < targetEnd,
  )
  const semantics = forecastSemantics(forecast.metric)
  const values = toSlotValues(groups, forecast.metric, forecast.unit, semantics, conversions)
  const points = normalizedPointsFromSlots(
    slotBounds.map((bounds, index) => ({ index, startUtc: bounds.startUtc })),
    values,
  )
  return {
    measurementPointRef: forecast.measurementPointRef,
    metric: forecast.metric,
    unit: CANONICAL_UNIT[forecast.metric],
    timeZone: request.timeZone,
    slotMinutes: request.slotMinutes,
    samplingType: 'forecast',
    semantics,
    points,
    sourceRef: forecast.sourceRef,
    mappingVersion: forecast.mappingVersion,
    sourceSnapshot: toSnapshotRef(forecast.sourceSnapshot),
    issuedAt: forecast.issuedAt,
    validityWindow: forecast.targetInterval,
    method: forecast.method,
    assumptions: [...forecast.assumptions],
  }
}

function hasUsableSample(series: NormalizedSeries): boolean {
  return series.points.some((point) => point.status === 'ok' || point.status === 'reset')
}

function sourceWatermarksOf(series: readonly NormalizedSeries[]): readonly SourceWatermarkRef[] {
  const bySource = new Map<string, SourceWatermarkRef>()
  for (const entry of series) {
    const snapshot: SourceSnapshotRef = entry.sourceSnapshot
    const key = `${snapshot.sourceRef.namespace}\u0000${snapshot.sourceRef.sourceId}`
    if (bySource.has(key)) continue
    bySource.set(key, {
      sourceRef: snapshot.sourceRef,
      ...(snapshot.watermark === undefined ? {} : { watermark: snapshot.watermark }),
      ...(snapshot.asOf === undefined ? {} : { asOf: snapshot.asOf }),
      consistency: snapshot.consistency,
    })
  }
  return [...bySource.values()].sort((left, right) =>
    left.sourceRef.sourceId.localeCompare(right.sourceRef.sourceId),
  )
}

function sortMissingInputs(inputs: readonly MissingInput[]): readonly MissingInput[] {
  return [...inputs].sort((left, right) => {
    const point = left.measurementPointRef.localeCompare(right.measurementPointRef)
    if (point !== 0) return point
    const metric = left.metric.localeCompare(right.metric)
    if (metric !== 0) return metric
    return left.purpose.localeCompare(right.purpose)
  })
}

export function normalizeEnergyInput(
  request: NormalizeEnergyInputRequest,
  bundle: EnergyInputBundle,
  deps: NormalizeEnergyInputDependencies,
): NormalizedEnergyInput {
  const evaluationClockMs = parseTimestamp(request.evaluationClock)
  const slots = alignSlots(request.horizon, request.timeZone, request.slotMinutes)
  const alignment = summarizeAlignment(slots, request.timeZone, request.slotMinutes)
  const slotBounds: readonly SlotBounds[] = slots.map((slot) => ({
    startUtc: slot.startUtc,
    endUtc: slot.endUtc,
  }))
  const slotCount = slots.length

  const coverage = resolveCoverage(request.coverage, request.measurementPoints)
  assertNonOverlappingCoverage(coverage)

  const series: NormalizedSeries[] = []
  const missingInputs: MissingInput[] = []

  for (const observation of bundle.observations) {
    const normalized = normalizeObservation(
      observation,
      request,
      slotCount,
      slotBounds,
      evaluationClockMs,
      deps.conversions,
    )
    series.push(normalized)
    if (!hasUsableSample(normalized)) {
      missingInputs.push({
        measurementPointRef: normalized.measurementPointRef,
        metric: normalized.metric,
        purpose: 'observation',
        reason: 'no_samples',
      })
    }
  }

  for (const forecast of bundle.forecasts) {
    if (parseTimestamp(forecast.issuedAt) > evaluationClockMs) {
      // A forecast issued after the evaluation clock must not leak into a historical snapshot.
      missingInputs.push({
        measurementPointRef: forecast.measurementPointRef,
        metric: forecast.metric,
        purpose: 'forecast',
        reason: 'issued_after_evaluation_clock',
      })
      continue
    }
    const normalized = normalizeForecast(forecast, request, slotCount, slotBounds, deps.conversions)
    series.push(normalized)
    if (!hasUsableSample(normalized)) {
      missingInputs.push({
        measurementPointRef: normalized.measurementPointRef,
        metric: normalized.metric,
        purpose: 'forecast',
        reason: 'no_samples',
      })
    }
  }

  for (const measurementPointRef of request.measurementPoints) {
    if (bundle.observations.some((entry) => entry.measurementPointRef === measurementPointRef)) continue
    const declaration = request.coverage.find(
      (entry) => entry.measurementPointRef === measurementPointRef,
    )
    missingInputs.push({
      measurementPointRef,
      metric: declaration?.metric ?? 'energy',
      purpose: 'observation',
      reason: 'not_read',
    })
  }

  series.sort((left, right) => {
    const point = left.measurementPointRef.localeCompare(right.measurementPointRef)
    if (point !== 0) return point
    const metric = left.metric.localeCompare(right.metric)
    if (metric !== 0) return metric
    return left.samplingType.localeCompare(right.samplingType)
  })

  return {
    normalizationVersion: NORMALIZATION_VERSION,
    siteRef: request.siteRef,
    evaluationClock: request.evaluationClock,
    horizon: request.horizon,
    timeZone: request.timeZone,
    slotMinutes: request.slotMinutes,
    slots,
    alignment,
    series,
    coverage,
    versions: request.versions,
    dataMode: request.dataMode,
    sourceWatermarks: sourceWatermarksOf(series),
    missingInputs: sortMissingInputs(missingInputs),
  }
}

/**
 * Sum a metric across the additive measurement points only. A redundant sub-circuit is excluded,
 * so a parent meter and its children are never counted twice. Missing points contribute nothing
 * and are reported, never treated as zero.
 */
export function sumAcrossAdditivePoints(
  input: NormalizedEnergyInput,
  metric: EnergyMetric,
  samplingType: 'observed' | 'forecast',
): { readonly perSlot: readonly (number | undefined)[]; readonly contributors: readonly string[]; readonly skippedMissing: readonly string[] } {
  const additive = new Set(input.coverage.additive)
  const contributors = input.series.filter(
    (entry) =>
      additive.has(entry.measurementPointRef) &&
      entry.metric === metric &&
      entry.samplingType === samplingType,
  )
  const slotCount = input.slots.length
  const perSlot: (number | undefined)[] = Array.from({ length: slotCount }, () => undefined)
  const skippedMissing: string[] = []
  for (const entry of contributors) {
    if (!hasUsableSample(entry)) {
      skippedMissing.push(entry.measurementPointRef)
      continue
    }
    for (const point of entry.points) {
      if (point.value === undefined) continue
      const existing = perSlot[point.slotIndex]
      perSlot[point.slotIndex] = round((existing ?? 0) + point.value)
    }
  }
  return { perSlot, contributors: contributors.map((entry) => entry.measurementPointRef), skippedMissing }
}
