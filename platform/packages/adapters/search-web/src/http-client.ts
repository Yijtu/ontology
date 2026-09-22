/**
 * HTTP transport for a search endpoint (C5).
 *
 * This module owns the protocol only: it performs the GET, observes the status and
 * returns the raw body text. It parses no vendor payload, applies no domain rule and
 * knows nothing about allowlists — that mapping lives in `mapping.ts` and `provider.ts`.
 */
export interface SearchHttpRequest {
  readonly url: string
  readonly signal: AbortSignal
}

export interface SearchHttpResponse {
  readonly status: number
  readonly retryAfterMs?: number
  readonly bodyText?: string
  readonly errorDetail?: string
}

export interface SearchHttpClientConfig {
  readonly fetchImpl?: typeof fetch
}

export class SearchHttpClient {
  readonly #fetch: typeof fetch

  constructor(config: SearchHttpClientConfig = {}) {
    this.#fetch = config.fetchImpl ?? globalThis.fetch
  }

  async send(request: SearchHttpRequest): Promise<SearchHttpResponse> {
    const response = await this.#fetch(request.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: request.signal,
    })
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    if (!response.ok) {
      const errorDetail = await safeText(response)
      return {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(errorDetail === undefined ? {} : { errorDetail }),
      }
    }
    const bodyText = await response.text()
    return {
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      bodyText,
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
