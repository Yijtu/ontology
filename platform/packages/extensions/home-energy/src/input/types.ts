import type {
  ConsistencyLevel,
  DataMode,
  Rfc3339UtcTimestamp,
  ResourceRef,
  SchemaVersion,
  Sha256Digest,
  SourceRef,
  SourceSnapshot,
  SourceWatermark,
  TelemetryQuality,
  TimeWindow,
  VersionRef,
} from '@ontology/contracts'

/**
 * Canonical energy input semantics (SPEC E2–E4, C3).
 *
 * The normaliser keeps four distinctions explicit, because conflating them is a correctness
 * bug rather than a formatting choice:
 *   - `power` (kW, an instantaneous rate) vs `energy` (kWh, an amount) vs `state_of_charge`
 *     (a declared device ratio, never a hardcoded percentage);
 *   - `observed` vs `forecast` vs `simulated` sampling;
 *   - `instantaneous` vs `interval` vs `cumulative` series semantics, so a monotonic meter
 *     register is never mistaken for per-slot energy;
 *   - a missing/unknown sample, which stays unknown, versus a real zero.
 *
 * Every normalised series states its unit, IANA time zone, slot length and sampling type, so
 * a downstream simulator or planner never has to guess an alignment.
 */

export type EnergyMetric = 'power' | 'energy' | 'state_of_charge'

export type SamplingType = 'observed' | 'forecast' | 'simulated'

/**
 * How a series is to be read. A cumulative register must be differenced before it becomes a
 * per-slot energy amount; an interval value is already a per-slot amount.
 */
export type SeriesSemantics = 'instantaneous' | 'interval' | 'cumulative'

/** What to do when a cumulative register moves backwards (a reset/rollover). */
export type MeterResetPolicy = 'mark_unknown' | 'count_since_reset'

/** The one canonical unit the normaliser emits for each metric. */
export const CANONICAL_UNIT: Readonly<Record<EnergyMetric, string>> = {
  power: 'kW',
  energy: 'kWh',
  state_of_charge: 'ratio',
}

/** A raw sample as read from a source. `value === undefined` means missing, never zero. */
export interface RawTelemetryPoint {
  readonly timestamp: Rfc3339UtcTimestamp
  readonly value?: number
  readonly quality: TelemetryQuality
}

export interface ObservationSeriesInput {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
  readonly semantics: SeriesSemantics
  readonly unit: string
  readonly points: readonly RawTelemetryPoint[]
  readonly sourceRef: SourceRef
  readonly sourceSnapshot: SourceSnapshot
  readonly mappingVersion: VersionRef
  readonly resetPolicy?: MeterResetPolicy
}

export interface ForecastSeriesInput {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
  readonly unit: string
  /** When the forecast was published. A forecast issued after the evaluation clock never leaks. */
  readonly issuedAt: Rfc3339UtcTimestamp
  /** The half-open window the forecast targets. */
  readonly targetInterval: TimeWindow
  readonly method: string
  readonly assumptions: readonly string[]
  /** The model/scenario version that produced the forecast; a forecast is never version-free. */
  readonly modelVersion: VersionRef
  readonly points: readonly RawTelemetryPoint[]
  readonly sourceRef: SourceRef
  readonly sourceSnapshot: SourceSnapshot
  readonly mappingVersion: VersionRef
}

/**
 * The bounded, already-read inputs handed to the pure normaliser.
 *
 * `forecastConfigured` and `requestedForecasts` let the caller state that a forecast was
 * requested through `ForecastPort`. When the port is absent the normaliser reports the request
 * as `forecast_not_configured` instead of silently treating "no forecast read" as "no forecast
 * exists". A caller that supplies forecasts directly (no port) leaves both unset, which keeps the
 * pre-existing behaviour: no requested forecast means no forecast gap.
 */
export interface EnergyInputBundle {
  readonly observations: readonly ObservationSeriesInput[]
  readonly forecasts: readonly ForecastSeriesInput[]
  readonly forecastConfigured?: boolean
  readonly requestedForecasts?: readonly ForecastRequestDeclaration[]
}

/** A forecast the caller asked `ForecastPort` to read, so a gap can be reported explicitly. */
export interface ForecastRequestDeclaration {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
}

/**
 * The explicit forecast outcome of a normalisation. `not_configured` means a forecast was
 * requested but no backend exists; it is never replaced by an empty or invented forecast.
 */
export type ForecastOutcomeStatus = 'ok' | 'not_configured'

/**
 * One measurement point's declared coverage. `parentCoverageRef` names the coverage this point
 * is a subset of, so a parent meter and its sub-circuits are never summed as independent loads.
 */
export interface CoverageDeclaration {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
  readonly coverageRef: string
  readonly parentCoverageRef?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

export interface RedundantMeasurementPoint {
  readonly measurementPointRef: string
  readonly coveredBy: string
  readonly reason: 'covered_by_parent'
}

export interface CoverageConflict {
  readonly coverageRef: string
  readonly measurementPointRefs: readonly string[]
}

/** The explicit additive/redundant/conflicting view of the selected measurement points. */
export interface CoveragePlan {
  readonly additive: readonly string[]
  readonly redundant: readonly RedundantMeasurementPoint[]
  readonly conflicts: readonly CoverageConflict[]
}

export interface InputVersions {
  readonly mapping: VersionRef
  readonly deviceSpec: VersionRef
  readonly tariff: VersionRef
  readonly userConstraint: VersionRef
}

export interface SourceWatermarkRef {
  readonly sourceRef: SourceRef
  readonly watermark?: SourceWatermark
  readonly asOf?: Rfc3339UtcTimestamp
  readonly consistency: ConsistencyLevel
}

/**
 * The stable projection of a read `SourceSnapshot`: it keeps the source identity, schema
 * version, as-of time, watermark, consistency and result digest, but deliberately drops the
 * local `readAt`. The read time is not a source property and would make an otherwise identical
 * snapshot hash differently on every read, defeating content addressing.
 */
export interface SourceSnapshotRef {
  readonly sourceRef: SourceRef
  readonly schemaVersion: SchemaVersion
  readonly asOf?: Rfc3339UtcTimestamp
  readonly watermark?: SourceWatermark
  readonly consistency: ConsistencyLevel
  readonly resultDigest: Sha256Digest
}

export interface NormalizedSlot {
  readonly index: number
  readonly startUtc: Rfc3339UtcTimestamp
  readonly endUtc: Rfc3339UtcTimestamp
  readonly localStart: string
  readonly utcOffsetMinutes: number
}

export interface OffsetChange {
  readonly atSlotIndex: number
  readonly fromMinutes: number
  readonly toMinutes: number
}

/** The explicit unit/time-zone/slot alignment the snapshot carries. */
export interface SlotAlignment {
  readonly timeZone: string
  readonly slotMinutes: number
  readonly slotCount: number
  readonly horizonHours: number
  readonly offsetChanges: readonly OffsetChange[]
}

export type NormalizedPointStatus = 'ok' | 'reset' | 'missing' | 'unknown'

export interface NormalizedPoint {
  readonly slotIndex: number
  readonly timestamp: Rfc3339UtcTimestamp
  readonly value?: number
  readonly quality: TelemetryQuality
  readonly status: NormalizedPointStatus
}

export interface NormalizedSeries {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
  readonly unit: string
  readonly timeZone: string
  readonly slotMinutes: number
  readonly samplingType: SamplingType
  readonly semantics: SeriesSemantics
  readonly points: readonly NormalizedPoint[]
  readonly sourceRef: SourceRef
  readonly mappingVersion: VersionRef
  readonly sourceSnapshot: SourceSnapshotRef
  readonly issuedAt?: Rfc3339UtcTimestamp
  readonly validityWindow?: TimeWindow
  readonly method?: string
  readonly assumptions?: readonly string[]
  readonly modelVersion?: VersionRef
}

export type MissingInputReason =
  | 'not_read'
  | 'issued_after_evaluation_clock'
  | 'no_samples'
  | 'forecast_not_configured'

export interface MissingInput {
  readonly measurementPointRef: string
  readonly metric: EnergyMetric
  readonly purpose: 'observation' | 'forecast'
  readonly reason: MissingInputReason
}

export interface NormalizedEnergyInput {
  readonly normalizationVersion: string
  readonly siteRef: ResourceRef
  readonly evaluationClock: Rfc3339UtcTimestamp
  readonly horizon: TimeWindow
  readonly timeZone: string
  readonly slotMinutes: number
  readonly slots: readonly NormalizedSlot[]
  readonly alignment: SlotAlignment
  readonly series: readonly NormalizedSeries[]
  readonly coverage: CoveragePlan
  readonly versions: InputVersions
  readonly dataMode: DataMode
  readonly sourceWatermarks: readonly SourceWatermarkRef[]
  readonly missingInputs: readonly MissingInput[]
  /** Explicit forecast outcome. `not_configured` is never a fabricated or empty forecast. */
  readonly forecastOutcome: ForecastOutcomeStatus
}

export interface NormalizeEnergyInputRequest {
  readonly siteRef: ResourceRef
  readonly evaluationClock: Rfc3339UtcTimestamp
  readonly horizon: TimeWindow
  readonly timeZone: string
  readonly slotMinutes: number
  readonly dataMode: DataMode
  readonly measurementPoints: readonly string[]
  readonly coverage: readonly CoverageDeclaration[]
  readonly versions: InputVersions
}

/** The serialisable, content-addressed manifest. Identical inputs reproduce an identical digest. */
export interface EnergyInputManifest {
  readonly normalizationVersion: string
  readonly siteRef: ResourceRef
  readonly evaluationClock: Rfc3339UtcTimestamp
  readonly horizon: TimeWindow
  readonly timeZone: string
  readonly slotMinutes: number
  readonly slotCount: number
  readonly dataMode: DataMode
  readonly versions: InputVersions
  readonly coverage: CoveragePlan
  readonly sourceWatermarks: readonly SourceWatermarkRef[]
  readonly missingInputs: readonly MissingInput[]
  readonly series: readonly NormalizedSeries[]
}

export interface EnergyInputSnapshot {
  readonly snapshotRef: ResourceRef
  readonly digest: string
  readonly mediaType: string
  readonly manifest: EnergyInputManifest
}
