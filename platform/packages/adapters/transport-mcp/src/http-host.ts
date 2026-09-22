import { McpTransportError } from './errors'
import { MCP_PROTOCOL_VERSION } from './protocol'

/**
 * SPEC C5: the Streamable HTTP host contract is defined but not enabled in this release.
 *
 * Enabling a working remote server requires separate authentication (token
 * audience/issuer negotiation) and disconnect/resumption testing, so this adapter
 * exposes an explicit not-enabled declaration instead of a half-built server. A caller
 * that asks for it gets a classified `CAPABILITY_NOT_CONFIGURED` refusal, never a
 * silently degraded transport.
 */
export interface StreamableHttpHostContract {
  readonly kind: 'streamable_http'
  readonly protocolVersion: string
  readonly enabled: false
  readonly requiredBeforeEnable: readonly string[]
}

export const STREAMABLE_HTTP_HOST_CONTRACT: StreamableHttpHostContract = Object.freeze({
  kind: 'streamable_http',
  protocolVersion: MCP_PROTOCOL_VERSION,
  enabled: false,
  requiredBeforeEnable: [
    'inbound token audience/issuer authentication (never a model-supplied tenant_id)',
    'per-session authorization, scope mapping and rate limiting',
    'disconnect, resumption and late-result isolation tests',
    'outbound remote endpoint allowlist and TLS policy',
  ],
})

export function isStreamableHttpEnabled(): boolean {
  return STREAMABLE_HTTP_HOST_CONTRACT.enabled
}

/** Fail loudly when a caller assumes the remote HTTP transport is available. */
export function requireStreamableHttpHost(): never {
  throw new McpTransportError(
    'REMOTE_UNAVAILABLE',
    'the Streamable HTTP MCP transport is not enabled in this release; only stdio is implemented',
    { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
  )
}
