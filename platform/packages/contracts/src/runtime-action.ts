import type { ToolCall } from './generated/contracts'
import { TOOL_IDS } from './generated/tool-catalogue'
import type { SubmitCandidatesCommand } from './submit-candidates'
import { assertSubmitCandidatesCommandShape } from './submit-candidates'
import { isRecord, isUuid } from './asset-workspace'

/**
 * The runtime action union (design §5). A runtime turn may produce either a **public data tool
 * call** (one of the fixed four: `ontology_lookup`/`data_query`/`document_search`/`web_search`) or
 * a **controlled authoring command**.
 *
 * The union is deliberately explicit instead of an opaque string tool: the public `ToolId`
 * catalogue stays exactly four entries, and candidate submission (`submit_candidates`) is modelled
 * as an authoring command, so it is never smuggled into `data_query` or a compute operation and a
 * reader can always tell a read from a write. Both branches still travel through the same gateway
 * (identity, schema, budget, intent, cancellation, audit).
 */

export type AgentActionKind = 'data_tool' | 'authoring_command'

/** A read-only public data tool call. `call.toolId` is one of the fixed four. */
export interface DataToolAction {
  readonly kind: 'data_tool'
  readonly call: ToolCall
}

/** A controlled authoring command. `submit_candidates` is currently the only member. */
export interface AuthoringCommandAction {
  readonly kind: 'authoring_command'
  readonly command: SubmitCandidatesCommand
}

export type AgentAction = DataToolAction | AuthoringCommandAction

/** The public data tool ids, straight from the canonical catalogue — never widened here. */
export const PUBLIC_DATA_TOOL_IDS: readonly string[] = TOOL_IDS

export class AgentActionError extends Error {
  constructor(readonly code: 'INVALID_ACTION', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentActionError'
  }
}

function invalid(message: string): AgentActionError {
  return new AgentActionError('INVALID_ACTION', message)
}

function assertDataToolCall(value: unknown): asserts value is ToolCall {
  if (!isRecord(value) || !isUuid(value['callId']) || !isRecord(value['arguments'])) {
    throw invalid('a data tool action requires a call id and arguments')
  }
  if (typeof value['toolId'] !== 'string' || !PUBLIC_DATA_TOOL_IDS.includes(value['toolId'])) {
    throw invalid('a data tool action must name one of the fixed four public tools')
  }
}

/**
 * Validate one runtime action. It rejects an unknown discriminant and any data-tool call whose id
 * is not in the fixed catalogue, so a proposal can never reach the gateway as an unmodelled write.
 */
export function assertAgentActionShape(value: unknown): asserts value is AgentAction {
  if (!isRecord(value)) throw invalid('an agent action must be an object')
  switch (value['kind']) {
    case 'data_tool':
      assertDataToolCall(value['call'])
      return
    case 'authoring_command':
      if (!isRecord(value['command'])) throw invalid('an authoring command action requires a command')
      assertSubmitCandidatesCommandShape(value['command'])
      return
    default:
      throw invalid('unknown agent action kind')
  }
}

export function isAgentAction(value: unknown): value is AgentAction {
  try {
    assertAgentActionShape(value)
    return true
  } catch {
    return false
  }
}

export function agentActionKindOf(value: unknown): AgentActionKind | undefined {
  if (!isRecord(value)) return undefined
  return value['kind'] === 'data_tool' || value['kind'] === 'authoring_command'
    ? value['kind']
    : undefined
}
