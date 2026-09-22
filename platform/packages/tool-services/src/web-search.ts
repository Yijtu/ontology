import { ERROR_CATALOG } from '@ontology/contracts'
import type {
  ErrorCode,
  ResolvedProfile,
  Rfc3339UtcTimestamp,
  SourceRef,
  ToolContext,
  ToolId,
  ToolWarning,
  WebPageEvidence,
  WebSearchFreshnessHint,
  WebSearchProvider,
  WebSearchProviderPage,
} from '@ontology/contracts'
import { ToolGatewayError } from './errors'
import type {
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolHandler,
  ToolSourceObservation,
} from './types'

/** Why the web-search capability is unavailable. Each reason is explicit, never a fake empty. */
export type WebSearchDisabledReason =
  | 'web_disabled_by_preference'
  | 'tool_not_enabled_by_profile'
  | 'provider_not_configured'

export interface WebSearchEnablement {
  readonly enabled: boolean
  readonly reason?: WebSearchDisabledReason
}

/**
 * The three-way gate for `web_search`. Networking is off when the run preference says so,
 * when the resolved profile does not enable the tool, or when no provider is configured.
 * A disabled capability is reported as `CAPABILITY_NOT_CONFIGURED`, never as a search
 * that found nothing.
 */
export function resolveWebSearchEnablement(input: {
  readonly resolvedProfile: ResolvedProfile
  readonly allowWeb: boolean
  readonly providerConfigured: boolean
}): WebSearchEnablement {
  if (!input.allowWeb) return { enabled: false, reason: 'web_disabled_by_preference' }
  const binding = input.resolvedProfile.toolBindings.find((entry) => entry.toolId === 'web_search')
  if (binding === undefined || !binding.enabled) {
    return { enabled: false, reason: 'tool_not_enabled_by_profile' }
  }
  if (!input.providerConfigured) return { enabled: false, reason: 'provider_not_configured' }
  return { enabled: true }
}

export interface WebSearchHandlerOptions {
  /** The replaceable provider. Absent means the capability is explicitly not configured. */
  readonly provider?: WebSearchProvider
  /** The run's `preferences.allowWeb`. False emits no provider request at all. */
  readonly allowWeb: boolean
  /** The run's resolved profile, so a profile-disabled tool is refused here too. */
  readonly resolvedProfile: ResolvedProfile
  /** The registered public-web source this tool reads, used for the evidence snapshot. */
  readonly sourceRef: SourceRef
  /** The trusted context; forwarded to the provider and never derived from arguments. */
  readonly ctx: ToolContext
  readonly schemaVersion?: string
}

const DISABLED_MESSAGE: Readonly<Record<WebSearchDisabledReason, string>> = {
  web_disabled_by_preference:
    'web search is disabled by this run preference; no provider request was made',
  tool_not_enabled_by_profile:
    'web search is not enabled by the resolved profile; no provider request was made',
  provider_not_configured:
    'no web search provider is configured for this deployment; the capability is disabled',
}

const FRESHNESS_HINTS: readonly WebSearchFreshnessHint[] = ['any', 'day', 'week', 'month', 'year']

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return entries.length === value.length ? entries : undefined
}

/**
 * The `web_search` tool handler (SPEC C4/C5, US-020/024, FR-25/26/33).
 *
 * It is registered through the existing gateway catalogue; there is no second tool
 * registry. The handler owns the platform semantics: the disable gate, the bounded
 * argument projection, the mapping of provider pages into untrusted `WebPageEvidence`
 * (URL, fetch time, publish date when present) and the distinct `ok`/`partial`/`empty`
 * outcome. It never mutates permissions, the tool catalogue, the allowlist or the budget,
 * and it never widens the approved domain set: pages outside it are dropped.
 */
export class WebSearchHandler implements ToolHandler {
  readonly toolId: ToolId = 'web_search'
  readonly #provider: WebSearchProvider | undefined
  readonly #enablement: WebSearchEnablement
  readonly #sourceRef: SourceRef
  readonly #ctx: ToolContext
  readonly #schemaVersion: string

  constructor(options: WebSearchHandlerOptions) {
    this.#provider = options.provider
    this.#enablement = resolveWebSearchEnablement({
      resolvedProfile: options.resolvedProfile,
      allowWeb: options.allowWeb,
      providerConfigured: options.provider !== undefined,
    })
    this.#sourceRef = options.sourceRef
    this.#ctx = options.ctx
    this.#schemaVersion = options.schemaVersion ?? options.provider?.providerRef.version ?? '1.0.0'
  }

  /** Exposed for composition and tests; disabled capabilities are visible before any call. */
  get enablement(): WebSearchEnablement {
    return this.#enablement
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const provider = this.#provider
    if (!this.#enablement.enabled || provider === undefined) {
      const reason = this.#enablement.reason ?? 'provider_not_configured'
      throw new ToolGatewayError('HANDLER_FAILED', DISABLED_MESSAGE[reason], {
        platformCode: 'CAPABILITY_NOT_CONFIGURED',
        fieldErrors: [{ pointer: '/', reason }],
      })
    }

    const args = request.arguments
    const query = readString(args.query)
    const allowedDomains = readStringArray(args.allowedDomains)
    if (query === undefined || allowedDomains === undefined || allowedDomains.length === 0) {
      throw new ToolGatewayError(
        'INVALID_ARGUMENTS',
        'web_search requires a non-empty query and at least one approved domain',
      )
    }
    const freshnessHint = readFreshness(args.freshnessHint)
    const cursor = readString(args.cursor)
    const limit = readLimit(args.limit, request.resultLimits.maxRows)

    const result = await this.#callProvider(provider, {
      query,
      allowedDomains,
      limit,
      ...(freshnessHint === undefined ? {} : { freshnessHint }),
      ...(cursor === undefined ? {} : { cursor }),
      deadline: request.deadline,
      signal: request.signal,
    })

    const pages: WebPageEvidence[] = []
    let excluded = result.excludedCount
    for (const page of result.pages) {
      if (!hostAllowed(page, allowedDomains)) {
        // Defence in depth: a provider that returned an unapproved host is filtered here
        // too, and the drop is reported rather than hidden.
        excluded += 1
        continue
      }
      pages.push(toEvidence(page))
    }

    const warnings: ToolWarning[] = []
    if (excluded > 0) {
      warnings.push({
        code: 'WEB_RESULTS_EXCLUDED',
        message: `${String(excluded)} result(s) were outside the approved domain allowlist and were dropped`,
      })
    }
    if (result.truncated) {
      warnings.push({
        code: 'WEB_RESULTS_TRUNCATED',
        message: 'the provider reported a bounded recall range; the result is partial',
      })
    }

    const status = result.truncated ? 'partial' : pages.length === 0 ? 'empty' : 'ok'
    const asOf = latestFetchedAt(pages)
    const observations: readonly ToolSourceObservation[] = [
      {
        sourceRef: this.#sourceRef,
        schemaVersion: this.#schemaVersion,
        consistency: 'read_time',
        ...(asOf === undefined ? {} : { asOf }),
      },
    ]

    return {
      payload: { pages },
      status,
      coverage: {
        returned: pages.length,
        truncated: result.truncated,
        completeness: result.truncated ? 'truncated' : 'complete',
        ...(result.knownTotal === undefined ? {} : { knownTotal: result.knownTotal }),
        ...(result.nextCursor === undefined || result.nextCursor === null
          ? {}
          : { cursor: result.nextCursor }),
      },
      sources: observations,
      evidenceKind: 'web_page',
      dataMode: 'observed',
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  async #callProvider(
    provider: WebSearchProvider,
    request: Parameters<WebSearchProvider['search']>[0],
  ): ReturnType<WebSearchProvider['search']> {
    try {
      return await provider.search(request, this.#ctx)
    } catch (error) {
      // The provider is an adapter and this is a service: they share only `contracts`, so
      // the classified failure is recognised structurally by its canonical error code
      // rather than by importing the adapter's error class.
      if (isClassifiedProviderFailure(error)) {
        throw new ToolGatewayError('HANDLER_FAILED', error.message, {
          cause: error,
          platformCode: error.code,
          ...(error.remoteStateUnknown === true ? { remoteStateUnknown: true } : {}),
        })
      }
      throw new ToolGatewayError('HANDLER_FAILED', 'the web search provider failed', { cause: error })
    }
  }
}

interface ClassifiedProviderFailure extends Error {
  readonly code: ErrorCode
  readonly remoteStateUnknown?: boolean
}

function isClassifiedProviderFailure(value: unknown): value is ClassifiedProviderFailure {
  if (!(value instanceof Error)) return false
  const candidate = value as { code?: unknown }
  return typeof candidate.code === 'string' && Object.hasOwn(ERROR_CATALOG, candidate.code)
}

function readFreshness(value: unknown): WebSearchFreshnessHint | undefined {
  return typeof value === 'string' && (FRESHNESS_HINTS as readonly string[]).includes(value)
    ? (value as WebSearchFreshnessHint)
    : undefined
}

function readLimit(value: unknown, ceiling: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return Math.min(value, ceiling)
  }
  return ceiling
}

function hostAllowed(page: WebSearchProviderPage, allowedDomains: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(page.url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some(
    (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
  )
}

function toEvidence(page: WebSearchProviderPage): WebPageEvidence {
  return {
    url: page.url,
    title: page.title,
    snippet: page.snippet,
    fetchedAt: page.fetchedAt,
    contentTrust: 'untrusted_data',
    contentDigest: page.contentDigest,
    ...(page.publishedAt === undefined ? {} : { publishedAt: page.publishedAt }),
  }
}

function latestFetchedAt(pages: readonly WebPageEvidence[]): Rfc3339UtcTimestamp | undefined {
  let latest: Rfc3339UtcTimestamp | undefined
  for (const page of pages) {
    if (latest === undefined || Date.parse(page.fetchedAt) > Date.parse(latest)) latest = page.fetchedAt
  }
  return latest
}
