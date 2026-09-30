/**
 * @ontology/adapter-data-postgres — real read-only PostgreSQL query backend (C3, C3.1).
 *
 * Implements `StructuredQueryPort`, `CatalogPort` and `SourceProbeAdapter` against a
 * business database reached through an independent read-only role. The adapter imports
 * only `@ontology/contracts`, `@ontology/core` and its SQL/driver SDKs; it never imports
 * another adapter, an extension, an industry pack, `application` or `services`.
 */
export { DATA_POSTGRES_ADAPTER_REF, PostgresQueryAdapter } from './adapter'
export type { PostgresQueryAdapterConfig } from './adapter'
export { BusinessPostgresDatabase } from './database'
export type { BusinessPostgresConfig, ReadOnlySession } from './database'
export { isPostgresQueryError, PostgresQueryError } from './errors'
export type { PostgresQueryErrorOptions } from './errors'
export {
  catalogRevisionOf,
  columnTypeOf,
  isAmbiguousRelation,
  resolveMapping,
  sourceRefAuthorized,
  sourceRefsEqual,
  SUPPORTED_DATA_TYPES,
} from './mapping'
export type { BusinessObjectMapping, MappedColumn } from './mapping'
export { POSTGRES_PROJECT_DATASET_BACKEND, PostgresProjectDatasetAdapter } from './project-dataset'
export type { PostgresProjectDatasetConfig } from './project-dataset'
export { validateReadOnlySql } from './sql-validator'
export type {
  SqlValidationAccepted,
  SqlValidationInput,
  SqlValidationRejected,
  SqlValidationResult,
} from './sql-validator'
