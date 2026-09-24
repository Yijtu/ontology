import { describe, expect, it } from 'vitest'
import { EnergyPlanner, EnergySimulator } from '@ontology/extension-home-energy'
import { buildSyntheticScenarioInput } from '../../apps/api/src/composition/home-energy-scenario'

function evaluate(input: ReturnType<typeof buildSyntheticScenarioInput>) {
  return new EnergyPlanner(new EnergySimulator()).plan({
    snapshot: input.snapshot, executionMode: 'simulation', topology: input.topology,
    battery: input.battery, grid: input.grid, load: input.load, pv: input.pv,
    tariff: input.tariff, reserves: input.reserves, tolerance: input.tolerance,
    assumptions: input.assumptions,
    ...(input.terminalEnergyValuation === undefined ? {} : { terminalEnergyValuation: input.terminalEnergyValuation }),
  })
}

describe('Anker time-segmented synthetic scenarios', () => {
  it('keeps morning-cloud PV fixed and changes only afternoon forecast slots', () => {
    const base = buildSyntheticScenarioInput({ reserveSocPercent: 20, weatherScenario: 'anker_base' })
    const afternoonCloud = buildSyntheticScenarioInput({ reserveSocPercent: 20, weatherScenario: 'afternoon_overcast' })
    const getPv = (input: typeof base) => input.snapshot.manifest.series.find((series) => series.measurementPointRef === 'mp-pv')?.points.map((point) => point.value) ?? []
    const sunnyAfternoon = getPv(base)
    const cloudyAfternoon = getPv(afternoonCloud)
    expect(sunnyAfternoon).toHaveLength(96)
    expect(cloudyAfternoon).toHaveLength(96)
    expect(cloudyAfternoon.slice(0, 48)).toEqual(sunnyAfternoon.slice(0, 48))
    expect(cloudyAfternoon.slice(48, 76).reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBeLessThan(sunnyAfternoon.slice(48, 76).reduce<number>((sum, value) => sum + (value ?? 0), 0))
    expect(cloudyAfternoon.slice(76)).toEqual(sunnyAfternoon.slice(76))
  })

  it('locks a replanning input to the observed state and advances the UTC horizon', () => {
    const input = buildSyntheticScenarioInput(
      { reserveSocPercent: 60, reserveWindowStartSlot: 68, weatherScenario: 'anker_base' },
      { energyKwh: 5.25, revision: 96, simulatedAt: '2026-01-01T16:00:00.000Z' },
    )
    expect(input.snapshot.manifest.horizon.start).toBe('2026-01-01T16:00:00.000Z')
    expect(input.battery.initialEnergyKwh).toBe(5.25)
    expect(input.assumptions).toContain('state_revision=96')
    expect(input.assumptions).toContain('synthetic_daily_profile_repeats_each_simulated_day')
    expect(input.assumptions).toContain('reserve_soc_percent=60')
    expect(input.reserves[0]?.windowStartSlot).toBe(68)
  })

  it('stops planning on an expired or missing afternoon PV forecast instead of publishing a cost', () => {
    const expired = evaluate(buildSyntheticScenarioInput({ reserveSocPercent: 20, weatherScenario: 'anker_base', forecastIntegrity: 'expired' }))
    expect(expired.status).toBe('insufficient_data')
    expect(expired.selection.selectedPlanRef).toBeUndefined()
    expect(expired.candidates).toHaveLength(0)
    expect(expired.missingInputs.some((item) => item.reason === 'forecast_expired')).toBe(true)

    const missing = evaluate(buildSyntheticScenarioInput({ reserveSocPercent: 20, weatherScenario: 'anker_base', forecastIntegrity: 'missing' }))
    expect(missing.status).toBe('insufficient_data')
    expect(missing.selection.selectedPlanRef).toBeUndefined()
    expect(missing.candidates).toHaveLength(0)
    expect(missing.missingInputs.some((item) => item.reason === 'missing_slot_value' && item.slotIndex === 48)).toBe(true)
  })
})
