import { randomUUID } from 'node:crypto'
import { createToolContext, isToolContext } from '@ontology/contracts'
import type {
  ResearchAuthorizationReceipt,
  ResourceKind,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/**
 * The workspace-research trusted context (design §4/§6, S07).
 *
 * A research run must never reuse the generic worker context — it carries `platform-admin`, an
 * empty domain allowlist and a rolling five-minute deadline, none of which is the run's actual
 * authorization. Instead this resolver **rebuilds** a ToolContext from the *persisted*
 * authorization receipt (who authorized the run, which material it may read, which domains it may
 * reach, the fixed quota and the original deadline), and then intersects that with the **current**
 * revocation state at resolve time. A receipt that cannot be re-read, or that has been revoked
 * since it was issued, is an explicit block — never a silent fall-through to the wide worker
 * context and never a retarget of the recipient.
 */

export type WorkspaceResearchContextBlockedReason =
  | 'ADMISSION_NOT_FOUND'
  | 'RECEIPT_UNREADABLE'
  | 'AUTHORIZATION_REVOKED'

export class WorkspaceResearchContextError extends Error {
  readonly code: WorkspaceResearchContextBlockedReason

  constructor(code: WorkspaceResearchContextBlockedReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceResearchContextError'
    this.code = code
  }
}

export interface WorkspaceResearchContextResolution {
  /** The rebuilt, receipt-derived context. It is *not* the generic worker context. */
  readonly ctx: ToolContext
  /** The exact receipt the context was rebuilt from; also carries the authorized material refs. */
  readonly receipt: ResearchAuthorizationReceipt
}

export interface WorkspaceResearchContextDependencies {
  /**
   * Reads the immutable authorization receipt back by ref (S05). The implementation verifies the
   * archived byte digest and the receipt shape before returning, so a forged or truncated receipt
   * is `RECEIPT_UNREADABLE`.
   */
  readonly readReceipt: (runId: Uuid, ctx: ToolContext) => Promise<ResearchAuthorizationReceipt>
  /**
   * The current revocation state, evaluated per resolve (design §8/§9). It returns the reasons the
   * run's authorization is no longer in force — a disabled/revoked tool or model connection, a
   * deleted workspace draft — so this resolver intersects the persisted authorization with it
   * instead of trusting the receipt alone.
   */
  readonly revocations?: (
    receipt: ResearchAuthorizationReceipt,
    ctx: ToolContext,
  ) => Promise<readonly WorkspaceResearchContextBlockedReason[]>
  readonly now?: () => Date
}

export interface WorkspaceResearchContextResolver {
  /** Rebuild the run's research context, or throw a classified block. */
  resolve(runId: Uuid, hostCtx: ToolContext): Promise<WorkspaceResearchContextResolution>
}

/** Resource kinds a research run's authorized reads may touch (mirrors the core worker grant). */
const RESEARCH_RESOURCE_KINDS: readonly ResourceKind[] = [
  'artifact',
  'document',
  'chunk',
  'evidence',
  'dataset',
  'plan',
  'job',
]

/**
 * The internal collection marker for a run's research staging set. `document_search` still carries
 * `allowedCollectionRefs` in its canonical shape, so the rebuilt context approves exactly this one
 * synthetic collection — the run's own evidence set — and nothing of a project corpus.
 */
export const RESEARCH_STAGING_COLLECTION_REF = 'research-staging'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkspaceResearchContextError('RECEIPT_UNREADABLE', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkspaceResearchContextError('RECEIPT_UNREADABLE', 'the host context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

export function createWorkspaceResearchContextResolver(
  dependencies: WorkspaceResearchContextDependencies,
): WorkspaceResearchContextResolver {
  const now = dependencies.now ?? (() => new Date())

  return {
    async resolve(runId: Uuid, hostCtx: ToolContext): Promise<WorkspaceResearchContextResolution> {
      const scope = scopeOf(hostCtx)
      let receipt: ResearchAuthorizationReceipt
      try {
        receipt = await dependencies.readReceipt(runId, hostCtx)
      } catch (cause) {
        if (cause instanceof WorkspaceResearchContextError) throw cause
        throw new WorkspaceResearchContextError(
          'ADMISSION_NOT_FOUND',
          `no research authorization receipt is readable for run ${runId}`,
          { cause },
        )
      }
      if (receipt.runId !== runId) {
        throw new WorkspaceResearchContextError(
          'RECEIPT_UNREADABLE',
          `the authorization receipt names run ${receipt.runId}, not ${runId}`,
        )
      }

      // Intersect the persisted authorization with the live revocation state. The receipt fixes
      // what was granted; a connection disabled or a workspace draft removed since then revokes it.
      const revocations = (await dependencies.revocations?.(receipt, hostCtx)) ?? []
      if (revocations.length > 0) {
        throw new WorkspaceResearchContextError(
          'AUTHORIZATION_REVOKED',
          `the research authorization for run ${runId} is no longer in force (${revocations.join(', ')})`,
        )
      }

      const grantedAt = now().toISOString()
      const ctx = createToolContext({
        principal: {
          tenantId: scope.tenantId,
          subjectId: receipt.operatorSubjectId,
          roles: [...receipt.operatorRoles],
          scopes: [],
          authEpoch: 1,
        },
        runId,
        // The frozen config hash is the receipt's pinned execution identity, not a fresh profile.
        resolvedProfileHash: receipt.configSnapshotHash,
        policyVersion: hostCtx.policyVersion,
        // The **original** deadline, fixed at accept time — never a rolling window from "now".
        deadline: receipt.deadline,
        budgetReservation: {
          reservationId: randomUUID(),
          runId,
          grantedAt,
          expiresAt: receipt.deadline,
        },
        allowedResources: {
          tenantId: scope.tenantId,
          spaceId: scope.spaceId,
          resourceKinds: [...RESEARCH_RESOURCE_KINDS],
          // The receipt's effective allowlist (deployment/space policy ∩ the user's selection); it
          // is never widened by this rebuild.
          sourceRefs: [],
          collectionRefs: [RESEARCH_STAGING_COLLECTION_REF],
          domains: [...receipt.allowedDomains],
          maxRows: hostCtx.allowedResources.maxRows,
        },
        traceId: `workspace-research:${runId}`,
      })
      return { ctx, receipt }
    },
  }
}
