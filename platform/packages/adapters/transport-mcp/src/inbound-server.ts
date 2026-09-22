import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolCall, ToolDefinition, ToolId } from '@ontology/contracts'
import { errorToolResult, McpTransportError, toPlatformError } from './errors'
import { MCP_PROTOCOL_VERSION, MCP_TOOL_RESULT_SCHEMA_REF, toCallToolResult } from './protocol'
import { resolveSchemaRef } from './schema'
import { assertMcpToolSession } from './session'
import type { McpSessionLauncher, McpToolSession } from './session'

export interface InboundToolServerInfo {
  readonly name: string
  readonly version: string
}

export interface InboundToolServerOptions {
  /** The trusted launcher; it, not the client, establishes the session identity. */
  readonly launcher: McpSessionLauncher
  readonly serverInfo?: InboundToolServerInfo
  readonly now?: () => number
}

const DEFAULT_SERVER_INFO: InboundToolServerInfo = {
  name: 'ontology-mcp-tool-server',
  version: '1.0.0',
}

function toMcpTool(definition: ToolDefinition): Tool {
  const inputRef = definition.inputSchema['$ref']
  if (typeof inputRef !== 'string') {
    throw new McpTransportError(
      'INVALID_SCHEMA',
      `the tool ${definition.toolId} input schema has no canonical $ref`,
    )
  }
  return {
    name: definition.toolId,
    title: definition.toolId,
    description: `Platform tool ${definition.toolId} v${definition.version} (read-only=${String(definition.readOnly)})`,
    inputSchema: resolveSchemaRef(inputRef) as Tool['inputSchema'],
    outputSchema: resolveSchemaRef(MCP_TOOL_RESULT_SCHEMA_REF) as Tool['outputSchema'],
    // INV-07: annotations describe the tool, they are never an authorization credential.
    annotations: {
      readOnlyHint: definition.readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }
}

/**
 * The inbound MCP server (C5, ADR-05).
 *
 * It exposes the run's enabled `ToolDefinition`s and routes every `tools/call` through
 * the *server-side* gateway with the host-minted session context. It contains no domain
 * logic: it never validates an argument itself, resolves an operation, queries a backend
 * or interprets a result. Authorization, budget, intent, evidence and settlement all
 * reuse the same `ToolGateway` implementation the local path uses.
 *
 * The session is established by the trusted launcher on connect. Client-supplied
 * `tenant_id`/`run_id`/role values are ordinary untrusted arguments and are rejected by
 * the gateway's trusted-envelope check, so they can never grant trust.
 */
export class InboundMcpToolServer {
  readonly #options: InboundToolServerOptions
  readonly #serverInfo: InboundToolServerInfo
  readonly #now: () => number
  readonly #tools = new Map<ToolId, ToolDefinition>()
  #session: McpToolSession | undefined
  #server: Server | undefined

  constructor(options: InboundToolServerOptions) {
    this.#options = options
    this.#serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO
    this.#now = options.now ?? (() => Date.now())
  }

  /** The negotiated protocol version advertised by this server's SDK. */
  get protocolVersion(): string {
    return MCP_PROTOCOL_VERSION
  }

  async connect(transport: Transport): Promise<void> {
    if (this.#server !== undefined) {
      throw new McpTransportError('IDENTITY_REJECTED', 'the inbound server is already connected')
    }
    const session = await this.#options.launcher.openSession()
    assertMcpToolSession(session)
    this.#session = session
    for (const definition of session.tools) {
      this.#tools.set(definition.toolId, definition)
    }

    const server = new Server(this.#serverInfo, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.#tools.values()].map((definition) => toMcpTool(definition)),
    }))
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.#call(request.params.name, request.params.arguments ?? {}),
    )
    this.#server = server
    await server.connect(transport)
  }

  async close(): Promise<void> {
    const session = this.#session
    this.#session = undefined
    await this.#server?.close()
    this.#server = undefined
    if (session !== undefined) {
      await this.#options.launcher.closeSession?.(session)
    }
  }

  async #call(name: string, args: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const session = this.#session
    if (session === undefined) {
      throw new McpTransportError('IDENTITY_REJECTED', 'no session is established on this connection')
    }
    const definition = this.#tools.get(name as ToolId)
    if (definition === undefined) {
      return {
        content: [{ type: 'text', text: `unknown tool ${name}` }],
        isError: true,
      }
    }
    const startedAt = this.#now()
    const call: ToolCall = {
      callId: randomUUID(),
      toolId: definition.toolId,
      arguments: args,
    }
    try {
      const result = await session.gateway.invoke(call, session.context)
      return toCallToolResult(result)
    } catch (error) {
      const classified =
        error instanceof McpTransportError
          ? error
          : new McpTransportError('REMOTE_ERROR', 'the tool call failed unexpectedly', { cause: error })
      const platformError = toPlatformError(classified, session.context.traceId)
      return toCallToolResult(
        errorToolResult(call.callId, definition.toolId, platformError, this.#now() - startedAt),
      )
    }
  }
}
