import type { ToolContext, Uuid } from '@ontology/contracts'

/**
 * The outcome of pinning a run's public search at accept time (S03).
 *
 * The run's public search is pinned from the catalogue — never from the deployment environment — so
 * the request actually goes to the connection the run was authorized against. A blocked resolution
 * is an explicit, stable reason (`TOOL_NOT_CONFIGURED`, `TOOL_DISABLED`, `TOOL_BINDING_REVOKED`, ...);
 * a new run that cannot be pinned is refused rather than falling back to another connection or to the
 * legacy environment.
 *
 * S11 retired the fixed research execution chain, so there is no longer a resolver port implemented
 * in composition; the durable binding pinned here is what the agentic run's gateway reads.
 */
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
