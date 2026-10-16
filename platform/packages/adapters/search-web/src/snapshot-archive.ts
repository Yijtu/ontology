import { canonicalJson } from '@ontology/core'
import { assertWebPageSnapshotManifestShape } from '@ontology/contracts'
import type {
  ImmutableArtifactWriter,
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  ScopeRef,
  ToolContext,
  VersionRef,
  WebContentForm,
  WebPageSnapshotManifest,
  WebSnapshotArchiveLimits,
  WebSnapshotSkipReason,
} from '@ontology/contracts'
import { hostAllowed } from './host'

/** One page retrieval is bounded to the same ceiling as the controlled model probe. */
const DEFAULT_MAX_TIMEOUT_MS = 8_000
/** One archived page can never exceed the workspace snapshot cap. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_ACCEPTED_FORMS: readonly WebContentForm[] = ['html', 'text', 'json', 'xml']

const MEDIA_TYPE_MAX_LENGTH = 128
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder('utf-8')
/** The derived-text parser this archiver ships; a change is a new detectable revision (design §6). */
const DEFAULT_PARSER_VERSION: Semver = '1.0.0'

export interface WebPageSnapshotArchiveConfig {
  /** Archives the retrieved bytes; the adapter never touches a driver, only this port. */
  readonly artifacts: ImmutableArtifactWriter
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  /** Wall-clock bound for one page fetch. Defaults to the controlled 8s probe budget. */
  readonly maxTimeoutMs?: number
  /** Maximum decoded bytes archived for one page. Defaults to the 8 MiB snapshot cap. */
  readonly maxBytes?: number
  /** Content forms that can be archived and parsed. Anything else is a link only. */
  readonly acceptedContentForms?: readonly WebContentForm[]
  /** The derived-text parser version recorded on every archived page (design §6). */
  readonly parserVersion?: Semver
}

export interface WebPageSnapshotArchiveRequest {
  readonly url: string
  readonly allowedDomains: readonly string[]
  readonly deadline: Rfc3339UtcTimestamp
  readonly signal: AbortSignal
  /** The provider implementation/version that performed the retrieval; recorded in the manifest. */
  readonly providerRef: VersionRef
}

export interface ArchivedPageSnapshot {
  readonly status: 'archived'
  readonly snapshotRef: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly contentForm: WebContentForm
  readonly mediaType: NonEmptyString
  readonly byteSize: number
  readonly fetchedAt: Rfc3339UtcTimestamp
  /** The manifest artifact naming the original bytes and the separately archived parsed text. */
  readonly manifestRef: ResourceRef
  readonly parsedRef?: ResourceRef
  readonly parsedDigest?: Sha256Digest
  /** The derived-text parser version that produced the archived readable text. */
  readonly parserVersion: Semver
}

export interface UnarchivedPage {
  readonly status: 'discovery_only'
  readonly reason: WebSnapshotSkipReason
  readonly fetchedAt: Rfc3339UtcTimestamp
}

export type WebPageSnapshotArchiveOutcome = ArchivedPageSnapshot | UnarchivedPage

/** A page whose bytes were retrieved within every bound, before any artifact write. */
interface RetrievedPage {
  readonly status: 'retrieved'
  readonly form: WebContentForm
  readonly mediaType: NonEmptyString
  readonly bytes: Uint8Array
  readonly fetchedAt: Rfc3339UtcTimestamp
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function discoveryOnly(reason: WebSnapshotSkipReason, fetchedAt: Rfc3339UtcTimestamp): UnarchivedPage {
  return { status: 'discovery_only', reason, fetchedAt }
}

/**
 * The controlled snapshot archiver behind `web_search` (design §2.3, A-R02/R03).
 *
 * It fetches the *actual page bytes* (never the search summary) over a bounded, redirect-refusing
 * request, and it archives them as an immutable artifact. It refuses anything it cannot fetch and
 * verify:
 *
 * - only `https` URLs whose host is inside the approved allowlist are fetched;
 * - a redirect is refused (`redirect: 'manual'`, any 3xx is a `redirect_forbidden` outcome) so an
 *   approved host cannot bounce the retrieval to an unapproved one;
 * - the fetch is bounded by the propagated deadline and an 8s ceiling;
 * - the decoded body is streamed and capped, so a large page or a decompression bomb is a
 *   `download_exceeded` outcome, not an unbounded read;
 * - only readable content forms are archived; binary/unknown forms are a link only.
 *
 * The exact bytes and the derived readable text are archived *separately*, and a manifest records
 * the content form, fetch time, provider version and the archive bounds — so a research flow can
 * cite a stable artifact and a reviewer can tell the retrieved page from a derived parse.
 *
 * It does not resolve hosts or pin a resolved IP: the approved-domain allowlist plus the
 * deployment's egress policy are the network-target control (AGENTS: outbound targets are a
 * deployment boundary), and this adapter never widens the allowlist it is handed.
 */
export class WebPageSnapshotArchiver {
  readonly #artifacts: ImmutableArtifactWriter
  readonly #fetch: typeof fetch
  readonly #now: () => string
  readonly #maxTimeoutMs: number
  readonly #maxBytes: number
  readonly #acceptedForms: readonly WebContentForm[]
  readonly #parserVersion: Semver

  constructor(config: WebPageSnapshotArchiveConfig) {
    this.#artifacts = config.artifacts
    this.#fetch = config.fetchImpl ?? globalThis.fetch
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
    this.#maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
    this.#acceptedForms = config.acceptedContentForms ?? DEFAULT_ACCEPTED_FORMS
    this.#parserVersion = config.parserVersion ?? DEFAULT_PARSER_VERSION
  }

  async archive(
    request: WebPageSnapshotArchiveRequest,
    ctx: ToolContext,
  ): Promise<WebPageSnapshotArchiveOutcome> {
    const retrieved = await this.#retrieve(request)
    if (retrieved.status === 'discovery_only') return retrieved

    // Retrieval succeeded, so archiving the bytes is not best-effort: a storage failure must
    // surface rather than be reported as "no archivable content", which would silently turn a
    // citable page into a link-only result.
    const scopeRef = scopeOf(ctx)
    const { form, mediaType, bytes, fetchedAt } = retrieved
    const original = await this.#artifacts.putBytes({ scopeRef, content: bytes, mediaType }, ctx)

    const parsedText = deriveParsedText(form, bytes)
    const parsed = parsedText.length === 0
      ? undefined
      : await this.#artifacts.putBytes(
          { scopeRef, content: TEXT_ENCODER.encode(parsedText), mediaType: 'text/plain' },
          ctx,
        )

    const limits: WebSnapshotArchiveLimits = {
      maxBytes: this.#maxBytes,
      maxTimeoutMs: this.#maxTimeoutMs,
      redirectsAllowed: false,
      acceptedContentForms: [...this.#acceptedForms],
    }
    const manifest: WebPageSnapshotManifest = {
      schemaVersion: 'web-page-snapshot@1',
      url: request.url,
      providerRef: request.providerRef,
      fetchedAt,
      contentForm: form,
      mediaType,
      originalRef: original.blobRef,
      originalDigest: original.contentDigest,
      originalByteSize: bytes.byteLength,
      ...(parsed === undefined ? {} : { parsedRef: parsed.blobRef, parsedDigest: parsed.contentDigest }),
      limits,
    }
    assertWebPageSnapshotManifestShape(manifest)
    const manifestRef = await this.#artifacts.putBytes(
      { scopeRef, content: TEXT_ENCODER.encode(canonicalJson(manifest)), mediaType: 'application/json' },
      ctx,
    )

    return {
      status: 'archived',
      snapshotRef: original.blobRef,
      contentDigest: original.contentDigest,
      contentForm: form,
      mediaType,
      byteSize: bytes.byteLength,
      fetchedAt,
      manifestRef: manifestRef.blobRef,
      ...(parsed === undefined ? {} : { parsedRef: parsed.blobRef, parsedDigest: parsed.contentDigest }),
      parserVersion: this.#parserVersion,
    }
  }

  /**
   * Bounded page retrieval. Every failure here is a per-page link-only outcome; a run-level
   * cancellation is rethrown so it is never masked. The error is never surfaced with the page
   * body — the reason code is all a caller may see.
   */
  async #retrieve(request: WebPageSnapshotArchiveRequest): Promise<RetrievedPage | UnarchivedPage> {
    const attemptedAt = this.#now()
    const target = parseHttpsUrl(request.url)
    if (target === undefined) return discoveryOnly('domain_not_allowed', attemptedAt)
    if (!hostAllowed(request.url, request.allowedDomains)) {
      return discoveryOnly('domain_not_allowed', attemptedAt)
    }

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMsFor(request.deadline, this.#maxTimeoutMs))

    try {
      const response = await this.#fetch(target, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' },
        signal: controller.signal,
      })

      if (isRedirect(response)) {
        await cancelBody(response)
        return discoveryOnly('redirect_forbidden', attemptedAt)
      }
      if (!response.ok) {
        await cancelBody(response)
        return discoveryOnly('http_error', attemptedAt)
      }

      const mediaType = readMediaType(response.headers.get('content-type'))
      const form = mediaType === undefined ? undefined : contentFormFor(mediaType)
      if (mediaType === undefined || form === undefined || !this.#acceptedForms.includes(form)) {
        await cancelBody(response)
        return discoveryOnly('unsupported_content_type', attemptedAt)
      }

      const body = await readBounded(response, this.#maxBytes)
      if (body.status === 'exceeded') return discoveryOnly('download_exceeded', attemptedAt)
      if (body.status === 'empty') return discoveryOnly('empty_body', attemptedAt)

      return { status: 'retrieved', form, mediaType, bytes: body.bytes, fetchedAt: this.#now() }
    } catch (error) {
      if (request.signal.aborted) throw error
      return discoveryOnly(timedOut ? 'fetch_timeout' : 'fetch_failed', attemptedAt)
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

function timeoutMsFor(deadline: Rfc3339UtcTimestamp, ceiling: number): number {
  const remaining = Date.parse(deadline) - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) return 1
  return Math.min(remaining, ceiling)
}

function parseHttpsUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * A redirect is refused before its body is read. `redirect: 'manual'` leaves the 3xx observable
 * (Node returns the status; some runtimes return an opaque-redirect response), so both shapes are
 * treated as a redirect and neither is followed.
 */
function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

type BoundedBody =
  | { readonly status: 'ok'; readonly bytes: Uint8Array }
  | { readonly status: 'empty' }
  | { readonly status: 'exceeded' }

/** Read the body in bounded chunks so a large page or a decompression bomb cannot exhaust memory. */
async function readBounded(response: Response, maxBytes: number): Promise<BoundedBody> {
  const body = response.body
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) return { status: 'empty' }
    return bytes.byteLength > maxBytes ? { status: 'exceeded' } : { status: 'ok', bytes }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      if (chunk === undefined) continue
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { status: 'exceeded' }
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return { status: 'empty' }
  return { status: 'ok', bytes: concat(chunks, total) }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function readMediaType(header: string | null): NonEmptyString | undefined {
  if (header === null) return undefined
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mediaType.length === 0 || mediaType.length > MEDIA_TYPE_MAX_LENGTH) return undefined
  return mediaType
}

function contentFormFor(mediaType: string): WebContentForm | undefined {
  switch (mediaType) {
    case 'text/html':
    case 'application/xhtml+xml':
      return 'html'
    case 'text/plain':
    case 'text/markdown':
      return 'text'
    case 'application/json':
    case 'text/json':
      return 'json'
    case 'application/xml':
    case 'text/xml':
      return 'xml'
    default:
      return undefined
  }
}

/**
 * The derived, readable text archived separately from the original bytes. HTML/XML tags and
 * scripts are stripped; plain text and JSON are decoded as-is. This is a lossy convenience view —
 * the original bytes stay the citable record.
 */
function deriveParsedText(form: WebContentForm, bytes: Uint8Array): string {
  const decoded = TEXT_DECODER.decode(bytes)
  if (form === 'html' || form === 'xml') return stripMarkup(decoded)
  return decoded.trim()
}

function stripMarkup(markup: string): string {
  const withoutScripts = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, ' ')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? match)
}
