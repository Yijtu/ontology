import type {
  ComputationData,
  ComputeOperationHandler,
  ComputeOperationRequest,
  ComputeOperationResult,
  ComputeSourceObservation,
  DataQueryOutput,
  DomainResultStatus,
  ScopeRef,
  SourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { isToolContext } from '@ontology/contracts'
import { canonicalJson } from '../input'
import { EnergyPlanner } from '../planning'
import type { CandidateStrategyKind, EnergyPlanRequest } from '../planning'
import { EnergySimulator, round } from '../simulation'
import type { EnergySimulationRequest, SimulationResult } from '../simulation'
import { EnergyComputeError } from './errors'
import {
  assertSimulationOnly,
  decodeEnergyOperationInput,
  requirePlan,
} from './input'
import type { EnergyOperationInput } from './input'
import {
  ENERGY_METRIC_AGGREGATIONS,
  energyOperationRef,
} from './manifest'
import type { EnergyMetricAggregation } from './manifest'

/**
 * The registered home-energy compute handlers (SPEC E6, ADR-11/ADR-12).
 *
 * Each handler is a pure domain function wrapped in the generic compute contract: it reads
 * its bounded input only through the scoped reader, runs the deterministic planner/simulator,
 * archives a content-addressed result artifact and returns a typed `computation` payload.
 * Every result is marked `simulation`; there is no device port and no network call anywhere,
 * so no execution can send a device request.
 */

export const ENERGY_RESULT_MEDIA_TYPE = 'application/vnd.ontology.energy-compute-result+json'

const ENERGY_COMPUTE_SOURCE_REF: SourceRef = { namespace: 'home-energy', sourceId: 'compute' }

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new EnergyComputeError('INVALID_ARGUMENT', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new EnergyComputeError('INVALID_ARGUMENT', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

async function readOperationInput(request: ComputeOperationRequest): Promise<EnergyOperationInput> {
  const ref = request.inputRefs[0]
  if (ref === undefined) {
    throw new EnergyComputeError(
      'INVALID_INPUT',
      'a compute operation requires at least one approved input reference',
    )
  }
  const bytes = await request.readInput.read({ approvedInputRefs: [ref] }, request.ctx)
  return decodeEnergyOperationInput(bytes)
}

function sourceOf(input: EnergyOperationInput, resultDigest: string): ComputeSourceObservation {
  const series = input.snapshot.manifest.series[0]
  return {
    sourceRef: series === undefined ? ENERGY_COMPUTE_SOURCE_REF : series.sourceRef,
    schemaVersion: input.snapshot.manifest.normalizationVersion,
    consistency: 'immutable',
    resultDigest,
  }
}

async function archiveAndFinish(input: {
  readonly request: ComputeOperationRequest
  readonly input: EnergyOperationInput
  readonly result: unknown
  readonly resultDigest: string
  readonly algorithm: VersionRef
  readonly domainStatus: DomainResultStatus
  readonly violations?: readonly string[]
  readonly metrics?: Readonly<Record<string, unknown>>
}): Promise<ComputeOperationResult> {
  const content = new TextEncoder().encode(canonicalJson(input.result))
  const stored = await input.request.artifacts.putBytes(
    { scopeRef: scopeOf(input.request.ctx), content, mediaType: ENERGY_RESULT_MEDIA_TYPE },
    input.request.ctx,
  )
  const computation: ComputationData = {
    operationRef: input.request.operationRef,
    resultRef: stored.blobRef,
    algorithmVersion: input.algorithm,
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    ...(input.violations === undefined || input.violations.length === 0
      ? {}
      : { violations: [...input.violations] }),
    domainStatus: input.domainStatus,
  }
  const payload: DataQueryOutput = { resultKind: 'computation', computation }
  return {
    payload,
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [sourceOf(input.input, input.resultDigest)],
    domainStatus: input.domainStatus,
    dataMode: 'simulation',
    evidenceKind: 'computation',
  }
}

const STRATEGY_VALUES: readonly CandidateStrategyKind[] = [
  'self_consumption',
  'reserve_first',
  'price_window',
]

function strategyWhitelistOf(
  parameters: Readonly<Record<string, unknown>>,
): readonly CandidateStrategyKind[] | undefined {
  const value = parameters.strategyWhitelist
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new EnergyComputeError('INVALID_ARGUMENT', 'strategyWhitelist must be an array')
  }
  return value.filter((entry): entry is CandidateStrategyKind =>
    (STRATEGY_VALUES as readonly unknown[]).includes(entry),
  )
}

function aggregationsOf(
  parameters: Readonly<Record<string, unknown>>,
): readonly EnergyMetricAggregation[] {
  const value = parameters.aggregations
  if (!Array.isArray(value) || value.length === 0) {
    throw new EnergyComputeError('INVALID_ARGUMENT', 'aggregations must be a non-empty array')
  }
  return value.filter((entry): entry is EnergyMetricAggregation =>
    (ENERGY_METRIC_AGGREGATIONS as readonly unknown[]).includes(entry),
  )
}

function windowOf(parameters: Readonly<Record<string, unknown>>): {
  readonly start: number
  readonly end: number | undefined
} {
  const start = typeof parameters.windowStartSlot === 'number' ? parameters.windowStartSlot : 0
  const end = typeof parameters.windowEndSlot === 'number' ? parameters.windowEndSlot : undefined
  return { start, end }
}

function simulationRequestOf(
  input: EnergyOperationInput,
): EnergySimulationRequest {
  return {
    snapshot: input.snapshot,
    executionMode: 'simulation',
    topology: input.topology,
    battery: input.battery,
    grid: input.grid,
    load: input.load,
    pv: input.pv,
    tariff: input.tariff,
    reserves: input.reserves,
    plan: requirePlan(input, 'home-energy.simulate'),
    tolerance: input.tolerance,
    assumptions: input.assumptions,
  }
}

function metricsOf(
  simulation: SimulationResult,
  input: EnergyOperationInput,
  aggregations: readonly EnergyMetricAggregation[],
  window: { readonly start: number; readonly end: number | undefined },
): Readonly<Record<string, unknown>> {
  const slotHours = input.snapshot.manifest.slotMinutes / 60
  const decimals = input.tolerance.reportingDecimals
  const intervals = simulation.intervals.filter(
    (interval) =>
      interval.slotIndex >= window.start &&
      (window.end === undefined || interval.slotIndex < window.end),
  )
  const metrics: Record<string, unknown> = {}
  for (const aggregation of aggregations) {
    if (aggregation === 'energy_import_kwh') {
      metrics[aggregation] = round(
        intervals.reduce((total, interval) => total + interval.gridImportKw * slotHours, 0),
        decimals,
      )
    } else if (aggregation === 'energy_export_kwh') {
      metrics[aggregation] = round(
        intervals.reduce((total, interval) => total + interval.gridExportKw * slotHours, 0),
        decimals,
      )
    } else if (aggregation === 'energy_load_kwh') {
      metrics[aggregation] = round(
        intervals.reduce((total, interval) => total + interval.loadKw * slotHours, 0),
        decimals,
      )
    } else if (aggregation === 'energy_pv_used_kwh') {
      metrics[aggregation] = round(
        intervals.reduce((total, interval) => total + interval.pvUsedKw * slotHours, 0),
        decimals,
      )
    } else if (aggregation === 'net_cost') {
      metrics[aggregation] = round(
        intervals.reduce(
          (total, interval) =>
            total + interval.importCost - interval.exportRevenue + interval.degradationCost,
          0,
        ),
        decimals,
      )
    } else {
      const margins = simulation.reserveMargins
        .filter(
          (margin) =>
            margin.windowStartSlot >= window.start &&
            (window.end === undefined || margin.windowEndSlot <= window.end),
        )
        .map((margin) => margin.marginKwh)
      metrics[aggregation] = margins.length === 0 ? null : round(Math.min(...margins), decimals)
    }
  }
  return metrics
}

export function createEnergyComputeHandlers(): readonly ComputeOperationHandler[] {
  const planner = new EnergyPlanner(new EnergySimulator())
  const simulator = new EnergySimulator()

  const plan: ComputeOperationHandler = {
    operationRef: energyOperationRef('home-energy.plan'),
    async execute(request: ComputeOperationRequest): Promise<ComputeOperationResult> {
      const input = await readOperationInput(request)
      assertSimulationOnly(input, 'home-energy.plan')
      const strategyWhitelist = strategyWhitelistOf(request.parameters)
      const planRequest: EnergyPlanRequest = {
        snapshot: input.snapshot,
        executionMode: 'simulation',
        topology: input.topology,
        battery: input.battery,
        grid: input.grid,
        load: input.load,
        pv: input.pv,
        tariff: input.tariff,
        reserves: input.reserves,
        tolerance: input.tolerance,
        assumptions: input.assumptions,
        ...(strategyWhitelist === undefined ? {} : { strategyWhitelist }),
        ...(input.terminalEnergyValuation === undefined
          ? {}
          : { terminalEnergyValuation: input.terminalEnergyValuation }),
      }
      const result = planner.plan(planRequest)
      const selected = result.candidates.find((candidate) => candidate.planRef.id === result.selection.selectedPlanRef?.id)
      return archiveAndFinish({
        request,
        input,
        result,
        resultDigest: result.resultDigest,
        algorithm: result.algorithmVersion,
        domainStatus: result.domainStatus,
        metrics: {
          candidate_total_cost: selected?.objective.totalCost,
          baseline_total_cost: result.baseline?.objective.totalCost,
          terminal_energy_kwh: selected?.objective.terminalEnergyKwh,
          reserve_satisfied: selected?.objective.reserveSatisfied === undefined ? undefined : (selected.objective.reserveSatisfied ? 1 : 0),
          units: { candidate_total_cost: 'CNY', baseline_total_cost: 'CNY', terminal_energy_kwh: 'kWh', reserve_satisfied: 'boolean' },
        },
      })
    },
  }

  const simulate: ComputeOperationHandler = {
    operationRef: energyOperationRef('home-energy.simulate'),
    async execute(request: ComputeOperationRequest): Promise<ComputeOperationResult> {
      const input = await readOperationInput(request)
      assertSimulationOnly(input, 'home-energy.simulate')
      const result = simulator.simulate(simulationRequestOf(input))
      return archiveAndFinish({
        request,
        input,
        result,
        resultDigest: result.resultDigest,
        algorithm: result.algorithmVersion,
        domainStatus: result.domainStatus,
        violations: result.violations.map(
          (violation) => `${violation.constraint}@${String(violation.slotIndex)}: ${violation.detail}`,
        ),
      })
    },
  }

  const metrics: ComputeOperationHandler = {
    operationRef: energyOperationRef('home-energy.metrics'),
    async execute(request: ComputeOperationRequest): Promise<ComputeOperationResult> {
      const input = await readOperationInput(request)
      assertSimulationOnly(input, 'home-energy.metrics')
      const result = simulator.simulate(simulationRequestOf(input))
      const aggregated = metricsOf(
        result,
        input,
        aggregationsOf(request.parameters),
        windowOf(request.parameters),
      )
      return archiveAndFinish({
        request,
        input,
        result: { operation: energyOperationRef('home-energy.metrics'), metrics: aggregated },
        resultDigest: result.resultDigest,
        algorithm: result.algorithmVersion,
        domainStatus: result.domainStatus,
        metrics: aggregated,
      })
    },
  }

  return [plan, simulate, metrics]
}
