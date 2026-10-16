import { sha256DigestOf } from '@ontology/core'
import type {
  ToolContext,
  VersionRef,
  WebSearchProvider,
  WebSearchProviderPage,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { archivePermittedPage } from './archive-page'
import { WebSearchProviderError, providerErrorForHttpStatus } from './errors'
import { hostAllowed } from './host'
import { SearchHttpClient } from './http-client'
import { mapSearchResponse } from './mapping'
import type { WebPageSnapshotArchiver } from './snapshot-archive'

export { hostAllowed } from './host'

export interface HttpWebSearchProviderConfig {
  /** Base address of the search endpoint, e.g. a controlled fixture server or the vendor host. */
  readonly baseUrl: string
  /** Path of the search endpoint. Defaults to `/v1/search`. */
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  /** Upper bound for a single call even when the propagated deadline is further out. */
  readonly maxTimeoutMs?: number
  /**
   * The controlled snapshot archiver. When present, every permitted page is retrieved and archived
   * so its `snapshotRef` names immutable bytes a research flow can cite. When absent the provider
   * returns links only and marks each page `archive_not_configured` — never a fake snapshot.
   */
  readonly snapshotArchive?: WebPageSnapshotArchiver
}

const DEFAULT_ENDPOINT = '/v1/search'
const DEFAULT_MAX_TIMEOUT_MS = 30_000

/** The compatibility-gateway adapter's stable version ref; exported so a probe can pin it. */
export const HTTP_WEB_SEARCH_PROVIDER_REF: VersionRef = {
  id: 'web-search.http',
  version: '1.0.0',
  digest: sha256DigestOf('web-search.http@1.0.0'),
}

const PROVIDER_REF: VersionRef = HTTP_WEB_SEARCH_PROVIDER_REF

/**
 * Compatibility HTTP web-search provider — the "兼容网关" adapter (design §9).
 *
 * It speaks the platform's own HTTP search dialect (`GET /v1/search?query=&domains=&limit=`) for an
 * existing deployment that already runs a self-built search gateway, so such a deployment keeps
 * working. New deployments that must not build a gateway use the native provider
 * (`NativeTavilySearchProvider`) instead; the two share the same `WebSearchProvider` port and the
 * same platform-controlled archiving (design §9).
 *
 * It owns the transport and the vendor response mapping, and it enforces the approved
 * domain allowlist before the request leaves (the `domains` query parameter is exactly
 * the approved set) and again on every returned URL (a page whose host is not approved
 * is dropped and counted, never silently widened). It performs no persistence, holds no
 * credentials and applies no budget or permission rule — those belong to the gateway.
 *
 * When a `snapshotArchive` is configured it also retrieves and archives the *actual page
 * bytes* behind each permitted result (design §2.3): the returned `contentDigest` then
 * describes the archived bytes, not the search summary, and `snapshotRef` names the
 * immutable snapshot. A page it cannot archive is returned as a link only with an explicit
 * `snapshotUnavailableReason`.
 */
export class HttpWebSearchProvider implements WebSearchProvider {
  readonly providerRef: VersionRef = PROVIDER_REF
  readonly #baseUrl: string
  readonly #endpoint: string
  readonly #client: SearchHttpClient
  readonly #now: () => string
  readonly #maxTimeoutMs: number
  readonly #snapshotArchive: WebPageSnapshotArchiver | undefined

  constructor(config: HttpWebSearchProviderConfig) {
    this.#baseUrl = config.baseUrl
    this.#endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#client = new SearchHttpClient(
      config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl },
    )
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
    this.#snapshotArchive = config.snapshotArchive
  }

  async search(
    request: WebSearchProviderRequest,
    ctx: ToolContext,
  ): Promise<WebSearchProviderResult> {
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
    const archived: WebSearchProviderPage[] = []
    for (const page of capped) {
      archived.push(
        await archivePermittedPage(page, request, ctx, this.#snapshotArchive, this.providerRef),
      )
    }

    const truncated = mapped.truncated || permitted.length > request.limit
    return {
      pages: archived,
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
