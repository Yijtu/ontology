import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InboundMcpToolServer } from './inbound-server'
import type { InboundToolServerOptions } from './inbound-server'
import { OutboundMcpToolClient } from './outbound-client'
import type { OutboundToolClientOptions } from './outbound-client'

export type StdioInboundServerOptions = InboundToolServerOptions

/**
 * Start the inbound tool server on the process's stdin/stdout (SPEC C5: stdio first).
 *
 * stdout is the protocol channel, so the process must write diagnostics to stderr only.
 */
export async function startStdioInboundToolServer(
  options: StdioInboundServerOptions,
): Promise<InboundMcpToolServer> {
  const server = new InboundMcpToolServer(options)
  await server.connect(new StdioServerTransport())
  return server
}

export interface StdioOutboundClientOptions extends OutboundToolClientOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly stderr?: 'inherit' | 'pipe'
}

/**
 * Connect an outbound tool client to a child process over stdio.
 *
 * The child is a real MCP server process. Its environment is the launcher channel that
 * carries a trusted identity when it hosts the platform server; it is never taken from
 * the client's tool arguments.
 */
export async function connectStdioToolClient(
  options: StdioOutboundClientOptions,
): Promise<OutboundMcpToolClient> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...(options.args ?? [])],
    env: { ...(options.env ?? {}) },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stderr: options.stderr ?? 'inherit',
  })
  return OutboundMcpToolClient.connect(transport, options)
}
