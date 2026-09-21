import type {
  ComponentManifest,
  ComponentVersionRecord,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  VersionRef,
} from '@ontology/contracts'

export type ComponentKind = ComponentManifest['kind']

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

/**
 * Where a registration request came from. Only a direct operator request may install
 * a component: an MCP discovery result or a model output is data, never an install
 * trigger (INV-06 / C1 "不自动从网络下载未知包").
 */
export type RegistrationSource = 'operator' | 'mcp_discovery' | 'model_output'

export interface RegisterComponentInput {
  readonly scopeRef: ScopeRef
  readonly manifest: ComponentManifest
  /**
   * Immutable blob reference of the component artifact. The registration API accepts
   * a reference only — never bytes, a network URL or a filesystem path.
   */
  readonly artifactRef: ResourceRef
  readonly source: RegistrationSource
}

export interface TransitionComponentInput {
  readonly scopeRef: ScopeRef
  readonly kind: ComponentKind
  readonly ref: VersionRef
  readonly to: ModuleLifecycleState
}

export interface ComponentReferenceInput {
  readonly scopeRef: ScopeRef
  readonly kind: ComponentKind
  readonly ref: VersionRef
}

export interface ActiveComponentReferenceInput extends ComponentReferenceInput {
  readonly runId: string
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

export type { ComponentVersionRecord }
