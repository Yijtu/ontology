export type EnergyComputeErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_INPUT'
  | 'MISSING_PLAN'
  | 'LIVE_NOT_SUPPORTED'
  | 'CAPABILITY_NOT_CONFIGURED'

/**
 * Classified failure for the home-energy compute extension. It never carries a secret, a
 * device address or a customer payload; the caller maps it onto the canonical error catalogue.
 */
export class EnergyComputeError extends Error {
  readonly code: EnergyComputeErrorCode

  constructor(code: EnergyComputeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'EnergyComputeError'
    this.code = code
  }
}
