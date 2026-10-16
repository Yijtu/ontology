import { AUTHORING_COMMAND_KINDS, TOOL_IDS } from '@ontology/contracts'
import type {
  AuthoringCommandKind,
  GenerationCompleted,
  GenerationEvent,
  GenerationUsage,
  ToolId,
  Uuid,
} from '@ontology/contracts'
import { ModelAdapterError } from './errors'
import type { CompanyWireChunk } from './vendor/company-wire'

/**
 * Converts a decoded vendor chunk into canonical `GenerationEvent`s (SPEC §4.2).
 *
 * `redact` is the secret redactor: every string that leaves this module passes through
 * it, so a credential echoed by the provider can never reach an emitted event.
 */
export interface VendorChunkOutcome {
  readonly events: readonly GenerationEvent[]
  readonly textDelta?: string
  readonly toolDelta?: { readonly callId: Uuid; readonly argumentsDelta: string }
  readonly commandDelta?: { readonly callId: Uuid; readonly argumentsDelta: string }
  readonly usage?: GenerationUsage
  readonly completed?: GenerationCompleted
  readonly failure?: ModelAdapterError
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOOL_ID_SET: ReadonlySet<string> = new Set(TOOL_IDS)
const COMMAND_KIND_SET: ReadonlySet<string> = new Set(AUTHORING_COMMAND_KINDS)

export function mapVendorChunk(
  chunk: CompanyWireChunk,
  redact: (text: string) => string,
): VendorChunkOutcome {
  switch (chunk.type) {
    case 'text_delta': {
      const text = redact(chunk.text)
      return { events: [{ type: 'text_delta', text }], textDelta: text }
    }
    case 'tool_call_delta': {
      if (!UUID_PATTERN.test(chunk.call_id)) {
        return {
          events: [],
          failure: new ModelAdapterError(
            'INTERNAL_ERROR',
            'provider proposed a tool call without a canonical call id',
            { remoteStateUnknown: true },
          ),
        }
      }
      const argumentsDelta = redact(chunk.args_delta)
      const callId = chunk.call_id as Uuid
      // A controlled authoring command is proposed on the same vendor tool-call channel but is
      // surfaced as a distinct canonical event, so a reader can always tell a data read from a
      // controlled write and the command never enters the four-tool catalogue.
      if (COMMAND_KIND_SET.has(chunk.tool)) {
        return {
          events: [
            {
              type: 'authoring_command_delta',
              callId,
              commandKind: chunk.tool as AuthoringCommandKind,
              argumentsDelta,
            },
          ],
          commandDelta: { callId, argumentsDelta },
        }
      }
      if (!TOOL_ID_SET.has(chunk.tool)) {
        return {
          events: [],
          failure: new ModelAdapterError(
            'INVALID_ARGUMENT',
            `provider proposed an unregistered tool ${redact(chunk.tool)}`,
          ),
        }
      }
      return {
        events: [{ type: 'tool_call_delta', callId, toolId: chunk.tool as ToolId, argumentsDelta }],
        toolDelta: { callId, argumentsDelta },
      }
    }
    case 'usage': {
      // A usage event with missing counts is surfaced explicitly as `usageUnknown`
      // instead of being silently rounded to zero (never a silent success).
      const partial =
        chunk.usage.prompt_tokens === undefined || chunk.usage.completion_tokens === undefined
      const usage: GenerationUsage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(partial ? { usageUnknown: true } : {}),
      }
      return { events: [{ type: 'usage', usage }], usage }
    }
    case 'completed': {
      const completed: GenerationCompleted = {
        type: 'completed',
        stopReason: stopReasonOf(chunk.finish_reason),
        candidateOnly: true,
      }
      return { events: [completed], completed }
    }
    case 'error':
      return { events: [], failure: failureOf(chunk) }
  }
}

function stopReasonOf(finishReason: string | undefined): GenerationCompleted['stopReason'] {
  switch (finishReason) {
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

function failureOf(chunk: Extract<CompanyWireChunk, { type: 'error' }>): ModelAdapterError {
  const detail = chunk.error_message ?? 'provider reported an error'
  switch (chunk.error_code) {
    case 'rate_limit':
      return new ModelAdapterError('RATE_LIMITED', detail)
    case 'overloaded':
    case 'unavailable':
      return new ModelAdapterError('MODEL_UNAVAILABLE', detail)
    case 'timeout':
      return new ModelAdapterError('DEADLINE_EXCEEDED', detail, { remoteStateUnknown: true })
    case 'invalid_request':
      return new ModelAdapterError('INVALID_ARGUMENT', detail)
    default:
      return new ModelAdapterError('INTERNAL_ERROR', detail, { remoteStateUnknown: true })
  }
}

/** An explicit, conservative usage record for a call whose true usage is unknown. */
export function unknownUsage(): GenerationUsage {
  return { inputTokens: 0, outputTokens: 0, usageUnknown: true }
}
