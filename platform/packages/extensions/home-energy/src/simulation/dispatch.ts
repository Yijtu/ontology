/**
 * The deterministic AC-side dispatch for one slot (SPEC E4).
 *
 * Given the load, the available PV, the planned battery charge/discharge setpoints and the
 * export/grid-charging policy, it derives every other flow so the balance
 *
 *   PV_used + Grid_import + Discharge = Load + Charge + Grid_export
 *
 * holds exactly (before tolerance). The policy is fixed and order-dependent, never a choice:
 *   1. PV serves load first;
 *   2. planned discharge serves the remaining load; any surplus discharge can only be exported;
 *   3. PV surplus then charges the battery;
 *   4. remaining charge demand is drawn from the grid (unless grid charging is disallowed, which
 *      is reported as a violation by the caller);
 *   5. remaining PV surplus is exported when export is allowed, otherwise curtailed.
 *
 * `curtailment` is deliberately outside the balance: it is PV energy that never entered the AC
 * node. `gridImport` and `gridExport` can only both be positive when the plan charges and
 * discharges in the same slot, which the caller flags as a constraint violation.
 */

export interface SlotDispatchInputs {
  readonly loadKw: number
  readonly pvAvailableKw: number
  readonly chargeKw: number
  readonly dischargeKw: number
  readonly exportAllowed: boolean
}

export interface SlotFlows {
  readonly pvToLoadKw: number
  readonly pvToChargeKw: number
  readonly pvExportKw: number
  readonly pvUsedKw: number
  readonly curtailmentKw: number
  readonly dischargeToLoadKw: number
  readonly dischargeExportKw: number
  readonly gridImportKw: number
  readonly gridExportKw: number
}

function min(a: number, b: number): number {
  return a < b ? a : b
}

export function dispatchSlot(inputs: SlotDispatchInputs): SlotFlows {
  const { loadKw, pvAvailableKw, chargeKw, dischargeKw, exportAllowed } = inputs

  const pvToLoadKw = min(pvAvailableKw, loadKw)
  const remainingLoadKw = loadKw - pvToLoadKw

  const dischargeToLoadKw = min(dischargeKw, remainingLoadKw)
  const dischargeExportKw = dischargeKw - dischargeToLoadKw

  const pvSurplusKw = pvAvailableKw - pvToLoadKw
  const pvToChargeKw = min(pvSurplusKw, chargeKw)
  const gridToChargeKw = chargeKw - pvToChargeKw
  const pvSurplusAfterChargeKw = pvSurplusKw - pvToChargeKw

  const pvExportKw = exportAllowed ? pvSurplusAfterChargeKw : 0
  const curtailmentKw = pvSurplusAfterChargeKw - pvExportKw

  const gridImportKw = remainingLoadKw - dischargeToLoadKw + gridToChargeKw
  const gridExportKw = (exportAllowed ? dischargeExportKw : 0) + pvExportKw

  const pvUsedKw = pvToLoadKw + pvToChargeKw + pvExportKw

  return {
    pvToLoadKw,
    pvToChargeKw,
    pvExportKw,
    pvUsedKw,
    curtailmentKw,
    dischargeToLoadKw,
    dischargeExportKw,
    gridImportKw,
    gridExportKw,
  }
}
