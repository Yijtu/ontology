import type { PublishedPackRuleVersion, RuleCandidate, VersionRef } from '@ontology/contracts'
/** Legacy extracted bindings remain readable; pack bindings name their actual published origin. */
export interface CompetencyExtractedRuleAlias {
  readonly origin?: 'extracted'
  readonly declarationRef: VersionRef
  readonly publishedRef: VersionRef
  readonly sourceCandidateId: string
  readonly publicationId: string
}
export interface CompetencyPackRuleAlias {
  readonly origin: 'pack'
  readonly declarationRef: VersionRef
  readonly publishedRef: VersionRef
  readonly sourceCandidateId: string
  readonly publishedPackRef: VersionRef
}
export type CompetencyRuleAlias = CompetencyExtractedRuleAlias | CompetencyPackRuleAlias
/** A pack rule is not an extraction candidate and has no extraction publication id. */
export type CompetencyTemplateRuleSource = RuleCandidate | PublishedPackRuleVersion
