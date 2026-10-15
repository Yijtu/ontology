/**
 * Pack assets: portable export, maturity gating and compatibility upgrade (LOCAL-041).
 *
 * The module owns the industry-pack export/upgrade orchestration. It depends only on
 * `@ontology/contracts` (and its sibling registry/profile services) and receives every
 * persistence and catalogue capability by construction injection.
 */
export { IndustryPackError } from './errors'
export type { IndustryPackErrorCode, IndustryPackErrorOptions } from './errors'
export { resolveTrustedScope, assertRole } from './scope'
export { findPackExportViolations } from './violations'
export type { PackExportViolation, PackExportViolationCode } from './violations'
export { InMemoryIndustryPackCatalogue, summarizePackCatalogEntry } from './catalogue'
export {
  StoreBackedIndustryPackCatalogue,
  StoreBackedIndustryManifestSource,
} from './dynamic-catalogue'
export type {
  StoreBackedIndustryPackCatalogueDependencies,
  StoreBackedIndustryManifestSourceDependencies,
} from './dynamic-catalogue'
export {
  IndustryPackExportService,
  PACK_EXPORT_VERSION,
  identityPolicyOf,
  mappingTemplatesOf,
} from './export-service'
export type { ExportPackInput, IndustryPackExportDependencies } from './export-service'
export { IndustryPackUpgradeService, applyUpgradeSlot, fromRefOf } from './upgrade-service'
export type { IndustryPackUpgradeDependencies } from './upgrade-service'
