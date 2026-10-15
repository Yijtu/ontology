export { DefinitionCandidateError, isDefinitionCandidateError } from './errors'
export type { DefinitionCandidateErrorCode, DefinitionCandidateErrorOptions } from './errors'
export { InMemoryAssetCandidateStore } from './in-memory-store'
export {
  StaticDefinitionTerminologySource,
  EMPTY_TERMINOLOGY,
} from './terminology'
export type {
  DefinitionTerminologySource,
  MountedAttributeTerm,
  MountedDefinitionTerminology,
} from './terminology'
export { parseDefinitionCandidateOutput } from './model-output'
export type { DraftDefinitionCandidate, DraftDefinitionCandidates } from './model-output'
export {
  DefinitionCandidateGenerationService,
  TBOX_PROMPT_VERSION,
  TBOX_RESPONSE_SCHEMA_REF,
  DEFINITION_SOURCE_CONFIRMATION_SCHEMA_REF,
} from './service'
export type {
  DefinitionCandidateGenerationDependencies,
  DefinitionGenerationExecution,
  DefinitionGenerationInput,
  DefinitionGenerationView,
} from './service'
export { InMemoryDefinitionEditingStore } from './in-memory-editing-store'
export { CompositeReviewableCandidateReader } from './reviewable-reader'
export type { CompositeReviewableCandidateReaderDependencies } from './reviewable-reader'
export {
  DefinitionCandidateEditingService,
  DEFINITION_EDIT_MODEL_REF,
  DEFINITION_EDIT_POLICY_REF,
  DEFINITION_EDIT_RESPONSE_SCHEMA_REF,
} from './editing-service'
export type { DefinitionCandidateEditingDependencies } from './editing-service'
export {
  computeAffectedDefinitions,
  currentDefinitionProjection,
  diffDefinitionProjection,
  issuesForCandidate,
  validateDefinitionProjection,
  HARD_DEFINITION_ISSUES,
} from './validation'
export type { DefinitionValidationContext } from './validation'
export { definitionRevisionStrategyProblem } from './validation'
export { DynamicDefinitionTerminologySource, createDynamicDefinitionTerminologySource } from './dynamic-terminology'
export type { DynamicDefinitionTerminologyDependencies } from './dynamic-terminology'

export type { DefinitionSourceConfirmationInput } from './service'
export { groundingFragments, selectedGrounding } from './grounding'
