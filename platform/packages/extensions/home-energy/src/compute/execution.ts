import type {
  OperationRef,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { findRegisteredOperation } from '@ontology/contracts'
import { canonicalJson } from '../input'
import { EnergyComputeError } from './errors'
import { ENERGY_OPERATION_REGISTRY } from './manifest'

/**
 * Simulation execution service (SPEC E7, C6; ADR-12, INV-10).
 *
 * First version only ever schedules a `simulation` execution. The real `DeviceActionPort`
 * contract is retained for a later, separately reviewed node (LOCAL-053), but no driver is
 * enabled here: a `mode=live` request returns `CAPABILITY_NOT_CONFIGURED` and is **never**
 * proxied to a device driver. Simulation never touches the driver either, so a simulation
 * execution sends zero device requests by construction.
 *
 * Every execution record is explicitly `mode=simulation` and `liveSupported=false`, so a
 * simulated success can never be presented as a live success (INV-10).
 */

export type ExecutionMode = 'simulation' | 'live'

export type ExecutionPhase =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ExecutionRecord {
  readonly executionId: Uuid
  readonly runId?: Uuid
  /** Always `simulation` in this version; the field is explicit so a reader never infers it. */
  readonly mode: 'simulation'
  readonly operationRef: OperationRef
  readonly planRef: ResourceRef
  readonly inputRefs: readonly ResourceRef[]
  /** Original If-Match revision, kept so an idempotent replay cannot change request identity. */
  readonly expectedStateRevision?: number
  readonly phase: ExecutionPhase
  readonly requestedAt: Rfc3339UtcTimestamp
  readonly liveSupported: false
  /** Structural marker: a simulation execution sent no device request. */
  readonly deviceRequestsSent: 0
  readonly stepRecords?: readonly SimulationStepExecutionRecord[]
  readonly finalStateRef?: ResourceRef
  readonly finalState?: { readonly energyKwh: number; readonly socPercent: number; readonly revision: number; readonly mode: 'simulation' }
}

export interface SimulationStepExecutionRecord {
  readonly slotIndex: number
  readonly requested: { readonly chargeKw: number; readonly dischargeKw: number }
  readonly accepted: boolean
  readonly observed: boolean
  readonly statusHistory: readonly ('Requested' | 'Accepted' | 'Observed')[]
  readonly beforeEnergyKwh: number
  readonly afterEnergyKwh: number
  readonly stateRef: ResourceRef
  readonly mode: 'simulation'
}

/**
 * The reserved side-effecting device port (SPEC E1/E7). It is declared so the contract is not
 * lost, but this node never enables a driver: no adapter implements it, the service never
 * calls it, and a live request is refused before any driver lookup.
 */
export interface DeviceActionPort {
  sendCommand(request: { readonly planRef: ResourceRef; readonly commandRef: Uuid }, ctx: ToolContext): Promise<void>
}

/** Durable job enqueue port; the composition root implements it over the job service. */
export interface SimulationJobPort {
  enqueue(
    input: {
      readonly jobId: Uuid
      readonly operationRef: OperationRef
      readonly planRef: ResourceRef
      readonly inputRefs: readonly ResourceRef[]
      readonly runId: Uuid
      readonly idempotencyKey: string
    },
    ctx: ToolContext,
  ): Promise<{ readonly jobId: Uuid; readonly reused: boolean }>
}

export interface SimulationExecutionDependencies {
  readonly jobs: SimulationJobPort
  /** Retained contract only; never invoked in this version. */
  readonly deviceDriver?: DeviceActionPort
  readonly now?: () => string
  readonly newId?: () => string
}

export interface RequestExecutionInput {
  readonly operationRef: OperationRef
  readonly planRef: ResourceRef
  readonly inputRefs: readonly ResourceRef[]
  readonly mode: ExecutionMode
  readonly runId: Uuid
  readonly idempotencyKey: string
  readonly expectedStateRevision?: number
}

/** The bounded job payload encoded into the durable job's opaque `datasetRef`. */
export type SimulationJobRequest = {
  readonly kind: 'home-energy.simulation-job'
  readonly version: string
  readonly mode: 'simulation'
  readonly runId: Uuid
  readonly operationRef: OperationRef
  readonly planRef: ResourceRef
  readonly inputRefs: readonly ResourceRef[]
}

export const SIMULATION_JOB_REQUEST_KIND = 'home-energy.simulation-job'

export function encodeSimulationJobRequest(request: SimulationJobRequest): string {
  return canonicalJson(request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function decodeSimulationJobRequest(datasetRef: string): SimulationJobRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(datasetRef)
  } catch (error) {
    throw new EnergyComputeError('INVALID_INPUT', 'the simulation job reference is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed) || parsed.kind !== SIMULATION_JOB_REQUEST_KIND || parsed.mode !== 'simulation') {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      `the simulation job reference must declare kind=${SIMULATION_JOB_REQUEST_KIND} and mode=simulation`,
    )
  }
  if (!isRecord(parsed.operationRef) || !isRecord(parsed.planRef) || !Array.isArray(parsed.inputRefs)) {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      'the simulation job reference is missing its operation, plan or input references',
    )
  }
  return parsed as SimulationJobRequest
}

export class SimulationExecutionService {
  readonly #jobs: SimulationJobPort
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: SimulationExecutionDependencies) {
    this.#jobs = dependencies.jobs
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Schedule a simulation execution. A live request is refused with
   * `CAPABILITY_NOT_CONFIGURED` and is not proxied to any driver; a simulation request is
   * enqueued as a durable job and returns an explicit `mode=simulation` record.
   */
  async requestExecution(
    input: RequestExecutionInput,
    ctx: ToolContext,
  ): Promise<ExecutionRecord> {
    if (input.mode === 'live') {
      throw new EnergyComputeError(
        'CAPABILITY_NOT_CONFIGURED',
        'live device execution is not configured; the request is not proxied to a device driver',
      )
    }
    const operation = findRegisteredOperation(ENERGY_OPERATION_REGISTRY, input.operationRef)
    if (operation === undefined) {
      throw new EnergyComputeError(
        'INVALID_ARGUMENT',
        `operation ${input.operationRef.id}@${input.operationRef.version} is not registered`,
      )
    }
    const executionId = this.#newId()
    const job = await this.#jobs.enqueue(
      {
        jobId: executionId,
        operationRef: input.operationRef,
        planRef: input.planRef,
        inputRefs: input.inputRefs,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )
    return {
      executionId: job.jobId,
      runId: input.runId,
      mode: 'simulation',
      operationRef: input.operationRef,
      planRef: input.planRef,
      inputRefs: [...input.inputRefs],
      phase: 'scheduled',
      requestedAt: this.#now(),
      liveSupported: false,
      deviceRequestsSent: 0,
    }
  }
}
