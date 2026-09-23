export { SemanticMappingError, isSemanticMappingError } from './errors'
export type { SemanticMappingErrorCode, SemanticMappingErrorOptions } from './errors'
export { assertSafeIdentifier, buildMappingIndex, compileSemanticQuery } from './compile'
export type { CompileOptions } from './compile'
export { renderCompiledQuery } from './render'
export {
  DEFAULT_VOCABULARY_LIMITS,
  SemanticSchemaVocabularyService,
  buildSchemaVocabulary,
} from './vocabulary'
export type {
  BuildSchemaVocabularyInput,
  SemanticSchemaVocabularyDependencies,
  VocabularyLimits,
} from './vocabulary'
export { InMemorySemanticMappingRegistry, defineSemanticMapping, semanticMappingDigest } from './registry'
export { OntologyLookupService } from './lookup'
export { PublishedFactReferenceProvider } from './published-facts'
export type {
  OntologyFactPage,
  OntologyFactQuery,
  OntologyFactReference,
  OntologyFactReferenceProvider,
  OntologyLookupDependencies,
  OntologyLookupPage,
} from './lookup'
export { canonicalColumnTypeOf } from './types'
export type {
  CompilationBudget,
  CompiledColumnRef,
  CompiledExpression,
  CompiledJoin,
  CompiledOrder,
  CompiledPredicate,
  CompiledProjection,
  CompiledQuery,
  CompiledSource,
  FieldMapping,
  LinkMapping,
  LinkScope,
  MappingDialect,
  ObjectMapping,
  RenderedQuery,
  SemanticMapping,
  SemanticMappingRegistry,
  ValueMapEntry,
} from './types'
