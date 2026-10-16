import { AuthoringCommandError, assertCommandCallShape } from '@ontology/contracts'
import type {
  AuthoringCommandGateway,
  CandidateDispatchFence,
  CommandCall,
  CommandReceipt,
  ScopeRef,
  SubmitCandidatesReceipt,
  ToolContext,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import type { CandidateSubmissionService } from './service'

/**
 * The real authoring-command gateway (design §5). It maps one routed `submit_candidates` call to
 * one controlled submission and projects the service's receipt back into the runtime's recorded
 * outcome. It mints the host envelope — the run id, the logical action and the idempotency key —
 * from trusted context + the command content digest, never from the model, so a crash-replay of the
 * same command returns the original receipt instead of writing a second candidate (design §7).
 *
 * When the host supplies a durable dispatch fence, the gateway forwards it so the atomic commit can
 * reject a worker that lost its lease before it writes a candidate (design §7, S08).
 */
export class CandidateAuthoringCommandGateway implements AuthoringCommandGateway {
  constructor(
    readonly service: CandidateSubmissionService,
    readonly fenceFor?: (ctx: ToolContext) => CandidateDispatchFence | undefined,
  ) {}

  async invoke(command: CommandCall, ctx: ToolContext): Promise<CommandReceipt> {
    try {
      assertCommandCallShape(command)
    } catch (error) {
      throw new AuthoringCommandError('INVALID_COMMAND_CALL', 'the authoring command call is malformed', { cause: error })
    }
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const commandDigest = sha256DigestOf(canonicalJson(command.command))
    const idempotencyKey = `submit:${sha256DigestOf(canonicalJson({ runId: ctx.runId, commandDigest }))}`
    const fence = this.fenceFor?.(ctx)
    const receipt = await this.service.submit(scope, {
      command: command.command,
      runId: ctx.runId,
      logicalActionId: command.callId,
      idempotencyKey,
    }, ctx, fence === undefined ? {} : { fence })
    return toCommandReceipt(command.callId, command.commandKind, receipt)
  }
}

function toCommandReceipt(callId: CommandReceipt['callId'], commandKind: CommandReceipt['commandKind'], receipt: SubmitCandidatesReceipt): CommandReceipt {
  const issueCodes = new Set<string>()
  for (const rejected of receipt.rejected) issueCodes.add(rejected.code)
  for (const accepted of receipt.accepted) for (const issue of accepted.issues) issueCodes.add(issue.code)
  const candidateIds = receipt.accepted.map((accepted) => accepted.candidateId)
  const pending = receipt.accepted.some((accepted) => accepted.pendingConfirmation)
  const status: CommandReceipt['status'] = receipt.accepted.length === 0 ? 'rejected'
    : receipt.rejected.length > 0 || pending ? 'pending_confirmation' : 'accepted'
  return {
    callId,
    commandKind,
    status,
    candidateIds,
    issueCodes: [...issueCodes],
    receiptDigest: sha256DigestOf(canonicalJson(receipt)),
    recordedAt: receipt.recordedAt,
  }
}
