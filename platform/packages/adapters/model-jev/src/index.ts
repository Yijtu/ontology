/**
 * @ontology/adapter-model-jev — JEV decision API adapter (SPEC C2, ADR-09).
 *
 * Public surface: the `DecisionPort` implementation, its injected dependencies, the
 * classified error and the score-comparability helper. The vendor wire types stay
 * internal (`src/vendor`), so no provider type becomes a platform contract or leaks into
 * `contracts`/`core`.
 */
export { JevDecisionAdapter } from './adapter'
export {
  JevAdapterError,
  isJevAdapterError,
  httpStatusForJevError,
  isRetryableJevError,
  jevErrorForHttpStatus,
} from './errors'
export type { JevAdapterErrorCode, JevAdapterErrorOptions } from './errors'
export { assertDecisionRequest } from './request'
export { comparableScoreSet, rankComparableScores } from './compare'
export type { ComparableScoreSet, RankedDecisionScore } from './compare'
export { EMPTY_OPTION_SET_HASH } from './constants'
export type {
  DecisionEvidenceRecorder,
  DecisionEvidenceRequest,
  DecisionEvidenceResult,
  GenerativeClassificationFallback,
  GenerativeClassificationOutput,
  GenerativeClassificationRequest,
  JevAdapterConfig,
  JevAdapterLogRecord,
  JevAdapterLogger,
  JevFallbackPolicy,
  JevModelBinding,
  JevUsage,
} from './types'
