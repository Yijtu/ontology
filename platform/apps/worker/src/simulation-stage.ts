import type { JobStageContext, JobStageHandler, JobStageHandlerRegistry, JobStageOutcome } from '@ontology/application'
import { JobStageFailure, decodeResearchJobRequest, isAgentResearchJobRequest, nextPipelineStage } from '@ontology/application'
import type {
  ComputeOperationHandler,
  ImmutableArtifactWriter,
  LogicalJobRecord,
  OperationRegistry,
  ScopeRef,
  ScopedArtifactReader,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { findRegisteredOperation, isToolContext } from '@ontology/contracts'
import {
  decodeSimulationJobRequest,
} from '@ontology/extension-home-energy'
import {
  canonicalJson as canonicalJsonOf,
  computeRequestOf,
  createScopedArtifactReader,
  resolveComputeHandler,
  runComputeWithBudget,
} from '@ontology/tool-services'

/**
 * The simulation execution job (SPEC E7, C6; ADR-12).
 *
 * The durable job carries a bounded, content-addressed input reference. The handler reads it
 * only through a scoped artifact reader, runs the registered compute operation and archives
 * the typed result. It holds no device port and makes no network call, so it can never send a
 * device request; every result is a simulation result.
 *
 * The durable pipeline is generic, so a simulation job walks the runnable stages with an
 * idempotent checkpoint: the computation runs exactly once (the first runnable stage) and the
 * remaining stages are no-op checkpoints, so an at-least-once retry never recomputes.
 */

export const SIMULATION_RESULT_MEDIA_TYPE =
  'application/vnd.ontology.energy-simulation-result+json'

export interface SimulationRunGuard {
  /**
   * Quarantine a simulation result when its run has already been cancelled. Returns true when
   * the run was terminal/cancelling and the result was recorded as abandoned, so a late job
   * can never revive or publish a cancelled run.
   */
  quarantineIfCancelled(
    runId: Uuid,
    input: { readonly attemptId: Uuid; readonly reason: string },
    ctx: ToolContext,
  ): Promise<boolean>
}

export interface SimulationStageDependencies {
  readonly reader: ScopedArtifactReader
  readonly artifacts: ImmutableArtifactWriter
  readonly operations: OperationRegistry
  readonly handlers: readonly ComputeOperationHandler[]
  readonly runGuard?: SimulationRunGuard
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new JobStageFailure('INTERNAL_ERROR', 'a host-minted trusted tool context is required', false)
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

export class SimulationStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #deps: SimulationStageDependencies

  constructor(dependencies: SimulationStageDependencies) {
    this.#deps = dependencies
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const job = context.job
    if (job.kind !== 'simulation') {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the simulation handler only serves simulation jobs', false)
    }
    // Idempotent checkpoint: once the result is archived, later runnable stages only advance.
    if (job.documentRef !== undefined) {
      const next = nextPipelineStage(job.stage)
      return next === undefined
        ? { nextStage: job.stage, counts: job.counts }
        : { nextStage: next, counts: job.counts }
    }
    const datasetRef = job.datasetRef
    if (datasetRef === undefined) {
      throw new JobStageFailure('INVALID_ARGUMENT', 'a simulation job requires a datasetRef', false)
    }
    const request = decodeSimulationJobRequest(datasetRef)
    const operation = findRegisteredOperation(this.#deps.operations, request.operationRef)
    if (operation === undefined) {
      throw new JobStageFailure(
        'CAPABILITY_NOT_CONFIGURED',
        `operation ${request.operationRef.id}@${request.operationRef.version} is not registered`,
        false,
      )
    }
    const handler = resolveComputeHandler(this.#deps.handlers, request.operationRef)
    if (handler === undefined) {
      throw new JobStageFailure(
        'CAPABILITY_NOT_CONFIGURED',
        `no handler is registered for operation ${request.operationRef.id}@${request.operationRef.version}`,
        false,
      )
    }
    const readInput = createScopedArtifactReader(this.#deps.reader, request.inputRefs)
    const outcome = await runComputeWithBudget(
      ({ signal }) =>
        handler.execute(
          computeRequestOf({
            operationRef: request.operationRef,
            parameters: {},
            inputRefs: request.inputRefs,
            readInput,
            artifacts: this.#deps.artifacts,
            limits: operation.limits,
            deadline: context.ctx.deadline,
            ctx: context.ctx,
            signal,
          }),
        ),
      operation.limits.maxDurationMs,
      context.ctx.deadline,
      context.signal,
    )
    const stored = await this.#deps.artifacts.putBytes(
      {
        scopeRef: scopeOf(context.ctx),
        content: new TextEncoder().encode(canonicalJsonOf(outcome.payload)),
        mediaType: SIMULATION_RESULT_MEDIA_TYPE,
      },
      context.ctx,
    )
    const quarantined =
      this.#deps.runGuard === undefined
        ? false
        : await this.#deps.runGuard.quarantineIfCancelled(
            request.runId,
            {
              attemptId: job.jobId,
              reason: 'the simulation job completed after the run was cancelled',
            },
            context.ctx,
          )
    const next = nextPipelineStage(job.stage)
    return {
      nextStage: next ?? job.stage,
      counts: { total: 1, processed: 1, failed: 0, skipped: 0 },
      documentRef: canonicalJsonOf({
        kind: 'home-energy.simulation-result',
        resultRef: stored.blobRef,
        domainStatus: outcome.domainStatus ?? null,
        mode: 'simulation',
        quarantined,
      }),
    }
  }
}

/**
 * Route the generic runnable stages by job kind: a simulation job runs the simulation handler,
 * any other job delegates to the ingestion registry. The durable stage machine is unchanged.
 *
 * A research job whose version is the agentic scheduling handoff (`ResearchJobRequestAgent`, design
 * §8) declares that it needs **no** background ledger: the job only enqueues an already-accepted run
 * for the controller, so the worker must not open a second ledger for it — every execution consumes
 * the run's one manifest ledger.
 */
export function createWorkerStageRegistry(options: {
  readonly ingestion: JobStageHandlerRegistry
  readonly simulation?: JobStageHandler
  readonly research?: JobStageHandler
}): JobStageHandlerRegistry {
  const router: JobStageHandler = {
    stage: 'received',
    async run(context: JobStageContext): Promise<JobStageOutcome> {
      if (context.job.kind === 'simulation') {
        if (options.simulation === undefined) {
          throw new JobStageFailure('CAPABILITY_NOT_CONFIGURED', 'no simulation handler is mounted for this deployment', false)
        }
        return options.simulation.run(context)
      }
      if (context.job.kind === 'research') {
        if (options.research === undefined) {
          throw new JobStageFailure('CAPABILITY_NOT_CONFIGURED', 'no research handler is mounted for this deployment', false)
        }
        return options.research.run(context)
      }
      const handler = options.ingestion.get(context.job.stage)
      if (handler === undefined) {
        throw new JobStageFailure(
          'INTERNAL_ERROR',
          `no stage handler is registered for ${context.job.stage}`,
          false,
        )
      }
      return handler.run(context)
    },
  }
  return {
    get: () => router,
    requiresBackgroundLedger: (job: LogicalJobRecord): boolean => {
      if (job.kind !== 'research') return true
      try {
        return !isAgentResearchJobRequest(decodeResearchJobRequest(job.datasetRef))
      } catch {
        // A malformed reference is handled by the research handler; keep the historical ledger here.
        return true
      }
    },
  }
}
