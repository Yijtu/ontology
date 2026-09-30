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

export { parseRuleDrafts } from './rule-output'
export type { DraftRules } from './rule-output'

export {
  buildRuleAst,
  collectRuleReferences,
  detectCyclicRules,
  flattenComparisons,
} from './rule-ast'
export type { RuleAstOk, RuleAstResult, RuleAstUnhandled, RuleExceptionDraft } from './rule-ast'

export { detectRuleConflicts } from './rule-conflicts'

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
  validateRule,
  validateRuleUnhandled,
} from './schema-validation'

export { ExtractionPipeline, EXTRACTION_RESPONSE_SCHEMA_REF } from './extraction-service'
export type { ExtractionGenerationExecution, ExtractionPipelineDependencies } from './extraction-service'

export {
  buildSchemaContext,
  EXTRACTION_SCHEMA_PROMPT_VERSION,
  SUPPORTED_RULE_GRAMMAR,
} from './schema-context'
export type { SchemaContext } from './schema-context'

export { StructuredExtractionService } from './structured-extraction-service'
export type {
  StructuredExtractionResult,
  StructuredExtractionRunContext,
  StructuredExtractionServiceDependencies,
} from './structured-extraction-service'

export { InMemoryCandidateStore } from './in-memory-store'
export { InMemoryIndustrySchemaSource } from './in-memory-schema-source'

export {
  CandidateValidationStageHandler,
  ExtractionStageHandler,
  ParsedStageDispatcher,
  ReviewHandoffStageHandler,
  StructuredExtractionStageHandler,
  createExtractionHandlerRegistry,
} from './stage-handlers'
export type {
  ExtractionHandlerRegistryOptions,
  ExtractionStageHandlerDependencies,
  StructuredExtractionStageHandlerDependencies,
} from './stage-handlers'
