/**
 * @ontology/adapter-model-company — company generation API adapter (SPEC C2, §4.2).
 *
 * Public surface: the `GenerationPort` implementation, its injected dependencies and
 * the classified error. The vendor wire types stay internal (`src/vendor`), so no
 * provider type becomes a platform contract or leaks into `contracts`/`core`.
 */
export { CompanyGenerationAdapter } from './adapter'
export { ModelAdapterError, isModelAdapterError, httpStatusForModelError } from './errors'
export type { ModelAdapterErrorCode, ModelAdapterErrorOptions } from './errors'
export type {
  CandidateValidationResult,
  CompanyGenerationAdapterConfig,
  CompanyModelBinding,
  CompanyModelProtocol,
  ModelAdapterLogRecord,
  ModelAdapterLogger,
  ModelCallEvidenceRecorder,
  ModelCallEvidenceRequest,
  ResponseSchemaValidator,
} from './types'
