import { HttpWebSearchProvider, WebPageSnapshotArchiver } from '@ontology/adapter-search-web'
import type { ImmutableArtifactWriter, WebSearchProvider } from '@ontology/contracts'

/**
 * The controlled public-search surface of a normal Core start (design §2.3, A-R02/N12).
 *
 * The deployment configures one search endpoint; this factory constructs the reference provider
 * with its snapshot archiver already attached, so a normal start can actually *discover* research
 * instead of only inheriting a test-injected provider. When no endpoint is configured the provider
 * is simply absent — `web_search`/research stay unavailable with an explicit reason, never a
 * fabricated capability. The archiver archives the *actual page bytes* through the same immutable
 * artifact writer the run gateway uses, so a discovered source is a citable snapshot or an explicit
 * link-only result.
 */

const BASE_URL_SETTING = 'CORE_WEB_SEARCH_BASE_URL'
const ENDPOINT_SETTING = 'CORE_WEB_SEARCH_ENDPOINT'
const MAX_TIMEOUT_SETTING = 'CORE_WEB_SEARCH_MAX_TIMEOUT_MS'
const MAX_BYTES_SETTING = 'CORE_WEB_SEARCH_MAX_BYTES'

export interface CoreWebSearchOptions {
  /** Server-only deployment environment. Browser `VITE_` variables are deliberately ignored. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The immutable artifact writer every archived snapshot is published through. */
  readonly artifacts: ImmutableArtifactWriter
  /** Test seam; production uses the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
}

function optionalPositiveInteger(env: Readonly<Record<string, string | undefined>>, setting: string): number | undefined {
  const raw = env[setting]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${setting} must be a positive integer`)
  return Number(raw)
}

/**
 * Construct the snapshot-archiving web-search provider from deployment configuration. It returns
 * `undefined` (research not configured) when no base URL is set, so the ordinary kernel start stays
 * honest about the absent capability rather than pretending a provider exists.
 */
export function createCoreWebSearchProvider(options: CoreWebSearchOptions): WebSearchProvider | undefined {
  const baseUrl = options.env[BASE_URL_SETTING]?.trim()
  if (baseUrl === undefined || baseUrl.length === 0) return undefined
  const endpoint = options.env[ENDPOINT_SETTING]?.trim()
  const maxTimeoutMs = optionalPositiveInteger(options.env, MAX_TIMEOUT_SETTING)
  const maxBytes = optionalPositiveInteger(options.env, MAX_BYTES_SETTING)
  const fetchImpl = options.fetchImpl
  const now = options.now
  const archiver = new WebPageSnapshotArchiver({
    artifacts: options.artifacts,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(now === undefined ? {} : { now }),
    ...(maxTimeoutMs === undefined ? {} : { maxTimeoutMs }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })
  return new HttpWebSearchProvider({
    baseUrl,
    ...(endpoint === undefined || endpoint.length === 0 ? {} : { endpoint }),
    snapshotArchive: archiver,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(now === undefined ? {} : { now }),
  })
}
