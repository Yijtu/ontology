/**
 * @ontology/adapter-search-web — reference HTTP web-search provider (SPEC C4/C5).
 *
 * Public surface: the `WebSearchProvider` implementation, the classified provider error
 * and the transport/mapping building blocks. The vendor wire shape stays internal, so no
 * provider type becomes a platform contract or leaks into `contracts`/`core`.
 */
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
export { HttpWebSearchProvider, hostAllowed } from './provider'
export type { HttpWebSearchProviderConfig } from './provider'
