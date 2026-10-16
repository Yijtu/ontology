import {
  ToolConnectionError,
  TOOL_SELECTION_RESOLUTION_ORDER,
} from '@ontology/contracts'
import type {
  EffectiveToolSelection,
  EffectiveToolState,
  ScopeRef,
  ToolAssignmentSet,
  ToolAssignmentStore,
  ToolConnectionCapability,
  ToolConnectionSelection,
  ToolConnectionStore,
  ToolConnectionSummary,
  ToolSelectionReason,
  ToolSelectionSource,
  ToolTargetDirectory,
  ToolTargetScope,
  ToolContext,
} from '@ontology/contracts'
import { assertToolTargetEditor, scopeOf } from './guards'
import { toolAdapterRequiresCredential } from './tool-adapter-capabilities'

const TOOLS: readonly ToolConnectionCapability[] = ['ontology_lookup', 'data_query', 'document_search', 'web_search']

export interface ToolSelectionServiceDependencies {
  readonly assignments: ToolAssignmentStore
  readonly connections: ToolConnectionStore
  readonly targets: ToolTargetDirectory
  readonly now?: () => string
}

function toolSelection(set: ToolAssignmentSet, toolId: ToolConnectionCapability): ToolConnectionSelection | undefined {
  return set.toolSelections.find((entry) => entry.toolId === toolId)?.selection
}

function connectionSummaryOf(view: ToolConnectionSummary): ToolConnectionSummary {
  return {
    connectionId: view.connectionId,
    name: view.name,
    revision: view.revision,
    adapterType: view.adapterType,
    capabilities: view.capabilities,
    enabled: view.enabled,
    credentialState: view.credentialState,
    ...(view.probeSummary === undefined ? {} : { probeSummary: view.probeSummary }),
    updatedAt: view.updatedAt,
  }
}

/**
 * Resolve an effective tool selection for one tool/object without ever silently switching vendor
 * (design §9). A named-but-broken connection is reported as `blocked` with a stable reason; it never
 * falls through to a lower layer, so disabling or revoking access cannot retarget traffic to another
 * connection. `ToolConnectionSummary` carries no address or secret.
 */
export class ToolSelectionService {
  readonly #assignments: ToolAssignmentStore
  readonly #connections: ToolConnectionStore
  readonly #targets: ToolTargetDirectory
  readonly #now: () => string

  constructor(dependencies: ToolSelectionServiceDependencies) {
    this.#assignments = dependencies.assignments
    this.#connections = dependencies.connections
    this.#targets = dependencies.targets
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async resolve(
    scopeRef: ScopeRef,
    request: { readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    ctx: ToolContext,
  ): Promise<EffectiveToolSelection> {
    assertToolTargetEditor(ctx)
    if (!TOOLS.includes(request.toolId)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', `unknown tool ${String(request.toolId)}`)
    }
    const trusted = scopeOf(ctx)
    if (trusted.tenantId !== scopeRef.tenantId || trusted.spaceId !== scopeRef.spaceId) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'the request scope does not match the trusted principal scope')
    }
    await this.#targets.assertTargetInScope(scopeRef, request.scope, ctx)
    const objectSet = request.scope.kind === 'space'
      ? undefined
      : await this.#assignments.getAssignmentSet(scopeRef, request.scope, ctx)
    const spaceSet = await this.#assignments.getAssignmentSet(scopeRef, { kind: 'space' }, ctx)

    for (const layer of TOOL_SELECTION_RESOLUTION_ORDER) {
      const isObjectLayer = layer === 'object_tool' || layer === 'object_default'
      if (isObjectLayer && request.scope.kind === 'space') continue
      const set = isObjectLayer ? objectSet : spaceSet
      if (set === undefined) continue
      const isToolLayer = layer === 'object_tool' || layer === 'space_tool'
      const selection = isToolLayer ? toolSelection(set, request.toolId) : set.defaultSelection
      if (selection === undefined || selection.kind === 'inherit') continue
      if (selection.kind === 'disabled') {
        return this.#effective(request, layer, selection, set.revision, 'disabled', 'TOOL_DISABLED')
      }
      return this.#resolveConnection(scopeRef, request, layer, selection, set.revision, ctx)
    }

    return this.#effective(request, 'unconfigured', { kind: 'inherit' }, undefined, 'unconfigured', 'TOOL_NOT_CONFIGURED')
  }

  /** Resolve several tools for one scope, e.g. the capability strip in AI settings. */
  async resolveAll(
    scopeRef: ScopeRef,
    request: { readonly scope: ToolTargetScope; readonly toolIds: readonly ToolConnectionCapability[] },
    ctx: ToolContext,
  ): Promise<readonly EffectiveToolSelection[]> {
    const result: EffectiveToolSelection[] = []
    for (const toolId of request.toolIds) {
      result.push(await this.resolve(scopeRef, { scope: request.scope, toolId }, ctx))
    }
    return result
  }

  async #resolveConnection(
    scopeRef: ScopeRef,
    request: { readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    layer: ToolSelectionSource,
    selection: ToolConnectionSelection,
    assignmentRevision: string | undefined,
    ctx: ToolContext,
  ): Promise<EffectiveToolSelection> {
    if (selection.kind !== 'connection') {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'the resolved selection is not a connection reference')
    }
    const connection = await this.#connections.getConnection(scopeRef, selection.connectionId, ctx)
    if (connection === undefined) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'TOOL_NOT_CONFIGURED', { connectionId: selection.connectionId })
    }
    if (!connection.enabled) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'TOOL_DISABLED', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    if (!connection.capabilities.includes(request.toolId)) {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'TOOL_CAPABILITY_MISMATCH', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    if (toolAdapterRequiresCredential(connection.adapterType) && connection.credentialState !== 'present') {
      return this.#effective(request, layer, selection, assignmentRevision, 'blocked', 'CREDENTIAL_MISSING', { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
    }
    return this.#effective(request, layer, selection, assignmentRevision, 'available', undefined, { connectionId: selection.connectionId, summary: connectionSummaryOf(connection) })
  }

  #effective(
    request: { readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    resolvedFrom: ToolSelectionSource,
    selection: ToolConnectionSelection,
    assignmentRevision: string | undefined,
    state: EffectiveToolState,
    blockedReason: ToolSelectionReason | undefined,
    extra: { readonly connectionId?: string; readonly summary?: ToolConnectionSummary } = {},
  ): EffectiveToolSelection {
    return {
      schemaVersion: 'effective-tool-selection@1',
      scope: request.scope,
      toolId: request.toolId,
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
