/**
 * Classified failures for energy input normalisation. Every failure keeps its category, so a
 * caller can tell an undeclared conversion from a coverage conflict from a bad horizon; a
 * failure is never swallowed into an empty series or a default value.
 */
export type EnergyInputErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_TIME_ZONE'
  | 'MISALIGNED_HORIZON'
  | 'UNDECLARED_CONVERSION'
  | 'UNDECLARED_SOC_MAPPING'
  | 'INVALID_DECLARATION'
  | 'COVERAGE_CONFLICT'
  | 'SNAPSHOT_DIGEST_MISMATCH'

export class EnergyInputError extends Error {
  readonly code: EnergyInputErrorCode

  constructor(code: EnergyInputErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EnergyInputError'
    this.code = code
  }
}
