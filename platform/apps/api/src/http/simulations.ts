import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { OperationRef, ResourceKind, ResourceRef, ToolContext } from '@ontology/contracts'
import { EnergyComputeError } from '@ontology/extension-home-energy'
import type { ExecutionRecord, ExecutionMode, RequestExecutionInput } from '@ontology/extension-home-energy'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  ForbiddenError,
  InvalidRequestFieldError,
  isRecord,
  readHeader,
  readTraceId,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'
import { SimulationSurfaceError } from '../composition/energy-simulation'
import type { ExecutionSurface, ScenarioRequest, SimulationSurface } from '../composition/energy-simulation'
import {
  MAX_BACKUP_REQUIREMENT_KWH,
  WEATHER_SCENARIOS,
  isWeatherScenario,
} from '../composition/home-energy-scenario'

/**
 * The C6 simulation/plan/execution surface (SPEC E6–E8; ADR-11/ADR-12).
 *
 * `POST /simulations/inputs` turns the operator's two intents (backup requirement and weather
 * scenario) into an archived, content-addressed synthetic input and returns its descriptor.
 * `POST /simulations` runs a *registered* operation over approved input refs and returns a
 * `mode=simulation` record. `GET /simulations/{id}` returns the typed result plus the scenario
 * labels and the content-digest verification outcome. `POST /executions` schedules a simulation
 * execution; `mode=live` is refused with `CAPABILITY_NOT_CONFIGURED` and is never proxied to a
 * device driver.
 *
 * Identity, tenant/space scope and the trace id come from the server-side authenticator, never
 * from the body. A request can name only a registered operation id and opaque artifact refs —
 * there is no `code`, script, path or URL field.
 */

export interface SimulationRouteDependencies {
  readonly service: SimulationSurface
  readonly execution: ExecutionSurface
  readonly authenticate: RequestAuthenticator
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) {
    throw new InvalidRequestFieldError('a create request requires an Idempotency-Key header')
  }
  return key
}

/** The C6 permissions for this surface: a simulation user or an operator, never a bare reader. */
const SIMULATION_ROLES: readonly string[] = ['simulation-user', 'business-user', 'operator', 'platform-admin']

function requireSimulationRole(auth: AuthenticatedRequest): void {
  if (!auth.principal.roles.some((role) => SIMULATION_ROLES.includes(role))) {
    throw new ForbiddenError('the simulation surface requires a simulation-user or operator role')
  }
}

function readOperationRef(value: unknown): OperationRef {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'string') {
    throw new InvalidRequestFieldError('operationRef must carry a string id and version')
  }
  return { id: value.id, version: value.version }
}

const RESOURCE_KINDS: readonly ResourceKind[] = [
  'artifact',
  'dataset',
  'plan',
  'simulation',
  'computation',
  'evidence',
  'document',
]

function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value)
}

function readResourceRef(value: unknown, field: string): ResourceRef {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.digest !== 'string' ||
    !isResourceKind(value.kind)
  ) {
    throw new InvalidRequestFieldError(`${field} must be a resource reference`)
  }
  return { id: value.id, version: value.version, digest: value.digest, kind: value.kind }
}

function readResourceRefs(value: unknown, field: string): readonly ResourceRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty array of resource references`)
  }
  return value.map((entry) => readResourceRef(entry, field))
}

function contextFor(auth: AuthenticatedRequest, traceId: string, runId: string): ToolContext {
  return createRequestToolContext({
    principal: auth.principal,
    spaceId: auth.spaceId,
    traceId,
    runId,
  })
}

/** Map a classified domain failure onto the C6 envelope; anything else stays a 500. */
function rethrowClassified(error: unknown): never {
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

export function registerSimulationRoutes(
  app: FastifyInstance,
  dependencies: SimulationRouteDependencies,
): void {
  app.post('/api/v1/simulations/inputs', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireSimulationRole(auth)
    requireIdempotencyKey(request)
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const backup = body.backupRequirementKwh
    if (
      typeof backup !== 'number' ||
      !Number.isFinite(backup) ||
      backup < 0 ||
      backup > MAX_BACKUP_REQUIREMENT_KWH
    ) {
      throw new InvalidRequestFieldError(
        `backupRequirementKwh must be a finite number in [0, ${String(MAX_BACKUP_REQUIREMENT_KWH)}]`,
      )
    }
    const weather = body.weatherScenario
    if (!isWeatherScenario(weather)) {
      throw new InvalidRequestFieldError(`weatherScenario must be one of ${WEATHER_SCENARIOS.join(', ')}`)
    }
    const timeZone = typeof body.timeZone === 'string' && body.timeZone.length > 0 ? body.timeZone : undefined
    const scenarioRequest: ScenarioRequest = {
      backupRequirementKwh: backup,
      weatherScenario: weather,
      ...(timeZone === undefined ? {} : { timeZone }),
    }
    const ctx = contextFor(auth, traceId, globalThis.crypto.randomUUID())
    const scenario = await dependencies.service.buildScenario(scenarioRequest, ctx)
    reply.status(201).send({ data: scenario, meta: { traceId } })
    return reply
  })

  app.post('/api/v1/simulations', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireSimulationRole(auth)
    requireIdempotencyKey(request)
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const operationRef = readOperationRef(body.operationRef)
    const inputRefs = readResourceRefs(body.inputRefs, 'inputRefs')
    const parameters = isRecord(body.parameters) ? body.parameters : {}
    const ctx = contextFor(auth, traceId, globalThis.crypto.randomUUID())
    try {
      const record = await dependencies.service.requestSimulation(
        { operationRef, inputRefs, parameters },
        ctx,
      )
      reply.status(202).send({ data: record, meta: { traceId } })
    } catch (error) {
      rethrowClassified(error)
    }
    return reply
  })

  app.get<{ Params: { simulationId: string } }>(
    '/api/v1/simulations/:simulationId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      requireSimulationRole(auth)
      const simulationId = request.params.simulationId
      const ctx = contextFor(auth, traceId, simulationId)
      try {
        const detail = await dependencies.service.getSimulation(simulationId, ctx)
        reply.status(200).send({ data: detail, meta: { traceId } })
      } catch (error) {
        rethrowClassified(error)
      }
      return reply
    },
  )

  app.post('/api/v1/executions', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireSimulationRole(auth)
    const idempotencyKey = requireIdempotencyKey(request)
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const operationRef = readOperationRef(body.operationRef)
    const planRef = readResourceRef(body.planRef, 'planRef')
    const inputRefs = readResourceRefs(body.inputRefs, 'inputRefs')
    const mode = body.mode
    if (mode !== 'simulation' && mode !== 'live') {
      throw new InvalidRequestFieldError('mode must be simulation or live')
    }
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : globalThis.crypto.randomUUID()
    const executionInput: RequestExecutionInput = {
      operationRef,
      planRef,
      inputRefs,
      mode: mode as ExecutionMode,
      runId,
      idempotencyKey,
    }
    const ctx = contextFor(auth, traceId, runId)
    try {
      const record: ExecutionRecord = await dependencies.execution.requestExecution(executionInput, ctx)
      reply.status(202).send({ data: record, meta: { traceId } })
    } catch (error) {
      rethrowClassified(error)
    }
    return reply
  })
}
