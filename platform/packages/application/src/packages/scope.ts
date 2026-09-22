import { isToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { IndustryPackError } from './errors'

/**
 * Every pack service resolves the tenant/space scope from the host-minted trusted context,
 * never from the request body, and refuses a context that does not carry the brand
 * (INV-07). This is the same rule the registry/profile services enforce.
 */
export function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new IndustryPackError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new IndustryPackError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new IndustryPackError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

export function assertRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new IndustryPackError('FORBIDDEN', `${action} requires one of the roles: ${roles.join(', ')}`)
  }
}
