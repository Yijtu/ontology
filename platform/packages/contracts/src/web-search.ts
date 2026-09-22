import type {
  NonEmptyString,
  OpaqueCursor,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  VersionRef,
  WebSearchFreshnessHint,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Replaceable web-search provider port (SPEC C4/C5, US-020/024, FR-25/26/33).
 *
 * The `web_search` tool is transport-agnostic: a provider owns the HTTP protocol and
 * the vendor response shape, and the tool handler owns the platform semantics (domain
 * allowlist enforcement, evidence mapping, truncation/empty/error distinction). This
 * port lives in `contracts` because the tool handler is a service-layer component and
 * the provider is an adapter: an adapter may depend on `contracts` but never on a
 * service, so the interface both sides share has to be here.
 *
 * The provider is a public-web read. It receives the already-authorized domain set the
 * gateway approved and must never widen it. `ctx` is passed through by convention so a
 * provider can enforce scope if it reaches tenant-scoped infrastructure; the reference
 * HTTP provider uses it only for the trusted deadline/identity it already carries.
 */
export interface WebSearchProviderRequest {
  readonly query: NonEmptyString
  /** The exact allowlist the gateway approved. The provider must not add to it. */
  readonly allowedDomains: readonly string[]
  readonly freshnessHint?: WebSearchFreshnessHint
  readonly cursor?: OpaqueCursor
  /** Bounded page count the caller will accept. */
  readonly limit: number
  /** The propagated child deadline; a provider must abort at or before it. */
  readonly deadline: Rfc3339UtcTimestamp
  readonly signal: AbortSignal
}

/**
 * One fetched public page. `url` is the canonical `https://` page address, `fetchedAt`
 * is when the provider actually retrieved it and `publishedAt` is present only when the
 * page declared one. `contentDigest` is the digest of the exact retrieved text; the raw
 * text is never returned, so untrusted content cannot travel beyond the provider as a
 * first-class field.
 */
export interface WebSearchProviderPage {
  readonly url: string
  readonly title: NonEmptyString
  readonly snippet: string
  readonly publishedAt?: Rfc3339UtcTimestamp
  readonly fetchedAt: Rfc3339UtcTimestamp
  readonly contentDigest: Sha256Digest
}

/**
 * A provider response. `truncated` distinguishes a bounded recall range from a complete
 * one; `excludedCount` reports pages the provider dropped because their host was outside
 * the approved allowlist (a non-zero value is surfaced as a warning, never as a silently
 * widened result).
 */
export interface WebSearchProviderResult {
  readonly pages: readonly WebSearchProviderPage[]
  readonly truncated: boolean
  readonly nextCursor?: OpaqueCursor | null
  readonly knownTotal?: number
  readonly excludedCount: number
}

export interface WebSearchProvider {
  readonly providerRef: VersionRef
  search(
    request: WebSearchProviderRequest,
    ctx: ToolContext,
  ): Promise<WebSearchProviderResult>
}
