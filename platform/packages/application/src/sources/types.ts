import type {
  CapabilityRequirement,
  LogicalRole,
  MappingRef,
  ProfileRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  SourceKind,
  SourceStatus,
  VersionRef,
} from '@ontology/contracts'

export interface RegisterSourceInput {
  readonly scopeRef: ScopeRef
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  readonly secretRef: string
  readonly mappingRef?: MappingRef
  readonly capabilityVersion?: Semver
}

export interface ReviseSourceInput {
  readonly scopeRef: ScopeRef
  readonly sourceId: string
  readonly version: Semver
  readonly capabilityVersion: Semver
  readonly mappingRef?: MappingRef
}

export interface ProbeSourceInput {
  readonly scopeRef: ScopeRef
  readonly sourceId: string
  /** C6: the capability subset the caller expects. A gap fails the probe, never a silent ready. */
  readonly capabilities?: readonly CapabilityRequirement[]
}

export interface SourceQueryInput {
  readonly scopeRef: ScopeRef
  readonly sourceId: string
}

export interface ProbeJobQueryInput {
  readonly scopeRef: ScopeRef
  readonly jobId: string
}

export interface SourceConfigEntry {
  readonly sourceId: string
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  readonly secretRef: string
  readonly status: SourceStatus
  readonly currentVersion: Semver
  readonly capabilityVersion?: Semver
  readonly revision: string
  readonly mappingRef?: MappingRef
}

/** Refs-only configuration export. It carries `secretRef`, never a resolved secret value. */
export interface SourceConfigExport {
  readonly scopeRef: ScopeRef
  readonly exportedAt: Rfc3339UtcTimestamp
  readonly sources: readonly SourceConfigEntry[]
}

export interface ModelSourceCapability {
  readonly name: string
  readonly version: Semver
}

/**
 * The only source shape that may reach a model context: identity, role, status and the
 * confirmed capability names. No `secretRef`, no adapter physical detail, no mapping object.
 */
export interface ModelSourceSummary {
  readonly sourceId: string
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly status: SourceStatus
  readonly capabilities: readonly ModelSourceCapability[]
}

export interface ModelSourceContext {
  readonly sources: readonly ModelSourceSummary[]
}

export interface RecordSourcePreflightInput {
  readonly scopeRef: ScopeRef
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  /** Logical roles the resolved profile binds to a backend. */
  readonly roles: readonly LogicalRole[]
}

export interface AssessSourcePreflightInput {
  readonly scopeRef: ScopeRef
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
}

export interface SourcePreflightFresh {
  readonly status: 'fresh'
  readonly checkedAt: Rfc3339UtcTimestamp
}

export interface SourcePreflightStale {
  readonly status: 'stale'
  readonly checkedAt: Rfc3339UtcTimestamp
  readonly reasons: readonly string[]
}

export type SourcePreflightFreshness = SourcePreflightFresh | SourcePreflightStale
