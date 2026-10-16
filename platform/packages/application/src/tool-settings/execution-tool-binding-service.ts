import {
  ToolConnectionError,
  assertExecutionToolBindingShape,
} from '@ontology/contracts'
import type {
  ExecutionToolBinding,
  ExecutionToolBindingStore,
  ToolConnectionCapability,
  ToolConnectionStore,
  ToolExecutionSnapshotStore,
  ToolSelectionResolver,
  ToolTargetScope,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../extraction/canonical'
import { assertToolTargetEditor, scopeOf } from './guards'
import { toolAdapterRequiresCredential, toolAdapterSupportsCapability } from './tool-adapter-capabilities'
import { toolExecutionSnapshotOf } from './tool-connection-service'

export interface ExecutionToolBindingServiceDependencies {
  readonly bindings: ExecutionToolBindingStore
  readonly resolver: ToolSelectionResolver
  /**
   * The pinned connection catalogue, consulted only to enforce the revocation fence. Optional so a
   * host that does not mount the catalogue keeps the bind/read-back behaviour.
   */
  readonly connections?: ToolConnectionStore
  /**
   * The immutable execution-config snapshot store (S02). When mounted, `bind` captures the pinned
   * revision's non-secret config and records a `snapshotRef`, so the runtime reads that snapshot
   * instead of today's catalogue row. Requires `connections` so the snapshot can be captured.
   */
  readonly snapshots?: ToolExecutionSnapshotStore
  readonly now?: () => string
}

/**
 * Bind a resolved tool selection to one execution and read it back unchanged (design §9).
 *
 * The binding pins the connection id, its revision, the assignment revision and a version ref. It
 * never contains a credential. A retry/resume/parallel run must read the stored binding back rather
 * than re-resolve, so a later default change cannot retarget an in-flight task.
 */
export class ExecutionToolBindingService {
  readonly #bindings: ExecutionToolBindingStore
  readonly #resolver: ToolSelectionResolver
  readonly #connections: ToolConnectionStore | undefined
  readonly #snapshots: ToolExecutionSnapshotStore | undefined
  readonly #now: () => string

  constructor(dependencies: ExecutionToolBindingServiceDependencies) {
    this.#bindings = dependencies.bindings
    this.#resolver = dependencies.resolver
    this.#connections = dependencies.connections
    this.#snapshots = dependencies.snapshots
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async bind(
    input: { readonly executionId: Uuid; readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    ctx: ToolContext,
  ): Promise<ExecutionToolBinding> {
    assertToolTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    const effective = await this.#resolver.resolve(scopeRef, { scope: input.scope, toolId: input.toolId }, ctx)
    if (effective.state !== 'available' || effective.connectionId === undefined) {
      throw new ToolConnectionError(
        effective.blockedReason ?? 'TOOL_NOT_CONFIGURED',
        `no usable ${input.toolId} tool is configured for this target`,
      )
    }
    const connectionRevision = effective.connectionSummary?.revision
    if (connectionRevision === undefined) {
      throw new ToolConnectionError('TOOL_NOT_CONFIGURED', 'the resolved connection has no revision to pin')
    }
    const snapshotRef = await this.#captureSnapshot(scopeRef, effective.connectionId, connectionRevision, ctx)
    const binding: ExecutionToolBinding = {
      schemaVersion: 'execution-tool-binding@1',
      executionId: input.executionId,
      toolId: input.toolId,
      connectionId: effective.connectionId,
      connectionRevision,
      connectionRef: {
        id: `tool-connection:${effective.connectionId}`,
        version: `${connectionRevision}.0.0`,
        digest: sha256DigestOf(canonicalJson({ connectionId: effective.connectionId, revision: connectionRevision })),
      },
      ...(snapshotRef === undefined ? {} : { snapshotRef }),
      assignmentRevision: effective.assignmentRevision ?? '0',
      resolvedFrom: effective.resolvedFrom,
      boundAt: this.#now(),
    }
    assertExecutionToolBindingShape(binding)
    return this.#bindings.putBinding(scopeRef, binding, ctx)
  }

  /**
   * Capture the pinned revision's immutable, non-secret config snapshot and return its ref (S02).
   * When no snapshot store is mounted the binding keeps the legacy revision-only shape. The catalogue
   * is read here only to copy the config; a revision that moved between resolve and read is refused
   * rather than silently pinned to the newer config.
   */
  async #captureSnapshot(
    scopeRef: ReturnType<typeof scopeOf>,
    connectionId: Uuid,
    connectionRevision: string,
    ctx: ToolContext,
  ): Promise<VersionRef | undefined> {
    const snapshots = this.#snapshots
    if (snapshots === undefined) return undefined
    const connections = this.#connections
    if (connections === undefined) {
      throw new ToolConnectionError('TOOL_NOT_CONFIGURED', 'a snapshot store requires the connection catalogue to capture the pinned revision')
    }
    const connection = await connections.getConnection(scopeRef, connectionId, ctx)
    if (connection === undefined) {
      throw new ToolConnectionError('TOOL_NOT_CONFIGURED', 'the resolved connection is no longer visible in this scope')
    }
    if (connection.revision !== connectionRevision) {
      throw new ToolConnectionError('VERSION_CONFLICT', 'the connection moved while the binding was being fixed; re-resolve')
    }
    const stored = await snapshots.putToolSnapshot(scopeRef, toolExecutionSnapshotOf(connection), ctx)
    return {
      id: `tool-connection-snapshot:${connection.connectionId}`,
      version: `${connection.revision}.0.0`,
      digest: sha256DigestOf(canonicalJson(stored)),
    }
  }

  /**
   * Fix the binding for an execution exactly once. A retry, resume or parallel attempt reads the
   * stored binding back untouched instead of re-resolving (design §9), so a later default,
   * assignment or connection change can never retarget an in-flight execution.
   */
  async ensureBinding(
    input: { readonly executionId: Uuid; readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    ctx: ToolContext,
  ): Promise<ExecutionToolBinding> {
    const existing = await this.readBack(input.executionId, input.toolId, ctx)
    if (existing !== undefined) return existing
    return this.bind(input, ctx)
  }

  /**
   * The revocation fence (design §9). A binding names an exact connection revision, so a connection
   * that was later disabled, cleared of its credential or stripped of the capability must block
   * every further call rather than fall through to another connection. A missing binding is an
   * explicit `TOOL_NOT_CONFIGURED`; an unusable pinned connection is `TOOL_BINDING_REVOKED`.
   */
  async assertUsable(executionId: Uuid, toolId: ToolConnectionCapability, ctx: ToolContext): Promise<ExecutionToolBinding> {
    const binding = await this.readBack(executionId, toolId, ctx)
    if (binding === undefined) {
      throw new ToolConnectionError('TOOL_NOT_CONFIGURED', `execution ${executionId} has no fixed ${toolId} tool binding`)
    }
    const connections = this.#connections
    if (connections === undefined || binding.connectionId === undefined) return binding
    const scopeRef = scopeOf(ctx)
    const connection = await connections.getConnection(scopeRef, binding.connectionId, ctx)
    if (
      connection === undefined ||
      !connection.enabled ||
      (toolAdapterRequiresCredential(connection.adapterType) && connection.credentialState !== 'present') ||
      !toolAdapterSupportsCapability(connection.adapterType, toolId) ||
      !connection.capabilities.includes(toolId)
    ) {
      throw new ToolConnectionError(
        'TOOL_BINDING_REVOKED',
        `the ${toolId} tool this execution pinned is no longer usable`,
      )
    }
    return binding
  }

  /**
   * Whether a fixed binding is still usable, without throwing. Used by the runtime capability
   * factory, which must fail closed (disable the port) rather than fall back to another connection.
   */
  async isUsable(executionId: Uuid, toolId: ToolConnectionCapability, ctx: ToolContext): Promise<boolean> {
    try {
      await this.assertUsable(executionId, toolId, ctx)
      return true
    } catch (error) {
      if (error instanceof ToolConnectionError && (error.code === 'TOOL_BINDING_REVOKED' || error.code === 'TOOL_NOT_CONFIGURED')) return false
      throw error
    }
  }

  async readBack(
    executionId: Uuid,
    toolId: ToolConnectionCapability,
    ctx: ToolContext,
  ): Promise<ExecutionToolBinding | undefined> {
    assertToolTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    const binding = await this.#bindings.getBinding(scopeRef, executionId, toolId, ctx)
    if (binding !== undefined) assertExecutionToolBindingShape(binding)
    return binding
  }
}
