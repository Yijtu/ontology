import { sha256DigestOf } from '@ontology/core'
import type { ErrorCode, PlatformError, ToolId, ToolResult } from '@ontology/contracts'

/**
 * Refusal reasons raised at the MCP boundary (C5).
 *
 * These are transport-level classifications, deliberately separate from the platform
 * `ErrorCode` union: several of them (a tool outside the profile-bound whitelist, an
 * abandoned late result) are MCP policy, and each maps onto a canonical catalogue entry
 * so the wire contract never invents a new public error name.
 */
export type McpTransportErrorCode =
  | 'INVALID_SCHEMA'
  | 'REMOTE_UNAVAILABLE'
  | 'REMOTE_PROTOCOL_ERROR'
  | 'REMOTE_ERROR'
  | 'ABANDONED'
  | 'TOOL_NOT_WHITELISTED'
  | 'UNKNOWN_REMOTE_TOOL'
  | 'IDENTITY_REJECTED'

const PLATFORM_CODE: Readonly<Record<McpTransportErrorCode, ErrorCode>> = {
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  REMOTE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  REMOTE_PROTOCOL_ERROR: 'INTERNAL_ERROR',
  REMOTE_ERROR: 'INTERNAL_ERROR',
  ABANDONED: 'DEADLINE_EXCEEDED',
  TOOL_NOT_WHITELISTED: 'FORBIDDEN',
  UNKNOWN_REMOTE_TOOL: 'CAPABILITY_NOT_CONFIGURED',
  IDENTITY_REJECTED: 'FORBIDDEN',
}

const RETRYABLE: Readonly<Record<McpTransportErrorCode, boolean>> = {
  INVALID_SCHEMA: false,
  REMOTE_UNAVAILABLE: true,
  REMOTE_PROTOCOL_ERROR: false,
  REMOTE_ERROR: false,
  ABANDONED: false,
  TOOL_NOT_WHITELISTED: false,
  UNKNOWN_REMOTE_TOOL: false,
  IDENTITY_REJECTED: false,
}

/**
 * A classified MCP-boundary refusal.
 *
 * `remoteStateUnknown` marks a failure where the remote call may already have taken
 * effect (a dropped connection or a timeout after send), so the caller must settle the
 * attempt as `usage_unknown` instead of releasing it as a free failure. The transport
 * never retries such a call on its own.
 */
export class McpTransportError extends Error {
  readonly code: McpTransportErrorCode
  readonly platformCode: ErrorCode
  readonly retryable: boolean
  readonly remoteStateUnknown: boolean

  constructor(
    code: McpTransportErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly remoteStateUnknown?: boolean
      readonly platformCode?: ErrorCode
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'McpTransportError'
    this.code = code
    this.platformCode = options?.platformCode ?? PLATFORM_CODE[code]
    this.retryable = RETRYABLE[code]
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
  }
}

export function isMcpTransportError(value: unknown): value is McpTransportError {
  return value instanceof McpTransportError
}

export function toPlatformError(error: McpTransportError, traceId: string): PlatformError {
  return {
    code: error.platformCode,
    message: error.message,
    retryable: error.retryable,
    traceId,
    ...(error.remoteStateUnknown ? { remoteStateUnknown: true } : {}),
  }
}

/**
 * The error `ToolResult` shape the gateway itself emits for a rejected call (C4).
 *
 * The schema reference mirrors `ToolGatewayService.#errorResult` exactly so a result
 * observed over the local path and one observed over MCP stay logically identical.
 */
export function errorToolResult(
  callId: string,
  toolId: ToolId,
  error: PlatformError,
  durationMs: number,
): ToolResult {
  return {
    callId,
    status: 'error',
    schemaRef: {
      id: `${toolId}.result`,
      version: '1.0.0',
      digest: sha256DigestOf('tool-result'),
    },
    evidenceRefs: [],
    sourceSnapshots: [],
    coverage: { returned: 0, truncated: false },
    usage: { durationMs },
    warnings: [],
    error,
  }
}
