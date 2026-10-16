import { ResearchError, isToolContext } from '@ontology/contracts'
import type { ResearchExecutionAny, ScopeRef, ToolContext } from '@ontology/contracts'

/** Roles allowed to start, read or stop a bounded research run. */
export const RESEARCH_ROLES: readonly string[] = ['researcher', 'platform-admin']

/** Statuses after which a run is frozen: a later write can never resurrect or overwrite it. */
export const TERMINAL_RESEARCH_STATUSES: readonly ResearchExecutionAny['status'][] = ['completed', 'cancelled', 'failed']

export function isTerminal(status: ResearchExecutionAny['status']): boolean {
  return TERMINAL_RESEARCH_STATUSES.includes(status)
}

/** Read the trusted tenant/space scope from a host-minted context, refusing an inconsistent one. */
export function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) throw new ResearchError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) throw new ResearchError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  return { tenantId, spaceId }
}

export function assertResearcher(ctx: ToolContext): void {
  if (!ctx.principal.roles.some((role) => RESEARCH_ROLES.includes(role))) {
    throw new ResearchError('SCOPE_MISMATCH', 'web research requires a researcher or platform-admin role')
  }
}

/** Only an editor may pin a model assignment/binding; a researcher defers the pin to the worker. */
export function canPinModel(ctx: ToolContext): boolean {
  return ctx.principal.roles.some((role) => role === 'platform-admin' || role === 'profile-editor')
}
