import { createHash } from 'node:crypto'
import type { CompanyWireChunk } from './company-wire'

/**
 * @internal OpenAI-compatible wire shapes for `chat/completions` streaming.
 *
 * The company gateway is OpenAI-compatible: each SSE `data:` payload is a
 * `chat.completion.chunk` with `choices[].delta.content` text, `choices[].delta.tool_calls[]`
 * fragments (non-UUID ids, streamed `function.arguments`), a terminal `finish_reason`, an
 * optional trailing `usage`, and a `data: [DONE]` sentinel. These types stay inside the
 * adapter: the codec converts them into the adapter's single internal chunk union, so no
 * OpenAI field ever becomes a platform contract (SPEC §4.2, INV-01/02).
 */

export interface OpenAiFunctionDelta {
  readonly name?: string
  readonly arguments?: string
}

export interface OpenAiToolCallDelta {
  readonly index?: number
  readonly id?: string
  readonly type?: string
  readonly function?: OpenAiFunctionDelta | null
}

export interface OpenAiDelta {
  readonly role?: string
  readonly content?: string | null
  readonly tool_calls?: readonly OpenAiToolCallDelta[] | null
}

export interface OpenAiChoice {
  readonly index?: number
  readonly delta?: OpenAiDelta | null
  readonly finish_reason?: string | null
}

export interface OpenAiUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly total_tokens?: number
}

export interface OpenAiErrorBody {
  readonly message?: string
  readonly type?: string
  readonly code?: string | number
}

export interface OpenAiStreamChunk {
  readonly id?: string
  readonly object?: string
  readonly model?: string
  readonly choices?: readonly OpenAiChoice[]
  // Some gateways emit an explicit `null` for these on chunks that do not carry them.
  readonly usage?: OpenAiUsage | null
  readonly error?: OpenAiErrorBody | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recognise one SSE payload as an OpenAI stream chunk. A payload that parses to JSON but
 * carries none of `choices`/`usage`/`error` is not an OpenAI chunk; returning `undefined`
 * lets the adapter classify it as an upstream protocol fault instead of dropping it.
 */
export function parseOpenAiStreamChunk(payload: string): OpenAiStreamChunk | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (Array.isArray(parsed['choices']) || isRecord(parsed['usage']) || isRecord(parsed['error'])) {
    return parsed
  }
  return undefined
}

interface AccumulatedToolCall {
  id: string | undefined
  name: string | undefined
  args: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CALL_ID_NAMESPACE = 'ontology.adapter.openai.tool-call:'

/**
 * Normalise a provider tool-call id into a canonical UUID.
 *
 * The OpenAI gateway streams ids such as `call_abc123` that are not UUIDs, while the
 * canonical `tool_call_delta` contract requires a `Uuid`. A canonical id is passed
 * through unchanged; anything else is mapped deterministically to a version-5-shaped
 * UUID derived from `CALL_ID_NAMESPACE + <vendor id>`, so the same vendor id always
 * yields the same platform id across runs and retries (and distinct ids stay distinct).
 * A fragment with no id falls back to its per-stream index, which is stable within the
 * one call the codec serves.
 */
export function normaliseToolCallId(rawId: string | undefined, index: number): string {
  if (rawId !== undefined && UUID_PATTERN.test(rawId)) return rawId
  const name = rawId !== undefined && rawId.length > 0 ? rawId : `index.${String(index)}`
  const digest = createHash('sha256').update(`${CALL_ID_NAMESPACE}${name}`).digest('hex')
  const chars = digest.slice(0, 32).split('')
  chars[12] = '5'
  const variant = Number.parseInt(chars[16] ?? '0', 16)
  chars[16] = ((variant & 0x3) | 0x8).toString(16)
  return [
    chars.slice(0, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
    chars.slice(16, 20).join(''),
    chars.slice(20, 32).join(''),
  ].join('-')
}

function protocolError(message: string): CompanyWireChunk {
  return { type: 'error', error_code: 'protocol', error_message: message }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Map an OpenAI error body onto the error-code vocabulary `failureOf` classifies. */
function errorCodeOf(error: OpenAiErrorBody): string | undefined {
  const raw = typeof error.code === 'string' ? error.code : error.type
  if (raw === undefined) return undefined
  const code = raw.toLowerCase()
  if (code.includes('rate')) return 'rate_limit'
  if (code.includes('overload') || code.includes('unavailable') || code.includes('server')) {
    return 'overloaded'
  }
  if (code.includes('timeout')) return 'timeout'
  if (code.includes('invalid')) return 'invalid_request'
  return undefined
}

/**
 * Stateful codec for an OpenAI-compatible stream. Text and usage are emitted as soon as
 * they are seen; tool-call fragments are accumulated by `index` and only flushed by
 * `finish()` once the whole candidate is complete, so a `tool_call_delta` always carries
 * complete JSON and never a half-parsed fragment. `finish()` also emits the terminal
 * `completed` chunk (from `finish_reason`), which is why the adapter can keep treating
 * `completed` as the end of a call.
 */
export class OpenAiStreamCodec {
  readonly #toolCalls = new Map<number, AccumulatedToolCall>()
  #finishReason: string | undefined

  decode(payload: string): readonly CompanyWireChunk[] | undefined {
    const parsed = parseOpenAiStreamChunk(payload)
    if (parsed === undefined) return undefined
    const chunks: CompanyWireChunk[] = []
    const error = parsed.error
    if (error !== undefined && error !== null) {
      const code = errorCodeOf(error)
      chunks.push({
        type: 'error',
        ...(code === undefined ? {} : { error_code: code }),
        ...(error.message === undefined ? {} : { error_message: error.message }),
      })
      return chunks
    }
    const usage = parsed.usage
    if (usage !== undefined && usage !== null) {
      chunks.push({
        type: 'usage',
        usage: {
          ...(typeof usage.prompt_tokens === 'number' ? { prompt_tokens: usage.prompt_tokens } : {}),
          ...(typeof usage.completion_tokens === 'number'
            ? { completion_tokens: usage.completion_tokens }
            : {}),
        },
      })
    }
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta
      if (delta !== undefined && delta !== null) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          chunks.push({ type: 'text_delta', text: delta.content })
        }
        for (const call of delta.tool_calls ?? []) this.#accumulate(call)
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        this.#finishReason = choice.finish_reason
      }
    }
    return chunks
  }

  finish(): readonly CompanyWireChunk[] {
    if (this.#finishReason === undefined) return []
    const chunks: CompanyWireChunk[] = []
    const ordered = [...this.#toolCalls.entries()].sort((left, right) => left[0] - right[0])
    for (const [index, call] of ordered) {
      if (call.name === undefined || call.name.length === 0) {
        chunks.push(protocolError('the provider streamed a tool call without a function name'))
        return chunks
      }
      const args = call.args.trim().length === 0 ? '{}' : call.args
      if (!isCompleteJson(args)) {
        chunks.push(protocolError('the provider streamed incomplete tool-call arguments'))
        return chunks
      }
      chunks.push({
        type: 'tool_call_delta',
        call_id: normaliseToolCallId(call.id, index),
        tool: call.name,
        args_delta: args,
      })
    }
    chunks.push({ type: 'completed', finish_reason: this.#finishReason })
    return chunks
  }

  #accumulate(call: OpenAiToolCallDelta): void {
    const index = typeof call.index === 'number' ? call.index : 0
    const existing = this.#toolCalls.get(index) ?? { id: undefined, name: undefined, args: '' }
    if (typeof call.id === 'string' && call.id.length > 0) existing.id = call.id
    const fn = call.function
    if (fn !== undefined && fn !== null) {
      if (typeof fn.name === 'string' && fn.name.length > 0) existing.name = fn.name
      if (typeof fn.arguments === 'string') existing.args += fn.arguments
    }
    this.#toolCalls.set(index, existing)
  }
}
