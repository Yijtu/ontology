import type { ToolAdapterType } from './tool-connection'
import type { RevisionString, Rfc3339UtcTimestamp, Uuid, VersionRef } from './generated/contracts'
import type { ResearchLimits } from './research-execution'
import { isRecord, isRevisionString, isUuid } from './asset-workspace'

/**
 * The bounded research preflight (design §2/§10).
 *
 * Before a run is authorized the host reports what the run *would* use — the actual search
 * recipient, the effective domain scope, the budget ceilings and every blocking reason — so the user
 * confirms real facts, not a guess. It never names a credential: only the connection's non-secret
 * identity, revision and state are reported. A blocked preflight is a stable, actionable reason; it
 * is never a fabricated "ready".
 */

export type ResearchPreflightRecipientState = 'available' | 'unconfigured' | 'disabled' | 'blocked'

export interface ResearchPreflightRecipient {
  readonly state: ResearchPreflightRecipientState
  readonly toolId: 'web_search'
  readonly connectionId?: Uuid
  readonly connectionName?: string
  readonly adapterType?: ToolAdapterType
  readonly connectionRevision?: RevisionString
  /** The stable machine reason this recipient is not available (never a credential). */
  readonly blockedReason?: string
}

export interface ResearchPreflightBlock {
  readonly code: string
  readonly message: string
}

/** The short-term authorization the run would execute under (design §2: 短期授权摘要). */
export interface ResearchPreflightAuthorization {
  readonly roles: readonly string[]
  readonly deadline: Rfc3339UtcTimestamp
  readonly note: string
}

export type ResearchPreflightArchiveState = 'available' | 'unverified' | 'unavailable'

/**
 * The page-archive assessment (design §9: 能力展示区分"可用配置"与"探测结果").
 *
 * A configured search connection is an *available configuration*; it is not proof that a page can be
 * retrieved and read back. `available` requires a page-archive probe that passed for the exact
 * pinned connection revision; a connection that merely exists is `unverified`, so the preflight never
 * claims "any page can be archived" just because a connection is present.
 */
export interface ResearchPreflightArchive {
  readonly connectionRevision?: RevisionString
  readonly state: ResearchPreflightArchiveState
  readonly note: string
}

export interface ResearchPreflight {
  readonly schemaVersion: 'research-preflight@1'
  readonly workspaceId: Uuid
  readonly generatedAt: Rfc3339UtcTimestamp
  /** The actual public-search recipient the run would contact. */
  readonly recipient: ResearchPreflightRecipient
  /** The domains the user selected. */
  readonly requestedDomains: readonly string[]
  /** Deployment/space policy intersected with the user selection; never wider than the policy. */
  readonly effectiveDomains: readonly string[]
  readonly limits: ResearchLimits
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  /** Everything that would block the run; empty means the run may start. */
  readonly blocked: readonly ResearchPreflightBlock[]
  readonly authorization: ResearchPreflightAuthorization
  /** The page-archive assessment, distinct from the search recipient's availability. */
  readonly archive: ResearchPreflightArchive
}

const RECIPIENT_STATES: readonly ResearchPreflightRecipientState[] = [
  'available', 'unconfigured', 'disabled', 'blocked',
]

const ARCHIVE_STATES: readonly ResearchPreflightArchiveState[] = ['available', 'unverified', 'unavailable']

function isVersionRef(value: unknown): boolean {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['version'] === 'string' && typeof value['digest'] === 'string'
}

function assertLimits(value: unknown): void {
  if (!isRecord(value)
    || !Number.isSafeInteger(value['sourceLimit']) || (value['sourceLimit'] as number) < 1
    || !Number.isSafeInteger(value['candidateLimit']) || (value['candidateLimit'] as number) < 1
    || typeof value['deadline'] !== 'string' || !Number.isFinite(Date.parse(value['deadline']))) {
    throw new Error('invalid research preflight limits')
  }
}

function assertRecipient(value: unknown): void {
  if (isRecord(value) && ('apiKey' in value || 'credential' in value || 'secret' in value)) {
    throw new Error('a research preflight recipient must never carry a credential')
  }
  if (!isRecord(value) || value['toolId'] !== 'web_search'
    || !RECIPIENT_STATES.includes(value['state'] as ResearchPreflightRecipientState)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !isRevisionString(value['connectionRevision']))
    || (value['connectionName'] !== undefined && typeof value['connectionName'] !== 'string')
    || (value['blockedReason'] !== undefined && typeof value['blockedReason'] !== 'string')
    || (value['adapterType'] !== undefined && value['adapterType'] !== 'native_tavily' && value['adapterType'] !== 'http_compat')) {
    throw new Error('invalid research preflight recipient')
  }
}

/** Runtime validation of a preflight; a malformed or credential-shaped reply is refused. */
export function assertResearchPreflightShape(value: unknown): asserts value is ResearchPreflight {
  if (!isRecord(value) || value['schemaVersion'] !== 'research-preflight@1'
    || !isUuid(value['workspaceId']) || typeof value['generatedAt'] !== 'string'
    || !Array.isArray(value['requestedDomains']) || !value['requestedDomains'].every((d) => typeof d === 'string')
    || !Array.isArray(value['effectiveDomains']) || !value['effectiveDomains'].every((d) => typeof d === 'string')
    || !isVersionRef(value['policyRef']) || !isVersionRef(value['budgetRef'])
    || !Array.isArray(value['blocked']) || !value['blocked'].every((entry) => isRecord(entry) && typeof entry['code'] === 'string' && typeof entry['message'] === 'string')) {
    throw new Error('invalid research preflight')
  }
  if ('apiKey' in value || 'credential' in value || 'secret' in value) {
    throw new Error('a research preflight must never carry a credential')
  }
  assertRecipient(value['recipient'])
  assertLimits(value['limits'])
  const archive = value['archive']
  if (!isRecord(archive)
    || !ARCHIVE_STATES.includes(archive['state'] as ResearchPreflightArchiveState)
    || typeof archive['note'] !== 'string'
    || (archive['connectionRevision'] !== undefined && !isRevisionString(archive['connectionRevision']))) {
    throw new Error('invalid research preflight archive assessment')
  }
  const authorization = value['authorization']
  if (!isRecord(authorization) || !Array.isArray(authorization['roles']) || !authorization['roles'].every((role) => typeof role === 'string')
    || typeof authorization['deadline'] !== 'string' || typeof authorization['note'] !== 'string') {
    throw new Error('invalid research preflight authorization')
  }
}
