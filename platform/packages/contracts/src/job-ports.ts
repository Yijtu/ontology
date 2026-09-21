import type { Rfc3339UtcTimestamp, Uuid } from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Background-job budget port (SPEC D6/D7.2, §9).
 *
 * Online runs draw from `BudgetPort`; import/simulation jobs draw from this port. They are
 * two separate ledgers by construction, so a background import cannot exhaust the online
 * model quota and an online run cannot consume a job's budget. This is intentionally a
 * narrow port rather than a reuse of `BudgetPort`: LOCAL-010 owns the online atomic budget
 * ledger and has not landed, and the two must not share reservations even after it does.
 * When the shared budget ledger lands, this port can be implemented on top of it with a
 * distinct `budgetClass`, but the separation stays.
 */
export type JobBudgetClass = 'background_job'

export interface JobQuotaRequest {
  readonly budgetClass: JobBudgetClass
  readonly modelCalls: number
  readonly modelTokens?: number
}

export interface JobQuotaReservation {
  readonly reservationId: Uuid
  readonly jobId: Uuid
  readonly budgetClass: JobBudgetClass
  readonly grantedAt: Rfc3339UtcTimestamp
  readonly expiresAt: Rfc3339UtcTimestamp
}

/**
 * Measured job usage. `usageUnknown` means the remote may have been billed; the reservation
 * is conservatively held until reconciled and never released as free (SPEC D7.2).
 */
export interface JobQuotaUsage {
  readonly modelCalls: number
  readonly modelTokens: number
  readonly usageUnknown?: boolean
}

export interface JobQuotaPort {
  reserve(
    jobId: Uuid,
    request: JobQuotaRequest,
    ctx: ToolContext,
  ): Promise<JobQuotaReservation>
  settle(
    reservation: JobQuotaReservation,
    usage: JobQuotaUsage,
    ctx: ToolContext,
  ): Promise<void>
}
