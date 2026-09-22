/**
 * @ontology/adapter-data-duckdb — a real, sandboxed DuckDB data backend.
 *
 * Implements `StructuredQueryPort`, `CatalogPort` and `SourceProbeAdapter` from
 * `@ontology/contracts` over a materialised read-only snapshot. The SQL subset is validated
 * from an AST, every relation must be registered, table functions are refused by default and
 * the engine is configured read-only with external access disabled.
 */
export { DATA_DUCKDB_ADAPTER_REF, DuckDbQueryAdapter } from './adapter'
export { DuckDbEngine, DuckDbSession, DuckDBTypeId } from './engine'
export type { SessionExecution, DuckDbEngineOptions } from './engine'
export { DuckDbAdapterError } from './errors'
export type { DuckDbAdapterErrorCode, DuckDbAdapterErrorOptions } from './errors'
export { DEFAULT_DUCKDB_LIMITS, RelationRegistry } from './config'
export type {
  DuckDbAdapterConfig,
  DuckDbAdapterLimits,
  RegisteredRelation,
} from './config'
export {
  canonicalJson,
  normaliseColumnType,
  normaliseValue,
  resultDigestOf,
} from './normalise'
export type { NormalisedResult } from './normalise'
export { validateSql } from './validator'
export type { SandboxInput, SandboxValidation } from './validator'
export { collectFacts, parseSql, splitStatements } from './ast'
export type { ParsedStatement, SqlFacts, SqlQuery } from './ast'
