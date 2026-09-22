/**
 * Entity/relation candidate extraction pipeline (SPEC D4, US-012/US-015, FR-14).
 *
 * The pipeline consumes traceable chunks from LOCAL-023, drives a `GenerationPort` for
 * unstructured text and a deterministic mapper for native strong-identifier records, then
 * validates every candidate against the published industry schema from LOCAL-025. It runs
 * as the `parsed → extracted → validated` job stages of LOCAL-022, so a failure is retried
 * from its stage checkpoint without redoing earlier stages or duplicating candidates.
 *
 * Candidates are append-only and never mutate the schema or published truth. Every
 * capability (schema, generation, candidate store, budget) arrives by construction
 * injection; this package imports no adapter, driver or model SDK.
 */
export { ExtractionError, isExtractionError } from './errors'
export type { ExtractionErrorCode } from './errors'

export type {
  ExtractionInput,
  ExtractionJobRef,
  ExtractionResult,
  ExtractionRunContext,
  ValidationResult,
} from './types'

export { decodeExtractionJobRef, encodeExtractionJobRef } from './job-ref'
export { candidateIdFor, canonicalJson, sha256DigestOf } from './canonical'

export { parseModelCandidates } from './model-output'
export type { DraftCandidates, DraftEntity, DraftRelation, DraftRelationEndpoint } from './model-output'

export { mapNativeEntities, parseNativeRecord } from './native-mapping'
export type { NativeEntityMapping } from './native-mapping'

export {
  dedupeIssues,
  isHardIssue,
  objectById,
  relationById,
  truncatedChunkIssue,
  validateEntity,
  validateRelation,
} from './schema-validation'

export { ExtractionPipeline, EXTRACTION_RESPONSE_SCHEMA_REF } from './extraction-service'
export type { ExtractionPipelineDependencies } from './extraction-service'

export { InMemoryCandidateStore } from './in-memory-store'
export { InMemoryIndustrySchemaSource } from './in-memory-schema-source'

export {
  CandidateValidationStageHandler,
  ExtractionStageHandler,
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
} from './stage-handlers'
export type { ExtractionStageHandlerDependencies } from './stage-handlers'
