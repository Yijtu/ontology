import { sha256DigestOf } from '@ontology/core'
import type { Rfc3339UtcTimestamp, WebSearchProviderPage } from '@ontology/contracts'
import { WebSearchProviderError } from './errors'

/**
 * Vendor response mapping for the search endpoint.
 *
 * The wire shape is the adapter's own boundary, so it is validated field by field
 * instead of being trusted. A malformed payload is a `SOURCE_UNAVAILABLE` failure, never
 * an empty success: the platform must not read "I could not parse the provider" as
 * "no results exist".
 */
export interface MappedSearchResponse {
  readonly pages: readonly WebSearchProviderPage[]
  readonly truncated: boolean
  readonly nextCursor?: string | null
  readonly knownTotal?: number
}

const HTTPS_URL = /^https:\/\//

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(detail: string): WebSearchProviderError {
  return new WebSearchProviderError('SOURCE_UNAVAILABLE', `the search provider returned a malformed response: ${detail}`)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw malformed(`${field} must be a non-empty string`)
  return value
}

/**
 * Map one decoded response into provider pages. `fetchedAt` is stamped by the caller so
 * the same response mapped twice reports the same retrieval time.
 */
export function mapSearchResponse(
  bodyText: string,
  fetchedAt: Rfc3339UtcTimestamp,
): MappedSearchResponse {
  let decoded: unknown
  try {
    decoded = JSON.parse(bodyText) as unknown
  } catch {
    throw malformed('the body is not valid JSON')
  }
  if (!isRecord(decoded)) throw malformed('the top level is not an object')

  const results = decoded.results
  if (!Array.isArray(results)) throw malformed('results must be an array')

  const pages: WebSearchProviderPage[] = []
  for (const [index, entry] of results.entries()) {
    if (!isRecord(entry)) throw malformed(`results[${String(index)}] is not an object`)
    const url = requireString(entry.url, `results[${String(index)}].url`)
    if (!HTTPS_URL.test(url)) {
      throw malformed(`results[${String(index)}].url must be an absolute https URL`)
    }
    const title = requireString(entry.title, `results[${String(index)}].title`)
    const content = requireString(entry.content, `results[${String(index)}].content`)
    const snippet = entry.snippet === undefined ? '' : requireString(entry.snippet, `results[${String(index)}].snippet`)
    const publishedAt = entry.publishedAt
    if (publishedAt !== undefined && typeof publishedAt !== 'string') {
      throw malformed(`results[${String(index)}].publishedAt must be an RFC 3339 string when present`)
    }
    pages.push({
      url,
      title,
      snippet,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      fetchedAt,
      contentDigest: sha256DigestOf(content),
    })
  }

  const truncated = decoded.truncated === true
  const nextCursor = readCursor(decoded.nextCursor)
  const knownTotal = readTotal(decoded.total)
  return {
    pages,
    truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(knownTotal === undefined ? {} : { knownTotal }),
  }
}

function readCursor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw malformed('nextCursor must be a non-empty string or null when present')
  }
  return value
}

function readTotal(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw malformed('total must be a non-negative integer when present')
  }
  return value
}
