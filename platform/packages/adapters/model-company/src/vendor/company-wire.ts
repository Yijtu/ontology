/**
 * @internal Company-API wire shapes.
 *
 * These are the vendor's own request/response/stream types. They are deliberately NOT
 * exported from the package root: the adapter converts them into canonical
 * `GenerationEvent`s at the boundary, so no vendor type ever becomes a platform
 * contract or reaches `contracts`/`core` (SPEC §4.2, INV-01/02).
 *
 * The field names intentionally follow the vendor's snake_case protocol and differ from
 * the canonical contract names; that difference is what the conversion layer absorbs.
 */

export interface CompanyWireMessage {
  readonly role: string
  readonly content: string
}

export interface CompanyWireToolDeclaration {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
  }
}

export interface CompanyWireEvidenceRef {
  readonly id: string
  readonly version: string
  readonly digest: string
  readonly kind: string
}

export interface CompanyWireRequest {
  readonly model: string
  readonly messages: readonly CompanyWireMessage[]
  readonly max_tokens: number
  readonly temperature?: number
  readonly tools?: readonly CompanyWireToolDeclaration[]
  readonly response_format?: { readonly type: 'json_object' }
  readonly evidence_refs?: readonly CompanyWireEvidenceRef[]
  readonly stream: true
}

export interface CompanyWireTextDelta {
  readonly type: 'text_delta'
  readonly text: string
}

export interface CompanyWireToolCallDelta {
  readonly type: 'tool_call_delta'
  readonly call_id: string
  readonly tool: string
  readonly args_delta: string
}

export interface CompanyWireUsage {
  readonly type: 'usage'
  readonly usage: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
  }
}

export interface CompanyWireCompleted {
  readonly type: 'completed'
  readonly finish_reason?: string
}

export interface CompanyWireError {
  readonly type: 'error'
  readonly error_code?: string
  readonly error_message?: string
}

export type CompanyWireChunk =
  | CompanyWireTextDelta
  | CompanyWireToolCallDelta
  | CompanyWireUsage
  | CompanyWireCompleted
  | CompanyWireError

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Decode one SSE data payload into a vendor chunk. `undefined` means the payload is not
 * a recognised vendor chunk; the adapter classifies that as an upstream protocol fault
 * rather than silently dropping it.
 */
export function decodeCompanyWireChunk(payload: string): CompanyWireChunk | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const type = parsed['type']
  switch (type) {
    case 'text_delta': {
      const text = parsed['text']
      return typeof text === 'string' ? { type: 'text_delta', text } : undefined
    }
    case 'tool_call_delta': {
      const callId = optionalString(parsed, 'call_id')
      const tool = optionalString(parsed, 'tool')
      const argsDelta = optionalString(parsed, 'args_delta')
      if (callId === undefined || tool === undefined || argsDelta === undefined) return undefined
      return { type: 'tool_call_delta', call_id: callId, tool, args_delta: argsDelta }
    }
    case 'usage': {
      const usage = parsed['usage']
      if (!isRecord(usage)) return undefined
      const prompt = usage['prompt_tokens']
      const completion = usage['completion_tokens']
      return {
        type: 'usage',
        usage: {
          ...(typeof prompt === 'number' ? { prompt_tokens: prompt } : {}),
          ...(typeof completion === 'number' ? { completion_tokens: completion } : {}),
        },
      }
    }
    case 'completed': {
      const finish = optionalString(parsed, 'finish_reason')
      return finish === undefined ? { type: 'completed' } : { type: 'completed', finish_reason: finish }
    }
    case 'error': {
      const code = optionalString(parsed, 'error_code')
      const message = optionalString(parsed, 'error_message')
      return {
        type: 'error',
        ...(code === undefined ? {} : { error_code: code }),
        ...(message === undefined ? {} : { error_message: message }),
      }
    }
    default:
      return undefined
  }
}
