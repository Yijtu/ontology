import type {
  CancellationSupport,
  Capability,
  CapabilityLimits,
  CapabilityRequirement,
  CatalogDescribeResponse,
  ConsistencyLevel,
  ErrorCode,
  LogicalRole,
  MappingRef,
  PaginationKind,
  ProfileRef,
  Rfc3339UtcTimestamp,
  RevisionString,
  SchemaVersion,
  ScopeRef,
  Semver,
  Sha256Digest,
  SupportedDataType,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Source registration, capability probing and secret handling (SPEC C1/C3/C6, D2; US-008/009).
 *
 * A source binding is a refs-only declaration: `adapterRef` names a registered component and
 * `secretRef` is an opaque, server-resolved reference. Neither a URL, a host, a physical
 * table/column nor a credential value ever appears here, so a configuration export or a
 * model-visible payload cannot carry a secret.
 *
 * The ports live next to `ProfileStore`/`ComponentRegistryStore` so an adapter implements
 * them while depending on `contracts` alone (SPEC §2: adapters → contracts). The
 * application layer receives them by construction injection.
 */

/**
 * How a source is used. A read-only origin database and an imported (ingested) source share
 * one registration path; the kind is data, not a second code path that can drift.
 */
export type SourceKind = 'read_only_origin' | 'imported'

/**
 * Probe lifecycle. A binding is `ready` only after a probe actually confirmed its scope;
 * a failed or partially failed probe leaves it `failed`/`registered`, never optimistically
 * `ready`.
 */
export type SourceStatus = 'registered' | 'probing' | 'ready' | 'failed'

export type SourceProbeJobStatus = 'pending' | 'succeeded' | 'failed'

export interface SourceBindingRecord {
  readonly sourceId: string
  readonly scopeRef: ScopeRef
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  /** Opaque, server-side reference. A secret value is never stored here. */
  readonly secretRef: string
  readonly status: SourceStatus
  readonly currentVersion: Semver
  readonly capabilityVersion?: Semver
  readonly revision: RevisionString
  readonly createdAt: Rfc3339UtcTimestamp
  readonly createdBy: string
  readonly updatedAt: Rfc3339UtcTimestamp
}

/**
 * One immutable source version. Registering a new mapping or capability version is a new
 * row, so a preflight that pinned the previous version can be detected as stale instead of
 * being silently reinterpreted.
 */
export interface SourceVersionRecord {
  readonly sourceId: string
  readonly version: Semver
  readonly digest: Sha256Digest
  readonly capabilityVersion: Semver
  readonly mappingRef?: MappingRef
  readonly registeredAt: Rfc3339UtcTimestamp
  readonly registeredBy: string
}

export interface SourceProbeJobRecord {
  readonly jobId: string
  readonly sourceId: string
  readonly status: SourceProbeJobStatus
  readonly requestedCapabilities: readonly CapabilityRequirement[]
  readonly capabilities?: readonly Capability[]
  readonly schemaRevision?: SchemaVersion
  readonly errorCode?: ErrorCode
  /** Classified, secret-scrubbed message. Never carries a resolved secret value. */
  readonly safeMessage?: string
  readonly createdAt: Rfc3339UtcTimestamp
  readonly completedAt?: Rfc3339UtcTimestamp
}

/**
 * The exact source binding a resolved preflight observed, so a later mapping/capability
 * change can be detected as stale. Stored next to the preflight's `snapshotHash`.
 */
export interface SourceFingerprint {
  readonly role: LogicalRole
  readonly sourceId: string
  readonly status: SourceStatus
  readonly sourceVersion: Semver
  readonly sourceDigest: Sha256Digest
  readonly adapterRef: VersionRef
  readonly capabilityVersion?: Semver
  readonly mappingRef?: MappingRef
}

export interface SourcePreflightBindingRecord {
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  readonly fingerprints: readonly SourceFingerprint[]
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly recordedBy: string
}

export type SourceStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'SOURCE_NOT_FOUND'
  | 'VERSION_EXISTS'
  | 'REVISION_CONFLICT'

export class SourceStoreError extends Error {
  readonly code: SourceStoreErrorCode

  constructor(code: SourceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceStoreError'
    this.code = code
  }
}

export interface SourceBindingUpdate {
  /** Compare-and-set token: the binding revision the caller last observed. */
  readonly expectedRevision: RevisionString
  readonly status: SourceStatus
  readonly currentVersion?: Semver
  readonly capabilityVersion?: Semver
  readonly updatedAt: Rfc3339UtcTimestamp
}

export interface SourceProbeJobCompletion {
  readonly status: Exclude<SourceProbeJobStatus, 'pending'>
  readonly completedAt: Rfc3339UtcTimestamp
  readonly capabilities?: readonly Capability[]
  readonly schemaRevision?: SchemaVersion
  readonly errorCode?: ErrorCode
  readonly safeMessage?: string
}

/**
 * Control persistence for source bindings (D2). It keeps the current binding, immutable
 * source versions and probe jobs, always inside the trusted tenant/space scope. A binding
 * update is a compare-and-set on the monotonic revision; a stored version is never
 * overwritten.
 */
export interface SourceStore {
  insertBinding(scopeRef: ScopeRef, record: SourceBindingRecord, ctx: ToolContext): Promise<void>
  findBinding(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord | undefined>
  listBindings(scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord[]>
  applyBindingUpdate(
    scopeRef: ScopeRef,
    sourceId: string,
    update: SourceBindingUpdate,
    ctx: ToolContext,
  ): Promise<SourceBindingRecord>
  insertVersion(scopeRef: ScopeRef, record: SourceVersionRecord, ctx: ToolContext): Promise<void>
  findVersion(
    sourceId: string,
    version: Semver,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourceVersionRecord | undefined>
  listVersions(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceVersionRecord[]>
  insertProbeJob(scopeRef: ScopeRef, record: SourceProbeJobRecord, ctx: ToolContext): Promise<void>
  findProbeJob(jobId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord | undefined>
  listProbeJobs(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord[]>
  completeProbeJob(
    scopeRef: ScopeRef,
    jobId: string,
    completion: SourceProbeJobCompletion,
    ctx: ToolContext,
  ): Promise<SourceProbeJobRecord>
  /**
   * Record the fingerprints a preflight observed, keyed by `(profileRef, snapshotHash)`.
   * Re-recording replaces the previous observation: a re-preflight after a source change
   * must be able to clear the staleness it was recorded to detect.
   */
  insertPreflightBinding(
    scopeRef: ScopeRef,
    record: SourcePreflightBindingRecord,
    ctx: ToolContext,
  ): Promise<void>
  findPreflightBinding(
    profileRef: ProfileRef,
    snapshotHash: Sha256Digest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourcePreflightBindingRecord | undefined>
}

/**
 * Resolved secret material. The value is reachable only through `reveal()`, and every
 * implicit string/JSON conversion renders `[redacted]`, so a resolved secret cannot leak
 * through `JSON.stringify`, template interpolation or `String(value)`.
 *
 * The composition root supplies the resolver; the application layer resolves a `secretRef`
 * only at the point of use and never persists or returns the value.
 */
export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    if (value.length === 0) throw new Error('SecretValue must not be empty')
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  get length(): number {
    return this.#value.length
  }

  /** Replace every occurrence of the secret in `text` with `[redacted]`. */
  redact(text: string): string {
    return text.split(this.#value).join('[redacted]')
  }

  toString(): string {
    return '[redacted]'
  }

  toJSON(): string {
    return '[redacted]'
  }
}

/** Server-side resolution of an opaque `secretRef`. Never returns a serializable secret. */
export interface SecretResolver {
  resolve(secretRef: string, ctx: ToolContext): Promise<SecretValue>
}

/** A capability the probed adapter confirms it can serve; the probe composes the full `Capability`. */
export interface ProbeCapability {
  readonly name: string
  readonly version: Semver
}

export interface ObservedPagination {
  readonly kind: PaginationKind
  /** Pages the probe actually fetched. A cursor/offset claim needs at least one real page. */
  readonly pagesFetched: number
  /** True when the adapter reported the resource set exhausted (`nextCursor === null`). */
  readonly exhausted: boolean
}

export interface ObservedCancellation {
  readonly support: CancellationSupport
  /** True only when a real cancel request was issued and its outcome observed. */
  readonly attempted: boolean
}

export interface ObservedSnapshot {
  readonly consistency: ConsistencyLevel
  readonly schemaRevision: SchemaVersion
}

/**
 * Exactly what a real, bounded connection probe observed. The probe service composes the
 * capability set from these raw facts (plus `capabilities`), so an adapter cannot hand over
 * a ready-made "ready" verdict.
 */
export interface SourceProbeObservation {
  readonly adapterRef: VersionRef
  readonly catalog: CatalogDescribeResponse
  readonly pagination: ObservedPagination
  readonly cancellation: ObservedCancellation
  readonly snapshot: ObservedSnapshot
  readonly limits: CapabilityLimits
  readonly supportedDataTypes: readonly SupportedDataType[]
  readonly capabilities: readonly ProbeCapability[]
}

export interface SourceProbeRequest {
  readonly role: LogicalRole
  readonly secretRef: string
  readonly secret: SecretValue
  readonly mappingRef?: MappingRef
  readonly requestedCapabilities: readonly CapabilityRequirement[]
}

/**
 * The probe target. LOCAL-012/013 implement the concrete Postgres/DuckDB adapters; this node
 * defines the contract and a controlled test adapter. `probe` must exercise catalog
 * discovery, pagination, cancellation and snapshot observation and report exactly what it
 * observed. Throwing means the source is unreachable or refused.
 */
export interface SourceProbeAdapter {
  readonly adapterRef: VersionRef
  probe(request: SourceProbeRequest, ctx: ToolContext): Promise<SourceProbeObservation>
}

/** Resolves a registered adapter ref to the probe target. Supplied by the composition root. */
export interface SourceProbeAdapterResolver {
  resolve(adapterRef: VersionRef, ctx: ToolContext): Promise<SourceProbeAdapter | undefined>
}
