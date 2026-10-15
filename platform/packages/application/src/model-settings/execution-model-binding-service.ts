import { ModelSelectionError, assertExecutionModelBindingShape } from '@ontology/contracts'
import type {
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelCapability,
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
  readonly #now: () => string

  constructor(dependencies: ExecutionModelBindingServiceDependencies) {
    this.#bindings = dependencies.bindings
    this.#resolver = dependencies.resolver
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
