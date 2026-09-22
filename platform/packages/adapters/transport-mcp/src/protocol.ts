import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, ContentBlock, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  PlatformError,
  ResourceRef,
  SourceSnapshot,
  ToolCoverage,
  ToolResult,
  ToolUsage,
  ToolWarning,
  VersionRef,
} from '@ontology/contracts'
import { McpTransportError } from './errors'
import { resolveSchemaRef } from './schema'

/** SPEC §12: the first release negotiates the 2025-06-18 compatible subset. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** Locked SDK. `pnpm run verify` and the protocol test assert this exact version. */
export const MCP_SDK_VERSION = '1.30.0'
/** The canonical unified result the MCP boundary carries as `structuredContent`. */
export const MCP_TOOL_RESULT_SCHEMA_REF = 'https://ontology.local/schema/tools.schema.json#/$defs/ToolResult'

export interface McpSchemaIssue {
  readonly pointer: string
  readonly reason: string
}

export interface McpSchemaValidationResult {
  readonly valid: boolean
  readonly issues: readonly McpSchemaIssue[]
}

/**
 * Runtime JSON Schema validation capability, injected by the composition root. The
 * adapter never imports a schema library: it validates the remote `structuredContent`
 * against the canonical `ToolResult` contract through this port (INV-01).
 */
export interface McpSchemaValidator {
  validateInline(schema: Readonly<Record<string, unknown>>, value: unknown): McpSchemaValidationResult
}

let toolResultSchema: Readonly<Record<string, unknown>> | undefined

function toolResultSchemaRef(): Readonly<Record<string, unknown>> {
  toolResultSchema ??= resolveSchemaRef(MCP_TOOL_RESULT_SCHEMA_REF)
  return toolResultSchema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(content: readonly ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  return undefined
}

/**
 * Map the platform result onto the MCP wire shape.
 *
 * The whole `ToolResult` travels as `structuredContent` (validated against the
 * canonical `ToolResult` schema), so the transport moves the platform contract rather
 * than inventing a second result format. `isError` mirrors `status === 'error'`; error
 * text is a human summary only and is never the payload.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  const summary =
    result.status === 'error'
      ? (result.error?.safeMessage ?? result.error?.message ?? 'the tool call failed')
      : `status=${result.status} rows=${String(result.coverage.returned)}`
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: structuredContentOf(result),
    isError: result.status === 'error',
  }
}

function structuredContentOf(result: ToolResult): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result)) record[key] = value
  return record
}

export interface RemoteResultInput {
  readonly callId: string
  readonly structuredContent: Record<string, unknown> | undefined
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  readonly validator: McpSchemaValidator
}

/**
 * Reconstruct the platform `ToolResult` from a remote MCP result, or raise a classified
 * `McpTransportError`.
 *
 * Every failure mode is explicit and none is collapsed into a valid result:
 *  - `isError` without a schema-valid error result is a platform error, never data;
 *  - an error marked as success (or vice versa) is an `INVALID_SCHEMA` contract break;
 *  - `structuredContent` that violates the canonical `ToolResult` schema is rejected;
 *  - a missing `structuredContent` on a declared-output tool is rejected, so error text
 *    or a partial payload can never masquerade as a successful result.
 */
function requiredField<T>(record: Record<string, unknown>, key: string): T {
  const value = record[key]
  if (value === undefined) {
    throw new McpTransportError('INVALID_SCHEMA', `the remote result is missing the ${key} field`)
  }
  return value as T
}

/**
 * Rebuild the platform `ToolResult` from a schema-validated record field by field.
 *
 * The values are re-read through the canonical field names rather than asserted as a
 * whole, so a remote payload cannot smuggle an unexpected key into the trusted result.
 */
function rebuildToolResult(record: Record<string, unknown>, callId: string): ToolResult {
  const dataRef = record.dataRef
  const inlineData = record.inlineData
  const domainStatus = record.domainStatus
  const error = record.error
  return {
    callId,
    status: requiredField<ToolResult['status']>(record, 'status'),
    schemaRef: requiredField<VersionRef>(record, 'schemaRef'),
    evidenceRefs: requiredField<ResourceRef[]>(record, 'evidenceRefs'),
    sourceSnapshots: requiredField<SourceSnapshot[]>(record, 'sourceSnapshots'),
    coverage: requiredField<ToolCoverage>(record, 'coverage'),
    usage: requiredField<ToolUsage>(record, 'usage'),
    warnings: requiredField<ToolWarning[]>(record, 'warnings'),
    ...(dataRef === undefined ? {} : { dataRef: dataRef as ResourceRef }),
    ...(inlineData === undefined ? {} : { inlineData: inlineData as NonNullable<ToolResult['inlineData']> }),
    ...(domainStatus === undefined
      ? {}
      : { domainStatus: domainStatus as NonNullable<ToolResult['domainStatus']> }),
    ...(error === undefined ? {} : { error: error as PlatformError }),
  }
}

export function parseRemoteToolResult(input: RemoteResultInput): ToolResult {
  const { structuredContent, isError, content, validator, callId } = input
  if (structuredContent === undefined) {
    if (isError) {
      const message = firstText(content) ?? 'the remote tool reported an unspecified error'
      throw new McpTransportError('REMOTE_ERROR', message)
    }
    throw new McpTransportError(
      'INVALID_SCHEMA',
      'the remote tool returned no structured content for a declared output schema',
    )
  }

  const validation = validator.validateInline(toolResultSchemaRef(), structuredContent)
  if (!validation.valid) {
    const detail = validation.issues
      .slice(0, 3)
      .map((issue) => `${issue.pointer === '' ? '/' : issue.pointer} ${issue.reason}`)
      .join('; ')
    throw new McpTransportError(
      'INVALID_SCHEMA',
      `the remote structuredContent does not match the ToolResult contract: ${detail}`,
    )
  }

  const result = rebuildToolResult(structuredContent, callId)
  if (isError !== (result.status === 'error')) {
    throw new McpTransportError(
      'INVALID_SCHEMA',
      `the remote isError flag (${String(isError)}) disagrees with status ${result.status}`,
    )
  }
  if (result.status === 'error' && result.error === undefined) {
    throw new McpTransportError('INVALID_SCHEMA', 'an error result must carry a platform error')
  }
  return result
}

/**
 * Map a thrown JSON-RPC / SDK error onto the platform taxonomy. A connection close or
 * request timeout after send marks `remoteStateUnknown`, because the remote may already
 * have executed the call.
 */
export function mapRemoteFailure(error: unknown): McpTransportError {
  if (error instanceof McpTransportError) return error
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.InvalidParams:
        return new McpTransportError('INVALID_SCHEMA', error.message, { cause: error })
      case ErrorCode.InvalidRequest:
      case ErrorCode.ParseError:
        return new McpTransportError('REMOTE_PROTOCOL_ERROR', error.message, { cause: error })
      case ErrorCode.MethodNotFound:
        return new McpTransportError('UNKNOWN_REMOTE_TOOL', error.message, { cause: error })
      case ErrorCode.ConnectionClosed:
      case ErrorCode.RequestTimeout:
        return new McpTransportError('REMOTE_UNAVAILABLE', error.message, {
          cause: error,
          remoteStateUnknown: true,
        })
      case ErrorCode.InternalError:
      default:
        return new McpTransportError('REMOTE_ERROR', error.message, { cause: error })
    }
  }
  const message = error instanceof Error ? error.message : 'the remote transport failed'
  return new McpTransportError('REMOTE_UNAVAILABLE', message, { cause: error, remoteStateUnknown: true })
}

function pinInitialize(message: JSONRPCMessage, version: string): JSONRPCMessage {
  if (!('method' in message) || message.method !== 'initialize') return message
  if (!('params' in message) || typeof message.params !== 'object' || message.params === null) {
    return message
  }
  const params: Record<string, unknown> = { ...(message.params as Record<string, unknown>) }
  params.protocolVersion = version
  return { ...message, params }
}

/**
 * Negotiate the pinned protocol version on the client side.
 *
 * The SDK client always offers its own latest version; rewriting the `initialize`
 * request to the pinned version keeps the negotiated subset reproducible (the server
 * echoes a requested version it supports). The transport instance is returned so the
 * call can be chained; every other message and callback is left untouched.
 * `onNegotiated` observes the version the server actually selected.
 */
export function pinProtocolVersion<T extends Transport>(
  transport: T,
  version: string = MCP_PROTOCOL_VERSION,
  onNegotiated?: (version: string) => void,
): T {
  const originalSend = transport.send.bind(transport)
  transport.send = (message, options) => originalSend(pinInitialize(message, version), options)
  const originalSet = transport.setProtocolVersion?.bind(transport)
  transport.setProtocolVersion = (negotiated: string) => {
    onNegotiated?.(negotiated)
    originalSet?.(negotiated)
  }
  return transport
}

export { isRecord }
