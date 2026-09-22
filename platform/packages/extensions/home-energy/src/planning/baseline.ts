import type { BatterySpecDeclaration, SimulationResult, SimulationTolerance } from '../simulation'
import type {
  BaselineComparison,
  BaselineComparisonRefusal,
  TerminalEnergyValuation,
} from './types'

/**
 * Fair baseline comparison (SPEC E5, E-08).
 *
 * A saving is only ever claimed when the baseline and the candidate were computed from the *same*
 * input snapshot, in the same currency, and either end at the same terminal stored energy or are
 * put on one basis by an explicit residual-energy valuation. Comparing only spend while the two
 * plans end at different SOC is refused, not presented as an improvement — otherwise draining the
 * battery early would look like a saving.
 *
 * A refused comparison is a successful computation result, not an error.
 */

export function terminalEnergyOf(result: SimulationResult): number {
  const last = result.intervals[result.intervals.length - 1]
  return last === undefined ? 0 : last.energyEndKwh
}

export function unaccountedCostItemsOf(battery: BatterySpecDeclaration): readonly string[] {
  const items: string[] = []
  if (battery.degradationCostPerKwh === undefined) {
    items.push(
      'battery degradation / throughput wear is not modelled (no degradation_cost_per_kwh declared)',
    )
  }
  items.push('grid demand, standing and capacity charges are not modelled')
  items.push('battery standby and self-discharge losses are not modelled')
  items.push('inverter losses beyond the declared charge/discharge efficiency are not modelled')
  items.push('taxes, levies and meter-reading rounding are not modelled')
  items.push('the opportunity cost of curtailed PV is not valued')
  return items
}

export interface CompareToBaselineRequest {
  readonly baseline: SimulationResult
  readonly candidate: SimulationResult
  readonly tolerance: SimulationTolerance
  readonly valuation?: TerminalEnergyValuation
}

function refused(
  baseline: SimulationResult,
  candidate: SimulationResult,
  refusal: BaselineComparisonRefusal,
  note: string,
): BaselineComparison {
  return {
    comparable: false,
    refusal,
    currency: candidate.costs.currency,
    baselineTerminalEnergyKwh: terminalEnergyOf(baseline),
    candidateTerminalEnergyKwh: terminalEnergyOf(candidate),
    terminalEnergyDeltaKwh: terminalEnergyOf(candidate) - terminalEnergyOf(baseline),
    baselineTotalCost: baseline.costs.totalCost,
    candidateTotalCost: candidate.costs.totalCost,
    rawCostDelta: candidate.costs.totalCost - baseline.costs.totalCost,
    savingsClaim: false,
    notes: [note],
  }
}

export function compareToBaseline(request: CompareToBaselineRequest): BaselineComparison {
  const { baseline, candidate, tolerance, valuation } = request

  if (baseline.inputManifestHash !== candidate.inputManifestHash) {
    return refused(
      baseline,
      candidate,
      'different_input_snapshot',
      'the baseline and the candidate were computed from different input snapshots; a savings comparison requires the same input',
    )
  }
  if (baseline.costs.currency !== candidate.costs.currency) {
    return refused(
      baseline,
      candidate,
      'different_currency',
      'the baseline and the candidate are in different currencies; the costs are not comparable',
    )
  }
  if (baseline.status !== 'feasible') {
    return refused(
      baseline,
      candidate,
      'baseline_not_feasible',
      `the baseline is ${baseline.status}; savings against a plan that does not satisfy the constraints are not claimed`,
    )
  }
  if (candidate.status !== 'feasible') {
    return refused(
      baseline,
      candidate,
      'candidate_not_feasible',
      `the candidate is ${candidate.status}; an infeasible candidate is never presented as a saving`,
    )
  }

  const currency = candidate.costs.currency
  if (valuation !== undefined && valuation.currency !== currency) {
    return refused(
      baseline,
      candidate,
      'valuation_currency_mismatch',
      `the terminal-energy valuation is in ${valuation.currency} but the costs are in ${currency}; the valuation cannot be applied`,
    )
  }

  const baselineTerminalEnergyKwh = terminalEnergyOf(baseline)
  const candidateTerminalEnergyKwh = terminalEnergyOf(candidate)
  const terminalEnergyDeltaKwh = candidateTerminalEnergyKwh - baselineTerminalEnergyKwh
  const rawCostDelta = candidate.costs.totalCost - baseline.costs.totalCost

  if (Math.abs(terminalEnergyDeltaKwh) <= tolerance.capacityKwh) {
    return {
      comparable: true,
      basis: 'equal_terminal_energy',
      currency,
      baselineTerminalEnergyKwh,
      candidateTerminalEnergyKwh,
      terminalEnergyDeltaKwh,
      baselineTotalCost: baseline.costs.totalCost,
      candidateTotalCost: candidate.costs.totalCost,
      rawCostDelta,
      adjustedCostDelta: rawCostDelta,
      savingsClaim: rawCostDelta < -tolerance.cost,
      notes: ['the baseline and the candidate end at the same terminal stored energy'],
    }
  }

  if (valuation !== undefined) {
    const adjustedCostDelta = rawCostDelta - terminalEnergyDeltaKwh * valuation.valuationPerKwh
    return {
      comparable: true,
      basis: 'unified_valuation',
      currency,
      baselineTerminalEnergyKwh,
      candidateTerminalEnergyKwh,
      terminalEnergyDeltaKwh,
      baselineTotalCost: baseline.costs.totalCost,
      candidateTotalCost: candidate.costs.totalCost,
      rawCostDelta,
      adjustedCostDelta,
      valuationPerKwh: valuation.valuationPerKwh,
      savingsClaim: adjustedCostDelta < -tolerance.cost,
      notes: [
        `terminal stored energy is valued at ${valuation.valuationPerKwh} ${valuation.currency}/kWh (${valuation.source})`,
      ],
    }
  }

  return refused(
    baseline,
    candidate,
    'unequal_terminal_energy_without_valuation',
    'the plans end at different terminal stored energy and no valuation basis was declared; the raw spend difference is not a saving',
  )
}
