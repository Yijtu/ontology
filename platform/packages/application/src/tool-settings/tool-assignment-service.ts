import {
  ToolConnectionError,
  assertToolAssignmentSetShape,
  isUuid,
} from '@ontology/contracts'
import type {
  ScopeRef,
  ToolAssignmentSet,
  ToolAssignmentStore,
  ToolConnectionCapability,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolConnectionStore,
  ToolContext,
  ToolTargetDirectory,
  ToolTargetScope,
} from '@ontology/contracts'
import { assertToolAdministrator, assertToolTargetEditor, scopeOf } from './guards'
import { toolAdapterSupportsCapability } from './tool-adapter-capabilities'

const TOOLS: readonly ToolConnectionCapability[] = ['ontology_lookup', 'data_query', 'document_search', 'web_search']

export interface ToolAssignmentServiceDependencies {
  readonly assignments: ToolAssignmentStore
  readonly connections: ToolConnectionStore
  readonly targets: ToolTargetDirectory
  readonly now?: () => string
}

export interface ToolAssignmentWrite {
  readonly scope: ToolTargetScope
  readonly defaultSelection: ToolConnectionSelection
  readonly toolSelections: readonly ToolConnectionSelectionEntry[]
  readonly expectedRevision?: string
}

function scopeKey(scope: ToolTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return 'space'
    case 'industry_workspace':
      return `industry_workspace:${scope.workspaceId}`
    case 'project':
      return `project:${scope.projectId}`
  }
}

/**
 * Assignment service (design §9).
 *
 * One assignment set exists per target scope. Assignment is **per tool**: a `web_search` selection
 * names the connection that tool resolves, never a single connection applied blindly to every
 * capability. A reference is only accepted when that connection exists, is enabled and actually
 * declares the tool's capability, so a connection can never widen a tool's domain or budget. The
 * space default and per-tool map are administrator-only; an object override may be set by a
 * `profile-editor`. Using a connection is never authorization to widen an allowlist.
 */
export class ToolAssignmentService {
  readonly #assignments: ToolAssignmentStore
  readonly #connections: ToolConnectionStore
  readonly #targets: ToolTargetDirectory
  readonly #now: () => string

  constructor(dependencies: ToolAssignmentServiceDependencies) {
    this.#assignments = dependencies.assignments
    this.#connections = dependencies.connections
    this.#targets = dependencies.targets
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async get(scope: ToolTargetScope, ctx: ToolContext): Promise<ToolAssignmentSet | undefined> {
    assertToolTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(scope)
    await this.#targets.assertTargetInScope(scopeRef, scope, ctx)
    return this.#assignments.getAssignmentSet(scopeRef, scope, ctx)
  }

  /** Validate a proposed write (role, target ownership, capabilities) without persisting it. */
  async validate(input: ToolAssignmentWrite, ctx: ToolContext): Promise<void> {
    if (input.scope.kind === 'space') assertToolAdministrator(ctx)
    else assertToolTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(input.scope)
    await this.#targets.assertTargetInScope(scopeRef, input.scope, ctx)
    await this.#assertSelections(scopeRef, input.defaultSelection, input.toolSelections, ctx)
  }

  async put(input: ToolAssignmentWrite, ctx: ToolContext): Promise<ToolAssignmentSet> {
    if (input.scope.kind === 'space') assertToolAdministrator(ctx)
    else assertToolTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(input.scope)
    await this.#targets.assertTargetInScope(scopeRef, input.scope, ctx)
    await this.#assertSelections(scopeRef, input.defaultSelection, input.toolSelections, ctx)

    const current = await this.#assignments.getAssignmentSet(scopeRef, input.scope, ctx)
    let revision: string
    if (current === undefined) {
      if (input.expectedRevision !== undefined) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'no assignment set exists yet for this scope')
      }
      revision = '1'
    } else {
      if (input.expectedRevision === undefined) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'updating an assignment set requires its current revision')
      }
      if (input.expectedRevision !== current.revision) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'the assignment set moved since it was read; re-read before writing')
      }
      revision = String(BigInt(current.revision) + 1n)
    }

    const set: ToolAssignmentSet = {
      schemaVersion: 'tool-assignment-set@1',
      scope: input.scope,
      defaultSelection: input.defaultSelection,
      toolSelections: input.toolSelections,
      revision,
      updatedAt: this.#now(),
    }
    assertToolAssignmentSetShape(set)
    return this.#assignments.putAssignmentSet(scopeRef, {
      set,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    }, ctx)
  }

  #assertTargetShape(scope: ToolTargetScope): void {
    if (scope.kind === 'industry_workspace' && !isUuid(scope.workspaceId)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'workspaceId must be a UUID')
    }
    if (scope.kind === 'project' && !isUuid(scope.projectId)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'projectId must be a UUID')
    }
  }

  async #assertSelections(
    scopeRef: ScopeRef,
    defaultSelection: ToolConnectionSelection,
    toolSelections: readonly ToolConnectionSelectionEntry[],
    ctx: ToolContext,
  ): Promise<void> {
    const seen = new Set<ToolConnectionCapability>()
    for (const entry of toolSelections) {
      if (!TOOLS.includes(entry.toolId)) {
        throw new ToolConnectionError('INVALID_ARGUMENT', `unknown tool ${String(entry.toolId)}`)
      }
      if (seen.has(entry.toolId)) {
        throw new ToolConnectionError('INVALID_ARGUMENT', 'tool selections must be distinct')
      }
      seen.add(entry.toolId)
      if (entry.selection.kind === 'connection') {
        await this.#assertConnectionUsable(scopeRef, entry.selection.connectionId, entry.toolId, ctx)
      }
    }
    if (defaultSelection.kind === 'connection') {
      // A default governs tools without a specific selection; it must still be a usable connection
      // but is not pinned to one tool, so only existence/enabled/declared-capability are checked.
      await this.#assertConnectionUsable(scopeRef, defaultSelection.connectionId, undefined, ctx)
    }
  }

  async #assertConnectionUsable(
    scopeRef: ScopeRef,
    connectionId: string,
    toolId: ToolConnectionCapability | undefined,
    ctx: ToolContext,
  ): Promise<void> {
    const connection = await this.#connections.getConnection(scopeRef, connectionId, ctx)
    if (connection === undefined) {
      throw new ToolConnectionError('NOT_FOUND', `connection ${connectionId} is not visible in this scope`)
    }
    if (!connection.enabled) {
      throw new ToolConnectionError('TOOL_DISABLED', `connection ${connectionId} is disabled`)
    }
    if (toolId !== undefined) {
      if (!toolAdapterSupportsCapability(connection.adapterType, toolId) || !connection.capabilities.includes(toolId)) {
        throw new ToolConnectionError(
          'TOOL_CAPABILITY_MISMATCH',
          `connection ${connectionId} cannot serve the ${toolId} tool`,
        )
      }
    }
    for (const capability of connection.capabilities) {
      if (!toolAdapterSupportsCapability(connection.adapterType, capability)) {
        throw new ToolConnectionError(
          'TOOL_CAPABILITY_MISMATCH',
          `connection ${connectionId} declares a capability its adapter cannot serve`,
        )
      }
    }
  }
}

/** Stable textual key for a target scope, used by views and diagnostics. */
export { scopeKey }
