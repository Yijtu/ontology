import type {
  CandidateStore,
  IdentityDecisionStore,
  IndustrySchemaSource,
  SemanticPublicationStore,
} from '@ontology/contracts'

/**
 * Semantic publication and candidate review (SPEC D4.6/D5/D6, C6, US-011/US-012/US-015).
 *
 * The service resolves the pinned definition, loads candidates from the candidate store,
 * resolves entity identity from the decision store, then commits the versioned facts/rules
 * through the injected `SemanticPublicationStore`. It never recalls candidates, never
 * evaluates rules and never imports an adapter or driver.
 */
export interface SemanticPublicationServiceDependencies {
  /** Atomic candidate-review, publication and statement-revision persistence. */
  readonly store: SemanticPublicationStore
  /** The extraction candidates being published; a candidate is loaded, never trusted from the body. */
  readonly candidates: CandidateStore
  /** Published definitions; the schema/object shape is resolved from here, never from a name. */
  readonly schemaSource: IndustrySchemaSource
  /** Entity identity decisions; a published fact binds to the entity a candidate was asserted to. */
  readonly identity: IdentityDecisionStore
  readonly now?: () => string
  readonly newId?: () => string
}
