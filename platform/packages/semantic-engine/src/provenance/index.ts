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
  PublishedRulePolicySpan,
  PublishedRuleSupportGroup,
  PublishedRuleSupportInstance,
  PublishedRuleSupportReader,
  PublishedRuleSupportResolution,
  RuleSupportAxisCoverage,
  SupportEvidenceDependencySourceDependencies,
} from './support-dependency-source'
export {
  MaterializedRuleSupportReader,
  digestIsSelfConsistent,
  isRuleComputationArtifact,
  materializedRuleSupportFactGroupsOf,
} from './materialized-support-reader'
export type {
  MaterializedRuleSupportFactGroup,
  MaterializedRuleSupportReaderDependencies,
  RuleSupportPayloadMetadataReader,
  RuleSupportPayloadReader,
} from './materialized-support-reader'
export { MaterializedRuleDerivationEvidenceProducer, RuleDerivationEvidenceProducerError } from './rule-derivation-producer'
export type {
  MaterializedRuleDerivationEvidenceProducerDependencies,
  RecordMaterializedRuleDerivationEvidenceInput,
  RuleDerivationEvidenceProducerErrorCode,
} from './rule-derivation-producer'
export type {
  RuleDerivationSourceEvidenceMapping,
  RuleDerivationSupportPayload,
  RulePolicySourceEvidenceMapping,
  RulePolicySpanArchiveBinding,
  RuleSourceSpanArchiveBinding,
} from './support-payload'
export { HistoryReadService } from './history-service'
export type { HistoryReadServiceDependencies, ObjectHistoryReadView } from './history-service'
export { HistoryReadError, isHistoryReadError } from './errors'
export type { HistoryReadErrorCode } from './errors'
export { ArchivedRulePremiseReplayVerifier } from './rule-premise-replay'
export type { RulePremiseReplayDependencies } from './rule-premise-replay'
