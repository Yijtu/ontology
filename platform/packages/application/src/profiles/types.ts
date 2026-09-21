import type {
  DeploymentEnvironment,
  ProfileRef,
  ProfileSpec,
  RevisionString,
  ScopeRef,
  Sha256Digest,
} from '@ontology/contracts'

export interface PublishProfileInput {
  readonly scopeRef: ScopeRef
  readonly profileRef: ProfileRef
  readonly spec: ProfileSpec
  readonly environment: DeploymentEnvironment
}

export interface ProfileReferenceInput {
  readonly scopeRef: ScopeRef
  readonly profileRef: ProfileRef
}

export type PreflightProfileInput = ProfileReferenceInput

export interface ResolvedProfileQuery extends ProfileReferenceInput {
  readonly snapshotHash: Sha256Digest
}

export interface ActivateProfileInput extends ResolvedProfileQuery {
  /**
   * If-Match semantics. `undefined` means the header was absent and the call is rejected
   * with 428; `null` means "no active profile is expected" (first activation).
   */
  readonly expectedRevision?: RevisionString | null
}
