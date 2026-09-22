/**
 * @ontology/adapter-transport-mcp — real stdio MCP transport (C5, ADR-05).
 *
 * Two directions, one contract:
 *  - inbound: expose the run's `ToolDefinition`s through the *server-side* `ToolGateway`
 *    with a host-minted session identity, so an external MCP client can never bypass
 *    authorization, budget, evidence or settlement;
 *  - outbound: discover a remote server's tools, keep only the profile-bound whitelist
 *    (`list_changed` never widens it) and map protocol/`isError`/schema/disconnect/late
 *    cancellation failures onto the platform taxonomy.
 *
 * The adapter imports only `@ontology/contracts`, `@ontology/core` and the MCP SDK. It
 * contains no domain logic: validation, authorization, evidence and settlement reuse the
 * gateway, and business validation reuses the registered handlers.
 */
export { McpTransportError, isMcpTransportError, toPlatformError, errorToolResult } from './errors'
export type { McpTransportErrorCode } from './errors'
export {
  MCP_PROTOCOL_VERSION,
  MCP_SDK_VERSION,
  MCP_TOOL_RESULT_SCHEMA_REF,
  mapRemoteFailure,
  parseRemoteToolResult,
  pinProtocolVersion,
  toCallToolResult,
} from './protocol'
export type {
  McpSchemaIssue,
  McpSchemaValidationResult,
  McpSchemaValidator,
  RemoteResultInput,
} from './protocol'
export { resolveSchemaRef } from './schema'
export { assertMcpToolSession, createMcpSession, mintSessionContext } from './session'
export type {
  CreateMcpSessionInput,
  McpLauncherIdentity,
  McpSessionLauncher,
  McpToolSession,
} from './session'
export { InboundMcpToolServer } from './inbound-server'
export type { InboundToolServerInfo, InboundToolServerOptions } from './inbound-server'
export { OutboundMcpToolClient } from './outbound-client'
export type { OutboundToolClientOptions, RemoteToolMapping } from './outbound-client'
export { connectStdioToolClient, startStdioInboundToolServer } from './stdio'
export type { StdioInboundServerOptions, StdioOutboundClientOptions } from './stdio'
export {
  STREAMABLE_HTTP_HOST_CONTRACT,
  isStreamableHttpEnabled,
  requireStreamableHttpHost,
} from './http-host'
export type { StreamableHttpHostContract } from './http-host'
