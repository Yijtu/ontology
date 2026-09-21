import { TOOL_CATALOGUE } from '@ontology/contracts'
import type { GenerationMessage, ResourceRef, ToolId, VersionRef } from '@ontology/contracts'
import { iterateSseData } from './sse'
import type { CompanyWireMessage, CompanyWireRequest, CompanyWireToolDeclaration } from './vendor/company-wire'

/**
 * Transport for the company generation API. It owns the HTTP/SSE protocol only: it
 * builds the vendor request, sends the bearer credential it is given, and returns the
 * response status plus an iterable of raw SSE payloads. All vendor decoding happens in
 * `vendor/company-wire.ts`; the caller never sees a vendor type.
 */

export interface CompanyHttpRequest {
  readonly vendorModel: string
  readonly messages: readonly GenerationMessage[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly toolIds?: readonly ToolId[]
  readonly responseSchemaRef?: VersionRef
  readonly maxTokens: number
  readonly temperature?: number
  /** Resolved credential. Revealed only here, only for the Authorization header. */
  readonly apiKey: string
  readonly signal: AbortSignal
}

export interface CompanyHttpResponse {
  readonly status: number
  readonly retryAfterMs?: number
  readonly payloads: AsyncIterable<string>
  readonly errorDetail?: string
}

export interface CompanyHttpClientConfig {
  readonly baseUrl: string
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_ENDPOINT = '/v1/generate'

export class CompanyHttpClient {
  readonly #url: string
  readonly #fetch: typeof fetch

  constructor(config: CompanyHttpClientConfig) {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#url = new URL(endpoint, config.baseUrl).toString()
    this.#fetch = config.fetchImpl ?? globalThis.fetch
  }

  async send(request: CompanyHttpRequest): Promise<CompanyHttpResponse> {
    const body: CompanyWireRequest = {
      model: request.vendorModel,
      messages: request.messages.map(
        (message): CompanyWireMessage => ({ role: message.role, content: message.content }),
      ),
      max_tokens: request.maxTokens,
      stream: true,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.toolIds === undefined || request.toolIds.length === 0
        ? {}
        : { tools: declarationsFor(request.toolIds) }),
      ...(request.responseSchemaRef === undefined
        ? {}
        : { response_format: { type: 'json_object' as const } }),
      ...(request.evidenceRefs.length === 0
        ? {}
        : {
            evidence_refs: request.evidenceRefs.map((ref) => ({
              id: ref.id,
              version: ref.version,
              digest: ref.digest,
              kind: ref.kind,
            })),
          }),
    }

    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    if (!response.ok) {
      const errorDetail = await safeText(response)
      return {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        payloads: emptyPayloads(),
        ...(errorDetail === undefined ? {} : { errorDetail }),
      }
    }
    if (response.body === null) {
      return { status: response.status, payloads: emptyPayloads(), errorDetail: 'empty response body' }
    }
    return {
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      payloads: iterateSseData(response.body, request.signal),
    }
  }
}

function declarationsFor(toolIds: readonly ToolId[]): readonly CompanyWireToolDeclaration[] {
  const byId = new Map(TOOL_CATALOGUE.map((definition) => [definition.toolId, definition]))
  return toolIds.map((toolId): CompanyWireToolDeclaration => {
    const definition = byId.get(toolId)
    return {
      type: 'function',
      function: {
        name: toolId,
        description: definition === undefined ? toolId : `Platform tool ${toolId}`,
        parameters: definition?.inputSchema ?? { type: 'object' },
      },
    }
  })
}

/** RFC 9110 delta-seconds; anything malformed is treated as "not supplied". */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number.parseInt(trimmed, 10) * 1000
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    return text.length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

async function* emptyPayloads(): AsyncGenerator<string, void, void> {
  // No payloads on a non-2xx response.
}
