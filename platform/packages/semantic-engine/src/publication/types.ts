import type {
  CandidateStore,
  IdentityDecisionStore,
  IndustrySchemaSource,
  ReviewableCandidateReader,
  SemanticPublicationStore,
  InstanceReviewStore,
  ProjectStore,
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
  /** Mandatory for a stored rule with projectId; the request never supplies project authority. */
  readonly projects?: Pick<ProjectStore, 'getProject' | 'getRevision'>
  /** Atomic candidate-review, publication and statement-revision persistence. */
  readonly store: SemanticPublicationStore
  /** The extraction candidates being published; a candidate is loaded, never trusted from the body. */
  readonly candidates: CandidateStore
  /** Published definitions; the schema/object shape is resolved from here, never from a name. */
  readonly schemaSource: IndustrySchemaSource
  /** Entity identity decisions; a published fact binds to the entity a candidate was asserted to. */
  readonly identity: IdentityDecisionStore
  /** Required for mapped structured candidates; absence fails closed. */
  readonly instanceRecords?: Pick<InstanceReviewStore, 'getRecord'>
  /**
   * Optional dispatch over the candidate families a review may address (V03-009). When
   * provided, `reviewCandidate` verifies visibility through it (instance OR definition) and
   * `publish` explicitly refuses a definition candidate; the review store is still the only
   * decision truth. Omitted preserves the extraction-only behaviour.
   */
  readonly reviewableCandidates?: ReviewableCandidateReader
  readonly now?: () => string
  readonly newId?: () => string
}
