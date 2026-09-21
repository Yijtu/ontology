import type {
  ComponentKind,
  ComponentManifest,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  VersionRef,
} from '@ontology/contracts'

/**
 * The store-level identity, history and reference types now live in `@ontology/contracts`
 * next to the `ComponentRegistryStore` port, so an adapter can implement the port without
 * depending on this package. They are re-exported here to keep the application public
 * entry stable.
 */
export type {
  ActiveComponentReference,
  ComponentKey,
  ComponentKind,
  ComponentLifecycleEvent,
  ComponentListFilter,
} from '@ontology/contracts'
export { componentKeyFromRef, componentKeyOf, componentKeyString } from '@ontology/contracts'

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

export type { ComponentVersionRecord } from '@ontology/contracts'
