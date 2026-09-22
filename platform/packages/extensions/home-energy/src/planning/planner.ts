import type { DomainResultStatus, ResourceRef, Sha256Digest } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../input/snapshot'
import { assertSimulationMode, NUMERIC_POLICY, round } from '../simulation'
import type {
  EnergySimulationRequest,
  EnergySimulatorPort,
  PlanStep,
  PlanTrajectory,
  SimulationResult,
} from '../simulation'
import { compareToBaseline, terminalEnergyOf, unaccountedCostItemsOf } from './baseline'
import { EnergyPlannerError } from './errors'
import {
  generateStrategyPlan,
  purchasePricesOf,
  resolveBatteryNumbers,
  strategyAvailability,
  type StrategyContext,
} from './strategies'
import {
  BASELINE_STRATEGY,
  DEFAULT_CANDIDATE_STRATEGIES,
  ENERGY_PLANNER_ALGORITHM,
  PLANNER_VERSION,
  type BaselinePlan,
  type BaselineStrategyKind,
  type CandidateComparison,
  type CandidateObjective,
  type CandidatePlan,
  type CandidateStrategyKind,
  type CandidateUnavailability,
  type EnergyPlanRequest,
  type EnergyPlannerPort,
  type JevStrategyScore,
  type PlannerResult,
  type PlannerSelection,
  type PlannerStatus,
  type TerminalEnergyValuation,
} from './types'

/**
 * The pure energy planner (SPEC E5–E7; ADR-11/ADR-12, INV-08/INV-10).
 *
 * It generates a bounded deterministic candidate set inside the declared device constraints and
 * evaluates **every** candidate through the injected `EnergySimulatorPort` — the same simulator,
 * with the same input snapshot, device parameters, tariff and reserve conditions. The idle
 * baseline is the same request with an all-zero trajectory, so the baseline and the candidates are
 * always on one input.
 *
 * It holds no port, credential, clock or randomness: `plan` is a pure synchronous function, so the
 * same request yields the same candidates, the same simulations and the same selection. The output
 * is `best_of_tested_candidates`; it never claims a global physical optimum, and an optional JEV
 * strategy score is recorded separately and never used as the objective or the ranking key.
 */

interface EvaluatedPlan<S extends string> {
  readonly planRef: ResourceRef
  readonly strategy: S
  readonly plan: PlanTrajectory
  readonly objective: CandidateObjective
  readonly simulation: SimulationResult
}

interface PlannerResultBase {
  readonly status: PlannerStatus
  readonly domainStatus: DomainResultStatus
  readonly optimality: 'best_of_tested_candidates'
  readonly executionMode: 'simulation'
  readonly liveSupported: false
  readonly plannerVersion: string
  readonly numericPolicy: string
  readonly algorithmVersion: typeof ENERGY_PLANNER_ALGORITHM
  readonly inputDataMode: EnergyPlanRequest['snapshot']['manifest']['dataMode']
  readonly inputManifestHash: Sha256Digest
  readonly snapshotRef: ResourceRef
  readonly candidates: readonly CandidatePlan[]
  readonly unavailableStrategies: readonly CandidateUnavailability[]
  readonly selection: PlannerSelection
  readonly baseline?: BaselinePlan
  readonly comparisons: readonly CandidateComparison[]
  readonly jevStrategyScores: readonly JevStrategyScore[]
  readonly jevScoresInfluencedSelection: false
  readonly unaccountedCostItems: readonly string[]
  readonly assumptions: readonly string[]
  readonly evidenceRefs: readonly ResourceRef[]
}

function finalize(base: PlannerResultBase): PlannerResult {
  const digest = sha256DigestOf(new TextEncoder().encode(canonicalJson(base)))
  return { ...base, resultDigest: digest }
}

function domainStatusOf(status: PlannerStatus): DomainResultStatus {
  switch (status) {
    case 'feasible':
      return 'known'
    case 'infeasible':
      return 'infeasible'
    case 'insufficient_data':
      return 'unknown'
    case 'unsupported_topology':
      return 'not_applicable'
    default:
      throw new EnergyPlannerError('INVALID_ARGUMENT', `unknown planner status ${String(status)}`)
  }
}

function uuidFromDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, '').padEnd(32, '0').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function dedupeStrategies(
  strategies: readonly CandidateStrategyKind[],
): readonly CandidateStrategyKind[] {
  const seen = new Set<CandidateStrategyKind>()
  const unique: CandidateStrategyKind[] = []
  for (const strategy of strategies) {
    if (!seen.has(strategy)) {
      seen.add(strategy)
      unique.push(strategy)
    }
  }
  return unique
}

function priceThresholds(prices: readonly (number | undefined)[]): {
  readonly cheapThreshold: number
  readonly expensiveThreshold: number
} {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const price of prices) {
    if (price === undefined) continue
    if (price < min) min = price
    if (price > max) max = price
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { cheapThreshold: 0, expensiveThreshold: 0 }
  }
  const midpoint = (min + max) / 2
  return { cheapThreshold: midpoint, expensiveThreshold: midpoint }
}

function physicalSlots(
  result: SimulationResult,
): {
  readonly slotCount: number
  readonly loadKw: readonly number[]
  readonly pvAvailableKw: readonly number[]
} {
  return {
    slotCount: result.intervals.length,
    loadKw: result.intervals.map((interval) => interval.loadKw),
    pvAvailableKw: result.intervals.map((interval) => interval.pvAvailableKw),
  }
}

function buildTrajectory(
  request: EnergyPlanRequest,
  strategy: CandidateStrategyKind | BaselineStrategyKind,
  steps: readonly PlanStep[],
): PlanTrajectory {
  const slotCount = request.snapshot.manifest.slotCount
  const bySlot = new Map<number, PlanStep>()
  for (const step of steps) bySlot.set(step.slotIndex, step)
  const resolved: PlanStep[] = Array.from({ length: slotCount }, (_unused, slotIndex) => {
    return bySlot.get(slotIndex) ?? { slotIndex, chargeKw: 0, dischargeKw: 0 }
  })
  const digest = sha256DigestOf(
    new TextEncoder().encode(
      canonicalJson({
        strategy,
        snapshotDigest: request.snapshot.digest,
        batteryDeviceRef: request.battery.deviceRef,
        algorithm: ENERGY_PLANNER_ALGORITHM,
        steps: resolved,
      }),
    ),
  )
  return {
    planRef: { id: uuidFromDigest(digest), version: PLANNER_VERSION, digest, kind: 'plan' },
    algorithmVersion: ENERGY_PLANNER_ALGORITHM,
    steps: resolved,
  }
}

function toSimulationRequest(
  request: EnergyPlanRequest,
  plan: PlanTrajectory,
): EnergySimulationRequest {
  return {
    snapshot: request.snapshot,
    executionMode: 'simulation',
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    plan,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
  }
}

function objectiveOf(
  simulation: SimulationResult,
  request: EnergyPlanRequest,
  decimals: number,
  valuation: TerminalEnergyValuation | undefined,
): CandidateObjective {
  const terminalEnergyKwh = terminalEnergyOf(simulation)
  const valuationApplicable = valuation !== undefined && valuation.currency === simulation.costs.currency
  const objectiveValue = valuationApplicable
    ? round(simulation.costs.totalCost - terminalEnergyKwh * valuation.valuationPerKwh, decimals)
    : round(simulation.costs.totalCost, decimals)
  const reserveSatisfied = simulation.reserveMargins.every(
    (margin) => margin.severity !== 'hard' || margin.satisfied,
  )
  return {
    kind: 'deterministic_cost',
    currency: simulation.costs.currency,
    netCost: simulation.costs.netCost,
    degradationCost: simulation.costs.degradationCost,
    degradationModelled: simulation.costs.degradationModelled,
    totalCost: simulation.costs.totalCost,
    terminalEnergyKwh: round(terminalEnergyKwh, decimals),
    reserveSatisfied,
    objectiveValue,
    objectiveBasis: valuationApplicable
      ? 'total_cost_with_terminal_energy_valuation'
      : 'total_cost',
    includes: [
      'grid import purchase cost',
      'grid export revenue (a negative cost)',
      simulation.costs.degradationModelled
        ? 'battery degradation cost (linear per-kWh throughput)'
        : 'no battery degradation cost (not modelled)',
    ],
    excludes: unaccountedCostItemsOf(request.battery),
  }
}

function evaluate<S extends CandidateStrategyKind | BaselineStrategyKind>(
  request: EnergyPlanRequest,
  strategy: S,
  trajectory: PlanTrajectory,
  simulation: SimulationResult,
  decimals: number,
  valuation: TerminalEnergyValuation | undefined,
): EvaluatedPlan<S> {
  return {
    planRef: trajectory.planRef,
    strategy,
    plan: trajectory,
    objective: objectiveOf(simulation, request, decimals, valuation),
    simulation,
  }
}

function assemble(request: EnergyPlanRequest, common: {
  readonly status: PlannerStatus
  readonly candidates: readonly CandidatePlan[]
  readonly unavailableStrategies: readonly CandidateUnavailability[]
  readonly selection: PlannerSelection
  readonly baseline?: BaselinePlan
  readonly comparisons: readonly CandidateComparison[]
  readonly jevStrategyScores: readonly JevStrategyScore[]
  readonly unaccountedCostItems: readonly string[]
  readonly assumptions: readonly string[]
}): PlannerResultBase {
  return {
    status: common.status,
    domainStatus: domainStatusOf(common.status),
    optimality: 'best_of_tested_candidates',
    executionMode: 'simulation',
    liveSupported: false,
    plannerVersion: PLANNER_VERSION,
    numericPolicy: NUMERIC_POLICY,
    algorithmVersion: ENERGY_PLANNER_ALGORITHM,
    inputDataMode: request.snapshot.manifest.dataMode,
    inputManifestHash: request.snapshot.digest,
    snapshotRef: request.snapshot.snapshotRef,
    candidates: common.candidates,
    unavailableStrategies: common.unavailableStrategies,
    selection: common.selection,
    ...(common.baseline === undefined ? {} : { baseline: common.baseline }),
    comparisons: common.comparisons,
    jevStrategyScores: common.jevStrategyScores,
    jevScoresInfluencedSelection: false,
    unaccountedCostItems: common.unaccountedCostItems,
    assumptions: common.assumptions,
    evidenceRefs: [request.snapshot.snapshotRef],
  }
}

export class EnergyPlanner implements EnergyPlannerPort {
  readonly #simulator: EnergySimulatorPort

  constructor(simulator: EnergySimulatorPort) {
    this.#simulator = simulator
  }

  plan(request: EnergyPlanRequest): PlannerResult {
    assertSimulationMode(request.executionMode)

    const slotCount = request.snapshot.manifest.slotCount
    const deltaHours = request.snapshot.manifest.slotMinutes / 60
    const decimals = request.tolerance.reportingDecimals
    const declaredValuation = request.terminalEnergyValuation
    const jevStrategyScores = request.jevStrategyScores ?? []
    const unaccountedCostItems = unaccountedCostItemsOf(request.battery)

    const baselineTrajectory = buildTrajectory(request, BASELINE_STRATEGY, [])
    const baselineSimulation = this.#simulator.simulate(
      toSimulationRequest(request, baselineTrajectory),
    )

    if (
      baselineSimulation.status === 'unsupported_topology' ||
      baselineSimulation.status === 'insufficient_data'
    ) {
      return finalize(
        assemble(request, {
          status: baselineSimulation.status,
          candidates: [],
          unavailableStrategies: [],
          selection: {
            reason: baselineSimulation.status,
            optimality: 'best_of_tested_candidates',
            objectiveKind: 'deterministic_cost',
            comparableBasis: false,
            notes: [
              baselineSimulation.status === 'unsupported_topology'
                ? 'the topology is out of the first controlled model; no candidate is generated'
                : 'the input is incomplete; a missing load, PV, price or device parameter is never defaulted',
            ],
          },
          comparisons: [],
          jevStrategyScores,
          unaccountedCostItems,
          assumptions: [...request.assumptions],
        }),
      )
    }

    const physical = physicalSlots(baselineSimulation)
    const batteryNumbers = resolveBatteryNumbers(request.battery)
    const prices = purchasePricesOf(request.tariff, slotCount)
    const { cheapThreshold, expensiveThreshold } = priceThresholds(prices)
    const strategyContext: StrategyContext = {
      slotCount: physical.slotCount,
      deltaHours,
      loadKw: physical.loadKw,
      pvAvailableKw: physical.pvAvailableKw,
      purchasePrices: prices,
      battery: batteryNumbers,
      reserves: request.reserves,
      cheapThreshold,
      expensiveThreshold,
    }

    const valuationForObjective =
      declaredValuation !== undefined && declaredValuation.currency === request.tariff.currency
        ? declaredValuation
        : undefined

    const baseline = evaluate(
      request,
      BASELINE_STRATEGY,
      baselineTrajectory,
      baselineSimulation,
      decimals,
      valuationForObjective,
    )

    const candidates: CandidatePlan[] = []
    const unavailableStrategies: CandidateUnavailability[] = []
    for (const strategy of dedupeStrategies(
      request.strategyWhitelist ?? DEFAULT_CANDIDATE_STRATEGIES,
    )) {
      const availability = strategyAvailability(
        strategy,
        request.battery,
        prices,
        request.tolerance,
      )
      if (availability !== undefined) {
        unavailableStrategies.push(availability)
        continue
      }
      const trajectory = buildTrajectory(request, strategy, generateStrategyPlan(strategy, strategyContext))
      const simulation = this.#simulator.simulate(toSimulationRequest(request, trajectory))
      candidates.push(evaluate(request, strategy, trajectory, simulation, decimals, valuationForObjective))
    }

    const feasible = candidates.filter((candidate) => candidate.simulation.status === 'feasible')
    const terminalEnergies = feasible.map((candidate) => candidate.objective.terminalEnergyKwh)
    const terminalEnergiesEqual =
      terminalEnergies.length <= 1 ||
      Math.max(...terminalEnergies) - Math.min(...terminalEnergies) <=
        request.tolerance.capacityKwh
    const comparableBasis = valuationForObjective !== undefined || terminalEnergiesEqual

    const selectionNotes: string[] = []
    if (!comparableBasis) {
      selectionNotes.push(
        'feasible candidates end at different terminal stored energy and no matching valuation was declared; the ranking used raw total cost and no saving is claimed',
      )
    }
    if (declaredValuation !== undefined && valuationForObjective === undefined) {
      selectionNotes.push(
        'the declared terminal-energy valuation currency did not match the tariff currency, so it was not applied to the objective',
      )
    }

    let status: PlannerStatus
    let selection: PlannerSelection
    if (feasible.length > 0) {
      status = 'feasible'
      const best = feasible.reduce((current, next) =>
        next.objective.objectiveValue < current.objective.objectiveValue ? next : current,
      )
      selection = {
        reason: 'lowest_objective_among_feasible',
        optimality: 'best_of_tested_candidates',
        objectiveKind: 'deterministic_cost',
        selectedPlanRef: best.planRef,
        selectedStrategy: best.strategy,
        objectiveValue: best.objective.objectiveValue,
        comparableBasis,
        notes: selectionNotes,
      }
    } else if (candidates.length === 0) {
      status = 'infeasible'
      selection = {
        reason: 'all_strategies_unavailable',
        optimality: 'best_of_tested_candidates',
        objectiveKind: 'deterministic_cost',
        comparableBasis: false,
        notes: [
          'no bounded candidate strategy was available for this device/data combination',
          ...selectionNotes,
        ],
      }
    } else {
      status = 'infeasible'
      selection = {
        reason: 'no_feasible_candidate',
        optimality: 'best_of_tested_candidates',
        objectiveKind: 'deterministic_cost',
        comparableBasis: false,
        notes: [
          'every tested candidate was infeasible; no plan is selected and the user reserve requirement is left unchanged',
          ...selectionNotes,
        ],
      }
    }

    const comparisons: CandidateComparison[] = candidates.map((candidate) => ({
      ...compareToBaseline({
        baseline: baselineSimulation,
        candidate: candidate.simulation,
        tolerance: request.tolerance,
        ...(declaredValuation === undefined ? {} : { valuation: declaredValuation }),
      }),
      planRef: candidate.planRef,
      strategy: candidate.strategy,
    }))

    const assumptions: string[] = [
      ...request.assumptions,
      'planner execution mode is simulation; no live device state or action is used',
      'every candidate and the baseline use the same input snapshot, device parameters, tariff and reserve conditions',
      'the selected plan is best_of_tested_candidates among a bounded deterministic strategy set, not a global physical optimum',
      ...(valuationForObjective === undefined
        ? []
        : [
            `terminal stored energy is valued at ${valuationForObjective.valuationPerKwh} ${valuationForObjective.currency}/kWh (${valuationForObjective.source})`,
          ]),
    ]

    return finalize(
      assemble(request, {
        status,
        candidates,
        unavailableStrategies,
        selection,
        baseline,
        comparisons,
        jevStrategyScores,
        unaccountedCostItems,
        assumptions,
      }),
    )
  }
}
