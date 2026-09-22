export { EnergyInputError } from './errors'
export type { EnergyInputErrorCode } from './errors'

export {
  DeclaredConversions,
} from './conversions'
export type {
  DeclaredConversionSet,
  SocConversionDeclaration,
  SocToEnergyDeclaration,
  UnitConversionDeclaration,
} from './conversions'

export {
  assertNonOverlappingCoverage,
  resolveCoverage,
} from './coverage'

export {
  computeCumulativeIntervals,
} from './cumulative'
export type {
  CumulativeInterval,
  CumulativeIntervalStatus,
  CumulativeReading,
  CumulativeSeriesResult,
  SlotBounds,
} from './cumulative'

export {
  NORMALIZATION_VERSION,
  normalizeEnergyInput,
  sumAcrossAdditivePoints,
} from './normalize'
export type { NormalizeEnergyInputDependencies } from './normalize'

export {
  ENERGY_INPUT_MEDIA_TYPE,
  buildEnergyInputManifest,
  canonicalJson,
  energyInputDigest,
  publishEnergyInputSnapshot,
  sha256DigestOf,
} from './snapshot'
export type { EnergyInputSnapshotPublisherDependencies } from './snapshot'

export {
  EnergyInputService,
} from './service'
export type {
  BuildEnergyInputRequest,
  EnergyInputServiceDependencies,
} from './service'

export { readObservationSeries } from './telemetry'
export type { ObservationReadSpec } from './telemetry'

export {
  alignSlots,
  assertTimeZone,
  localDayWindow,
  slotIndexFor,
  summarizeAlignment,
  utcOffsetMinutesAt,
} from './time'
export type { LocalDayAlignment } from './time'

export { CANONICAL_UNIT } from './types'
export type {
  CoverageConflict,
  CoverageDeclaration,
  CoveragePlan,
  EnergyInputBundle,
  EnergyInputManifest,
  EnergyInputSnapshot,
  EnergyMetric,
  ForecastSeriesInput,
  InputVersions,
  MeterResetPolicy,
  MissingInput,
  MissingInputReason,
  NormalizeEnergyInputRequest,
  NormalizedEnergyInput,
  NormalizedPoint,
  NormalizedPointStatus,
  NormalizedSeries,
  NormalizedSlot,
  ObservationSeriesInput,
  OffsetChange,
  RawTelemetryPoint,
  RedundantMeasurementPoint,
  SamplingType,
  SeriesSemantics,
  SlotAlignment,
  SourceSnapshotRef,
  SourceWatermarkRef,
} from './types'
