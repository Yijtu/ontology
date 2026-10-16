import { ModelSelectionError, assertExecutionModelBindingShape, modelAdapterSupportsCapability } from '@ontology/contracts'
import type {
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelCapability,
  ModelConnectionStore,
  ModelExecutionSnapshotStore,
  ModelSelectionResolver,
  ModelTargetScope,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../extraction/canonical'
import { assertTargetEditor, scopeOf } from './guards'
import { modelExecutionSnapshotOf } from './model-connection-service'

export interface ExecutionModelBindingServiceDependencies {
  readonly bindings: ExecutionModelBindingStore
  readonly resolver: ModelSelectionResolver
  /**
   * The pinned connection catalogue, consulted only to enforce the revocation fence. It is
   * optional so a host that does not mount the catalogue keeps the N15 bind/read-back behaviour.
   */
  readonly connections?: ModelConnectionStore
  /**
   * The immutable execution-config snapshot store (S02). When mounted, `bind` captures the pinned
   * revision's non-secret config and records a `snapshotRef`, so the runtime reads that snapshot
   * instead of today's catalogue row. Requires `connections` so the snapshot can be captured.
   */
  readonly snapshots?: ModelExecutionSnapshotStore
  readonly now?: () => string
}

/**
 * Bind a resolved selection to one execution and read it back unchanged (design §5.3).
 *
 * The binding pins the connection id, its revision, the assignment revision and a model/component
 * ref. It never contains a credential. A retry/resume/parallel run must read the stored binding
 * back rather than re-resolve, so a later default change cannot retarget an in-flight task.
 */
export class ExecutionModelBindingService {
  readonly #bindings: ExecutionModelBindingStore
  readonly #resolver: ModelSelectionResolver
  readonly #connections: ModelConnectionStore | undefined
  readonly #snapshots: ModelExecutionSnapshotStore | undefined
  readonly #now: () => string

  constructor(dependencies: ExecutionModelBindingServiceDependencies) {
    this.#bindings = dependencies.bindings
    this.#resolver = dependencies.resolver
    this.#connections = dependencies.connections
    this.#snapshots = dependencies.snapshots
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async bind(
    input: { readonly executionId: Uuid; readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    ctx: ToolContext,
  ): Promise<ExecutionModelBinding> {
    assertTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    const effective = await this.#resolver.resolve(scopeRef, { scope: input.scope, capability: input.capability }, ctx)
    if (effective.state !== 'available' || effective.connectionId === undefined) {
      throw new ModelSelectionError(
        effective.blockedReason ?? 'MODEL_NOT_CONFIGURED',
        `no usable ${input.capability} model is configured for this target`,
      )
    }
    const connectionRevision = effective.connectionSummary?.revision
    if (connectionRevision === undefined) {
      throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'the resolved connection has no revision to pin')
    }
    const snapshotRef = await this.#captureSnapshot(scopeRef, effective.connectionId, connectionRevision, ctx)
    const binding: ExecutionModelBinding = {
      schemaVersion: 'execution-model-binding@1',
      executionId: input.executionId,
      capability: input.capability,
      connectionId: effective.connectionId,
      connectionRevision,
      modelRef: { modelId: effective.connectionId, version: connectionRevision },
      componentRef: {
        id: `model-connection:${effective.connectionId}`,
        version: `${connectionRevision}.0.0`,
        digest: sha256DigestOf(canonicalJson({ connectionId: effective.connectionId, revision: connectionRevision })),
      },
      ...(snapshotRef === undefined ? {} : { snapshotRef }),
      assignmentRevision: effective.assignmentRevision ?? '0',
      resolvedFrom: effective.resolvedFrom,
      boundAt: this.#now(),
    }
    assertExecutionModelBindingShape(binding)
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
      throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'a snapshot store requires the connection catalogue to capture the pinned revision')
    }
    const connection = await connections.getConnection(scopeRef, connectionId, ctx)
    if (connection === undefined) {
      throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'the resolved connection is no longer visible in this scope')
    }
    if (connection.revision !== connectionRevision) {
      throw new ModelSelectionError('VERSION_CONFLICT', 'the connection moved while the binding was being fixed; re-resolve')
    }
    const stored = await snapshots.putModelSnapshot(scopeRef, modelExecutionSnapshotOf(connection), ctx)
    return {
      id: `model-connection-snapshot:${connection.connectionId}`,
      version: `${connection.revision}.0.0`,
      digest: sha256DigestOf(canonicalJson(stored)),
    }
  }

  /**
   * Fix the binding for an execution exactly once. A retry, resume or parallel attempt reads the
   * stored binding back untouched instead of re-resolving (design §5.3), so a later default,
   * assignment or connection change can never retarget an in-flight execution.
   */
  async ensureBinding(
    input: { readonly executionId: Uuid; readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    ctx: ToolContext,
  ): Promise<ExecutionModelBinding> {
    const existing = await this.readBack(input.executionId, input.capability, ctx)
    if (existing !== undefined) return existing
    return this.bind(input, ctx)
  }

  /**
   * The revocation fence (design §5.3/§5.5). A binding names an exact connection revision, so a
   * connection that was later disabled, cleared of its credential or stripped of the capability
   * must block every further call rather than fall through to another vendor. A missing binding is
   * an explicit `MODEL_NOT_CONFIGURED`; an unusable pinned connection is `MODEL_BINDING_REVOKED`.
   * When the host does not mount the catalogue the fence cannot be evaluated and is a no-op.
   */
  async assertUsable(executionId: Uuid, capability: ModelCapability, ctx: ToolContext): Promise<ExecutionModelBinding> {
    const binding = await this.readBack(executionId, capability, ctx)
    if (binding === undefined) {
      throw new ModelSelectionError('MODEL_NOT_CONFIGURED', `execution ${executionId} has no fixed ${capability} model binding`)
    }
    const connections = this.#connections
    if (connections === undefined || binding.connectionId === undefined) return binding
    const scopeRef = scopeOf(ctx)
    const connection = await connections.getConnection(scopeRef, binding.connectionId, ctx)
    if (
      connection === undefined ||
      !connection.enabled ||
      connection.credentialState !== 'present' ||
      !modelAdapterSupportsCapability(connection.adapterType, capability) ||
      !connection.capabilities.includes(capability)
    ) {
      throw new ModelSelectionError(
        'MODEL_BINDING_REVOKED',
        `the ${capability} model this execution pinned is no longer usable`,
      )
    }
    return binding
  }

  /**
   * Whether a fixed binding is still usable, without throwing. Used by the runtime capability
   * factory, which must fail closed (disable the port) rather than fall back to another model.
   */
  async isUsable(executionId: Uuid, capability: ModelCapability, ctx: ToolContext): Promise<boolean> {
    try {
      await this.assertUsable(executionId, capability, ctx)
      return true
    } catch (error) {
      if (error instanceof ModelSelectionError && (error.code === 'MODEL_BINDING_REVOKED' || error.code === 'MODEL_NOT_CONFIGURED')) return false
      throw error
    }
  }

  async readBack(
    executionId: Uuid,
    capability: ModelCapability,
    ctx: ToolContext,
  ): Promise<ExecutionModelBinding | undefined> {
    assertTargetEditor(ctx)
    const scopeRef = scopeOf(ctx)
    const binding = await this.#bindings.getBinding(scopeRef, executionId, capability, ctx)
    if (binding !== undefined) assertExecutionModelBindingShape(binding)
    return binding
  }
}
