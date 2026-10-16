import { ToolConnectionError, isToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'

/**
 * Trusted-context helpers shared by the tool-settings services (design §9).
 *
 * They mirror the model-settings guards deliberately: the tenant and space always come from the
 * host-minted `ToolContext`, never from a request body, and a foreign target is invisible
 * (`SCOPE_MISMATCH`). Managing connections, credentials and space defaults is a local
 * `platform-admin` action; a normal editor may only pick an already-authorized connection.
 */

/** Only the local `platform-admin` may manage connections, credentials and space defaults. */
export function assertToolAdministrator(ctx: ToolContext): void {
  if (!ctx.principal.roles.includes('platform-admin')) {
    throw new ToolConnectionError(
      'SCOPE_MISMATCH',
      'managing tool connections requires the platform-admin role',
    )
  }
}

/** A `profile-editor` may only set a target-scoped override, never a connection or credential. */
export function assertToolTargetEditor(ctx: ToolContext): void {
  if (
    !ctx.principal.roles.includes('platform-admin') &&
    !ctx.principal.roles.includes('profile-editor')
  ) {
    throw new ToolConnectionError(
      'SCOPE_MISMATCH',
      'setting a tool assignment for a target requires the profile-editor or platform-admin role',
    )
  }
}

/** The trusted tenant/space scope of a request, never read from a body or query string. */
export function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ToolConnectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ToolConnectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/** A non-empty idempotency key in the shared 8..256 bound; a longer/shorter key is a 400. */
export function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new ToolConnectionError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}
