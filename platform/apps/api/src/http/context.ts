import { CONTRACT_VERSION, createToolContext } from '@ontology/contracts'
import type { Principal, ToolContext } from '@ontology/contracts'

const PLACEHOLDER_PROFILE_HASH = `sha256:${'0'.repeat(64)}`
const REQUEST_DEADLINE_MS = 5 * 60 * 1000

export interface RequestToolContextInput {
  readonly principal: Principal
  readonly spaceId: string
  readonly traceId: string
  readonly runId: string
  readonly resolvedProfileHash?: string
}

/**
 * Mint the trusted tool context for one HTTP request.
 *
 * Identity, tenant/space scope and the trace id come from the server-side authentication
 * result — never from the request body (INV-07, SPEC §3). The budget reservation is a
 * structural placeholder: the atomic budget ledger is LOCAL-010 and this context is never
 * used to widen a budget. `runId` is the run the request targets (or the prospective run id
 * for `POST /runs`), and `resolvedProfileHash` is the run's locked hash once it is known.
 */
export function createRequestToolContext(input: RequestToolContextInput): ToolContext {
  const grantedAt = new Date()
  const expiresAt = new Date(grantedAt.getTime() + REQUEST_DEADLINE_MS)
  return createToolContext({
    principal: input.principal,
    runId: input.runId,
    resolvedProfileHash: input.resolvedProfileHash ?? PLACEHOLDER_PROFILE_HASH,
    policyVersion: CONTRACT_VERSION,
    deadline: expiresAt.toISOString(),
    budgetReservation: {
      reservationId: globalThis.crypto.randomUUID(),
      runId: input.runId,
      grantedAt: grantedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    allowedResources: {
      tenantId: input.principal.tenantId,
      spaceId: input.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: input.traceId,
  })
}
