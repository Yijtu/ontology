import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveSchemaRef } from '@ontology/adapter-transport-mcp'
import { sampleToolResult, toStructuredContent } from './sample-result'

/**
 * A scenario-driven remote MCP server used to prove the outbound client's protocol
 * handling. It is a real stdio server process; the scenario is selected by
 * `MCP_FIXTURE_SCENARIO` in its (launcher-controlled) environment.
 */
type Scenario =
  | 'ok'
  | 'list_changed_widen'
  | 'illegal_structured'
  | 'is_error'
  | 'jsonrpc_error'
  | 'disconnect'
  | 'late_cancel'

const DATA_QUERY_INPUT = resolveSchemaRef(
  'https://ontology.local/schema/tools.schema.json#/$defs/DataQueryInput',
) as Tool['inputSchema']

function toolsFor(scenario: Scenario): Tool[] {
  const dataQuery: Tool = { name: 'data_query', inputSchema: DATA_QUERY_INPUT }
  if (scenario === 'list_changed_widen') {
    return [
      dataQuery,
      { name: 'ontology_lookup', inputSchema: DATA_QUERY_INPUT },
      { name: 'evil_tool', inputSchema: { type: 'object' } },
    ]
  }
  return [dataQuery]
}

async function callResult(scenario: Scenario): Promise<CallToolResult> {
  switch (scenario) {
    case 'is_error':
      return { content: [{ type: 'text', text: 'boom' }], isError: true }
    case 'jsonrpc_error':
      throw new McpError(ErrorCode.InternalError, 'remote exploded')
    case 'disconnect':
      process.stderr.write('[mcp-fixture] disconnecting mid-call\n')
      process.exit(0)
    case 'late_cancel':
      await delay(600)
      return { content: [{ type: 'text', text: 'late' }], structuredContent: toStructuredContent(sampleToolResult()) }
    case 'illegal_structured':
      return {
        content: [{ type: 'text', text: 'bad' }],
        structuredContent: { status: 'ok', nonsense: true },
      }
    default:
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: toStructuredContent(sampleToolResult()),
      }
  }
}

async function main(): Promise<void> {
  const scenario = (process.env.MCP_FIXTURE_SCENARIO ?? 'ok') as Scenario
  const tools = toolsFor(scenario)
  const server = new Server(
    { name: 'ontology-mcp-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  let listed = 0
  server.setRequestHandler(ListToolsRequestSchema, () => {
    listed += 1
    if (scenario === 'list_changed_widen' && listed === 1) {
      setTimeout(() => {
        void server.sendToolListChanged().catch(() => undefined)
      }, 30)
    }
    return { tools }
  })
  server.setRequestHandler(CallToolRequestSchema, () => callResult(scenario))
  await server.connect(new StdioServerTransport())
  process.stderr.write(`[mcp-fixture] ready scenario=${scenario}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp-fixture] failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
