import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  JsonObject,
  JsonValue,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
  Usage,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type {
  GenerationCompleted,
  GenerationEvent,
  GenerationMessage,
  GenerationPort,
  GenerationRequest,
  GenerationRole,
  GenerationUsage,
  ModelRef,
  ResourceRef,
  ToolContext,
  ToolId,
} from '@ontology/contracts'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export interface ControlledStreamInput {
  /** The injected generation port. The controlled stream never executes a tool. */
  readonly generation: GenerationPort
  readonly ctx: ToolContext
  readonly modelRef: ModelRef
  readonly role: GenerationRole
  readonly maxTokens: number
  readonly toolIds: readonly ToolId[]
  /** Evidence collected so far, attached to each generation request. */
  readonly evidenceRefs: () => readonly ResourceRef[]
  readonly now: () => string
}

/**
 * The controlled stream function (SPEC §4.2, C2).
 *
 * Pi's `Agent` calls this instead of a provider client. It converts the Pi transcript into a
 * canonical `GenerationRequest`, streams `GenerationEvent`s from the host-injected
 * `GenerationPort`, and folds them back into the single `AssistantMessage` the Pi loop
 * expects. The streamed model output is only a candidate: it becomes the Pi transcript's
 * assistant message (which drives tool proposals) and is never published on any platform
 * surface. Stopping the consumer early lets the generation adapter's own cleanup settle a
 * possibly-billed reservation as `usage_unknown`.
 */
export function createControlledStreamFn(input: ControlledStreamInput): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()
    void runControlledStream(stream, model, context, options?.signal, input).catch(
      (error: unknown) => {
        // Contract: the stream function never throws; failures are encoded in the stream.
        stream.push({
          type: 'error',
          reason: 'error',
          error: failureMessage(model, messageOf(error), input.now()),
        })
      },
    )
    return stream
  }
}

async function runControlledStream(
  stream: AssistantMessageEventStream,
  model: Model<string>,
  context: TranscriptContext,
  signal: AbortSignal | undefined,
  input: ControlledStreamInput,
): Promise<void> {
  const request: GenerationRequest = {
    role: input.role,
    messages: context.messages.map(toGenerationMessage),
    evidenceRefs: [...input.evidenceRefs()],
    toolSchemas: [...input.toolIds],
    modelRef: input.modelRef,
    outputLimit: { maxTokens: input.maxTokens },
  }

  const toolCalls = new Map<string, { readonly toolId: ToolId; argsText: string }>()
  let text = ''
  let usage: GenerationUsage | undefined
  let completed: GenerationCompleted | undefined
  let failure: string | undefined
  let aborted = signal?.aborted === true

  const iterator = input.generation.generate(request, input.ctx)[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), abortSignalPromise(signal)])
      if (next === 'aborted') {
        aborted = true
        break
      }
      if (next.done === true) break
      const event: GenerationEvent = next.value
      switch (event.type) {
        case 'text_delta':
          text += event.text
          break
        case 'tool_call_delta': {
          const existing = toolCalls.get(event.callId)
          toolCalls.set(event.callId, {
            toolId: event.toolId,
            argsText: (existing?.argsText ?? '') + event.argumentsDelta,
          })
          break
        }
        case 'usage':
          usage = event.usage
          break
        case 'completed':
          completed = event
          break
        case 'error':
          failure = event.error.message
          break
      }
    }
  } catch (error) {
    if (signal?.aborted === true) aborted = true
    else failure = messageOf(error)
  } finally {
    // Stop consuming promptly so the generation adapter's cleanup (which settles a
    // possibly-billed reservation as `usage_unknown`) runs instead of leaking a slot.
    await iterator.return?.()
  }

  if (aborted) {
    stream.push({
      type: 'error',
      reason: 'aborted',
      error: failureMessage(model, 'the run was cancelled', input.now()),
    })
    return
  }
  if (failure !== undefined) {
    stream.push({ type: 'error', reason: 'error', error: failureMessage(model, failure, input.now()) })
    return
  }
  if (completed !== undefined && completed.stopReason === 'content_filter') {
    stream.push({
      type: 'error',
      reason: 'error',
      error: failureMessage(model, 'the model response was filtered', input.now()),
    })
    return
  }

  const proposed: ToolCall[] = [...toolCalls.entries()].map(([id, entry]) => ({
    type: 'toolCall',
    id,
    name: entry.toolId,
    arguments: parseArguments(entry.argsText),
  }))
  const stopReason: StopReason =
    proposed.length > 0 ? 'toolUse' : completed?.stopReason === 'length' ? 'length' : 'stop'
  stream.push({
    type: 'done',
    reason: stopReason === 'length' ? 'length' : stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message: {
      role: 'assistant',
      content: [
        ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
        ...proposed,
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: toUsage(usage),
      stopReason,
      timestamp: Date.parse(input.now()),
    },
  })
}

function abortSignalPromise(signal: AbortSignal | undefined): Promise<'aborted'> {
  return new Promise<'aborted'>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve('aborted')
      return
    }
    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
}

function failureMessage(model: Model<string>, message: string, now: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.parse(now),
  }
}

function toUsage(usage: GenerationUsage | undefined): Usage {
  if (usage === undefined || usage.usageUnknown === true) return ZERO_USAGE
  const input = usage.inputTokens
  const output = usage.outputTokens
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function toGenerationMessage(message: TranscriptContext['messages'][number]): GenerationMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: textOf(message.content) }
    case 'user':
      return { role: 'user', content: textOf(message.content) }
    case 'assistant':
      return { role: 'assistant', content: assistantText(message.content) }
    case 'toolResult':
      return { role: 'tool', content: textOf(message.content), toolCallId: message.toolCallId }
  }
}

function assistantText(content: readonly (TextContent | ThinkingContent | ToolCall)[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'toolCall') {
        return `[tool_call ${part.name} ${JSON.stringify(part.arguments)}]`
      }
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '[image omitted]')).join('')
}

/**
 * Convert streamed tool-call argument text into the JSON object the Pi loop validates.
 * The text comes from the model, so a malformed or non-object payload yields `{}` and the
 * Pi loop's schema validation reports the call as an error instead of executing junk.
 */
function parseArguments(argsText: string): JsonObject {
  if (argsText.trim().length === 0) return {}
  try {
    return toJsonObject(JSON.parse(argsText))
  } catch {
    return {}
  }
}

function toJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toJsonValue(entry)
  }
  return result
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') return toJsonObject(value)
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the controlled stream failed'
}
