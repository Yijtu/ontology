import type {
  NonEmptyString,
  OpaqueCursor,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  VersionRef,
  WebSearchFreshnessHint,
} from './generated/contracts'
import { isRecord, isResourceRef } from './asset-workspace'
import type { ToolContext } from './trusted'

/**
 * The archived form of the retrieved page bytes. `binary` is a legitimate *discovered* form but
 * not one this reference archiver can derive readable text from, so it is reported as a link
 * only rather than stored as a citable snapshot.
 */
export type WebContentForm = 'html' | 'text' | 'json' | 'xml' | 'binary'

/**
 * Why a discovered page is a link only and cannot be a formal basis. `archive_not_configured`
 * is set by a provider that has no archiver wired; the rest are per-page retrieval outcomes.
 */
export type WebSnapshotSkipReason =
  | 'archive_not_configured'
  | 'domain_not_allowed'
  | 'redirect_forbidden'
  | 'unsupported_content_type'
  | 'empty_body'
  | 'download_exceeded'
  | 'fetch_timeout'
  | 'http_error'
  | 'fetch_failed'

/**
 * The enforced bounds and scope of one snapshot archive. These are recorded with the snapshot so
 * a reader can prove what was retrieved had a ceiling, and `redirectsAllowed` is the literal
 * `false`: a redirect is refused, never silently followed to an unapproved host.
 */
export interface WebSnapshotArchiveLimits {
  readonly maxBytes: number
  readonly maxTimeoutMs: number
  readonly redirectsAllowed: false
  readonly acceptedContentForms: readonly WebContentForm[]
}

/**
 * The metadata record of one archived page. The bytes themselves live in the immutable artifacts
 * the record names: `originalRef` is the exact retrieved bytes (the citable original) and
 * `parsedRef`, when present, is the derived readable text archived *separately*, so a consumer can
 * tell the retrieved page apart from a derived parse. `providerRef` pins the implementation and
 * version that produced the bytes, so a later change is detectable.
 */
export interface WebPageSnapshotManifest {
  readonly schemaVersion: 'web-page-snapshot@1'
  readonly url: string
  readonly providerRef: VersionRef
  readonly fetchedAt: Rfc3339UtcTimestamp
  readonly contentForm: WebContentForm
  readonly mediaType: NonEmptyString
  readonly originalRef: ResourceRef
  readonly originalDigest: Sha256Digest
  readonly originalByteSize: number
  readonly parsedRef?: ResourceRef
  readonly parsedDigest?: Sha256Digest
  readonly limits: WebSnapshotArchiveLimits
}

export const WEB_CONTENT_FORMS: readonly WebContentForm[] = ['html', 'text', 'json', 'xml', 'binary']

export const WEB_SNAPSHOT_SKIP_REASONS: readonly WebSnapshotSkipReason[] = [
  'archive_not_configured',
  'domain_not_allowed',
  'redirect_forbidden',
  'unsupported_content_type',
  'empty_body',
  'download_exceeded',
  'fetch_timeout',
  'http_error',
  'fetch_failed',
]

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
  /**
   * The immutable snapshot of the exact page bytes, present only when the provider both retrieved
   * and archived the page. It lets a research flow cite a stable artifact instead of a page that
   * may change after retrieval; a page without it cannot be ingested as a citable source.
   */
  readonly snapshotRef?: ResourceRef
  /**
   * The metadata record of the archived snapshot (content form, fetch time, provider version,
   * archive bounds). Present together with `snapshotRef`; it names the separately archived
   * derived text as well as the original bytes.
   */
  readonly snapshotManifestRef?: ResourceRef
  /**
   * Why this discovered page could not be archived (a link only, never a formal basis). Present
   * only when there is no `snapshotRef`, so "found a link" is never mistaken for "can cite it".
   */
  readonly snapshotUnavailableReason?: WebSnapshotSkipReason
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

const HTTPS_URL = /^https:\/\//
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function assertLimits(value: unknown): void {
  if (!isRecord(value) || !Number.isSafeInteger(value['maxBytes']) || (value['maxBytes'] as number) < 1
    || !Number.isSafeInteger(value['maxTimeoutMs']) || (value['maxTimeoutMs'] as number) < 1
    || value['redirectsAllowed'] !== false
    || !Array.isArray(value['acceptedContentForms']) || value['acceptedContentForms'].length === 0
    || !value['acceptedContentForms'].every((form) => WEB_CONTENT_FORMS.includes(form as WebContentForm))) {
    throw new Error('invalid web snapshot archive limits')
  }
}

/**
 * Runtime validation of an archived-page manifest before it is stored as an immutable artifact.
 * It rejects a manifest that does not name both an https page and a digest-bound original, so a
 * caller cannot record a snapshot whose bytes are missing or unverifiable.
 */
export function assertWebPageSnapshotManifestShape(value: unknown): asserts value is WebPageSnapshotManifest {
  if (!isRecord(value) || value['schemaVersion'] !== 'web-page-snapshot@1'
    || typeof value['url'] !== 'string' || !HTTPS_URL.test(value['url'])
    || !isRecord(value['providerRef'])
    || typeof value['fetchedAt'] !== 'string' || !Number.isFinite(Date.parse(value['fetchedAt']))
    || !WEB_CONTENT_FORMS.includes(value['contentForm'] as WebContentForm)
    || !isNonEmptyString(value['mediaType']) || (value['mediaType'] as string).length > 128
    || !isResourceRef(value['originalRef'])
    || typeof value['originalDigest'] !== 'string' || !SHA256_PATTERN.test(value['originalDigest'])
    || !Number.isSafeInteger(value['originalByteSize']) || (value['originalByteSize'] as number) < 1
    || (value['parsedRef'] !== undefined && !isResourceRef(value['parsedRef']))
    || (value['parsedDigest'] !== undefined && (typeof value['parsedDigest'] !== 'string' || !SHA256_PATTERN.test(value['parsedDigest'])))) {
    throw new Error('invalid web page snapshot manifest')
  }
  assertLimits(value['limits'])
}
