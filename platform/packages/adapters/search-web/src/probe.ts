import { createHash } from 'node:crypto'
import type {
  ImmutableArtifactWriter,
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ScopedArtifactReader,
  SecretValue,
  ToolAdapterType,
  ToolConnectionDescriptor,
  ToolConnectionProbeItem,
  ToolConnectionProbePort,
  ToolConnectionProbeReason,
  ToolConnectionProbeResult,
  ToolContext,
  ToolCredentialCustodian,
  VersionRef,
  WebSearchProvider,
  WebSnapshotSkipReason,
} from '@ontology/contracts'
import { isWebSearchProviderError } from './errors'
import { HTTP_WEB_SEARCH_PROVIDER_REF, HttpWebSearchProvider } from './provider'
import { WebPageSnapshotArchiver } from './snapshot-archive'
import { NATIVE_TAVILY_PROVIDER_REF, NativeTavilySearchProvider } from './tavily'
import type { TavilySearchDepth } from './tavily'

/**
 * The two-item web-search connection probe (design §9).
 *
 * "The interface adapter compiles" is never "the connection really works", so the probe runs two
 * independent, bounded tests and reports them separately:
 *
 * 1. **search** — one small, explicit, real query that proves authentication, the response
 *    *mapping* and the deadline end to end. It is not a `GET /health`.
 * 2. **archive** — a read-back of one approved test page through the platform archiver, proving the
 *    retrieved bytes' digest and a readable fragment, so "search works" never implies "pages archive".
 *
 * It never fabricates a capability: an unconfigured connection reports `not_configured` (both items
 * skipped), a missing credential reports `authentication_failed`, and every failure is a classified,
 * sanitized reason — no credential, no provider body. Each probe has its own timeout and refuses
 * redirects through the same bounded archiver the run path uses, and it writes no business candidate.
 */

export interface WebSearchArchiveProbeTarget {
  /** The approved test page (an absolute `https` URL inside `domains`). */
  readonly url: string
  /** The approved allowlist that must contain the test page host. */
  readonly domains: readonly string[]
}

export interface WebSearchConnectionProbeConfig {
  /** Resolves the opaque credential ref; the value never leaves custody. */
  readonly credentials: ToolCredentialCustodian
  /** The one small, explicit real query and its approved domains. */
  readonly searchQuery: NonEmptyString
  readonly searchDomains: readonly string[]
  /** The approved test page read back by the archive item. Absent ⇒ archive item is `not_configured`. */
  readonly testPage?: WebSearchArchiveProbeTarget
  /** Archives the test page bytes; without it the archive item is `not_configured`. */
  readonly artifacts?: ImmutableArtifactWriter
  /** Reads the archived bytes/fragment back so a digest mismatch is detectable. */
  readonly artifactReader?: ScopedArtifactReader
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  /** Independent probe budget (default 8s), never the run's own deadline. */
  readonly maxTimeoutMs?: number
  /** The compat gateway's search path when probing an `http_compat` connection. Defaults to `/v1/search`. */
  readonly compatEndpointPath?: string
  /** The fixed native search strategy used by the probe query. */
  readonly searchDepth?: TavilySearchDepth
}

const DEFAULT_MAX_TIMEOUT_MS = 8_000
const DEFAULT_COMPAT_ENDPOINT = '/v1/search'

export class WebSearchConnectionProbe implements ToolConnectionProbePort {
  readonly #config: WebSearchConnectionProbeConfig
  readonly #maxTimeoutMs: number
  readonly #now: () => string

  constructor(config: WebSearchConnectionProbeConfig) {
    this.#config = config
    this.#maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
    this.#now = config.now ?? (() => new Date().toISOString())
  }

  async probe(
    scopeRef: ScopeRef,
    request: {
      readonly draft: ToolConnectionDescriptor
      readonly credentialRef?: ResourceRef
      readonly signal?: AbortSignal
    },
    ctx: ToolContext,
  ): Promise<ToolConnectionProbeResult> {
    const testedAt = this.#now()
    const signal = request.signal ?? new AbortController().signal
    const descriptor = request.draft
    const endpoint = descriptor.endpoint?.trim()

    // No endpoint ⇒ the connection is simply not configured. Report that honestly, never a pass.
    if (endpoint === undefined || endpoint.length === 0 || !descriptor.capabilities.includes('web_search')) {
      return probeResult(testedAt, {
        credentialConfigured: false,
        search: skipped('not_configured'),
        archive: skipped('not_configured'),
      })
    }

    const credential = await this.#resolveCredential(scopeRef, request.credentialRef, ctx)
    const credentialConfigured = credential !== undefined

    const search = await this.#probeSearch(descriptor, endpoint, credential, ctx, signal)
    const archive = await this.#probeArchive(descriptor, signal, ctx)

    return probeResult(testedAt, { credentialConfigured, search, archive })
  }

  async #resolveCredential(
    scopeRef: ScopeRef,
    credentialRef: ResourceRef | undefined,
    ctx: ToolContext,
  ): Promise<SecretValue | undefined> {
    if (credentialRef === undefined) return undefined
    try {
      return await this.#config.credentials.resolve(scopeRef, credentialRef, ctx)
    } catch {
      return undefined
    }
  }

  async #probeSearch(
    descriptor: ToolConnectionDescriptor,
    endpoint: string,
    credential: SecretValue | undefined,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolConnectionProbeItem> {
    if (this.#config.searchDomains.length === 0 || this.#config.searchQuery.length === 0) {
      return skipped('not_configured')
    }
    const started = Date.now()
    const provider = this.#providerFor(descriptor, endpoint, credential)
    if (provider === undefined) {
      // A native connection with no resolvable credential cannot authenticate; report that.
      return { status: 'failed', reason: 'authentication_failed', latencyMs: Date.now() - started }
    }
    try {
      await provider.search(
        {
          query: this.#config.searchQuery,
          allowedDomains: [...this.#config.searchDomains],
          limit: 1,
          deadline: this.#deadline(),
          signal,
        },
        ctx,
      )
      return { status: 'passed', latencyMs: Date.now() - started }
    } catch (error) {
      return { status: 'failed', reason: classifySearchFailure(error), latencyMs: Date.now() - started }
    }
  }

  #providerFor(
    descriptor: ToolConnectionDescriptor,
    endpoint: string,
    credential: SecretValue | undefined,
  ): WebSearchProvider | undefined {
    const { fetchImpl, now, searchDepth } = this.#config
    const shared = {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(now === undefined ? {} : { now }),
      maxTimeoutMs: this.#maxTimeoutMs,
    }
    if (descriptor.adapterType === 'native_tavily') {
      if (credential === undefined) return undefined
      return new NativeTavilySearchProvider({
        baseUrl: endpoint,
        apiKey: credential,
        ...(searchDepth === undefined ? {} : { searchDepth }),
        ...shared,
      })
    }
    return new HttpWebSearchProvider({
      baseUrl: endpoint,
      endpoint: this.#config.compatEndpointPath ?? DEFAULT_COMPAT_ENDPOINT,
      ...shared,
    })
  }

  async #probeArchive(
    descriptor: ToolConnectionDescriptor,
    signal: AbortSignal,
    ctx: ToolContext,
  ): Promise<ToolConnectionProbeItem> {
    const target = this.#config.testPage
    const artifacts = this.#config.artifacts
    const reader = this.#config.artifactReader
    if (target === undefined || artifacts === undefined || reader === undefined) {
      return skipped('not_configured')
    }
    const started = Date.now()

    const archiver = new WebPageSnapshotArchiver({
      artifacts,
      ...(this.#config.fetchImpl === undefined ? {} : { fetchImpl: this.#config.fetchImpl }),
      ...(this.#config.now === undefined ? {} : { now: this.#config.now }),
      maxTimeoutMs: this.#maxTimeoutMs,
    })
    try {
      const outcome = await archiver.archive(
        {
          url: target.url,
          allowedDomains: [...target.domains],
          deadline: this.#deadline(),
          signal,
          providerRef: providerRefFor(descriptor.adapterType),
        },
        ctx,
      )
      const latencyMs = Date.now() - started
      if (outcome.status === 'discovery_only') {
        return { status: 'failed', reason: archiveFailureReason(outcome.reason), latencyMs }
      }

      const bytes = await reader.read({ approvedInputRefs: [outcome.snapshotRef] }, ctx)
      if (sha256Of(bytes) !== outcome.contentDigest || bytes.byteLength !== outcome.byteSize) {
        return { status: 'failed', reason: 'digest_mismatch', latencyMs }
      }
      if (outcome.parsedRef !== undefined) {
        const fragment = await reader.read({ approvedInputRefs: [outcome.parsedRef] }, ctx)
        if (fragment.byteLength === 0) {
          return { status: 'failed', reason: 'page_not_readable', latencyMs }
        }
      }
      return { status: 'passed', latencyMs }
    } catch {
      return {
        status: 'failed',
        reason: signal.aborted ? 'timeout' : 'unreachable',
        latencyMs: Date.now() - started,
      }
    }
  }

  #deadline(): Rfc3339UtcTimestamp {
    return new Date(Date.now() + this.#maxTimeoutMs).toISOString()
  }
}

/** Build the probe from explicit, operator-supplied test parameters and injected custody/ports. */
export function createWebSearchConnectionProbe(
  config: WebSearchConnectionProbeConfig,
): ToolConnectionProbePort {
  return new WebSearchConnectionProbe(config)
}

function providerRefFor(adapterType: ToolAdapterType): VersionRef {
  return adapterType === 'native_tavily' ? NATIVE_TAVILY_PROVIDER_REF : HTTP_WEB_SEARCH_PROVIDER_REF
}

function probeResult(
  testedAt: Rfc3339UtcTimestamp,
  items: {
    readonly credentialConfigured: boolean
    readonly search: ToolConnectionProbeItem
    readonly archive: ToolConnectionProbeItem
  },
): ToolConnectionProbeResult {
  // The port is handed an (unsaved) descriptor, so the result is a draft result; a
  // stored-revision caller that persists the summary marks it as such itself.
  return {
    schemaVersion: 'tool-connection-test-result@1',
    testedAt,
    draft: true,
    credentialConfigured: items.credentialConfigured,
    search: items.search,
    archive: items.archive,
  }
}

function skipped(reason: ToolConnectionProbeReason): ToolConnectionProbeItem {
  return { status: 'skipped', reason }
}

/**
 * Map a classified provider failure onto a probe reason. A malformed *response* is
 * `invalid_response` (the service answered wrongly); a transport failure is `unreachable`.
 */
function classifySearchFailure(error: unknown): ToolConnectionProbeReason {
  if (!isWebSearchProviderError(error)) return 'unreachable'
  switch (error.code) {
    case 'FORBIDDEN':
      return 'authentication_failed'
    case 'DEADLINE_EXCEEDED':
      return 'timeout'
    case 'RATE_LIMITED':
      return 'rate_limited'
    case 'UNSUPPORTED_QUERY':
      return 'protocol_mismatch'
    case 'SOURCE_UNAVAILABLE':
      return error.malformedResponse ? 'invalid_response' : 'unreachable'
    case 'RESULT_TOO_LARGE':
    case 'INVALID_ARGUMENT':
    case 'INTERNAL_ERROR':
      return 'invalid_response'
    default:
      return 'invalid_response'
  }
}

function archiveFailureReason(reason: WebSnapshotSkipReason): ToolConnectionProbeReason {
  switch (reason) {
    case 'fetch_timeout':
      return 'timeout'
    case 'fetch_failed':
      return 'unreachable'
    default:
      return 'page_not_readable'
  }
}

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
