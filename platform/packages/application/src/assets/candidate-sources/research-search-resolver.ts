import type { ToolAdapterType, ToolContext, Uuid, WebSearchProvider } from '@ontology/contracts'

/**
 * The resolved public-search provider for one research run (S03, design §4/§9).
 *
 * The provider is built from the run's **pinned** catalogue binding — never from the deployment
 * environment — so the request actually goes to the connection the run was authorized against. A
 * blocked resolution is an explicit, stable reason (`TOOL_NOT_CONFIGURED`, `TOOL_DISABLED`,
 * `TOOL_BINDING_REVOKED`, ...); the executor fails the run instead of falling back to another
 * connection or to the legacy environment provider.
 */
export type ResearchSearchResolution =
  | {
      readonly state: 'available'
      readonly provider: WebSearchProvider
      readonly connectionName?: string
      readonly adapterType?: ToolAdapterType
    }
  | { readonly state: 'blocked'; readonly reason: string; readonly message: string }

/** The outcome of pinning a run's public search at accept time (S03). */
export type ResearchSearchBindingResult =
  | { readonly state: 'available' }
  | { readonly state: 'blocked'; readonly reason: string; readonly message: string }

/**
 * Pins the run's public search from the catalogue at accept time (S03, design §9). It resolves the
 * `web_search` selection at the run's **workspace scope** and fixes the execution binding, so the
 * run is authorized against the exact connection it will use — and a run that cannot be pinned is
 * refused now rather than failing later or falling back.
 */
export interface ResearchSearchBinder {
  bindSearchForResearch(
    input: { readonly researchId: Uuid; readonly workspaceId: Uuid },
    ctx: ToolContext,
  ): Promise<ResearchSearchBindingResult>
}

/**
 * A port the fixed research chain reads its public search through. It is implemented in composition
 * (it needs the search adapter and credential custody), so the application service stays free of
 * adapters and never touches a vendor body or a credential.
 */
export interface ResearchSearchResolver {
  /**
   * Resolve the run's pinned public search. It must never silently switch: an unavailable binding is
   * returned as a stable block, from the same catalogue resolution the preflight and the capability
   * projection read.
   */
  resolveForResearch(
    input: { readonly researchId: Uuid; readonly workspaceId: Uuid },
    ctx: ToolContext,
  ): Promise<ResearchSearchResolution>
}
