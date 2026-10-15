import {
  ModelSelectionError,
  MODEL_CAPABILITIES,
  assertModelAssignmentSetShape,
  isUuid,
  modelAdapterSupportsCapability,
} from '@ontology/contracts'
import type {
  ModelAssignmentSet,
  ModelAssignmentStore,
  ModelCapability,
  ModelCapabilitySelection,
  ModelConnectionSelection,
  ModelConnectionStore,
  ModelTargetDirectory,
  ModelTargetScope,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { assertModelAdministrator, assertTargetEditor, scopeOf } from './guards'

export interface ModelAssignmentServiceDependencies {
  readonly assignments: ModelAssignmentStore
  readonly connections: ModelConnectionStore
  readonly targets: ModelTargetDirectory
  readonly now?: () => string
}

export interface ModelAssignmentWrite {
  readonly scope: ModelTargetScope
  readonly defaultSelection: ModelConnectionSelection
  readonly capabilitySelections: readonly ModelCapabilitySelection[]
  readonly expectedRevision?: string
}

function scopeKey(scope: ModelTargetScope): string {
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
 * Assignment service (design §5.3, A-R10).
 *
 * One assignment set exists per target scope. A reference to a connection is only accepted when
 * that connection exists, is enabled and its adapter family actually serves the capability
 * (`modelAdapterSupportsCapability`), so a generation adapter can never be assigned to JEV and a
 * user cannot widen an adapter's declared capabilities. The space-scope default and capability
 * map are administrator-only; an object override may be set by a `profile-editor`.
 */
export class ModelAssignmentService {
  readonly #assignments: ModelAssignmentStore
  readonly #connections: ModelConnectionStore
  readonly #targets: ModelTargetDirectory
  readonly #now: () => string

  constructor(dependencies: ModelAssignmentServiceDependencies) {
    this.#assignments = dependencies.assignments
    this.#connections = dependencies.connections
    this.#targets = dependencies.targets
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async get(scope: ModelTargetScope, ctx: ToolContext): Promise<ModelAssignmentSet | undefined> {
    assertTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(scope)
    await this.#targets.assertTargetInScope(scopeRef, scope, ctx)
    return this.#assignments.getAssignmentSet(scopeRef, scope, ctx)
  }

  /** Validate a proposed write (role, target ownership, capabilities) without persisting it. */
  async validate(input: ModelAssignmentWrite, ctx: ToolContext): Promise<void> {
    if (input.scope.kind === 'space') assertModelAdministrator(ctx)
    else assertTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(input.scope)
    await this.#targets.assertTargetInScope(scopeRef, input.scope, ctx)
    await this.#assertSelections(scopeRef, input.defaultSelection, input.capabilitySelections, ctx)
  }

  async put(input: ModelAssignmentWrite, ctx: ToolContext): Promise<ModelAssignmentSet> {
    if (input.scope.kind === 'space') assertModelAdministrator(ctx)
    else assertTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    this.#assertTargetShape(input.scope)
    await this.#targets.assertTargetInScope(scopeRef, input.scope, ctx)
    await this.#assertSelections(scopeRef, input.defaultSelection, input.capabilitySelections, ctx)

    const current = await this.#assignments.getAssignmentSet(scopeRef, input.scope, ctx)
    let revision: string
    if (current === undefined) {
      if (input.expectedRevision !== undefined) {
        throw new ModelSelectionError('VERSION_CONFLICT', 'no assignment set exists yet for this scope')
      }
      revision = '1'
    } else {
      if (input.expectedRevision === undefined) {
        throw new ModelSelectionError('VERSION_CONFLICT', 'updating an assignment set requires its current revision')
      }
      if (input.expectedRevision !== current.revision) {
        throw new ModelSelectionError('VERSION_CONFLICT', 'the assignment set moved since it was read; re-read before writing')
      }
      revision = String(BigInt(current.revision) + 1n)
    }

    const set: ModelAssignmentSet = {
      schemaVersion: 'model-assignment-set@1',
      scope: input.scope,
      defaultSelection: input.defaultSelection,
      capabilitySelections: input.capabilitySelections,
      revision,
      updatedAt: this.#now(),
    }
    assertModelAssignmentSetShape(set)
    return this.#assignments.putAssignmentSet(scopeRef, {
      set,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    }, ctx)
  }

  #assertTargetShape(scope: ModelTargetScope): void {
    if (scope.kind === 'industry_workspace' && !isUuid(scope.workspaceId)) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'workspaceId must be a UUID')
    }
    if (scope.kind === 'project' && !isUuid(scope.projectId)) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'projectId must be a UUID')
    }
  }

  async #assertSelections(
    scopeRef: ScopeRef,
    defaultSelection: ModelConnectionSelection,
    capabilitySelections: readonly ModelCapabilitySelection[],
    ctx: ToolContext,
  ): Promise<void> {
    const seen = new Set<ModelCapability>()
    for (const entry of capabilitySelections) {
      if (!MODEL_CAPABILITIES.includes(entry.capability)) {
        throw new ModelSelectionError('INVALID_ARGUMENT', `unknown model capability ${String(entry.capability)}`)
      }
      if (seen.has(entry.capability)) {
        throw new ModelSelectionError('INVALID_ARGUMENT', 'capability selections must be distinct')
      }
      seen.add(entry.capability)
      if (entry.selection.kind === 'connection') {
        await this.#assertConnectionUsable(scopeRef, entry.selection.connectionId, entry.capability, ctx)
      }
    }
    if (defaultSelection.kind === 'connection') {
      // A default selection governs the generative capabilities; a JEV-only adapter may not be one.
      await this.#assertConnectionUsable(scopeRef, defaultSelection.connectionId, 'generation', ctx)
    }
  }

  async #assertConnectionUsable(
    scopeRef: ScopeRef,
    connectionId: string,
    capability: ModelCapability,
    ctx: ToolContext,
  ): Promise<void> {
    const connection = await this.#connections.getConnection(scopeRef, connectionId, ctx)
    if (connection === undefined) {
      throw new ModelSelectionError('NOT_FOUND', `connection ${connectionId} is not visible in this scope`)
    }
    if (!connection.enabled) {
      throw new ModelSelectionError('MODEL_DISABLED', `connection ${connectionId} is disabled`)
    }
    if (!modelAdapterSupportsCapability(connection.adapterType, capability)) {
      throw new ModelSelectionError(
        'MODEL_CAPABILITY_MISMATCH',
        `connection ${connectionId} cannot serve the ${capability} capability`,
      )
    }
    if (!connection.capabilities.includes(capability)) {
      throw new ModelSelectionError(
        'MODEL_CAPABILITY_MISMATCH',
        `connection ${connectionId} does not declare the ${capability} capability`,
      )
    }
  }
}

/** Stable textual key for a target scope, used by views and diagnostics. */
export { scopeKey }
