/**
 * Typed errors for the pure energy planner.
 *
 * These are *declaration* failures — a malformed request that never should have been built.
 * They are deliberately distinct from the domain outcomes (`infeasible`, `insufficient_data`,
 * `unsupported_topology`), which are returned as successful computation results, never thrown.
 * Nothing here reaches a network, a database, a model or a clock.
 */

export type EnergyPlannerErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_DECLARATION'
  | 'PLAN_GENERATION_FAILED'

export class EnergyPlannerError extends Error {
  readonly code: EnergyPlannerErrorCode

  constructor(code: EnergyPlannerErrorCode, message: string) {
    super(message)
    this.name = 'EnergyPlannerError'
    this.code = code
  }
}
