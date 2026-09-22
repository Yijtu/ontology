import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIMULATION_TOLERANCE,
  EnergyPlanner,
  EnergySimulator,
  canonicalJson,
  compareToBaseline,
} from '@ontology/extension-home-energy'
import type {
  CandidatePlan,
  EnergyPlanRequest,
  EnergySimulationRequest,
  EnergySimulatorPort,
  JevStrategyScore,
  ReserveConstraint,
  SimulationResult,
  TerminalEnergyValuation,
} from '@ontology/extension-home-energy'
import {
  planFor,
  planningRequest,
  simulationRequest,
  simulationSnapshot,
  tariffFor,
  varyingTariff,
} from '../fixtures/home-energy'
import type { PlanningRequestOverrides } from '../fixtures/home-energy'

/**
 * LOCAL-045 pure energy planner acceptance.
 *
 * Expectations are derived from SPEC E5–E7 and independently reasoned here; the tests do not
 * reproduce the planner algorithm. Coverage: bounded candidates within device constraints, every
 * candidate through the same simulator, no feasible candidate → no forced pick, the user reserve is
 * never lowered, fair baseline comparison on a unified terminal-energy basis (and refusal on a
 * different basis), deterministic objective vs separate JEV scoring, `best_of_tested_candidates`
 * labelling, determinism and explicit simulation/synthetic markers.
 */

const SIMULATOR = new EnergySimulator()
const PLANNER = new EnergyPlanner(SIMULATOR)

const RESERVE_WINDOW: readonly ReserveConstraint[] = [
  {
    reserveEnergyKwh: 9,
    windowStartSlot: 2,
    windowEndSlot: 4,
    source: 'user_preference',
    severity: 'hard',
    requiresIslanding: false,
  },
]

const VALUATION: TerminalEnergyValuation = {
  currency: 'CNY',
  valuationPerKwh: 1.0,
  source: 'fixture_declared',
}

/** A varied-price request that makes all three bounded strategies available and feasible. */
function variedRequest(overrides: PlanningRequestOverrides = {}): EnergyPlanRequest {
  return planningRequest({ tariff: varyingTariff([0.2, 0.2, 1.0, 1.0]), ...overrides })
}

function feasibleCandidates(result: { readonly candidates: readonly CandidatePlan[] }): readonly CandidatePlan[] {
  return result.candidates.filter((candidate) => candidate.simulation.status === 'feasible')
}

describe('bounded candidates run through the same simulator (E5, E-05)', () => {
  it('generates each whitelisted bounded strategy as a candidate', () => {
    const result = PLANNER.plan(variedRequest())
    expect(result.candidates.map((candidate) => candidate.strategy).sort()).toEqual([
      'price_window',
      'reserve_first',
      'self_consumption',
    ])
    expect(result.status).toBe('feasible')
    expect(result.baseline?.strategy).toBe('no_battery_action')
  })

  it('evaluates every candidate and the baseline through one simulator instance', () => {
    class CountingSimulator implements EnergySimulatorPort {
      calls = 0
      readonly #inner = new EnergySimulator()
      simulate(request: EnergySimulationRequest): SimulationResult {
        this.calls += 1
        return this.#inner.simulate(request)
      }
    }
    const counting = new CountingSimulator()
    const result = new EnergyPlanner(counting).plan(variedRequest())
    // One probe/baseline simulation plus one simulation per generated candidate.
    expect(counting.calls).toBe(1 + result.candidates.length)
    for (const candidate of result.candidates) {
      expect(candidate.simulation.algorithmVersion.id).toBe('home-energy.simulator')
    }
  })

  it('runs the baseline and every candidate on the same input snapshot', () => {
    const request = variedRequest()
    const result = PLANNER.plan(request)
    expect(result.baseline?.simulation.inputManifestHash).toBe(request.snapshot.digest)
    for (const candidate of result.candidates) {
      expect(candidate.simulation.inputManifestHash).toBe(request.snapshot.digest)
      expect(candidate.simulation.snapshotRef).toEqual(request.snapshot.snapshotRef)
    }
  })

  it('keeps every generated setpoint within the declared device constraints', () => {
    const request = variedRequest()
    const result = PLANNER.plan(request)
    const battery = request.battery
    for (const candidate of result.candidates) {
      for (const step of candidate.plan.steps) {
        expect(step.chargeKw).toBeGreaterThanOrEqual(0)
        expect(step.dischargeKw).toBeGreaterThanOrEqual(0)
        expect(step.chargeKw).toBeLessThanOrEqual(battery.chargePowerLimitKw ?? 0)
        expect(step.dischargeKw).toBeLessThanOrEqual(battery.dischargePowerLimitKw ?? 0)
        expect(Math.min(step.chargeKw, step.dischargeKw)).toBe(0)
      }
      for (const interval of candidate.simulation.intervals) {
        expect(interval.energyEndKwh).toBeGreaterThanOrEqual((battery.minEnergyKwh ?? 0) - 1e-9)
        expect(interval.energyEndKwh).toBeLessThanOrEqual((battery.maxEnergyKwh ?? 0) + 1e-9)
      }
    }
  })

  it('selects the lowest deterministic objective among feasible candidates', () => {
    const result = PLANNER.plan(variedRequest())
    const feasible = feasibleCandidates(result)
    const best = feasible.reduce((current, next) =>
      next.objective.objectiveValue < current.objective.objectiveValue ? next : current,
    )
    expect(result.selection.selectedPlanRef).toEqual(best.planRef)
    expect(result.selection.selectedStrategy).toBe(best.strategy)
    expect(result.selection.objectiveKind).toBe('deterministic_cost')
    expect(result.selection.objectiveValue).toBeCloseTo(best.objective.objectiveValue, 9)
    expect(result.optimality).toBe('best_of_tested_candidates')
    expect(result.selection.optimality).toBe('best_of_tested_candidates')
  })
})

describe('no feasible candidate is never forced (E-06)', () => {
  it('reports infeasible with no selected plan when the reserve is unreachable', () => {
    const request = planningRequest({
      battery: { initialEnergyKwh: 5, gridChargingAllowed: false },
      reserves: RESERVE_WINDOW,
    })
    const result = PLANNER.plan(request)
    expect(result.status).toBe('infeasible')
    expect(result.domainStatus).toBe('infeasible')
    expect(result.selection.reason).toBe('no_feasible_candidate')
    expect(result.selection.selectedPlanRef).toBeUndefined()
    expect(result.selection.selectedStrategy).toBeUndefined()
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every((candidate) => candidate.simulation.status === 'infeasible')).toBe(
      true,
    )
  })

  it('never lowers the user reserve requirement to manufacture a feasible plan', () => {
    const request = planningRequest({
      battery: { initialEnergyKwh: 5, gridChargingAllowed: false },
      reserves: RESERVE_WINDOW,
    })
    const result = PLANNER.plan(request)
    for (const candidate of result.candidates) {
      expect(candidate.simulation.reserveMargins[0]?.reserveKwh).toBe(9)
      expect(candidate.simulation.reserveMargins[0]?.satisfied).toBe(false)
      expect(candidate.simulation.reserveMargins[0]?.marginKwh).toBeLessThan(0)
      expect(
        candidate.simulation.violations.some((violation) => violation.constraint === 'backup_reserve'),
      ).toBe(true)
    }
    expect(result.baseline?.simulation.reserveMargins[0]?.reserveKwh).toBe(9)
  })

  it('honours a reachable reserve and selects the strategy that reaches it', () => {
    const request = planningRequest({
      battery: { initialEnergyKwh: 7, gridChargingAllowed: true },
      reserves: RESERVE_WINDOW,
    })
    const result = PLANNER.plan(request)
    expect(result.status).toBe('feasible')
    expect(result.selection.selectedStrategy).toBe('reserve_first')
    const selected = feasibleCandidates(result).find(
      (candidate) => candidate.planRef.id === result.selection.selectedPlanRef?.id,
    )
    expect(selected?.simulation.reserveMargins[0]?.reserveKwh).toBe(9)
    expect(selected?.simulation.reserveMargins[0]?.satisfied).toBe(true)
    // The reserve is reached by charging ahead of the window, not by relaxing the requirement.
    expect((selected?.plan.steps[0]?.chargeKw ?? 0) + (selected?.plan.steps[1]?.chargeKw ?? 0)).toBeGreaterThan(0)
  })

  it('leaves the reserve requirement in the baseline too, so the input is shared', () => {
    const result = PLANNER.plan(
      planningRequest({ battery: { initialEnergyKwh: 5, gridChargingAllowed: false }, reserves: RESERVE_WINDOW }),
    )
    expect(result.baseline?.simulation.reserveMargins[0]?.reserveKwh).toBe(9)
    expect(result.baseline?.simulation.inputManifestHash).toBe(result.inputManifestHash)
  })
})

describe('fair baseline comparison on a unified basis (E5, E-08)', () => {
  it('refuses a saving claim when terminal energies differ without a valuation', () => {
    const result = PLANNER.plan(variedRequest())
    expect(result.comparisons.length).toBe(result.candidates.length)
    for (const comparison of result.comparisons) {
      expect(comparison.comparable).toBe(false)
      expect(comparison.refusal).toBe('unequal_terminal_energy_without_valuation')
      expect(comparison.savingsClaim).toBe(false)
      expect(comparison.adjustedCostDelta).toBeUndefined()
    }
  })

  it('compares on one unified valuation basis when a valuation is declared', () => {
    const result = PLANNER.plan(variedRequest({ terminalEnergyValuation: VALUATION }))
    for (const comparison of result.comparisons) {
      expect(comparison.comparable).toBe(true)
      expect(comparison.basis).toBe('unified_valuation')
      expect(comparison.valuationPerKwh).toBe(1.0)
      expect(comparison.adjustedCostDelta).toBeCloseTo(
        comparison.rawCostDelta - comparison.terminalEnergyDeltaKwh * 1.0,
        9,
      )
    }
    expect(result.selection.comparableBasis).toBe(true)
    for (const candidate of result.candidates) {
      expect(candidate.objective.objectiveBasis).toBe('total_cost_with_terminal_energy_valuation')
    }
  })

  it('accepts an equal-terminal comparison with no saving when the plans match', () => {
    const baseline = SIMULATOR.simulate(simulationRequest({ plan: planFor(4) }))
    const same = SIMULATOR.simulate(simulationRequest({ plan: planFor(4) }))
    const comparison = compareToBaseline({
      baseline,
      candidate: same,
      tolerance: DEFAULT_SIMULATION_TOLERANCE,
    })
    expect(comparison.comparable).toBe(true)
    expect(comparison.basis).toBe('equal_terminal_energy')
    expect(comparison.rawCostDelta).toBeCloseTo(0, 9)
    expect(comparison.savingsClaim).toBe(false)
  })

  it('refuses to compare two different input snapshots', () => {
    const baseline = SIMULATOR.simulate(
      simulationRequest({ snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [4, 4, 0, 0] }), plan: planFor(4) }),
    )
    const other = SIMULATOR.simulate(
      simulationRequest({ snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [3, 3, 0, 0] }), plan: planFor(4) }),
    )
    const comparison = compareToBaseline({
      baseline,
      candidate: other,
      tolerance: DEFAULT_SIMULATION_TOLERANCE,
    })
    expect(comparison.comparable).toBe(false)
    expect(comparison.refusal).toBe('different_input_snapshot')
    expect(comparison.savingsClaim).toBe(false)
  })

  it('refuses to compare two different currencies', () => {
    const baseline = SIMULATOR.simulate(simulationRequest({ plan: planFor(4) }))
    const usd = SIMULATOR.simulate(
      simulationRequest({
        tariff: { ...tariffFor(4, 1.0, 0.4), currency: 'USD' },
        plan: planFor(4, [{ slotIndex: 0, chargeKw: 2, dischargeKw: 0 }]),
      }),
    )
    const comparison = compareToBaseline({
      baseline,
      candidate: usd,
      tolerance: DEFAULT_SIMULATION_TOLERANCE,
    })
    expect(comparison.comparable).toBe(false)
    expect(comparison.refusal).toBe('different_currency')
  })

  it('refuses a saving against a baseline that does not satisfy the constraints', () => {
    const battery = { initialEnergyKwh: 7, gridChargingAllowed: true }
    const baseline = SIMULATOR.simulate(
      simulationRequest({ battery, reserves: RESERVE_WINDOW, plan: planFor(4) }),
    )
    const candidate = SIMULATOR.simulate(
      simulationRequest({
        battery,
        reserves: RESERVE_WINDOW,
        plan: planFor(4, [
          { slotIndex: 0, chargeKw: 5, dischargeKw: 0 },
          { slotIndex: 1, chargeKw: 5, dischargeKw: 0 },
        ]),
      }),
    )
    expect(baseline.status).toBe('infeasible')
    expect(candidate.status).toBe('feasible')
    const comparison = compareToBaseline({
      baseline,
      candidate,
      tolerance: DEFAULT_SIMULATION_TOLERANCE,
    })
    expect(comparison.comparable).toBe(false)
    expect(comparison.refusal).toBe('baseline_not_feasible')
    expect(comparison.savingsClaim).toBe(false)
  })

  it('refuses a saving from an infeasible candidate', () => {
    const battery = { initialEnergyKwh: 7, gridChargingAllowed: true }
    const baseline = SIMULATOR.simulate(
      simulationRequest({
        battery,
        reserves: RESERVE_WINDOW,
        plan: planFor(4, [
          { slotIndex: 0, chargeKw: 5, dischargeKw: 0 },
          { slotIndex: 1, chargeKw: 5, dischargeKw: 0 },
        ]),
      }),
    )
    const candidate = SIMULATOR.simulate(
      simulationRequest({ battery, reserves: RESERVE_WINDOW, plan: planFor(4) }),
    )
    expect(baseline.status).toBe('feasible')
    expect(candidate.status).toBe('infeasible')
    const comparison = compareToBaseline({
      baseline,
      candidate,
      tolerance: DEFAULT_SIMULATION_TOLERANCE,
    })
    expect(comparison.comparable).toBe(false)
    expect(comparison.refusal).toBe('candidate_not_feasible')
    expect(comparison.savingsClaim).toBe(false)
  })

  it('refuses a valuation whose currency does not match the tariff', () => {
    const result = PLANNER.plan(
      variedRequest({
        terminalEnergyValuation: { currency: 'USD', valuationPerKwh: 1.0, source: 'user_declared' },
      }),
    )
    for (const comparison of result.comparisons) {
      expect(comparison.comparable).toBe(false)
      expect(comparison.refusal).toBe('valuation_currency_mismatch')
    }
    for (const candidate of result.candidates) {
      expect(candidate.objective.objectiveBasis).toBe('total_cost')
    }
    expect(result.selection.comparableBasis).toBe(false)
  })
})

describe('objective is separate from optional JEV strategy scoring (E3, C2, ADR-09)', () => {
  it('does not let a JEV score change the selected candidate', () => {
    const withoutScores = PLANNER.plan(variedRequest())
    const selected = withoutScores.selection.selectedPlanRef
    const notSelected = withoutScores.candidates.find(
      (candidate) => candidate.planRef.id !== selected?.id,
    )
    expect(selected).toBeDefined()
    expect(notSelected).toBeDefined()
    if (selected === undefined || notSelected === undefined) return

    const scores: readonly JevStrategyScore[] = [
      {
        kind: 'jev_strategy_score',
        planRef: notSelected.planRef,
        strategy: notSelected.strategy,
        probability: 0.99,
        optionSetRef: { id: 'home-energy.strategy.option-set', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
      },
      {
        kind: 'jev_strategy_score',
        planRef: selected,
        strategy: withoutScores.selection.selectedStrategy ?? 'self_consumption',
        probability: 0.01,
        optionSetRef: { id: 'home-energy.strategy.option-set', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
      },
    ]

    const withScores = PLANNER.plan(variedRequest({ jevStrategyScores: scores }))
    expect(withScores.selection.selectedPlanRef).toEqual(selected)
    expect(withScores.jevScoresInfluencedSelection).toBe(false)
    expect(withScores.jevStrategyScores).toHaveLength(2)
    expect(withScores.jevStrategyScores.map((score) => score.probability).sort()).toEqual([0.01, 0.99])
    expect('probability' in withScores.selection).toBe(false)

    // The deterministic objective is byte-identical with and without the JEV scores.
    const objectiveWithout = withoutScores.candidates.map((candidate) => candidate.objective)
    const objectiveWith = withScores.candidates.map((candidate) => candidate.objective)
    expect(canonicalJson(objectiveWith)).toBe(canonicalJson(objectiveWithout))
    expect(withScores.selection.objectiveValue).toBe(withoutScores.selection.objectiveValue)
  })

  it('labels the outcome best_of_tested_candidates, never a global optimum', () => {
    const result = PLANNER.plan(variedRequest())
    expect(result.optimality).toBe('best_of_tested_candidates')
    expect(result.selection.optimality).toBe('best_of_tested_candidates')
    expect(canonicalJson(result.selection)).not.toContain('global')
  })
})

describe('strategy availability is explicit, never silently substituted', () => {
  it('reports price_window unavailable when grid charging is not allowed', () => {
    const result = PLANNER.plan(planningRequest({ battery: { gridChargingAllowed: false } }))
    const unavailable = result.unavailableStrategies.find(
      (entry) => entry.strategy === 'price_window',
    )
    expect(unavailable?.reason).toBe('grid_charging_not_allowed')
    expect(result.candidates.some((candidate) => candidate.strategy === 'price_window')).toBe(false)
  })

  it('reports price_window unavailable when the tariff has no spread', () => {
    const result = PLANNER.plan(planningRequest({ tariff: tariffFor(4, 1.0, 0.4) }))
    const unavailable = result.unavailableStrategies.find(
      (entry) => entry.strategy === 'price_window',
    )
    expect(unavailable?.reason).toBe('no_price_spread')
  })

  it('reports all_strategies_unavailable when no bounded strategy can be generated', () => {
    const result = PLANNER.plan(
      planningRequest({ battery: { gridChargingAllowed: false }, strategyWhitelist: ['price_window'] }),
    )
    expect(result.candidates).toEqual([])
    expect(result.status).toBe('infeasible')
    expect(result.selection.reason).toBe('all_strategies_unavailable')
    expect(result.selection.selectedPlanRef).toBeUndefined()
  })
})

describe('explicit unaccounted costs, assumptions and markers (E3, INV-10)', () => {
  it('lists unaccounted cost items and states the simulation assumption', () => {
    const result = PLANNER.plan(variedRequest())
    expect(result.unaccountedCostItems.some((item) => item.includes('degradation'))).toBe(true)
    expect(result.assumptions).toContain(
      'planner execution mode is simulation; no live device state or action is used',
    )
    expect(result.assumptions).toContain(
      'the selected plan is best_of_tested_candidates among a bounded deterministic strategy set, not a global physical optimum',
    )
    for (const candidate of result.candidates) {
      expect(candidate.objective.excludes.length).toBeGreaterThan(0)
    }
  })

  it('drops the degradation item once a degradation cost is declared', () => {
    const result = PLANNER.plan(variedRequest({ battery: { degradationCostPerKwh: 0.05 } }))
    expect(result.unaccountedCostItems.some((item) => item.includes('degradation'))).toBe(false)
    for (const candidate of result.candidates) {
      expect(candidate.objective.degradationModelled).toBe(true)
    }
  })

  it('marks the execution mode, data mode and each sampling type explicitly', () => {
    const result = PLANNER.plan(variedRequest())
    expect(result.executionMode).toBe('simulation')
    expect(result.liveSupported).toBe(false)
    expect(result.inputDataMode).toBe('synthetic')
    for (const candidate of result.candidates) {
      expect(candidate.simulation.executionMode).toBe('simulation')
      expect(candidate.simulation.liveSupported).toBe(false)
      expect(candidate.simulation.samplingMarkers).toEqual([
        { measurementPointRef: 'mp-load', role: 'load', samplingType: 'observed', synthetic: true },
        { measurementPointRef: 'mp-pv', role: 'pv', samplingType: 'forecast', synthetic: true },
      ])
    }
  })
})

describe('determinism and purity', () => {
  it('produces byte-identical results for the same request', () => {
    const request = variedRequest()
    const first = PLANNER.plan(request)
    const second = PLANNER.plan(request)
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.resultDigest).toBe(second.resultDigest)
    expect(first.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first).toEqual(second)
  })

  it('has no reachable I/O or ambient clock in the planning source (structural purity)', () => {
    const directory = fileURLToPath(
      new URL('../../packages/extensions/home-energy/src/planning', import.meta.url),
    )
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    const forbidden = [
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'node:child_process',
      'node:dgram',
      'node:tls',
      'node:dns',
      'node:os',
      'Date.now',
      'Math.random',
      'performance.now',
      'process.env',
      'setTimeout',
      'setInterval',
      'fetch(',
      'require(',
    ]
    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8')
      for (const token of forbidden) {
        expect(source, `${file} must not contain ${token}`).not.toContain(token)
      }
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('@ontology/contracts') || specifier.startsWith('.'),
          `${file} may not import ${specifier}`,
        ).toBe(true)
      }
    }
  })
})

describe('unsupported topology and incomplete input are explicit outcomes', () => {
  it('returns unsupported_topology without generating candidates', () => {
    const result = PLANNER.plan(
      planningRequest({
        topology: { kind: 'dc_coupled', detail: 'DC-coupled storage is out of the first model' },
      }),
    )
    expect(result.status).toBe('unsupported_topology')
    expect(result.domainStatus).toBe('not_applicable')
    expect(result.candidates).toEqual([])
    expect(result.selection.selectedPlanRef).toBeUndefined()
  })

  it('returns insufficient_data when a key input is missing', () => {
    const result = PLANNER.plan(planningRequest({ load: [] }))
    expect(result.status).toBe('insufficient_data')
    expect(result.domainStatus).toBe('unknown')
    expect(result.candidates).toEqual([])
  })
})
