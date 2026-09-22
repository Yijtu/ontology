/**
 * Typed errors for the pure energy simulator.
 *
 * These are *declaration* failures — a structurally malformed plan or an out-of-range device
 * declaration. They are deliberately distinct from the domain outcomes (`infeasible`,
 * `insufficient_data`, `unsupported_topology`), which are returned as successful computation
 * results, never thrown. Nothing here reaches a network, a database or a model.
 */

export type EnergySimulationErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_DECLARATION'
  | 'DUPLICATE_PLAN_STEP'
  | 'PLAN_SLOT_OUT_OF_RANGE'
  | 'LIVE_MODE_UNSUPPORTED'

export class EnergySimulationError extends Error {
  readonly code: EnergySimulationErrorCode

  constructor(code: EnergySimulationErrorCode, message: string) {
    super(message)
    this.name = 'EnergySimulationError'
    this.code = code
  }
}
