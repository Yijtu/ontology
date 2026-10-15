import {
  ModelSelectionError,
  MODEL_CAPABILITIES,
  modelAdapterSupportsCapability,
} from '@ontology/contracts'
import type {
  EffectiveModelSelection,
  EffectiveModelState,
  ModelAssignmentSet,
  ModelAssignmentStore,
  ModelCapability,
  ModelConnectionSelection,
  ModelConnectionStore,
  ModelConnectionSummary,
  ModelSelectionReason,
  ModelSelectionSource,
  ModelTargetDirectory,
  ModelTargetScope,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { assertTargetEditor, scopeOf } from './guards'

/**
 * The fixed resolution order (A-R10): object capability → object default → space capability →
 * space default → unconfigured. `inherit` proceeds to the next layer; `disabled` terminates.
 */
export const MODEL_RESOLUTION_LAYERS: readonly ModelSelectionSource[] = [
  'object_capability',
  'object_default',
  'space_capability',
  'space_default',
]

export interface ModelSelectionServiceDependencies {
  readonly assignments: ModelAssignmentStore
  readonly connections: ModelConnectionStore
  readonly targets: ModelTargetDirectory
  readonly now?: () => string
}

function capabilitySelection(set: ModelAssignmentSet, capability: ModelCapability): ModelConnectionSelection | undefined {
  return set.capabilitySelections.find((entry) => entry.capability === capability)?.selection
}

function connectionSummaryOf(view: ModelConnectionSummary): ModelConnectionSummary {
  return {
    connectionId: view.connectionId,
    name: view.name,
    revision: view.revision,
    adapterType: view.adapterType,
    protocol: view.protocol,
    capabilities: view.capabilities,
    enabled: view.enabled,
    credentialState: view.credentialState,
    ...(view.testSummary === undefined ? {} : { testSummary: view.testSummary }),
    updatedAt: view.updatedAt,
  }
}

/**
 * Resolve an effective model selection for a capability/object without ever silently switching
 * vendor (design §5.2/§5.3). A named-but-broken connection is reported as `blocked` with a stable
 * reason; it never falls through to a lower layer, so revoking access cannot retarget traffic.
 * `ModelConnectionSummary` carries no address or secret.
 */
export class ModelSelectionService {
  readonly #assignments: ModelAssignmentStore
  readonly #connections: ModelConnectionStore
  readonly #targets: ModelTargetDirectory
  readonly #now: () => string

  constructor(dependencies: ModelSelectionServiceDependencies) {
    this.#assignments = dependencies.assignments
    this.#connections = dependencies.connections
    this.#targets = dependencies.targets
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async resolve(
    scopeRef: ScopeRef,
    request: { readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    ctx: ToolContext,
  ): Promise<EffectiveModelSelection> {
    assertTargetEditor(ctx)
    if (!MODEL_CAPABILITIES.includes(request.capability)) {
      throw new ModelSelectionError('INVALID_ARGUMENT', `unknown model capability ${String(request.capability)}`)
    }
    const trusted = scopeOf(ctx)
    if (trusted.tenantId !== scopeRef.tenantId || trusted.spaceId !== scopeRef.spaceId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'the request scope does not match the trusted principal scope')
    }
    await this.#targets.assertTargetInScope(scopeRef, request.scope, ctx)
    const objectSet = request.scope.kind === 'space'
      ? undefined
      : await this.#assignments.getAssignmentSet(scopeRef, request.scope, ctx)
    const spaceSet = await this.#assignments.getAssignmentSet(scopeRef, { kind: 'space' }, ctx)

    for (const layer of MODEL_RESOLUTION_LAYERS) {
      const isObjectLayer = layer === 'object_capability' || layer === 'object_default'
      if (isObjectLayer && request.scope.kind === 'space') continue
      const set = isObjectLayer ? objectSet : spaceSet
      if (set === undefined) continue
      const isCapabilityLayer = layer === 'object_capability' || layer === 'space_capability'
      const selection = isCapabilityLayer ? capabilitySelection(set, request.capability) : set.defaultSelection
      if (selection === undefined || selection.kind === 'inherit') continue
      if (selection.kind === 'disabled') {
        return this.#effective(request, layer, selection, set.revision, 'disabled', 'MODEL_DISABLED')
      }
      return this.#resolveConnection(scopeRef, request, layer, selection, set.revision, ctx)
    }

    return this.#effective(request, 'unconfigured', { kind: 'inherit' }, undefined, 'unconfigured', 'MODEL_NOT_CONFIGURED')
  }

  /** Resolve several capabilities for one scope, e.g. the first-screen capability strip. */
  async resolveAll(
    scopeRef: ScopeRef,
    request: { readonly scope: ModelTargetScope; readonly capabilities: readonly ModelCapability[] },
    ctx: ToolContext,
  ): Promise<readonly EffectiveModelSelection[]> {
    const result: EffectiveModelSelection[] = []
    for (const capability of request.capabilities) {
      result.push(await this.resolve(scopeRef, { scope: request.scope, capability }, ctx))
    }
    return result
  }

  async #resolveConnection(
    scopeRef: ScopeRef,
    request: { readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    layer: ModelSelectionSource,
    selection: ModelConnectionSelection,
    assignmentRevision: string | undefined,
    ctx: ToolContext,
  ): Promise<EffectiveModelSelection> {
    if (selection.kind !== 'connection') {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'the resolved selection is not a connection reference')
    }
    const connection = await this.#connections.getConnection(scopeRef, selection.connectionId, ctx)
    if (connection === undefined) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'MODEL_NOT_CONFIGURED', { connectionId: selection.connectionId })
    }
    if (!connection.enabled) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'MODEL_DISABLED', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    if (!modelAdapterSupportsCapability(connection.adapterType, request.capability) || !connection.capabilities.includes(request.capability)) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'MODEL_CAPABILITY_MISMATCH', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    if (connection.credentialState !== 'present') {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'CREDENTIAL_MISSING', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    return this.#effective(request, layer, selection, assignmentRevision, 'available', undefined, { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
  }

  #effective(
    request: { readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    resolvedFrom: ModelSelectionSource,
    selection: ModelConnectionSelection,
    assignmentRevision: string | undefined,
    state: EffectiveModelState,
    blockedReason: ModelSelectionReason | undefined,
    extra: { readonly connectionId?: string; readonly summary?: ModelConnectionSummary } = {},
  ): EffectiveModelSelection {
    return {
      schemaVersion: 'effective-model-selection@1',
      scope: request.scope,
      capability: request.capability,
      selection,
      resolvedFrom,
      state,
      ...(extra.connectionId === undefined ? {} : { connectionId: extra.connectionId }),
      ...(extra.summary === undefined ? {} : { connectionSummary: extra.summary }),
      ...(assignmentRevision === undefined ? {} : { assignmentRevision }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
      resolvedAt: this.#now(),
    }
  }
}
