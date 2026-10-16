/**
 * @ontology/adapter-search-web — the platform's web-search adapters and the web-search
 * connection probe (SPEC C4/C5, design §9).
 *
 * Public surface: the native Tavily provider, the compatibility HTTP gateway provider, the
 * two-item connection probe, the classified provider error and the transport/mapping building
 * blocks. The vendor wire shape stays internal, so no provider type becomes a platform contract
 * or leaks into `contracts`/`core`.
 */
export { WebPageSnapshotArchiver } from './snapshot-archive'
export type {
  ArchivedPageSnapshot,
  UnarchivedPage,
  WebPageSnapshotArchiveConfig,
  WebPageSnapshotArchiveOutcome,
  WebPageSnapshotArchiveRequest,
} from './snapshot-archive'

export {
  WebSearchProviderError,
  httpStatusForProviderError,
  isRetryableProviderError,
  isWebSearchProviderError,
  providerErrorForHttpStatus,
} from './errors'
export type { WebSearchProviderErrorCode, WebSearchProviderErrorOptions } from './errors'

export { SearchHttpClient } from './http-client'
export type { SearchHttpClientConfig, SearchHttpRequest, SearchHttpResponse } from './http-client'

export { mapSearchResponse } from './mapping'
export type { MappedSearchResponse } from './mapping'
export { mapTavilyResponse } from './tavily-mapping'
export type { MappedTavilyResponse } from './tavily-mapping'

export { HttpWebSearchProvider, HTTP_WEB_SEARCH_PROVIDER_REF, hostAllowed } from './provider'
export type { HttpWebSearchProviderConfig } from './provider'

export { NativeTavilySearchProvider, NATIVE_TAVILY_PROVIDER_REF } from './tavily'
export type {
  NativeTavilySearchProviderConfig,
  TavilySearchDepth,
  TavilyTopic,
} from './tavily'

export { WebSearchConnectionProbe, createWebSearchConnectionProbe } from './probe'
export type {
  WebSearchArchiveProbeTarget,
  WebSearchConnectionProbeConfig,
} from './probe'
