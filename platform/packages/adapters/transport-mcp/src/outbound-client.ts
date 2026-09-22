import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isToolContext } from '@ontology/contracts'
import type {
  CancelResponse,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolId,
  ToolResult,
  ToolWarning,
} from '@ontology/contracts'
import { errorToolResult, McpTransportError, toPlatformError } from './errors'
import { mapRemoteFailure, parseRemoteToolResult, pinProtocolVersion } from './protocol'
import { MCP_PROTOCOL_VERSION } from './protocol'
import type { McpSchemaValidator } from './protocol'

/** Profile-bound mapping from a platform tool to the remote tool that backs it. */
export interface RemoteToolMapping {
  readonly toolId: ToolId
  readonly remoteName: string
  readonly definition: ToolDefinition
}

export interface OutboundToolClientOptions {
  readonly mappings: readonly RemoteToolMapping[]
  readonly validator: McpSchemaValidator
  readonly clientInfo?: { readonly name: string; readonly version: string }
  readonly now?: () => number
  readonly requestTimeoutMs?: number
  /** Observability hook fired after every discovery refresh (including `list_changed`). */
  readonly onToolsChanged?: (tools: readonly ToolDefinition[]) => void
  /** Observes the protocol version the remote selected during initialization. */
  readonly onProtocolNegotiated?: (version: string) => void
}

const DEFAULT_CLIENT_INFO = { name: 'ontology-mcp-tool-client', version: '1.0.0' }
const ABANDONED_WARNING = 'ATTEMPT_ABANDONED'

/**
 * The outbound MCP client (C5).
 *
 * It discovers a remote server's tools, keeps only the profile-bound whitelist, and
 * invokes a remote tool through the same `ToolResult` contract the platform uses. It
 * never auto-widens: a `tools/list_changed` notification (or an explicit refresh)
 * re-lists the remote catalogue and re-applies the whitelist, so a tool or domain the
 * profile did not bind is never enabled or callable.
 *
 * Protocol failures are mapped explicitly and are never returned as data: a JSON-RPC
 * error, an `isError` result, a schema-violating `structuredContent`, a missing
 * `structuredContent` and a dropped connection each become a classified platform error.
 * A dropped connection marks `remoteStateUnknown` (the remote may already have run and
 * billed the call) and the transport never retries it on its own.
 */
export class OutboundMcpToolClient {
  readonly #client: Client
  readonly #mappings: ReadonlyMap<ToolId, RemoteToolMapping>
  readonly #validator: McpSchemaValidator
  readonly #now: () => number
  readonly #requestTimeoutMs: number | undefined
  readonly #onToolsChanged: ((tools: readonly ToolDefinition[]) => void) | undefined
  readonly #inFlight = new Map<string, AbortController>()
  readonly #abandoned = new Map<string, string>()
  #enabled: readonly ToolDefinition[] = []
  #changeCount = 0
  #negotiatedProtocolVersion: string | undefined

  private constructor(client: Client, options: OutboundToolClientOptions) {
    this.#client = client
    this.#mappings = new Map(options.mappings.map((mapping) => [mapping.toolId, mapping]))
    this.#validator = options.validator
    this.#now = options.now ?? (() => Date.now())
    this.#requestTimeoutMs = options.requestTimeoutMs
    this.#onToolsChanged = options.onToolsChanged
  }

  static async connect(
    transport: Transport,
    options: OutboundToolClientOptions,
  ): Promise<OutboundMcpToolClient> {
    const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} })
    const instance = new OutboundMcpToolClient(client, options)
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await instance.refreshTools()
    })
    await client.connect(
      pinProtocolVersion(transport, MCP_PROTOCOL_VERSION, (version) => {
        instance.#negotiatedProtocolVersion = version
        options.onProtocolNegotiated?.(version)
      }),
    )
    await instance.refreshTools()
    return instance
  }

  /** The whitelisted tools currently exposed by the remote server. */
  get tools(): readonly ToolDefinition[] {
    return this.#enabled
  }

  /** How many discovery refreshes have run (initial + each `list_changed`/manual). */
  get changeCount(): number {
    return this.#changeCount
  }

  /** The protocol version the remote selected during initialization, once negotiated. */
  get protocolVersion(): string | undefined {
    return this.#negotiatedProtocolVersion
  }

  /**
   * Re-discover and re-apply the whitelist. The remote catalogue can only ever shrink
   * the enabled set relative to the profile-bound mapping; a newly advertised tool is
   * ignored.
   */
  async refreshTools(): Promise<readonly ToolDefinition[]> {
    const listed = await this.#client.listTools()
    const advertised = new Set(listed.tools.map((tool) => tool.name))
    const enabled: ToolDefinition[] = []
    for (const mapping of this.#mappings.values()) {
      if (advertised.has(mapping.remoteName)) enabled.push(mapping.definition)
    }
    this.#enabled = Object.freeze(enabled)
    this.#changeCount += 1
    this.#onToolsChanged?.(this.#enabled)
    return this.#enabled
  }

  async invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    if (!isToolContext(ctx)) {
      throw new McpTransportError('IDENTITY_REJECTED', 'a host-minted trusted tool context is required')
    }
    const startedAt = this.#now()
    const mapping = this.#mappings.get(call.toolId)
    if (mapping === undefined) {
      return this.#failure(
        call,
        ctx,
        new McpTransportError(
          'TOOL_NOT_WHITELISTED',
          `${call.toolId} is not in the profile-bound remote tool whitelist`,
        ),
        startedAt,
      )
    }
    if (!this.#enabled.some((definition) => definition.toolId === call.toolId)) {
      return this.#failure(
        call,
        ctx,
        new McpTransportError(
          'UNKNOWN_REMOTE_TOOL',
          `the remote server does not expose ${mapping.remoteName}`,
        ),
        startedAt,
      )
    }

    const controller = new AbortController()
    this.#inFlight.set(call.callId, controller)
    try {
      const options =
        this.#requestTimeoutMs === undefined
          ? { signal: controller.signal }
          : { signal: controller.signal, timeout: this.#requestTimeoutMs }
      const result = (await this.#client.callTool(
        { name: mapping.remoteName, arguments: call.arguments },
        CallToolResultSchema,
        options,
      )) as CallToolResult
      if (this.#abandoned.has(call.callId)) {
        // The SDK drops a response for an aborted request; this guard also covers a
        // remote that answered before observing the cancellation.
        return this.#abandonedResult(call, ctx, startedAt)
      }
      return parseRemoteToolResult({
        callId: call.callId,
        structuredContent: result.structuredContent,
        isError: result.isError === true,
        content: result.content,
        validator: this.#validator,
      })
    } catch (error) {
      if (this.#abandoned.has(call.callId)) {
        return this.#abandonedResult(call, ctx, startedAt)
      }
      return this.#failure(call, ctx, mapRemoteFailure(error), startedAt)
    } finally {
      this.#inFlight.delete(call.callId)
    }
  }

  /**
   * Best-effort cancellation. The platform must not claim the remote task was
   * terminated, so the response is always `unsupported`; the attempt is recorded as
   * abandoned and any late result is quarantined instead of being published.
   */
  async cancel(callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse> {
    if (!isToolContext(ctx)) {
      throw new McpTransportError('IDENTITY_REJECTED', 'a host-minted trusted tool context is required')
    }
    this.#abandoned.set(callId, reason)
    this.#inFlight.get(callId)?.abort(reason)
    return {
      targetRef: callId,
      state: 'unsupported',
      acceptedAt: new Date(this.#now()).toISOString(),
    }
  }

  async close(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort('client closed')
    this.#inFlight.clear()
    await this.#client.close()
  }

  #failure(call: ToolCall, ctx: ToolContext, error: McpTransportError, startedAt: number): ToolResult {
    return errorToolResult(call.callId, call.toolId, toPlatformError(error, ctx.traceId), this.#now() - startedAt)
  }

  #abandonedResult(call: ToolCall, ctx: ToolContext, startedAt: number): ToolResult {
    const error = new McpTransportError(
      'ABANDONED',
      'the call was cancelled and its late result was quarantined',
    )
    const warning: ToolWarning = {
      code: ABANDONED_WARNING,
      message: 'the attempt was abandoned; no result is published for a cancelled call',
    }
    return {
      ...errorToolResult(call.callId, call.toolId, toPlatformError(error, ctx.traceId), this.#now() - startedAt),
      warnings: [warning],
    }
  }
}
