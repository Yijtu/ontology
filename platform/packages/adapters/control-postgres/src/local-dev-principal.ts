import type { Principal } from '@ontology/contracts'
import { ControlStorageError } from './errors'

/**
 * Deployment mode. The fixed `local-dev` principal is a development-only
 * convenience (SPEC §3): it may only be minted in `development` mode and only
 * for a loopback caller. Production authenticates through OIDC and must never
 * accept a fixed development subject.
 */
export type DeploymentMode = 'development' | 'production'

export interface LocalDevPrincipalConfig {
  readonly tenantId: string
  readonly subjectId?: string
  readonly roles: readonly string[]
  readonly scopes: readonly string[]
  readonly authEpoch: number
}

export const LOCAL_DEV_SUBJECT_ID = 'local-dev'

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const IPV4_MAPPED_LOOPBACK = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase()
  if (normalized === 'localhost') {
    return true
  }
  const bare =
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized
  if (bare === '::1') {
    return true
  }
  return IPV4_LOOPBACK.test(bare) || IPV4_MAPPED_LOOPBACK.test(bare)
}

/**
 * Mint the loopback-only development principal. Refuses any non-development
 * mode or non-loopback remote address, so enabling a fixed dev subject on a
 * public interface is impossible by construction.
 */
export function resolveLocalDevPrincipal(
  remoteAddress: string,
  mode: DeploymentMode,
  config: LocalDevPrincipalConfig,
): Principal {
  if (mode !== 'development') {
    throw new ControlStorageError(
      'LOCAL_DEV_PRINCIPAL_NOT_ALLOWED',
      'the local-dev principal is only available in development mode',
    )
  }
  if (!isLoopbackAddress(remoteAddress)) {
    throw new ControlStorageError(
      'LOCAL_DEV_PRINCIPAL_NOT_ALLOWED',
      `the local-dev principal is refused for non-loopback address ${remoteAddress}`,
    )
  }
  return Object.freeze({
    tenantId: config.tenantId,
    subjectId: config.subjectId ?? LOCAL_DEV_SUBJECT_ID,
    roles: [...config.roles],
    scopes: [...config.scopes],
    authEpoch: config.authEpoch,
  })
}
