export { ProfileResolver } from './resolver'
export type { ProfileResolverDependencies } from './resolver'
export { ProfileResolverError, isProfileResolverErrorCode } from './errors'
export type { ProfileResolverErrorCode, ProfileResolverErrorOptions } from './errors'
export { InMemoryProfileStore } from './in-memory-store'
export { InMemoryIndustryManifestSource } from './industry-source'
export {
  canonicalJson,
  profileSpecDigest,
  refKey,
  resolvedProfileDigest,
  sha256DigestOf,
} from './canonical'
export {
  availableComponentKeys,
  capabilitiesFromComponents,
  computeExplicitDegradations,
  isComponentAvailable,
} from './degradations'
export type {
  ActivateProfileInput,
  PreflightProfileInput,
  ProfileReferenceInput,
  PublishProfileInput,
  ResolvedProfileQuery,
} from './types'
export type {
  ProfileSpecValidationIssue,
  ProfileSpecValidationResult,
  ProfileSpecValidator,
} from './validator'
