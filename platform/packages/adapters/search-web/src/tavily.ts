import { sha256DigestOf } from '@ontology/core'
import type {
  NonEmptyString,
  SecretValue,
  ToolContext,
  VersionRef,
  WebSearchFreshnessHint,
  WebSearchProvider,
  WebSearchProviderPage,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { archivePermittedPage } from './archive-page'
import { WebSearchProviderError, providerErrorForHttpStatus } from './errors'
import { hostAllowed } from './host'
import { SearchHttpClient } from './http-client'
import type { WebPageSnapshotArchiver } from './snapshot-archive'
import { mapTavilyResponse } from './tavily-mapping'

/**
 * The native Tavily Search adapter — a real search backend a deployment can use **without building
 * its own gateway** (design §9).
 *
 * It differs from the compatibility HTTP gateway in three deliberate ways, all fixed by the
 * platform, not by the model:
 *
 * - **No vendor answer generation.** `include_answer: false` is always sent, so the vendor never
 *   returns an authored answer the platform might mistake for evidence; only page results come back.
 * - **No vendor query rewriting.** `auto_parameters: false` is always sent, so the searched query is
 *   exactly the one the runtime approved — a vendor cannot silently widen or re-interpret it.
 * - **Fixed search strategy.** `search_depth`/`topic` are adapter configuration, not per-call model
 *   arguments; `include_raw_content: false` keeps the vendor from acting as the archiver.
 *
 * Original page bytes are archived by the platform `WebPageSnapshotArchiver` (design §6): the
 * vendor summary is never treated as the page, and `contentDigest` describes the archived bytes when
 * an archiver is configured. The approved domain allowlist is enforced before the request leaves
 * (`include_domains` is exactly the approved set) and again on every returned URL.
 *
 * The API key is a `SecretValue`: it is reachable only to build the authorization header and is
 * never placed on a page, a result, or an error message.
 */

export const NATIVE_TAVILY_PROVIDER_REF: VersionRef = {
  id: 'web-search.tavily',
  version: '1.0.0',
  digest: sha256DigestOf('web-search.tavily@1.0.0'),
}

const DEFAULT_BASE_URL = 'https://api.tavily.com'
const DEFAULT_ENDPOINT = '/search'
const DEFAULT_MAX_TIMEOUT_MS = 30_000
const DEFAULT_SEARCH_DEPTH = 'basic'
const DEFAULT_TOPIC = 'general'

export type TavilySearchDepth = 'basic' | 'advanced'
export type TavilyTopic = 'general' | 'news'

export interface NativeTavilySearchProviderConfig {
  /** Tavily API base, e.g. `https://api.tavily.com`. Defaults to the public endpoint. */
  readonly baseUrl?: string
  /** Search path; defaults to `/search`. Kept configurable for a controlled test fixture. */
  readonly endpoint?: string
  /** The resolved credential. Never logged, never returned. */
  readonly apiKey: SecretValue
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  /** Upper bound for a single call even when the propagated deadline is further out. */
  readonly maxTimeoutMs?: number
  /** The fixed search strategy. Not a model-supplied argument. Defaults to `basic`. */
  readonly searchDepth?: TavilySearchDepth
  /** The fixed topic. Not a model-supplied argument. Defaults to `general`. */
  readonly topic?: TavilyTopic
  /**
   * The platform-controlled snapshot archiver. When present, permitted pages are retrieved and
   * archived by the platform; when absent every page is link only (`archive_not_configured`).
   */
  readonly snapshotArchive?: WebPageSnapshotArchiver
}

export class NativeTavilySearchProvider implements WebSearchProvider {
  readonly providerRef: VersionRef = NATIVE_TAVILY_PROVIDER_REF
  readonly #baseUrl: string
  readonly #endpoint: string
  readonly #apiKey: SecretValue
  readonly #client: SearchHttpClient
  readonly #now: () => string
  readonly #maxTimeoutMs: number
  readonly #searchDepth: TavilySearchDepth
  readonly #topic: TavilyTopic
  readonly #snapshotArchive: WebPageSnapshotArchiver | undefined

  constructor(config: NativeTavilySearchProviderConfig) {
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.#endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.#apiKey = config.apiKey
    this.#client = new SearchHttpClient(
      config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl },
    )
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
    this.#searchDepth = config.searchDepth ?? DEFAULT_SEARCH_DEPTH
    this.#topic = config.topic ?? DEFAULT_TOPIC
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

    const url = new URL(this.#endpoint, this.#baseUrl).toString()
    const timeoutMs = this.#timeoutMs(request.deadline)
    const body = await this.#send(url, JSON.stringify(this.#bodyFor(request)), request.signal, timeoutMs)
    const fetchedAt = this.#now()
    const mapped = mapTavilyResponse(body, fetchedAt, request.limit)

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
      ...(mapped.usage === undefined ? {} : { usage: mapped.usage }),
    }
  }

  /**
   * The fixed request body. `include_answer`, `auto_parameters` and `include_raw_content` are
   * constants, exactly so a model cannot ask the vendor to author an answer, rewrite the query or
   * hand back raw content that would bypass the platform archiver.
   */
  #bodyFor(request: WebSearchProviderRequest): Record<string, unknown> {
    const timeRange = timeRangeFor(request.freshnessHint)
    return {
      query: request.query,
      search_depth: this.#searchDepth,
      topic: this.#topic,
      include_answer: false,
      auto_parameters: false,
      include_raw_content: false,
      include_domains: [...request.allowedDomains],
      max_results: request.limit,
      ...(timeRange === undefined ? {} : { time_range: timeRange }),
    }
  }

  #timeoutMs(deadline: string): number {
    const remaining = Date.parse(deadline) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return 1
    return Math.min(remaining, this.#maxTimeoutMs)
  }

  async #send(url: string, body: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    if (signal.aborted) throw deadlineExceeded()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.#client.send({
        url,
        method: 'POST',
        body,
        headers: { authorization: `Bearer ${this.#apiKey.reveal()}` },
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status < 200 || response.status >= 300) {
        throw providerErrorForHttpStatus(
          response.status,
          response.errorDetail ?? `Tavily responded with HTTP ${String(response.status)}`,
        )
      }
      if (response.bodyText === undefined) {
        throw new WebSearchProviderError('SOURCE_UNAVAILABLE', 'the Tavily provider returned an empty body', {
          malformedResponse: true,
        })
      }
      return response.bodyText
    } catch (error) {
      if (error instanceof WebSearchProviderError) throw error
      if (signal.aborted || controller.signal.aborted) throw deadlineExceeded()
      throw new WebSearchProviderError('SOURCE_UNAVAILABLE', 'the Tavily provider request failed', {
        cause: error,
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/** Tavily `time_range` accepts day/week/month/year; an `any` hint omits the bound entirely. */
function timeRangeFor(hint: WebSearchFreshnessHint | undefined): NonEmptyString | undefined {
  switch (hint) {
    case 'day':
      return 'day'
    case 'week':
      return 'week'
    case 'month':
      return 'month'
    case 'year':
      return 'year'
    default:
      return undefined
  }
}

function deadlineExceeded(): WebSearchProviderError {
  return new WebSearchProviderError(
    'DEADLINE_EXCEEDED',
    'the Tavily provider did not answer before the propagated deadline',
    { remoteStateUnknown: true },
  )
}
