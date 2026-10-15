import { ModelSelectionError, assertExecutionModelBindingShape, modelAdapterSupportsCapability } from '@ontology/contracts'
import type {
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelCapability,
  ModelConnectionStore,
  ModelSelectionResolver,
  ModelTargetScope,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../extraction/canonical'
import { assertTargetEditor, scopeOf } from './guards'

export interface ExecutionModelBindingServiceDependencies {
  readonly bindings: ExecutionModelBindingStore
  readonly resolver: ModelSelectionResolver
  /**
   * The pinned connection catalogue, consulted only to enforce the revocation fence. It is
   * optional so a host that does not mount the catalogue keeps the N15 bind/read-back behaviour.
   */
  readonly connections?: ModelConnectionStore
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
  readonly #now: () => string

  constructor(dependencies: ExecutionModelBindingServiceDependencies) {
    this.#bindings = dependencies.bindings
    this.#resolver = dependencies.resolver
    this.#connections = dependencies.connections
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
      assignmentRevision: effective.assignmentRevision ?? '0',
      resolvedFrom: effective.resolvedFrom,
      boundAt: this.#now(),
    }
    assertExecutionModelBindingShape(binding)
    return this.#bindings.putBinding(scopeRef, binding, ctx)
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
