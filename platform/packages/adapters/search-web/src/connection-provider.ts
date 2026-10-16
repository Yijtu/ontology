import type {
  SecretValue,
  ToolAdapterType,
  ToolConnectionDescriptor,
  VersionRef,
  WebSearchProvider,
} from '@ontology/contracts'
import { HTTP_WEB_SEARCH_PROVIDER_REF, HttpWebSearchProvider } from './provider'
import { WebPageSnapshotArchiver } from './snapshot-archive'
import { NATIVE_TAVILY_PROVIDER_REF, NativeTavilySearchProvider } from './tavily'
import type { TavilySearchDepth, TavilyTopic } from './tavily'

/**
 * Build the actual search provider a run will use from its **pinned tool connection** (design §9).
 *
 * The connection catalogue stores a non-secret descriptor (adapter family + endpoint); the resolved
 * credential is a `SecretValue` handed to the vended provider once and never returned. A
 * `native_tavily` connection without a credential returns `undefined` (it cannot authenticate), so
 * the caller reports the capability blocked instead of calling an unauthenticated vendor. A
 * `http_compat` connection keeps the legacy keyless behaviour.
 *
 * The provider is given the same platform-controlled archiver the run gateway uses, so a discovered
 * page is a citable snapshot or an explicit link-only result — the vendor never becomes the
 * archiver.
 */
export interface WebSearchProviderFromConnectionConfig {
  readonly descriptor: ToolConnectionDescriptor
  /** The resolved credential, or `undefined` when the connection has none. Never logged. */
  readonly credential?: SecretValue
  /** Archives the actual page bytes through the run's immutable artifact writer. */
  readonly snapshotArchive?: WebPageSnapshotArchiver
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
  readonly maxTimeoutMs?: number
  /** The compat gateway's search path; defaults to `/v1/search`. */
  readonly compatEndpointPath?: string
  /** The fixed native search strategy (never a model argument). */
  readonly searchDepth?: TavilySearchDepth
  readonly topic?: TavilyTopic
}

export function providerRefForAdapter(adapterType: ToolAdapterType): VersionRef {
  return adapterType === 'native_tavily' ? NATIVE_TAVILY_PROVIDER_REF : HTTP_WEB_SEARCH_PROVIDER_REF
}

export function createWebSearchProviderFromConnection(
  config: WebSearchProviderFromConnectionConfig,
): WebSearchProvider | undefined {
  const endpoint = config.descriptor.endpoint?.trim()
  if (endpoint === undefined || endpoint.length === 0) return undefined
  const shared = {
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: config.maxTimeoutMs }),
    ...(config.snapshotArchive === undefined ? {} : { snapshotArchive: config.snapshotArchive }),
  }
  // The pinned search strategy (S03) is part of the descriptor, so an imported compat gateway keeps
  // its endpoint path/timeout and a native connection keeps its fixed vendor depth/topic.
  const strategy = config.descriptor.searchStrategy
  const searchDepth = config.searchDepth ?? strategy?.searchDepth
  const topic = config.topic ?? strategy?.topic
  const compatEndpointPath = config.compatEndpointPath ?? strategy?.compatEndpointPath
  const maxTimeoutMs = config.maxTimeoutMs ?? strategy?.maxTimeoutMs
  const withTimeout = maxTimeoutMs === undefined ? shared : { ...shared, maxTimeoutMs }
  if (config.descriptor.adapterType === 'native_tavily') {
    // The native service authenticates every call; without a credential it cannot be used.
    if (config.credential === undefined) return undefined
    return new NativeTavilySearchProvider({
      baseUrl: endpoint,
      apiKey: config.credential,
      ...(searchDepth === undefined ? {} : { searchDepth }),
      ...(topic === undefined ? {} : { topic }),
      ...withTimeout,
    })
  }
  return new HttpWebSearchProvider({
    baseUrl: endpoint,
    ...(compatEndpointPath === undefined ? {} : { endpoint: compatEndpointPath }),
    ...withTimeout,
  })
}
