import type {
  AuthoringCommandKind,
  AuthoringCommandReceiptStatus,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { SubmitCandidatesCommand } from './submit-candidates'
import { assertSubmitCandidatesCommandShape } from './submit-candidates'
import type { ToolContext } from './trusted'
import { isRecord, isSha256Digest, isUuid } from './asset-workspace'

/**
 * The controlled authoring-command port (design §5).
 *
 * A runtime turn may propose either a public data tool call or an authoring command. The public
 * `ToolId` catalogue stays exactly four; a candidate write travels as a **command** through its
 * own gateway port so it is never smuggled into `data_query`/compute and a reader can always tell
 * a read from a write. Both paths still take the host-minted `ToolContext`, so identity, scope,
 * budget, schema validation, cancellation and audit are applied identically.
 *
 * `submit_candidates` is currently the only command. The gateway is injected only into runs that
 * are authorized to author (a plain data-tool session never receives it), so read-only sessions
 * cannot obtain candidate write permission.
 */

/** A controlled command call proposed by the model and routed by the runtime. */
export interface SubmitCandidatesCommandCall {
  readonly commandKind: 'submit_candidates'
  /** Host-minted call id; the model's tool-call id never becomes a platform call id. */
  readonly callId: Uuid
  readonly command: SubmitCandidatesCommand
}

export type CommandCall = SubmitCandidatesCommandCall

/**
 * The recorded outcome of one routed command. It carries only the recorded result — never the
 * command body or a trusted attribute — so a runtime event and the delivery list can project it
 * without re-deriving it from the model.
 */
export interface CommandReceipt {
  readonly callId: Uuid
  readonly commandKind: AuthoringCommandKind
  readonly status: AuthoringCommandReceiptStatus
  /** The candidate ids the command wrote (accepted/pending_confirmation); empty otherwise. */
  readonly candidateIds: readonly Uuid[]
  /** Stable machine codes for a rejection/pending outcome; empty on a clean accept. */
  readonly issueCodes: readonly string[]
  readonly receiptDigest: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * The authoring-command gateway. It is a different port from `ToolGateway` because a write is not
 * a read: it reuses the same identity/schema/budget/intent/fence/audit discipline but never
 * appears on the model-visible tool surface.
 */
export interface AuthoringCommandGateway {
  invoke(command: CommandCall, ctx: ToolContext): Promise<CommandReceipt>
}

export const AUTHORING_COMMAND_KINDS: readonly AuthoringCommandKind[] = ['submit_candidates']

export const COMMAND_RECEIPT_STATUSES: readonly AuthoringCommandReceiptStatus[] = [
  'accepted',
  'rejected',
  'pending_confirmation',
  'deferred',
]

export class AuthoringCommandError extends Error {
  constructor(
    readonly code: 'INVALID_COMMAND_CALL' | 'INVALID_COMMAND_RECEIPT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AuthoringCommandError'
  }
}

function invalid(message: string): AuthoringCommandError {
  return new AuthoringCommandError('INVALID_COMMAND_CALL', message)
}

/**
 * Validate one proposed command call before the gateway acts on it. It rejects an unknown command
 * kind and any malformed command body, so a proposal can never reach a write path as an unmodelled
 * action.
 */
export function assertCommandCallShape(value: unknown): asserts value is CommandCall {
  if (!isRecord(value) || value['commandKind'] !== 'submit_candidates' || !isUuid(value['callId'])) {
    throw invalid('an authoring command call requires a submit_candidates kind and a call id')
  }
  if (!isRecord(value['command'])) throw invalid('an authoring command call requires a command body')
  assertSubmitCandidatesCommandShape(value['command'])
}

export function isCommandCall(value: unknown): value is CommandCall {
  try {
    assertCommandCallShape(value)
    return true
  } catch {
    return false
  }
}

export function assertCommandReceiptShape(value: unknown): asserts value is CommandReceipt {
  if (!isRecord(value) || !isUuid(value['callId'])
    || !AUTHORING_COMMAND_KINDS.includes(value['commandKind'] as AuthoringCommandKind)
    || !COMMAND_RECEIPT_STATUSES.includes(value['status'] as AuthoringCommandReceiptStatus)
    || !Array.isArray(value['candidateIds']) || !value['candidateIds'].every((id) => isUuid(id))
    || !Array.isArray(value['issueCodes']) || !value['issueCodes'].every((code) => typeof code === 'string' && code.length > 0)
    || !isSha256Digest(value['receiptDigest'])
    || typeof value['recordedAt'] !== 'string' || value['recordedAt'].length === 0) {
    throw new AuthoringCommandError('INVALID_COMMAND_RECEIPT', 'invalid authoring command receipt')
  }
}
