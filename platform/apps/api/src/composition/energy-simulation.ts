import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type {
  ComputeOperationHandler,
  ComputeOperationResult,
  ComputeSourceObservation,
  DataMode,
  DomainResultStatus,
  ImmutableArtifactWriter,
  OperationRef,
  OperationRegistry,
  ResourceRef,
  ScopedArtifactReader,
  ToolContext,
} from '@ontology/contracts'
import { findRegisteredOperation } from '@ontology/contracts'
import {
  EnergyComputeError,
  SimulationExecutionService,
  decodeEnergyOperationInput,
} from '@ontology/extension-home-energy'
import type {
  DeviceActionPort,
  EnergyOperationInput,
  ExecutionRecord,
  RequestExecutionInput,
  SimulationJobPort,
} from '@ontology/extension-home-energy'
import {
  assertNoComputeBypass,
  computeRequestOf,
  createScopedArtifactReader,
  resolveComputeHandler,
  runComputeWithBudget,
} from '@ontology/tool-services'
import {
  createSyntheticScenarioCatalog,
  scenarioDescriptorOf,
} from './home-energy-scenario'
import type { ScenarioCatalog, ScenarioDescriptor, ScenarioRequest, ScenarioStateBinding } from './home-energy-scenario'

/**
 * The home-energy simulation surface (SPEC E6–E8; C6, ADR-11/ADR-12, INV-10).
 *
 * It is the composition-owned service behind `POST /simulations`, `GET /simulations/{id}` and
 * `POST /simulations/inputs`. A request names a *registered* operation and one or more approved
 * input refs; the surface resolves the handler, binds a scoped reader to exactly those refs, runs
 * the deterministic domain computation under the operation's declared CPU budget, and returns a
 * record. The archived result is read back through the tenant/space-scoped blob store, which
 * verifies the content digest on every read — so `integrityVerified` is a real check, not a label.
 *
 * Every record is explicitly `mode: simulation` and `liveSupported: false`. The surface has no
 * device port and makes no network call, so no simulation can send a device request. A live
 * request is handled by the separate execution surface, which refuses it with
 * `CAPABILITY_NOT_CONFIGURED` before any driver is reached.
 */

/** A classified failure the shared C6 error boundary can render without leaking internals. */
export class SimulationSurfaceError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus: number, message: string) {
    super(message)
    this.name = 'SimulationSurfaceError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface RequestSimulationInput {
  readonly operationRef: OperationRef
  readonly inputRefs: readonly ResourceRef[]
  readonly parameters: Readonly<Record<string, unknown>>
}

/** The record `POST /simulations` returns (202). It names the typed result artifact, not its bytes. */
export interface SimulationRecordView {
  readonly simulationId: string
  readonly operationRef: OperationRef
  readonly mode: 'simulation'
  readonly liveSupported: false
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
  readonly inputRefs: readonly ResourceRef[]
  readonly resultRef: ResourceRef
  readonly sources: readonly ComputeSourceObservation[]
  readonly createdAt: string
  readonly status: 'completed'
}

/** The typed result/evidence `GET /simulations/{id}` returns, with its integrity check made explicit. */
export interface SimulationDetailView extends SimulationRecordView {
  readonly integrityVerified: boolean
  readonly scenario: ScenarioDescriptor
  readonly result: unknown
}

export interface SimulationSurface {
  buildScenario(request: ScenarioRequest, ctx: ToolContext, state?: ScenarioStateBinding): Promise<ScenarioDescriptor>
  requestSimulation(request: RequestSimulationInput, ctx: ToolContext): Promise<SimulationRecordView>
  getSimulation(simulationId: string, ctx: ToolContext): Promise<SimulationDetailView>
}

export interface EnergySimulationCompositionOptions {
  readonly blobStore: LocalImmutableBlobStore
  readonly artifacts: ImmutableArtifactWriter
  readonly reader: ScopedArtifactReader
  readonly operations: OperationRegistry
  readonly handlers: readonly ComputeOperationHandler[]
  /** Overridable only for tests; defaults to the synthetic scenario catalog. */
  readonly scenarioCatalog?: ScenarioCatalog
  readonly now?: () => string
  readonly newId?: () => string
  readonly records?: SimulationRecordStore
}

/** Tenant-scoped durable record index; payload artifacts remain in the immutable blob store. */
export interface SimulationRecordStore {
  put(record: SimulationRecordView, ctx: ToolContext): Promise<void>
  get(simulationId: string, ctx: ToolContext): Promise<SimulationRecordView | undefined>
}

function scopeKey(ctx: ToolContext): string {
  return `${ctx.principal.tenantId}:${ctx.allowedResources.spaceId}`
}

function toSurfaceError(error: unknown): never {
  if (error instanceof SimulationSurfaceError) throw error
  if (error instanceof EnergyComputeError) {
    if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'LIVE_NOT_SUPPORTED') {
      throw new SimulationSurfaceError(error.code, 409, error.message)
    }
    if (error.code === 'INVALID_INPUT' || error.code === 'MISSING_PLAN') {
      throw new SimulationSurfaceError(error.code, 422, error.message)
    }
    throw new SimulationSurfaceError(error.code, 400, error.message)
  }
  throw error
}

export function createEnergySimulationSurface(
  options: EnergySimulationCompositionOptions,
): SimulationSurface {
  const catalog =
    options.scenarioCatalog ?? createSyntheticScenarioCatalog({ artifacts: options.artifacts })
  const now = options.now ?? ((): string => new Date().toISOString())
  const newId = options.newId ?? ((): string => globalThis.crypto.randomUUID())
  const records = new Map<string, SimulationRecordView>()

  function requireHandler(operationRef: OperationRef): ComputeOperationHandler {
    const operation = findRegisteredOperation(options.operations, operationRef)
    if (operation === undefined) {
      throw new SimulationSurfaceError(
        'CAPABILITY_NOT_CONFIGURED',
        409,
        `operation ${operationRef.id}@${operationRef.version} is not registered`,
      )
    }
    const handler = resolveComputeHandler(options.handlers, operationRef)
    if (handler === undefined) {
      throw new SimulationSurfaceError(
        'CAPABILITY_NOT_CONFIGURED',
        409,
        `no handler is registered for operation ${operationRef.id}@${operationRef.version}`,
      )
    }
    return handler
  }

  return {
    buildScenario: (request, ctx, state) => catalog.buildScenario(request, ctx, state),

    async requestSimulation(request, ctx) {
      assertNoComputeBypass(request.parameters, request.inputRefs)
      const handler = requireHandler(request.operationRef)
      if (request.inputRefs.length === 0) {
        throw new SimulationSurfaceError(
          'INVALID_ARGUMENT',
          400,
          'a simulation requires at least one approved input reference',
        )
      }
      const operation = findRegisteredOperation(options.operations, request.operationRef)
      if (operation === undefined) {
        throw new SimulationSurfaceError(
          'CAPABILITY_NOT_CONFIGURED',
          409,
          `operation ${request.operationRef.id}@${request.operationRef.version} is not registered`,
        )
      }
      const readInput = createScopedArtifactReader(options.reader, request.inputRefs)
      const controller = new AbortController()
      let outcome: ComputeOperationResult
      try {
        outcome = await runComputeWithBudget(
          ({ signal }) =>
            handler.execute(
              computeRequestOf({
                operationRef: request.operationRef,
                parameters: request.parameters,
                inputRefs: request.inputRefs,
                readInput,
                artifacts: options.artifacts,
                limits: operation.limits,
                deadline: ctx.deadline,
                ctx,
                signal,
              }),
            ),
          operation.limits.maxDurationMs,
          ctx.deadline,
          controller.signal,
        )
      } catch (error) {
        toSurfaceError(error)
      }
      const computation = outcome.payload.computation
      if (computation === undefined) {
        throw new SimulationSurfaceError(
          'INTERNAL_ERROR',
          500,
          'the compute result carried no computation payload',
        )
      }
      const record: SimulationRecordView = {
        simulationId: newId(),
        operationRef: request.operationRef,
        mode: 'simulation',
        liveSupported: false,
        domainStatus: computation.domainStatus,
        dataMode: outcome.dataMode,
        inputRefs: [...request.inputRefs],
        resultRef: computation.resultRef,
        sources: [...outcome.sources],
        createdAt: now(),
        status: 'completed',
      }
      if (options.records === undefined) records.set(`${scopeKey(ctx)}:${record.simulationId}`, record)
      else await options.records.put(record, ctx)
      return record
    },

    async getSimulation(simulationId, ctx) {
      const record = options.records === undefined
        ? records.get(`${scopeKey(ctx)}:${simulationId}`)
        : await options.records.get(simulationId, ctx)
      if (record === undefined) {
        throw new SimulationSurfaceError(
          'SIMULATION_NOT_FOUND',
          404,
          `simulation ${simulationId} is not available in this scope`,
        )
      }
      const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
      const inputRef = record.inputRefs[0]
      if (inputRef === undefined) {
        throw new SimulationSurfaceError('INTERNAL_ERROR', 500, 'the simulation record lost its input reference')
      }
      let input: EnergyOperationInput
      let integrityVerified = false
      let result: unknown
      try {
        const inputBytes = await options.blobStore.readAuthorized(
          { scopeRef, blobRef: inputRef },
          ctx,
        )
        input = decodeEnergyOperationInput(inputBytes)
        const authorized = await options.blobStore.getAuthorized(
          { scopeRef, blobRef: record.resultRef },
          ctx,
        )
        integrityVerified = authorized.integrityVerified
        const resultBytes = await options.blobStore.readAuthorized(
          { scopeRef, blobRef: record.resultRef },
          ctx,
        )
        result = JSON.parse(new TextDecoder().decode(resultBytes)) as unknown
      } catch {
        throw new SimulationSurfaceError(
          'VERIFICATION_FAILED',
          422,
          `the simulation ${simulationId} result failed integrity verification`,
        )
      }
      return {
        ...record,
        integrityVerified,
        scenario: scenarioDescriptorOf(input, inputRef),
        result,
      }
    },
  }
}

/**
 * The simulation execution surface (SPEC E7, C6; ADR-12, INV-10).
 *
 * It wraps the extension's `SimulationExecutionService` so the HTTP layer depends only on the
 * picked method. A `mode=simulation` request enqueues a durable simulation job and returns an
 * explicit `mode=simulation` record with `deviceRequestsSent: 0`; a `mode=live` request throws
 * `CAPABILITY_NOT_CONFIGURED` before any driver is reached.
 */
export interface ExecutionSurface {
  requestExecution(input: RequestExecutionInput, ctx: ToolContext): Promise<ExecutionRecord>
  getExecution?(executionId: string, ctx: ToolContext): Promise<ExecutionRecord | undefined>
  getVirtualState?(ctx: ToolContext): Promise<VirtualBatteryStateView>
}

export interface VirtualBatteryStateView extends ScenarioStateBinding {
  readonly deviceId: string
  readonly capacityKwh: number
  readonly socPercent: number
  readonly mode: 'simulation'
  readonly updatedAt: string
  readonly simulatedAt: string
}

export function createSimulationExecutionSurface(options: {
  readonly jobs: SimulationJobPort
  readonly deviceDriver?: DeviceActionPort
  readonly now?: () => string
  readonly newId?: () => string
}): ExecutionSurface {
  const service = new SimulationExecutionService({
    jobs: options.jobs,
    ...(options.deviceDriver === undefined ? {} : { deviceDriver: options.deviceDriver }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })
  return {
    requestExecution: (input, ctx) => service.requestExecution(input, ctx),
  }
}

/** Re-exported so the HTTP layer can build the scenario request without importing the catalog module. */
export type { ScenarioCatalog, ScenarioDescriptor, ScenarioRequest }
