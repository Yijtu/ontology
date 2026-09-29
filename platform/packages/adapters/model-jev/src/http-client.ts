import type { JevWireRequest } from './vendor/jev-wire'

/**
 * Transport for the JEV decision API. It owns the HTTP/JSON protocol only: it builds the
 * vendor request, sends the bearer credential it is given, and returns the response
 * status plus the parsed body (or an error detail). All vendor decoding happens in
 * `vendor/jev-wire.ts`; the caller never sees a vendor type.
 */

export interface JevHttpRequest {
  readonly body: JevWireRequest
  /** Resolved credential. Revealed only here, only for the Authorization header. */
  readonly apiKey: string
  readonly signal: AbortSignal
}

export interface JevHttpResponse {
  readonly status: number
  readonly retryAfterMs?: number
  /** Parsed JSON body on a 2xx response; `undefined` when the body was absent or invalid. */
  readonly body?: unknown
}

export interface JevHttpClientConfig {
  readonly baseUrl: string
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_ENDPOINT = '/v1/systemone'

export class JevHttpClient {
  readonly #url: string
  readonly #fetch: typeof fetch

  constructor(config: JevHttpClientConfig) {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#url = new URL(endpoint, config.baseUrl).toString()
    this.#fetch = config.fetchImpl ?? globalThis.fetch
  }

  async send(request: JevHttpRequest): Promise<JevHttpResponse> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(request.body),
      signal: request.signal,
    })

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    if (!response.ok) {
      await discardBody(response)
      return {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    }

    const text = await safeText(response)
    if (text === undefined) return { status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    }
    return {
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      body: parsed,
    }
  }
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

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The status and Retry-After headers are enough to classify a rejected request.
  }
}
