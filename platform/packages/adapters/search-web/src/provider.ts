import { sha256DigestOf } from '@ontology/core'
import type {
  ToolContext,
  VersionRef,
  WebSearchProvider,
  WebSearchProviderPage,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { WebSearchProviderError, providerErrorForHttpStatus } from './errors'
import { SearchHttpClient } from './http-client'
import { mapSearchResponse } from './mapping'

export interface HttpWebSearchProviderConfig {
  /** Base address of the search endpoint, e.g. a controlled fixture server or the vendor host. */
  readonly baseUrl: string
  /** Path of the search endpoint. Defaults to `/v1/search`. */
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  /** Upper bound for a single call even when the propagated deadline is further out. */
  readonly maxTimeoutMs?: number
}

const DEFAULT_ENDPOINT = '/v1/search'
const DEFAULT_MAX_TIMEOUT_MS = 30_000

const PROVIDER_REF: VersionRef = {
  id: 'web-search.http',
  version: '1.0.0',
  digest: sha256DigestOf('web-search.http@1.0.0'),
}

/**
 * Reference HTTP web-search provider (SPEC C4/C5, US-020/024).
 *
 * It owns the transport and the vendor response mapping, and it enforces the approved
 * domain allowlist before the request leaves (the `domains` query parameter is exactly
 * the approved set) and again on every returned URL (a page whose host is not approved
 * is dropped and counted, never silently widened). It performs no persistence, holds no
 * credentials and applies no budget or permission rule — those belong to the gateway.
 */
export class HttpWebSearchProvider implements WebSearchProvider {
  readonly providerRef: VersionRef = PROVIDER_REF
  readonly #baseUrl: string
  readonly #endpoint: string
  readonly #client: SearchHttpClient
  readonly #now: () => string
  readonly #maxTimeoutMs: number

  constructor(config: HttpWebSearchProviderConfig) {
    this.#baseUrl = config.baseUrl
    this.#endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#client = new SearchHttpClient(
      config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl },
    )
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
  }

  async search(
    request: WebSearchProviderRequest,
    ctx: ToolContext,
  ): Promise<WebSearchProviderResult> {
    void ctx
    if (request.allowedDomains.length === 0) {
      throw new WebSearchProviderError(
        'FORBIDDEN',
        'a web search requires at least one approved domain; the allowlist is never widened',
      )
    }

    const url = this.#buildUrl(request)
    const timeoutMs = this.#timeoutMs(request.deadline)
    const body = await this.#send(url, request.signal, timeoutMs)
    const fetchedAt = this.#now()
    const mapped = mapSearchResponse(body, fetchedAt)

    const allowed = request.allowedDomains.map((domain) => domain.toLowerCase())
    const permitted: WebSearchProviderPage[] = []
    let excludedCount = 0
    for (const page of mapped.pages) {
      if (hostAllowed(page.url, allowed)) permitted.push(page)
      else excludedCount += 1
    }

    const capped = permitted.slice(0, request.limit)
    const truncated = mapped.truncated || permitted.length > request.limit
    return {
      pages: capped,
      truncated,
      excludedCount,
      ...(mapped.nextCursor === undefined ? {} : { nextCursor: mapped.nextCursor }),
      ...(mapped.knownTotal === undefined ? {} : { knownTotal: mapped.knownTotal }),
    }
  }

  #buildUrl(request: WebSearchProviderRequest): string {
    const url = new URL(this.#endpoint, this.#baseUrl)
    url.searchParams.set('query', request.query)
    url.searchParams.set('domains', request.allowedDomains.join(','))
    url.searchParams.set('limit', String(request.limit))
    if (request.freshnessHint !== undefined) {
      url.searchParams.set('freshness', request.freshnessHint)
    }
    if (request.cursor !== undefined) {
      url.searchParams.set('cursor', request.cursor)
    }
    return url.toString()
  }

  #timeoutMs(deadline: string): number {
    const remaining = Date.parse(deadline) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return 1
    return Math.min(remaining, this.#maxTimeoutMs)
  }

  async #send(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    if (signal.aborted) throw deadlineExceeded()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.#client.send({ url, signal: controller.signal })
      if (response.status < 200 || response.status >= 300) {
        throw providerErrorForHttpStatus(
          response.status,
          response.errorDetail ?? `search provider responded with HTTP ${String(response.status)}`,
        )
      }
      if (response.bodyText === undefined) {
        throw new WebSearchProviderError('SOURCE_UNAVAILABLE', 'the search provider returned an empty body')
      }
      return response.bodyText
    } catch (error) {
      if (error instanceof WebSearchProviderError) throw error
      if (signal.aborted || controller.signal.aborted) throw deadlineExceeded()
      throw new WebSearchProviderError('SOURCE_UNAVAILABLE', 'the search provider request failed', {
        cause: error,
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function deadlineExceeded(): WebSearchProviderError {
  return new WebSearchProviderError(
    'DEADLINE_EXCEEDED',
    'the search provider did not answer before the propagated deadline',
    { remoteStateUnknown: true },
  )
}

/**
 * A result is inside the allowlist when its host equals an approved domain or is a
 * subdomain of one. Anything else is outside and is dropped.
 */
export function hostAllowed(pageUrl: string, allowedDomains: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(pageUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}
