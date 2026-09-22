/**
 * Semantic publication and candidate review (SPEC D4.6/D5/D6, C6, US-011/US-012/US-015).
 *
 * The module turns approved candidates into versioned facts and rules in one transaction
 * with the identity-constraint checks and the outbox event, exposes the published read view
 * separately from the candidate table, and appends corrections/retractions without erasing
 * history. It never evaluates rules, never materialises a projection and never imports an
 * adapter or driver.
 */
export { SemanticPublicationService } from './publication-service'
export { InMemorySemanticPublicationStore } from './in-memory-publication-store'
export { SemanticPublicationError, isSemanticPublicationError } from './errors'
export type { PublicationRejectionReason, SemanticPublicationErrorCode } from './errors'
export type { SemanticPublicationServiceDependencies } from './types'
