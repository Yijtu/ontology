import { isToolContext } from '@ontology/contracts'
import type {
  RunStore,
  RuntimeCheckpointPort,
  RuntimeCheckpointRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { WorkflowControllerError } from './errors'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Adapt the runtime-private checkpoint port onto the existing run store. The runtime writes
 * its private blob through this port and the controller's `checkpoint_ready` handling reads
 * the same record, so a checkpoint is stored exactly once and never in a second store.
 */
export function createRunCheckpointPort(store: RunStore): RuntimeCheckpointPort {
  return {
    async save(
      runId: string,
      ref: RuntimeCheckpointRef,
      payload: Uint8Array,
      ctx: ToolContext,
    ): Promise<RuntimeCheckpointRef> {
      return store.saveCheckpoint(
        scopeOf(ctx),
        runId,
        {
          checkpointId: ref.checkpointId,
          runtimeKind: ref.runtimeKind,
          runtimeVersion: ref.runtimeVersion,
          stateDigest: ref.stateDigest,
          payload,
          createdAt: ref.createdAt,
        },
        ctx,
      )
    },
    async load(runId: string, ref: RuntimeCheckpointRef, ctx: ToolContext): Promise<Uint8Array> {
      const record = await store.loadCheckpoint(scopeOf(ctx), runId, ref.checkpointId, ctx)
      if (record === undefined) {
        throw new WorkflowControllerError(
          'CHECKPOINT_INCOMPATIBLE',
          `checkpoint ${ref.checkpointId} for run ${runId} was not found`,
        )
      }
      return record.payload
    },
  }
}
