import { describe, expect, it } from 'vitest'
import { buildSyntheticScenarioInput } from '../../apps/api/src/composition/home-energy-scenario'

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
    expect(input.assumptions).toContain('reserve_soc_percent=60')
    expect(input.reserves[0]?.windowStartSlot).toBe(68)
  })
})
