import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createToolContext } from '@ontology/contracts'
import type { ToolDefinition, ToolResult, VersionRef } from '@ontology/contracts'
import {
  McpTransportError,
  OutboundMcpToolClient,
  STREAMABLE_HTTP_HOST_CONTRACT,
  MCP_PROTOCOL_VERSION,
  MCP_SDK_VERSION,
  assertMcpToolSession,
  createMcpSession,
  isStreamableHttpEnabled,
  mapRemoteFailure,
  parseRemoteToolResult,
  pinProtocolVersion,
  requireStreamableHttpHost,
  resolveSchemaRef,
  toCallToolResult,
} from '@ontology/adapter-transport-mcp'
import type { McpLauncherIdentity, RemoteToolMapping } from '@ontology/adapter-transport-mcp'
import { createMcpSchemaValidator } from '../fixtures/mcp/validator'
import { toStructuredContent } from '../fixtures/mcp/sample-result'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-21T00:00:00Z'

const TOOL_DEFINITION: ToolDefinition = {
  toolId: 'data_query',
  version: '1.0.0',
  inputSchema: { $ref: 'https://ontology.local/schema/tools.schema.json#/$defs/DataQueryInput' },
  outputSchema: { $ref: 'https://ontology.local/schema/tools.schema.json#/$defs/DataQueryOutput' },
  requiredCapabilities: ['structured_query.execute'],
  readOnly: true,
  resultLimits: { maxRows: 100, maxBytes: 65536, maxDurationMs: 30000 },
}

const SCHEMA_REF: VersionRef = { id: 'data_query.output', version: '1.0.0', digest: DIGEST }

function validToolResult(overrides?: Partial<ToolResult>): ToolResult {
  return {
    callId: '44444444-4444-4444-8444-444444444444',
    status: 'ok',
    inlineData: { resultKind: 'table', table: { columns: [], rows: [] } },
    schemaRef: SCHEMA_REF,
    evidenceRefs: [{ id: '55555555-5555-4555-8555-555555555555', version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
    sourceSnapshots: [
      {
        sourceRef: { namespace: 'demo', sourceId: 'business-db' },
        schemaVersion: '2026-09-01',
        readAt: NOW,
        consistency: 'repeatable_read',
        resultDigest: DIGEST,
      },
    ],
    coverage: { returned: 0, truncated: false },
    usage: { durationMs: 1 },
    warnings: [],
    ...overrides,
  }
}

function errorResult(code?: NonNullable<ToolResult['error']>['code']): ToolResult {
  const base = validToolResult()
  const { inlineData, ...rest } = base
  void inlineData
  return {
    ...rest,
    status: 'error',
    ...(code === undefined ? {} : { error: { code, message: 'x', retryable: false } }),
  }
}

function launcherIdentity(overrides?: Partial<McpLauncherIdentity>): McpLauncherIdentity {
  return {
    sessionId: 'session-1',
    principal: { tenantId: TENANT, subjectId: 'mcp-session', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [{ namespace: 'demo', sourceId: 'business-db' }],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    runId: RUN,
    budgetReservation: { reservationId: '66666666-6666-4666-8666-666666666666', runId: RUN, grantedAt: NOW, expiresAt: '2030-01-01T00:00:00Z' },
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    traceId: 'trace-mcp-unit',
    ...overrides,
  }
}

function collectExternalRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectExternalRefs(entry, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string' && !value.startsWith('#/$defs/')) out.push(value)
    else collectExternalRefs(value, out)
  }
  return out
}

describe('canonical schema resolution for the MCP boundary', () => {
  it('resolves a union tool input into a self-contained object schema', () => {
    const schema = resolveSchemaRef(TOOL_DEFINITION.inputSchema['$ref'] as string)
    expect(schema.type).toBe('object')
    expect(collectExternalRefs(schema)).toEqual([])
    expect(schema.$defs).toBeTypeOf('object')
    expect(Object.keys(schema.$defs as Record<string, unknown>).length).toBeGreaterThan(0)
  })

  it('resolves the canonical ToolResult schema with no external reference', () => {
    const schema = resolveSchemaRef('https://ontology.local/schema/tools.schema.json#/$defs/ToolResult')
    expect(schema.type).toBe('object')
    expect(collectExternalRefs(schema)).toEqual([])
  })

  it('rejects a non-canonical reference instead of guessing', () => {
    expect(() => resolveSchemaRef('https://example.com/schema.json#/$defs/Nope')).toThrow(McpTransportError)
  })
})

describe('platform result <-> MCP result mapping', () => {
  it('carries the whole ToolResult as structuredContent with isError mirroring status', () => {
    const ok = toCallToolResult(validToolResult())
    expect(ok.isError).toBe(false)
    expect(ok.structuredContent).toMatchObject({ status: 'ok' })

    const failed = toCallToolResult(errorResult('FORBIDDEN'))
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({ status: 'error' })
  })

  it('reconstructs a valid ToolResult and rebinds the local callId', () => {
    const result = parseRemoteToolResult({
      callId: '77777777-7777-4777-8777-777777777777',
      structuredContent: toStructuredContent(validToolResult()),
      isError: false,
      content: [],
      validator: createMcpSchemaValidator(),
    })
    expect(result.callId).toBe('77777777-7777-4777-8777-777777777777')
    expect(result.status).toBe('ok')
  })

  it('never treats error text as a valid result', () => {
    expect(() =>
      parseRemoteToolResult({
        callId: 'x',
        structuredContent: undefined,
        isError: true,
        content: [{ type: 'text', text: 'stack trace' }],
        validator: createMcpSchemaValidator(),
      }),
    ).toThrowError(/stack trace/)
  })

  it('rejects a success without structured content', () => {
    expect(() =>
      parseRemoteToolResult({
        callId: 'x',
        structuredContent: undefined,
        isError: false,
        content: [{ type: 'text', text: '{}' }],
        validator: createMcpSchemaValidator(),
      }),
    ).toThrow(McpTransportError)
  })

  it('rejects schema-violating structuredContent', () => {
    expect(() =>
      parseRemoteToolResult({
        callId: 'x',
        structuredContent: { status: 'ok', nonsense: true },
        isError: false,
        content: [],
        validator: createMcpSchemaValidator(),
      }),
    ).toThrowError(/does not match the ToolResult contract/)
  })

  it('rejects an isError flag that disagrees with the status', () => {
    expect(() =>
      parseRemoteToolResult({
        callId: 'x',
        structuredContent: toStructuredContent(validToolResult()),
        isError: true,
        content: [],
        validator: createMcpSchemaValidator(),
      }),
    ).toThrowError(/disagrees with status/)
  })

  it('rejects an error status that carries no platform error', () => {
    expect(() =>
      parseRemoteToolResult({
        callId: 'x',
        structuredContent: toStructuredContent(errorResult()),
        isError: true,
        content: [],
        validator: createMcpSchemaValidator(),
      }),
    ).toThrowError(/must carry a platform error/)
  })
})

describe('JSON-RPC / transport failure mapping', () => {
  it('maps JSON-RPC error codes onto the platform taxonomy', () => {
    expect(mapRemoteFailure(new McpError(ErrorCode.InvalidParams, 'bad')).platformCode).toBe('INVALID_SCHEMA')
    expect(mapRemoteFailure(new McpError(ErrorCode.MethodNotFound, 'no')).platformCode).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(mapRemoteFailure(new McpError(ErrorCode.InternalError, 'boom')).platformCode).toBe('INTERNAL_ERROR')
  })

  it('marks a dropped connection as a possibly-billed remote state unknown', () => {
    const mapped = mapRemoteFailure(new McpError(ErrorCode.ConnectionClosed, 'closed'))
    expect(mapped.platformCode).toBe('SOURCE_UNAVAILABLE')
    expect(mapped.remoteStateUnknown).toBe(true)
  })

  it('treats a non-SDK throw as a remote-unavailable transport failure', () => {
    const mapped = mapRemoteFailure(new Error('socket hang up'))
    expect(mapped.code).toBe('REMOTE_UNAVAILABLE')
    expect(mapped.remoteStateUnknown).toBe(true)
  })
})

describe('pinned protocol negotiation', () => {
  it('locks the SDK version and negotiates the 2025-06-18 subset', () => {
    const sdkPackage = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version: string }
    expect(sdkPackage.version).toBe(MCP_SDK_VERSION)
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION)
  })

  it('rewrites only the initialize request version', async () => {
    const sent: unknown[] = []
    const transport: Transport = {
      start: async () => undefined,
      close: async () => undefined,
      send: async (message) => {
        sent.push(message)
      },
    }
    pinProtocolVersion(transport, '2025-06-18')
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
    })
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(sent[0]).toMatchObject({ params: { protocolVersion: '2025-06-18' } })
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
})

describe('trusted launcher session', () => {
  const gateway = {
    invoke: async () => validToolResult(),
    cancel: async () => ({ targetRef: 'x', state: 'unsupported' as const, acceptedAt: NOW }),
  }

  it('mints a host-branded context from the launcher identity', () => {
    const session = createMcpSession({ identity: launcherIdentity(), gateway, tools: [TOOL_DEFINITION] })
    expect(session.context.principal.tenantId).toBe(TENANT)
    expect(() => assertMcpToolSession(session)).not.toThrow()
  })

  it('refuses an inconsistent tenant scope', () => {
    const identity = launcherIdentity({
      allowedResources: { ...launcherIdentity().allowedResources, tenantId: '99999999-9999-4999-8999-999999999999' },
    })
    expect(() => createMcpSession({ identity, gateway, tools: [TOOL_DEFINITION] })).toThrow(McpTransportError)
  })

  it('refuses to expose a controller service as an MCP tool', () => {
    const controllerTool = JSON.parse(
      JSON.stringify({ ...TOOL_DEFINITION, toolId: 'final_answer' }),
    ) as ToolDefinition
    expect(() => createMcpSession({ identity: launcherIdentity(), gateway, tools: [controllerTool] })).toThrow(
      /controller service/,
    )
  })

  it('refuses a forged (unbranded) context', () => {
    const session = createMcpSession({ identity: launcherIdentity(), gateway, tools: [TOOL_DEFINITION] })
    const unbranded = JSON.parse(JSON.stringify(session.context)) as typeof session.context
    const forged = { ...session, context: unbranded }
    expect(() => assertMcpToolSession(forged)).toThrow(/host-minted tool context/)
  })
})

describe('streamable HTTP is an explicit not-enabled declaration', () => {
  it('reports not enabled and refuses to serve', () => {
    expect(isStreamableHttpEnabled()).toBe(false)
    expect(STREAMABLE_HTTP_HOST_CONTRACT.enabled).toBe(false)
    expect(STREAMABLE_HTTP_HOST_CONTRACT.requiredBeforeEnable.length).toBeGreaterThan(0)
    expect(() => requireStreamableHttpHost()).toThrowError(/not enabled/)
  })
})

function remoteTool(name: string): Tool {
  return {
    name,
    inputSchema: resolveSchemaRef(TOOL_DEFINITION.inputSchema['$ref'] as string) as Tool['inputSchema'],
  }
}

describe('outbound whitelist and list_changed containment', () => {
  async function connectFixture(advertised: string[]): Promise<{
    client: OutboundMcpToolClient
    server: Server
    close: () => Promise<void>
  }> {
    const tools = advertised.map(remoteTool)
    const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
    server.setRequestHandler(CallToolRequestSchema, (): CallToolResult => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: toStructuredContent(validToolResult()),
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const mapping: RemoteToolMapping = { toolId: 'data_query', remoteName: 'data_query', definition: TOOL_DEFINITION }
    const client = await OutboundMcpToolClient.connect(clientTransport, {
      mappings: [mapping],
      validator: createMcpSchemaValidator(),
    })
    return {
      client,
      server,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  const ctx = createToolContext({
    principal: { tenantId: TENANT, subjectId: 'client', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 },
    runId: RUN,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: { reservationId: '66666666-6666-4666-8666-666666666666', runId: RUN, grantedAt: NOW, expiresAt: '2030-01-01T00:00:00Z' },
    allowedResources: { tenantId: TENANT, spaceId: SPACE, resourceKinds: ['artifact'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 100 },
    traceId: 'trace-client',
  })

  it('exposes only the profile-bound whitelist', async () => {
    const fixture = await connectFixture(['data_query', 'document_search', 'evil_tool'])
    try {
      expect(fixture.client.tools.map((tool) => tool.toolId)).toEqual(['data_query'])
      expect(fixture.client.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    } finally {
      await fixture.close()
    }
  })

  it('does not widen the allowlist when the remote emits list_changed with a new tool', async () => {
    const fixture = await connectFixture(['data_query'])
    try {
      const before = fixture.client.changeCount
      await fixture.server.sendToolListChanged()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fixture.client.changeCount).toBeGreaterThan(before)
      expect(fixture.client.tools.map((tool) => tool.toolId)).toEqual(['data_query'])
    } finally {
      await fixture.close()
    }
  })

  it('refuses to call a tool outside the whitelist', async () => {
    const fixture = await connectFixture(['data_query', 'document_search'])
    try {
      const result = await fixture.client.invoke(
        { callId: '88888888-8888-4888-8888-888888888888', toolId: 'document_search', arguments: {} },
        ctx,
      )
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('FORBIDDEN')
    } finally {
      await fixture.close()
    }
  })

  it('reconstructs a whitelisted call through the same ToolResult contract', async () => {
    const fixture = await connectFixture(['data_query'])
    try {
      const result = await fixture.client.invoke(
        { callId: '99999999-9999-4999-8999-999999999999', toolId: 'data_query', arguments: { kind: 'describe' } },
        ctx,
      )
      expect(result.status).toBe('ok')
      expect(result.callId).toBe('99999999-9999-4999-8999-999999999999')
    } finally {
      await fixture.close()
    }
  })
})
