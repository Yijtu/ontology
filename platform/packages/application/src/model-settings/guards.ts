import { ModelSelectionError, isToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'

/**
 * Trusted-context helpers shared by the model-settings services.
 *
 * The tenant and space always come from the host-minted `ToolContext`; a request body never
 * supplies either. Cross-scope reads are invisible (a foreign id simply resolves to
 * `undefined`), and a write that names a foreign target is refused with `SCOPE_MISMATCH`
 * (design §5.3, §5.5).
 */

/** Only the local `platform-admin` may manage connections, credentials and space defaults. */
export function assertModelAdministrator(ctx: ToolContext): void {
  if (!ctx.principal.roles.includes('platform-admin')) {
    throw new ModelSelectionError(
      'SCOPE_MISMATCH',
      'managing model connections requires the platform-admin role',
    )
  }
}

/** A `profile-editor` may only set a target-scoped override, never a connection or credential. */
export function assertTargetEditor(ctx: ToolContext): void {
  if (
    !ctx.principal.roles.includes('platform-admin') &&
    !ctx.principal.roles.includes('profile-editor')
  ) {
    throw new ModelSelectionError(
      'SCOPE_MISMATCH',
      'setting a model assignment for a target requires the profile-editor or platform-admin role',
    )
  }
}

/** The trusted tenant/space scope of a request, never read from a body or query string. */
export function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ModelSelectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ModelSelectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/** A non-empty idempotency key in the shared 8..256 bound; a longer/shorter key is a 400. */
export function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new ModelSelectionError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}
