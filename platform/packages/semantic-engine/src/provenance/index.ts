/**
 * Provenance/history read side (SPEC C3.1/C6, D3/D5, US-017/US-022, FR-19/FR-20/FR-30).
 *
 * The module turns the compact rule support DAG (LOCAL-032) and the official published read
 * view (LOCAL-031) into the real evidence-dependency structure, and replays immutable
 * assertion versions at a recorded or valid instant. It never reads the candidate store, the
 * ontology type graph or an adapter.
 */
export { SupportEvidenceDependencySource } from './support-dependency-source'
export type {
  PublishedRuleSupportGroup,
  PublishedRuleSupportInstance,
  PublishedRuleSupportReader,
  PublishedRuleSupportResolution,
  SupportEvidenceDependencySourceDependencies,
} from './support-dependency-source'
export { MaterializedRuleSupportReader } from './materialized-support-reader'
export type {
  MaterializedRuleSupportReaderDependencies,
  RuleSupportPayloadMetadataReader,
  RuleSupportPayloadReader,
} from './materialized-support-reader'
export { HistoryReadService } from './history-service'
export type { HistoryReadServiceDependencies, ObjectHistoryReadView } from './history-service'
export { HistoryReadError, isHistoryReadError } from './errors'
export type { HistoryReadErrorCode } from './errors'
