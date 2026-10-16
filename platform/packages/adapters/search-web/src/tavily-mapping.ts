import { sha256DigestOf } from '@ontology/core'
import type {
  Rfc3339UtcTimestamp,
  WebSearchProviderPage,
  WebSearchProviderUsage,
} from '@ontology/contracts'
import { WebSearchProviderError } from './errors'

/**
 * Tavily `/search` response mapping (design §9).
 *
 * The wire shape is the adapter's own boundary, so it is validated field by field instead of being
 * trusted. A malformed payload is a `SOURCE_UNAVAILABLE` failure marked `malformedResponse`, never
 * an empty success: the platform must not read "I could not parse the provider" as "no results
 * exist". Only the fields the platform contract needs are read; the vendor `score` is dropped and
 * never presented as a trust probability (design §7).
 */
export interface MappedTavilyResponse {
  readonly pages: readonly WebSearchProviderPage[]
  readonly truncated: boolean
  readonly usage?: WebSearchProviderUsage
}

const HTTPS_URL = /^https:\/\//

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(detail: string): WebSearchProviderError {
  return new WebSearchProviderError(
    'SOURCE_UNAVAILABLE',
    `the Tavily search provider returned a malformed response: ${detail}`,
    { malformedResponse: true },
  )
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw malformed(`${field} must be a non-empty string`)
  return value
}

/**
 * Map one decoded Tavily response. `requestedMax` is the `max_results` the adapter sent, so a full
 * page of results is reported as a bounded recall range rather than a complete one.
 */
export function mapTavilyResponse(
  bodyText: string,
  fetchedAt: Rfc3339UtcTimestamp,
  requestedMax: number,
): MappedTavilyResponse {
  let decoded: unknown
  try {
    decoded = JSON.parse(bodyText) as unknown
  } catch {
    throw malformed('the body is not valid JSON')
  }
  if (!isRecord(decoded)) throw malformed('the top level is not an object')

  const results = decoded['results']
  if (!Array.isArray(results)) throw malformed('results must be an array')

  const pages: WebSearchProviderPage[] = []
  for (const [index, entry] of results.entries()) {
    if (!isRecord(entry)) throw malformed(`results[${String(index)}] is not an object`)
    const url = requireString(entry['url'], `results[${String(index)}].url`)
    if (!HTTPS_URL.test(url)) {
      throw malformed(`results[${String(index)}].url must be an absolute https URL`)
    }
    const rawTitle = entry['title']
    // Tavily occasionally omits/empties a title; the URL is a stable, honest fallback and the
    // contract requires a non-empty title, so a cosmetic gap is not a protocol failure.
    const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : url
    const content = requireString(entry['content'], `results[${String(index)}].content`)
    const publishedRaw = entry['published_date']
    if (publishedRaw !== undefined && typeof publishedRaw !== 'string') {
      throw malformed(`results[${String(index)}].published_date must be a string when present`)
    }
    pages.push({
      url,
      title,
      snippet: content,
      ...(typeof publishedRaw === 'string' && publishedRaw.length > 0 ? { publishedAt: publishedRaw } : {}),
      fetchedAt,
      contentDigest: sha256DigestOf(content),
    })
  }

  const usage = readUsage(decoded)
  return {
    pages,
    truncated: pages.length >= requestedMax,
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Tavily reports `response_time` (seconds) on every call and `usage.credits` when the account is
 * credit-metered. An absent or non-numeric cost is left unset (a hold), never coerced to `0`.
 */
function readUsage(decoded: Record<string, unknown>): WebSearchProviderUsage | undefined {
  const responseTime = decoded['response_time']
  const responseTimeMs =
    typeof responseTime === 'number' && Number.isFinite(responseTime) && responseTime >= 0
      ? Math.round(responseTime * 1000)
      : undefined

  const usageRecord = decoded['usage']
  const creditsRaw = isRecord(usageRecord) ? usageRecord['credits'] : undefined
  const creditsUsed =
    typeof creditsRaw === 'number' && Number.isFinite(creditsRaw) && creditsRaw >= 0 ? creditsRaw : undefined

  if (creditsUsed === undefined && responseTimeMs === undefined) return undefined
  return {
    ...(creditsUsed === undefined ? {} : { creditsUsed }),
    ...(responseTimeMs === undefined ? {} : { responseTimeMs }),
  }
}
