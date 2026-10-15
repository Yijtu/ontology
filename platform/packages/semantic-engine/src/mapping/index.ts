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
export {
  PROJECT_SNAPSHOT_RECORD_ID_FIELD,
  PROJECT_SNAPSHOT_SOURCES_FIELD,
  buildProjectSnapshotMapping,
  projectSnapshotColumnType,
  projectSnapshotMappingRef,
} from './project-snapshot'
export type { BuildProjectSnapshotMappingInput } from './project-snapshot'
export { OntologyLookupService } from './lookup'
export { PublishedFactsReferenceProvider } from './published-facts'
export type { PublishedFactsReferenceProviderOptions } from './published-facts'
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
