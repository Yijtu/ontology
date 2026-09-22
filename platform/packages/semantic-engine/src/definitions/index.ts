export { SemanticDefinitionError, toFieldErrors } from './errors'
export type {
  DefinitionValidationIssue,
  DefinitionValidationIssueCode,
  SemanticDefinitionErrorCode,
  SemanticDefinitionErrorOptions,
} from './errors'
export {
  definitionKey,
  definitionRefKey,
  isDefinitionIdentifier,
  isNamespace,
  isSemverValue,
  isSha256DigestValue,
  isUnitCode,
  sha256DigestOf,
  stableStringify,
} from './canonical'
export { definitionVersionDigest, scanDefinitionPurity, validateDefinitionVersion } from './validate'
export type { DefinitionValidationOptions } from './validate'
export { projectIndustrySchema } from './industry-schema'
export { InMemorySemanticDefinitionStore } from './store'
export { SemanticDefinitionService } from './service'
export type { SemanticDefinitionServiceDependencies } from './service'

/**
 * The definition model, persistence port and store error are declared in
 * `@ontology/contracts` (next to `ControlRepository`/`ComponentRegistryStore`) so an
 * adapter can implement the port while depending on `contracts` alone. They stay
 * re-exported here to keep `@ontology/semantic-engine`'s public surface unchanged.
 */
export {
  SemanticDefinitionStoreError,
  definitionRecordOf,
  definitionVersionFromRecord,
} from '@ontology/contracts'
/** The rule-comparison subset the definition model supports, kept under its historic name. */
export type { RuleComparisonOperator as ComparisonOperator } from '@ontology/contracts'
export type {
  AttributeDefinition,
  AttributeValueType,
  BindDataInput,
  Cardinality,
  DefinitionBinding,
  DefinitionLayer,
  IdentityScopeDefinition,
  ObjectDefinition,
  RelationDefinition,
  ResolveDataDefinitionInput,
  ResolvedDataDefinition,
  RuleConstraintDefinition,
  RuleExpression,
  SemanticDefinition,
  SemanticDefinitionAudit,
  SemanticDefinitionEvent,
  SemanticDefinitionKind,
  SemanticDefinitionListFilter,
  SemanticDefinitionQuery,
  SemanticDefinitionRecord,
  SemanticDefinitionStore,
  SemanticDefinitionStoreErrorCode,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
  UnitRef,
} from '@ontology/contracts'
