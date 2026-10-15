/**
 * Industry asset publication (V03-015 / #187): immutable pack publication, dynamic catalogue
 * assembly and version diffing. It depends only on `@ontology/contracts` and the sibling pure
 * validation helpers, and receives every persistence port by construction injection.
 */
export {
  IndustryAssetPublicationService,
  PACK_PUBLISHED_TOPIC,
} from './industry-asset-publication-service'
export type { IndustryAssetPublicationDependencies } from './industry-asset-publication-service'
export {
  PACK_PUBLICATION_VERSION,
  DEFAULT_PACK_CAPABILITY,
  actionCandidatesOf,
  assemblePack,
  buildCapabilityStatus,
  buildDefinitionRecord,
  buildSourceIndexEntries,
  buildTestSuite,
  buildVersionDiff,
  contentDigestOf,
  definitionVersionDigestOf,
  sourceIndexDigest,
} from './pack-assembly'
export type { AssemblePackArgs, AssembledPack } from './pack-assembly'
export { InMemoryPublishedPackAssetStore } from './in-memory-store'
export type { InMemoryPublishedPackAssetStoreDependencies } from './in-memory-store'
export { definitionApprovalPins, currentRuleActionProjection, ruleActionPublicationPins, industryValidationDigest } from './publication-pins'
export type { CandidateApprovalReader } from './publication-pins'
export { createPackPublicationGuard } from './publication-pins'
export { resolveDefinitionPredecessor, DefinitionPredecessorError } from './definition-predecessor'
export type { DefinitionPredecessor } from './definition-predecessor'
export { resolvePinnedDefinition } from './definition-predecessor'
export type { PinnedDefinitionDependencies } from './definition-predecessor'
export { PublishedPackRuleDeclarationReader } from './published-rule-reader'
export type { PublishedPackRuleReaderDependencies } from './published-rule-reader'
export { ruleApprovalPins } from './publication-pins'
export { publishedPackContentDigest } from './pack-assembly'
export { readWorkspacePublicationSourceDrafts } from './workspace-publication-drafts'
