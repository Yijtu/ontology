/**
 * Incremental materialisation, bitemporal projection and invalidation fence (SPEC D3.1/D5/D5.1,
 * ADR-13, US-016/US-017, FR-18/FR-19/FR-20).
 *
 * The module composes the pure rule evaluator (LOCAL-032) with the published read view
 * (LOCAL-031) and an injected projection/fence store. It resolves a change through a dependency
 * index so only the affected evaluations run, sets an invalidation fence before advancing
 * asynchronously, keeps valid time and `recorded_seq` independent in append-only slices, and
 * answers on demand and from the projection identically. It does not expose a provenance/history
 * API (LOCAL-034) or a UI.
 */
export { IncrementalMaterializer } from './service'
export { InMemoryMaterializationStore } from './in-memory-materialization-store'
export { PublishedSemanticSource } from './published-source'
export type { PublishedSemanticReadView } from './published-source'
export { ruleComputationArtifactOf, ruleComputationArtifactsOf } from './artifacts'
export { MaterializationDependencyIndex } from './dependency-index'
export type { DependencyEntityBinding, DependencyIndexInput } from './dependency-index'
export { MaterializationError, isMaterializationError } from './errors'
export type { MaterializationErrorCode } from './errors'
export type {
  MaterializationAdvanceResult,
  MaterializationFaultInjection,
  MaterializationPublishedSource,
  MaterializationReadRequest,
  MaterializationReadResult,
  MaterializationReadStatus,
  MaterializationServiceDependencies,
  MaterializationTicket,
  PublishedSemanticData,
} from './types'
