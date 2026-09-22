import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type {
  ComputeOperationHandler,
  OperationRegistry,
  ScopeRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  ToolContext,
} from '@ontology/contracts'
import {
  ENERGY_OPERATION_REGISTRY,
  createEnergyComputeHandlers,
  encodeSimulationJobRequest,
} from '@ontology/extension-home-energy'
import type { SimulationJobPort } from '@ontology/extension-home-energy'
import type { JobService } from '@ontology/application'
import { ToolGatewayError } from '@ontology/tool-services'
import type { DataQueryComputeConfig, ToolSchemaValidator } from '@ontology/tool-services'
import { createBlobArtifactWriter } from './tool-gateway'

/**
 * Composition root for the home-energy compute operations (ADR-11, C3/C4).
 *
 * This is the only place the generic `data_query` handler is wired to the industry extension:
 * `packages/tool-services` never imports `@ontology/extension-home-energy`. The registry, the
 * registered handlers, the immutable artifact writer and the scoped reader are all injected
 * here. The scoped reader reads only the approved input refs through the tenant/space-scoped
 * blob store — never a filesystem or database credential.
 */

export interface EnergyComputeCompositionOptions {
  readonly blobStore: LocalImmutableBlobStore
  /** The canonical schema validator, injected exactly as the gateway receives it. */
  readonly validator: ToolSchemaValidator
  /** Overridable only for tests; defaults to the declarative manifest registry. */
  readonly operations?: OperationRegistry
  /** Overridable only for tests; defaults to the real registered handlers. */
  readonly handlers?: readonly ComputeOperationHandler[]
}

/** A read-only reader over the approved immutable artifacts, scoped to the trusted context. */
export function createScopedBlobReader(blobStore: LocalImmutableBlobStore): ScopedArtifactReader {
  return {
    async read(request: ScopedArtifactReaderRequest, ctx: ToolContext): Promise<Uint8Array> {
      const ref = request.approvedInputRefs[0]
      if (ref === undefined) {
        throw new ToolGatewayError(
          'INVALID_ARGUMENTS',
          'a scoped artifact read requires an approved input reference',
        )
      }
      const scopeRef: ScopeRef = {
        tenantId: ctx.principal.tenantId,
        spaceId: ctx.allowedResources.spaceId,
      }
      return blobStore.readAuthorized({ scopeRef, blobRef: ref }, ctx)
    },
  }
}

export function createEnergyComputeConfig(
  options: EnergyComputeCompositionOptions,
): DataQueryComputeConfig {
  return {
    registry: options.operations ?? ENERGY_OPERATION_REGISTRY,
    handlers: options.handlers ?? createEnergyComputeHandlers(),
    artifacts: createBlobArtifactWriter(options.blobStore),
    reader: createScopedBlobReader(options.blobStore),
    validator: options.validator,
  }
}

/**
 * Adapt the durable job service into the energy simulation job port. The bounded simulation
 * request is encoded into the job's opaque `datasetRef`; the worker decodes it and reads the
 * approved input through its scoped reader.
 */
export function createSimulationJobPort(jobService: JobService): SimulationJobPort {
  return {
    async enqueue(input, ctx) {
      const result = await jobService.createJob(
        {
          jobId: input.jobId,
          kind: 'simulation',
          sourceRef: 'home-energy.simulation',
          datasetRef: encodeSimulationJobRequest({
            kind: 'home-energy.simulation-job',
            version: '1.0.0',
            mode: 'simulation',
            runId: input.runId,
            operationRef: input.operationRef,
            planRef: input.planRef,
            inputRefs: input.inputRefs,
          }),
          pipelineVersion: '1.0.0',
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
      )
      return { jobId: result.jobId, reused: result.reused }
    },
  }
}
