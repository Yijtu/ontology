import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EnergySimulator,
  EnergySimulationError,
  assertSimulationMode,
  canonicalJson,
} from '@ontology/extension-home-energy'
import type {
  BatterySpecDeclaration,
  ConstraintViolation,
  EnergySimulationRequest,
  SimulationResult,
} from '@ontology/extension-home-energy'
import {
  SIM_LOAD_BINDING,
  SIM_PV_BINDING,
  planFor,
  simulationRequest,
  simulationSnapshot,
  tariffFor,
} from '../fixtures/home-energy'

/**
 * LOCAL-044 pure energy simulator acceptance.
 *
 * Expectations are hand-derived from SPEC E4 and independently recomputed here — the test does
 * not copy the simulator algorithm. Coverage: storage recursion + energy balance, cost, each
 * physical constraint with the exact offending slot, tolerance traceability, determinism,
 * unsupported topology, missing key parameters, infeasible-as-a-domain-result, explicit
 * simulation/synthetic/forecast markers, and structural purity.
 */

const SIMULATOR = new EnergySimulator()

function violationOf(
  result: SimulationResult,
  constraint: ConstraintViolation['constraint'],
  slotIndex: number,
): ConstraintViolation | undefined {
  return result.violations.find(
    (violation) => violation.constraint === constraint && violation.slotIndex === slotIndex,
  )
}

const BATTERY_WITHOUT_DISCHARGE_EFFICIENCY: BatterySpecDeclaration = {
  deviceRef: 'battery-1',
  specSource: 'synthetic_assumption',
  energyCapacityKwh: 10,
  minEnergyKwh: 1,
  maxEnergyKwh: 10,
  chargePowerLimitKw: 5,
  dischargePowerLimitKw: 5,
  chargeEfficiency: 0.9,
  initialEnergyKwh: 5,
  gridChargingAllowed: true,
  exportAllowed: true,
  islandingSupported: false,
}

describe('storage recursion, energy balance and cost (E4, E-04)', () => {
  const request = simulationRequest({
    plan: planFor(4, [
      { slotIndex: 2, chargeKw: 2, dischargeKw: 0 },
      { slotIndex: 3, chargeKw: 0, dischargeKw: 2 },
    ]),
  })
  const result = SIMULATOR.simulate(request)

  it('runs the hand-checked trajectory as feasible', () => {
    expect(result.status).toBe('feasible')
    expect(result.domainStatus).toBe('known')
    expect(result.optimality).toBe('not_claimed')
    expect(result.intervals).toHaveLength(4)
  })

  it('applies the storage recursion E(t+1) = E(t) + eta_c*C*dt - D*dt/eta_d', () => {
    const energyEnd = result.intervals.map((interval) => interval.energyEndKwh)
    // E0=5; slot2 charges 2 kW for 0.25h at 0.9 -> +0.45; slot3 discharges 2 kW for 0.25h /0.9.
    expect(energyEnd[0]).toBeCloseTo(5, 9)
    expect(energyEnd[1]).toBeCloseTo(5, 9)
    expect(energyEnd[2]).toBeCloseTo(5.45, 9)
    expect(energyEnd[3]).toBeCloseTo(4.894444444444, 9)
  })

  it('derives grid import/export from the AC-side balance', () => {
    expect(result.intervals.map((interval) => interval.gridExportKw)).toEqual([3, 3, 0, 1])
    expect(result.intervals.map((interval) => interval.gridImportKw)).toEqual([0, 0, 3, 0])
  })

  it('keeps the energy-balance residual within the declared tolerance in every slot', () => {
    for (const interval of result.intervals) {
      expect(Math.abs(interval.energyBalanceResidualKwh)).toBeLessThanOrEqual(
        request.tolerance.energyBalanceKwh,
      )
    }
  })

  it('computes cost = sum(import*purchase - export*export)*dt', () => {
    // import 3 kW * 0.25h * 1.0 = 0.75; export (3+3+1) kW * 0.25h * 0.4 = 0.7.
    expect(result.costs.currency).toBe('CNY')
    expect(result.costs.importCost).toBeCloseTo(0.75, 9)
    expect(result.costs.exportRevenue).toBeCloseTo(0.7, 9)
    expect(result.costs.netCost).toBeCloseTo(0.05, 9)
    expect(result.costs.degradationModelled).toBe(false)
    expect(result.costs.totalCost).toBeCloseTo(0.05, 9)
  })

  it('carries the explicit tolerance configuration and numeric policy into the result', () => {
    expect(result.tolerance).toEqual(request.tolerance)
    expect(result.numericPolicy).toContain('ieee754')
    expect(result.simulationVersion).toBe('1.0.0')
    expect(result.algorithmVersion.id).toBe('home-energy.simulator')
  })

  it('does not zero a negative purchase price', () => {
    const negative = SIMULATOR.simulate(
      simulationRequest({
        tariff: tariffFor(4, -0.2, 0.4),
        plan: planFor(4, [{ slotIndex: 2, chargeKw: 2, dischargeKw: 0 }]),
      }),
    )
    expect(negative.status).toBe('feasible')
    expect(negative.intervals[2]?.importCost).toBeCloseTo(-0.15, 9)
    // slot2 (3 kW) plus slot3 idle-load (1 kW), both at -0.2 CNY/kWh over 0.25h.
    expect(negative.costs.importCost).toBeCloseTo(-0.2, 9)
    expect(negative.costs.importCost).not.toBe(0)
  })
})

describe('per-constraint violations name the exact slot (E-05)', () => {
  it('reports a capacity violation at the slot that leaves [min, max]', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [0, 0, 0, 0] }),
        battery: { initialEnergyKwh: 2 },
        plan: planFor(4, [
          { slotIndex: 0, chargeKw: 0, dischargeKw: 4 },
          { slotIndex: 1, chargeKw: 5, dischargeKw: 0 },
        ]),
      }),
    )
    expect(result.status).toBe('infeasible')
    const violation = violationOf(result, 'capacity', 0)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBeCloseTo(0.888888888888, 6)
    expect(violation?.limit).toBe(1)
    // E1 recovers above the minimum, so no later capacity violation is reported.
    expect(result.violations.filter((entry) => entry.constraint === 'capacity')).toHaveLength(1)
  })

  it('reports a capacity violation above the maximum at the offending slot', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        battery: { initialEnergyKwh: 9.5 },
        plan: planFor(4, [{ slotIndex: 0, chargeKw: 5, dischargeKw: 0 }]),
      }),
    )
    expect(violationOf(result, 'capacity', 0)).toBeDefined()
    expect(violationOf(result, 'capacity', 0)?.limit).toBe(10)
  })

  it('reports a power violation when the charge setpoint exceeds the device limit', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({ plan: planFor(4, [{ slotIndex: 2, chargeKw: 6, dischargeKw: 0 }]) }),
    )
    const violation = violationOf(result, 'power', 2)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBe(6)
    expect(violation?.limit).toBe(5)
    expect(result.status).toBe('infeasible')
  })

  it('reports an efficiency violation when the plan assumes a different efficiency', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        plan: planFor(4, [
          { slotIndex: 1, chargeKw: 0, dischargeKw: 0, assumedChargeEfficiency: 0.95 },
        ]),
      }),
    )
    const violation = violationOf(result, 'efficiency', 1)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBe(0.95)
    expect(violation?.limit).toBe(0.9)
  })

  it('reports a charge/discharge exclusivity violation at the offending slot', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [0, 0, 0, 0] }),
        plan: planFor(4, [{ slotIndex: 1, chargeKw: 1, dischargeKw: 1 }]),
      }),
    )
    expect(violationOf(result, 'charge_discharge_exclusivity', 1)).toBeDefined()
  })

  it('reports an export-limit violation when export is disallowed', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        battery: { exportAllowed: false },
        plan: planFor(4, [{ slotIndex: 3, chargeKw: 0, dischargeKw: 3 }]),
      }),
    )
    const violation = violationOf(result, 'export_limit', 3)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBeCloseTo(2, 9)
    expect(result.status).toBe('infeasible')
  })

  it('reports an export-limit violation when grid export exceeds the declared limit', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        grid: { connectionRef: 'grid-1', exportPowerLimitKw: 2 },
        plan: planFor(4, [{ slotIndex: 0, chargeKw: 0, dischargeKw: 4 }]),
      }),
    )
    const violation = violationOf(result, 'export_limit', 0)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBeCloseTo(7, 9)
    expect(violation?.limit).toBe(2)
  })

  it('reports a grid-import-limit violation at the offending slot', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        grid: { connectionRef: 'grid-1', importPowerLimitKw: 2 },
        plan: planFor(4, [{ slotIndex: 2, chargeKw: 2, dischargeKw: 0 }]),
      }),
    )
    const violation = violationOf(result, 'grid_import_limit', 2)
    expect(violation).toBeDefined()
    expect(violation?.observed).toBeCloseTo(3, 9)
    expect(violation?.limit).toBe(2)
  })

  it('reports a grid-charging violation when grid charging is disallowed', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        battery: { gridChargingAllowed: false },
        plan: planFor(4, [{ slotIndex: 2, chargeKw: 2, dischargeKw: 0 }]),
      }),
    )
    expect(violationOf(result, 'grid_charging', 2)).toBeDefined()
  })

  it('reports a grid import/export exclusivity violation alongside charge/discharge', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [0, 0, 0, 0] }),
        plan: planFor(4, [{ slotIndex: 0, chargeKw: 2, dischargeKw: 5 }]),
      }),
    )
    expect(violationOf(result, 'charge_discharge_exclusivity', 0)).toBeDefined()
    expect(violationOf(result, 'grid_import_export_exclusivity', 0)).toBeDefined()
  })

  it('reports a backup-reserve violation at the slot of minimum stored energy', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        reserves: [
          {
            reserveEnergyKwh: 4.9,
            windowStartSlot: 0,
            windowEndSlot: 4,
            source: 'user_preference',
            severity: 'hard',
            requiresIslanding: false,
          },
        ],
        plan: planFor(4, [{ slotIndex: 0, chargeKw: 0, dischargeKw: 1 }]),
      }),
    )
    expect(violationOf(result, 'backup_reserve', 0)).toBeDefined()
    expect(result.reserveMargins[0]?.satisfied).toBe(false)
    expect(result.reserveMargins[0]?.marginKwh).toBeLessThan(0)
  })

  it('does not promise outage supply when islanding is not supported', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        reserves: [
          {
            reserveEnergyKwh: 2,
            windowStartSlot: 0,
            windowEndSlot: 4,
            source: 'device_hard_constraint',
            severity: 'hard',
            requiresIslanding: true,
          },
        ],
      }),
    )
    expect(violationOf(result, 'islanding', 0)).toBeDefined()
    expect(result.status).toBe('infeasible')
  })
})

describe('infeasible reserve target is a domain result, never a probability (E-06)', () => {
  it('returns infeasible with the exact gap and does not lower the user target', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, 1, 1, 1], pvKw: [0, 0, 0, 0] }),
        battery: { gridChargingAllowed: false },
        reserves: [
          {
            reserveEnergyKwh: 9,
            windowStartSlot: 0,
            windowEndSlot: 4,
            source: 'user_preference',
            severity: 'hard',
            requiresIslanding: false,
          },
        ],
      }),
    )
    expect(result.status).toBe('infeasible')
    expect(result.domainStatus).toBe('infeasible')
    expect(result.reserveMargins[0]?.reserveKwh).toBe(9)
    expect(result.reserveMargins[0]?.minimumEnergyKwh).toBeCloseTo(5, 9)
    expect(result.reserveMargins[0]?.marginKwh).toBeCloseTo(-4, 9)
    expect(violationOf(result, 'backup_reserve', 0)).toBeDefined()
    expect('probability' in result).toBe(false)
    expect('confidence' in result).toBe(false)
  })
})

describe('explicit statuses for unsupported topology and missing parameters', () => {
  it('refuses an unsupported topology instead of approximating it', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        topology: { kind: 'dc_coupled', detail: 'DC-coupled storage is out of the first model' },
      }),
    )
    expect(result.status).toBe('unsupported_topology')
    expect(result.domainStatus).toBe('not_applicable')
    expect(result.intervals).toEqual([])
    expect(result.unsupportedReasons).toEqual(['DC-coupled storage is out of the first model'])
  })

  it('returns insufficient_data for a missing key battery parameter', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({ batterySpec: BATTERY_WITHOUT_DISCHARGE_EFFICIENCY }),
    )
    expect(result.status).toBe('insufficient_data')
    expect(result.domainStatus).toBe('unknown')
    expect(
      result.missingInputs.some(
        (entry) =>
          entry.reason === 'missing_battery_parameter' && entry.parameter === 'discharge_efficiency',
      ),
    ).toBe(true)
    expect(result.intervals).toEqual([])
  })

  it('returns insufficient_data when a tariff price is missing, not a zero price', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        tariff: {
          tariffRef: tariffFor(4, 1, 0.4).tariffRef,
          currency: 'CNY',
          prices: [
            { purchasePricePerKwh: 1, exportPricePerKwh: 0.4 },
            {},
            { purchasePricePerKwh: 1, exportPricePerKwh: 0.4 },
            { purchasePricePerKwh: 1, exportPricePerKwh: 0.4 },
          ],
        },
      }),
    )
    expect(result.status).toBe('insufficient_data')
    expect(
      result.missingInputs.some(
        (entry) => entry.reason === 'missing_tariff_price' && entry.slotIndex === 1,
      ),
    ).toBe(true)
  })

  it('returns insufficient_data when the load series is not bound', () => {
    const result = SIMULATOR.simulate(simulationRequest({ load: [] }))
    expect(result.status).toBe('insufficient_data')
    expect(result.missingInputs.some((entry) => entry.reason === 'missing_load_series')).toBe(true)
  })

  it('returns insufficient_data when the PV series is not bound', () => {
    const result = SIMULATOR.simulate(simulationRequest({ pv: [] }))
    expect(result.status).toBe('insufficient_data')
    expect(result.missingInputs.some((entry) => entry.reason === 'missing_pv_series')).toBe(true)
  })

  it('returns insufficient_data when a slot value is unknown', () => {
    const result = SIMULATOR.simulate(
      simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw: [1, undefined, 1, 1], pvKw: [0, 0, 0, 0] }),
      }),
    )
    expect(result.status).toBe('insufficient_data')
    expect(
      result.missingInputs.some(
        (entry) => entry.reason === 'missing_slot_value' && entry.slotIndex === 1,
      ),
    ).toBe(true)
  })

  it('refuses a live execution mode at runtime', () => {
    expect(assertSimulationMode('simulation')).toBe('simulation')
    expect(() => assertSimulationMode('live')).toThrowError(
      expect.objectContaining({ code: 'LIVE_MODE_UNSUPPORTED' }),
    )
    try {
      assertSimulationMode('live')
    } catch (error) {
      expect(error).toBeInstanceOf(EnergySimulationError)
    }
  })
})

describe('explicit synthetic/observed/forecast and simulation markers (INV-10)', () => {
  it('marks the input data mode, the execution mode and each sampling type', () => {
    const result = SIMULATOR.simulate(simulationRequest())
    expect(result.executionMode).toBe('simulation')
    expect(result.liveSupported).toBe(false)
    expect(result.inputDataMode).toBe('synthetic')
    expect(result.samplingMarkers).toEqual([
      { measurementPointRef: SIM_LOAD_BINDING.measurementPointRef, role: 'load', samplingType: 'observed', synthetic: true },
      { measurementPointRef: SIM_PV_BINDING.measurementPointRef, role: 'pv', samplingType: 'forecast', synthetic: true },
    ])
  })
})

describe('determinism and purity', () => {
  it('produces byte-identical results for the same input', () => {
    const request = simulationRequest({
      plan: planFor(4, [
        { slotIndex: 2, chargeKw: 2, dischargeKw: 0 },
        { slotIndex: 3, chargeKw: 0, dischargeKw: 2 },
      ]),
    })
    const first = SIMULATOR.simulate(request)
    const second = SIMULATOR.simulate(request)
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.resultDigest).toBe(second.resultDigest)
    expect(first.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first).toEqual(second)
  })

  it('conserves energy and stays deterministic across many deterministic scenarios', () => {
    let seed = 123456789
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let scenario = 0; scenario < 40; scenario += 1) {
      const slotCount = 4
      const loadKw = Array.from({ length: slotCount }, () => Math.round(next() * 60) / 10)
      const pvKw = Array.from({ length: slotCount }, () => Math.round(next() * 60) / 10)
      const steps = Array.from({ length: slotCount }, (_unused, slotIndex) => ({
        slotIndex,
        chargeKw: Math.round(next() * 40) / 10,
        dischargeKw: Math.round(next() * 40) / 10,
      }))
      const request = simulationRequest({
        snapshot: simulationSnapshot({ slotMinutes: 15, loadKw, pvKw }),
        plan: planFor(slotCount, steps),
      })
      const first = SIMULATOR.simulate(request)
      const second = SIMULATOR.simulate(request)
      expect(first.resultDigest).toBe(second.resultDigest)
      for (const interval of first.intervals) {
        expect(Math.abs(interval.energyBalanceResidualKwh)).toBeLessThanOrEqual(
          request.tolerance.energyBalanceKwh,
        )
      }
      expect(['feasible', 'infeasible', 'insufficient_data', 'unsupported_topology']).toContain(
        first.status,
      )
    }
  })

  it('has no reachable I/O in the simulation source (structural purity)', () => {
    const directory = fileURLToPath(
      new URL('../../packages/extensions/home-energy/src/simulation', import.meta.url),
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

describe('plan structure is validated, not silently repaired', () => {
  it('refuses a plan that declares a slot outside the horizon', () => {
    const request = simulationRequest({
      plan: {
        ...planFor(4),
        steps: [
          { slotIndex: 0, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 1, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 2, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 3, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 4, chargeKw: 0, dischargeKw: 0 },
        ],
      },
    })
    expect(() => SIMULATOR.simulate(request)).toThrowError(
      expect.objectContaining({ code: 'PLAN_SLOT_OUT_OF_RANGE' }),
    )
  })

  it('refuses a plan that declares the same slot twice', () => {
    const request: EnergySimulationRequest = simulationRequest({
      plan: {
        ...planFor(4),
        steps: [
          { slotIndex: 0, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 0, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 1, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 2, chargeKw: 0, dischargeKw: 0 },
          { slotIndex: 3, chargeKw: 0, dischargeKw: 0 },
        ],
      },
    })
    expect(() => SIMULATOR.simulate(request)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_PLAN_STEP' }),
    )
  })

  it('refuses a present-but-invalid device declaration', () => {
    expect(() =>
      SIMULATOR.simulate(simulationRequest({ battery: { chargeEfficiency: 1.5 } })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DECLARATION' }))
  })
})
