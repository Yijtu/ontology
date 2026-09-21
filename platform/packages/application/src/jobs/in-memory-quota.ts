import type {
  JobQuotaPort,
  JobQuotaRequest,
  JobQuotaReservation,
  JobQuotaUsage,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

interface ReservationState {
  readonly reservation: JobQuotaReservation
  readonly request: JobQuotaRequest
  settled?: JobQuotaUsage
}

/**
 * Reference background-quota ledger. It is deliberately a *separate* ledger from the online
 * run budget: this instance never touches a `BudgetPort`, so a job cannot consume or exhaust
 * the online quota (SPEC §9). Tests assert the separation by checking that the online budget
 * fake stays untouched while a job reserves and settles here.
 */
export class InMemoryJobQuota implements JobQuotaPort {
  readonly #reservations = new Map<Uuid, ReservationState>()
  #settledModelCalls = 0

  async reserve(
    jobId: Uuid,
    request: JobQuotaRequest,
    ctx: ToolContext,
  ): Promise<JobQuotaReservation> {
    void ctx
    const grantedAt = new Date().toISOString()
    const reservation: JobQuotaReservation = {
      reservationId: globalThis.crypto.randomUUID(),
      jobId,
      budgetClass: request.budgetClass,
      grantedAt,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }
    this.#reservations.set(reservation.reservationId, { reservation, request })
    return reservation
  }

  async settle(
    reservation: JobQuotaReservation,
    usage: JobQuotaUsage,
    ctx: ToolContext,
  ): Promise<void> {
    void ctx
    const state = this.#reservations.get(reservation.reservationId)
    if (state === undefined) {
      throw new Error(`no background quota reservation ${reservation.reservationId}`)
    }
    if (state.settled !== undefined) return
    state.settled = usage
    this.#settledModelCalls += usage.modelCalls
  }

  /** Model calls actually consumed by background jobs, never by an online run. */
  get settledModelCalls(): number {
    return this.#settledModelCalls
  }

  get reservationCount(): number {
    return this.#reservations.size
  }
}
