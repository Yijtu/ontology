import { isToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { DocumentSearchError } from './errors'

/**
 * The tenant/space scope always comes from the trusted `ToolContext`; a request
 * that names a different scope is refused before any read or write. This mirrors
 * the LOCAL-008/LOCAL-023 stores so the keyword index inherits the same isolation
 * guarantee rather than inventing a weaker one.
 */
export function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DocumentSearchError(
      'FORBIDDEN',
      'a host-minted trusted tool context is required',
    )
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new DocumentSearchError(
      'FORBIDDEN',
      'trusted context carries inconsistent tenant scope',
    )
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new DocumentSearchError(
      'FORBIDDEN',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

/** The trusted scope carried by a context that has no request-side `scopeRef`. */
export function trustedScope(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DocumentSearchError(
      'FORBIDDEN',
      'a host-minted trusted tool context is required',
    )
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new DocumentSearchError(
      'FORBIDDEN',
      'trusted context carries inconsistent tenant scope',
    )
  }
  return { tenantId, spaceId }
}

export function scopeKey(scope: ScopeRef): string {
  return `${scope.tenantId}\u0000${scope.spaceId}`
}

export function generationKey(scope: ScopeRef, collectionRef: string): string {
  return `${scopeKey(scope)}\u0000${collectionRef}`
}
