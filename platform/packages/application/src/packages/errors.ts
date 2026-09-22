import type { UpgradeBlocker } from '@ontology/contracts'

/**
 * Classified failure of pack export and lifecycle upgrade (C1/C6.2, US-023).
 *
 * A caller maps these onto the C6.2 table by `code`; it never inspects a message. A blocked
 * upgrade or retirement always carries the explicit `blockers` (each with `recoverable` and
 * a `nextAction`), so "cannot be recovered" is never a bare failure.
 */
export type IndustryPackErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'PACK_NOT_FOUND'
  | 'DEFINITION_NOT_FOUND'
  | 'EXPORT_LEAK_DETECTED'
  | 'PROFILE_NOT_FOUND'
  | 'SLOT_NOT_FOUND'
  | 'UPGRADE_BLOCKED'
  | 'RETIREMENT_BLOCKED'

const HTTP_STATUS: Readonly<Record<IndustryPackErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  PACK_NOT_FOUND: 404,
  DEFINITION_NOT_FOUND: 404,
  EXPORT_LEAK_DETECTED: 500,
  PROFILE_NOT_FOUND: 404,
  SLOT_NOT_FOUND: 400,
  UPGRADE_BLOCKED: 409,
  RETIREMENT_BLOCKED: 409,
}

export interface IndustryPackErrorOptions extends ErrorOptions {
  readonly blockers?: readonly UpgradeBlocker[]
  readonly reasons?: readonly string[]
}

export class IndustryPackError extends Error {
  readonly code: IndustryPackErrorCode
  readonly httpStatus: number
  readonly blockers: readonly UpgradeBlocker[] | undefined
  readonly reasons: readonly string[] | undefined

  constructor(code: IndustryPackErrorCode, message: string, options?: IndustryPackErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IndustryPackError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.blockers = options?.blockers
    this.reasons = options?.reasons
  }
}
