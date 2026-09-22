import { startStdioInboundToolServer } from '@ontology/adapter-transport-mcp'
import type { McpLauncherIdentity } from '@ontology/adapter-transport-mcp'
import { buildPlatformSession, launcherIdentity } from './platform-session'

/**
 * A real stdio MCP server process used by the integration acceptance.
 *
 * The trusted launcher (the test) passes the session identity and database handles
 * through the environment. The connecting MCP client cannot see or change them, which
 * is what makes a client-supplied `tenant_id`/`run_id` unable to grant trust.
 *
 * stdout is the protocol channel; diagnostics go to stderr only.
 */
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const identity: McpLauncherIdentity = launcherIdentity({
    runId: required('MCP_RUN_ID'),
    sessionId: process.env.MCP_SESSION_ID ?? 'stdio-session',
    tenantId: required('MCP_TENANT_ID'),
    spaceId: required('MCP_SPACE_ID'),
  })
  const platform = await buildPlatformSession({
    controlDatabaseUrl: required('MCP_CONTROL_DATABASE_URL'),
    businessDatabaseUrl: required('MCP_BUSINESS_DATABASE_URL'),
    objectDir: required('MCP_OBJECT_DIR'),
    identity,
    ledgerId: required('MCP_LEDGER_ID'),
  })
  await startStdioInboundToolServer({
    launcher: {
      openSession: () => platform.session,
      closeSession: async () => {
        await platform.close()
      },
    },
  })
  process.stderr.write(`[mcp-stdio-server] ready session=${identity.sessionId}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp-stdio-server] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
