import type { ToolAdapterType, ToolConnectionCapability } from '@ontology/contracts'

/**
 * Whether an adapter family can actually serve a capability (design §9).
 *
 * The declared `capabilities` array on a connection is user input; this map is the domain rule
 * that stops a search service from claiming to be a data tool. In the first phase both adapter
 * families serve only `web_search`; a `web_search` service is a tool connection and never a
 * generation model. Keeping the rule here (application, not contracts) lets R02 widen the family
 * set without redefining the shared data shapes.
 */
export function toolAdapterSupportsCapability(
  adapterType: ToolAdapterType,
  capability: ToolConnectionCapability,
): boolean {
  switch (adapterType) {
    case 'native_tavily':
    case 'http_compat':
      return capability === 'web_search'
  }
}

/** The capabilities an adapter family declares it can serve; used to reject an impossible claim. */
export function capabilitiesSupportedByAdapter(adapterType: ToolAdapterType): readonly ToolConnectionCapability[] {
  switch (adapterType) {
    case 'native_tavily':
    case 'http_compat':
      return ['web_search']
  }
}

/**
 * Whether an adapter family needs a credential to be usable.
 *
 * The native Tavily service authenticates every call, so a connection without a credential is
 * blocked. The existing "compat gateway" is the keyless HTTP provider it replaces, so a missing
 * credential does not block it (a revoked/cleared credential still does, per design §9).
 */
export function toolAdapterRequiresCredential(adapterType: ToolAdapterType): boolean {
  switch (adapterType) {
    case 'native_tavily':
      return true
    case 'http_compat':
      return false
  }
}
