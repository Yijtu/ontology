import type {
  ComponentKind,
  ComponentManifest,
  ComponentVersionRecord,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Component identity. It is `(kind, id, version)` per D2's unique key; the digest is
 * the freeze value, not part of the identity, so the same id+version with another
 * digest is a conflict rather than a second component.
 */
export interface ComponentKey {
  readonly kind: ComponentKind
  readonly id: string
  readonly version: Semver
}

export interface ComponentListFilter {
  readonly kind?: ComponentKind
  readonly lifecycleState?: ModuleLifecycleState
}

/** A run pinning one exact component version. Retiring is refused while any exists. */
export interface ActiveComponentReference {
  readonly key: ComponentKey
  readonly runId: string
  readonly acquiredAt: string
}

/**
 * One append-only lifecycle record. `payloadDigest` and `idempotencyKey` also exist in
 * the control event ledger, so the reconstructable history can be checked against a
 * stream that cannot be rewritten.
 */
export interface ComponentLifecycleEvent {
  readonly key: ComponentKey
  readonly digest: Sha256Digest
  readonly fromState: ModuleLifecycleState | null
  readonly toState: ModuleLifecycleState
  readonly payloadDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly occurredAt: string
  readonly actor: string
}

export function componentKeyOf(manifest: ComponentManifest): ComponentKey {
  return { kind: manifest.kind, id: manifest.id, version: manifest.version }
}

export function componentKeyFromRef(kind: ComponentKind, ref: VersionRef): ComponentKey {
  return { kind, id: ref.id, version: ref.version }
}

export function componentKeyString(key: ComponentKey): string {
  return `${key.kind}\u0000${key.id}\u0000${key.version}`
}

/**
 * Store-level failures. The registry service maps them onto classified
 * `ComponentRegistryError` codes; the store never leaks a driver error upward.
 *
 * The taxonomy lives next to the port so every implementation — in-memory reference
 * store, PostgreSQL adapter — throws the same class the application layer catches.
 */
export type ComponentStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'VERSION_EXISTS'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_RETIRED'
  | 'CONCURRENT_MODIFICATION'
  | 'ACTIVE_REFERENCE_EXISTS'

export class ComponentStoreError extends Error {
  readonly code: ComponentStoreErrorCode

  constructor(code: ComponentStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ComponentStoreError'
    this.code = code
  }
}

/** The append-only lifecycle record the service hands to the store on every change. */
export interface ComponentLifecycleAudit {
  readonly fromState: ModuleLifecycleState | null
  readonly toState: ModuleLifecycleState
  readonly digest: Sha256Digest
  readonly payloadDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly occurredAt: string
  readonly actor: string
}

export interface ComponentRegistrationRecordInput {
  readonly record: ComponentVersionRecord
  readonly artifactRef: ResourceRef
  readonly audit: ComponentLifecycleAudit
}

/**
 * Persistence port for the component registry (D2). It keeps immutable versions, the
 * active-run reference set and an append-only lifecycle history, always inside the
 * trusted tenant/space scope. `ControlRepository` is used separately for the durable
 * event ledger; this port is the version projection.
 *
 * Implementations must make `applyTransition` a compare-and-set on the lifecycle state
 * and must refuse to retire a version that still has an active reference.
 *
 * The port is declared here, next to `ControlRepository`/`BlobPort`, so an adapter can
 * implement it while depending on `contracts` alone (SPEC §2: adapters → contracts).
 */
export interface ComponentRegistryStore {
  findVersion(
    key: ComponentKey,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord | undefined>
  listVersions(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]>
  insertVersion(
    scopeRef: ScopeRef,
    input: ComponentRegistrationRecordInput,
    ctx: ToolContext,
  ): Promise<void>
  applyTransition(
    scopeRef: ScopeRef,
    key: ComponentKey,
    expectedFrom: ModuleLifecycleState,
    next: ComponentVersionRecord,
    audit: ComponentLifecycleAudit,
    ctx: ToolContext,
  ): Promise<void>
  listActiveReferences(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference[]>
  acquireActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference>
  releaseActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<boolean>
  listLifecycleEvents(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ComponentLifecycleEvent[]>
}
