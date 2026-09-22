import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_PROTOCOL_VERSION,
  OutboundMcpToolClient,
  connectStdioToolClient,
} from '@ontology/adapter-transport-mcp'
import type { RemoteToolMapping } from '@ontology/adapter-transport-mcp'
import type {
  DirectSqlQueryPlan,
  ScalarValue,
  ScopeRef,
  SourceObjectRef,
  ToolCall,
  ToolContext,
} from '@ontology/contracts'
import { ToolGatewayError, logicalEvidenceDigest } from '@ontology/tool-services'
import type { ToolExecutionOutcome, ToolExecutionRequest, ToolHandler } from '@ontology/tool-services'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { createMcpSchemaValidator } from '../fixtures/mcp/validator'
import {
  MCP_SOURCE,
  buildPlatformSession,
  dataQueryDefinition,
  documentSearchDefinition,
  launcherIdentity,
  ontologyLookupDefinition,
  webSearchDefinition,
} from '../fixtures/mcp/platform-session'
import type { PlatformSession } from '../fixtures/mcp/platform-session'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PLATFORM_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STDIO_SERVER = fileURLToPath(new URL('../fixtures/mcp/stdio-server.ts', import.meta.url))
const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-remote-server.ts', import.meta.url))
const READ_ONLY_ROLE = 'ontology_reader'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VICTIM_TENANT = '22222222-2222-4222-8222-222222222222'
const VICTIM_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const RUN_A2 = '33333333-3333-4333-8333-333333333334'
const LEDGER_A2 = '88888888-8888-4888-8888-888888888889'
const RUN_B = '44444444-4444-4444-8444-444444444444'
const LEDGER_B = '99999999-9999-4999-8999-999999999999'
const RUN_R = '55555555-5555-4555-8555-555555555555'
const LEDGER_R = 'aaaaaaaa-1111-4111-8111-111111111111'

const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function directPlan(sql: string, parameters: ScalarValue[], objects: SourceObjectRef[]): DirectSqlQueryPlan {
  return { mode: 'direct', statementKind: 'select', sql, parameters, referencedObjects: objects, readOnly: true }
}

function declared(...objectPaths: readonly string[]): SourceObjectRef[] {
  return objectPaths.map((objectPath) => ({ sourceRef: MCP_SOURCE, objectPath }))
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appUrl = ''
let businessUrl = ''
let objectDir = ''

let platformA: PlatformSession
let platformB: PlatformSession
let platformRemote: PlatformSession
let clientA: OutboundMcpToolClient

const MAPPINGS: readonly RemoteToolMapping[] = [
  { toolId: 'data_query', remoteName: 'data_query', definition: dataQueryDefinition() },
  { toolId: 'ontology_lookup', remoteName: 'ontology_lookup', definition: ontologyLookupDefinition() },
  { toolId: 'document_search', remoteName: 'document_search', definition: documentSearchDefinition() },
  { toolId: 'web_search', remoteName: 'web_search', definition: webSearchDefinition() },
]

function childEnv(runId: string, ledgerId: string): Record<string, string> {
  return {
    MCP_CONTROL_DATABASE_URL: appUrl,
    MCP_BUSINESS_DATABASE_URL: businessUrl,
    MCP_OBJECT_DIR: objectDir,
    MCP_RUN_ID: runId,
    MCP_LEDGER_ID: ledgerId,
    MCP_TENANT_ID: TENANT,
    MCP_SPACE_ID: SPACE,
    MCP_SESSION_ID: `stdio-${runId.slice(0, 8)}`,
  }
}

async function connectPlatformChild(runId: string, ledgerId: string): Promise<OutboundMcpToolClient> {
  return connectStdioToolClient({
    command: process.execPath,
    args: ['--import', 'tsx', STDIO_SERVER],
    cwd: PLATFORM_ROOT,
    env: { ...baseEnv(), ...childEnv(runId, ledgerId) },
    stderr: 'inherit',
    mappings: MAPPINGS,
    validator: createMcpSchemaValidator(),
  })
}

async function connectFixtureChild(scenario: string): Promise<OutboundMcpToolClient> {
  return connectStdioToolClient({
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE_SERVER],
    cwd: PLATFORM_ROOT,
    env: { ...baseEnv(), MCP_FIXTURE_SCENARIO: scenario },
    stderr: 'inherit',
    mappings: MAPPINGS,
    validator: createMcpSchemaValidator(),
  })
}

async function budgetRow(ledgerId: string): Promise<{ status: string; usage_unknown: boolean } | undefined> {
  const result = await adminClient.query<{ status: string; usage_unknown: boolean }>(
    `SELECT status, usage_unknown
       FROM agent_platform.budget_reservations
      WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3
      ORDER BY granted_at DESC
      LIMIT 1`,
    [TENANT, SPACE, ledgerId],
  )
  return result.rows[0]
}

/** Wraps an outbound MCP client as a gateway handler so remote failures settle through the platform. */
class RemoteToolHandler implements ToolHandler {
  readonly toolId = 'data_query'
  readonly #ctx: ToolContext
  readonly #client: OutboundMcpToolClient

  constructor(ctx: ToolContext, client: OutboundMcpToolClient) {
    this.#ctx = ctx
    this.#client = client
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const result = await this.#client.invoke(
      { callId: request.callId, toolId: this.toolId, arguments: request.arguments },
      this.#ctx,
    )
    if (result.status === 'error') {
      throw new ToolGatewayError('HANDLER_FAILED', result.error?.message ?? 'the remote tool failed', {
        platformCode: result.error?.code ?? 'INTERNAL_ERROR',
        ...(result.error?.remoteStateUnknown === true ? { remoteStateUnknown: true } : {}),
      })
    }
    return {
      payload: result.inlineData,
      status: result.status === 'partial' ? 'partial' : result.status === 'empty' ? 'empty' : 'ok',
      coverage: result.coverage,
      sources: result.sourceSnapshots.map((snapshot) => ({
        sourceRef: snapshot.sourceRef,
        schemaVersion: snapshot.schemaVersion,
        consistency: snapshot.consistency,
        resultDigest: snapshot.resultDigest,
      })),
      warnings: result.warnings,
    }
  }
}

beforeAll(async () => {
  container = await startPostgresContainer()
  adminUrl = container.adminUrl
  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'mcp-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'mcp-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const appStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = appStatement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword, 'postgres')

  const businessDbName = `business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const readerPassword = `throwaway_${randomBytes(8).toString('hex')}`
  const readerStatement = await adminClient.query<{ statement: string }>(
    "SELECT format('CREATE ROLE ' || quote_ident($1) || ' LOGIN PASSWORD %L', $2::text) AS statement",
    [READ_ONLY_ROLE, readerPassword],
  )
  const createReader = readerStatement.rows[0]?.statement
  if (createReader === undefined) throw new Error('could not build the read-only role statement')
  await adminClient.query(createReader)
  businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, readerPassword, businessDbName)
  const businessAdminUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  const businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE SCHEMA sales;
    CREATE TABLE sales.orders (
      id integer PRIMARY KEY,
      customer text NOT NULL,
      amount numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO sales.orders (id, customer, amount, created_at) VALUES
      (1, 'acme', 10.50, '2026-01-01T00:00:00Z'),
      (2, 'beta', 20.00, '2026-01-02T00:00:00Z'),
      (3, 'acme', 30.25, '2026-01-03T00:00:00Z'),
      (4, 'gamma', 40.00, '2026-01-04T00:00:00Z');
    GRANT USAGE ON SCHEMA sales TO ${READ_ONLY_ROLE};
    GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${READ_ONLY_ROLE};
  `)
  await businessAdmin.end()

  objectDir = await mkdtemp(join(tmpdir(), 'mcp-transport-blob-'))

  platformA = await buildPlatformSession({
    controlDatabaseUrl: appUrl,
    businessDatabaseUrl: businessUrl,
    objectDir,
    identity: launcherIdentity({ runId: RUN_A, sessionId: 'local-a', tenantId: TENANT, spaceId: SPACE }),
    ledgerId: LEDGER_A,
  })
  platformB = await buildPlatformSession({
    controlDatabaseUrl: appUrl,
    businessDatabaseUrl: businessUrl,
    objectDir,
    identity: launcherIdentity({ runId: RUN_B, sessionId: 'local-b', tenantId: TENANT, spaceId: SPACE }),
    ledgerId: LEDGER_B,
    overrideLimits: { maxToolCalls: 2 },
  })

  clientA = await connectPlatformChild(RUN_A2, LEDGER_A2)

  const disconnectClient = await connectFixtureChild('disconnect')
  platformRemote = await buildPlatformSession({
    controlDatabaseUrl: appUrl,
    businessDatabaseUrl: businessUrl,
    objectDir,
    identity: launcherIdentity({ runId: RUN_R, sessionId: 'local-r', tenantId: TENANT, spaceId: SPACE }),
    ledgerId: LEDGER_R,
    handlerFactory: (ctx) => [new RemoteToolHandler(ctx, disconnectClient)],
  })
}, 300_000)

afterAll(async () => {
  await clientA?.close().catch(() => undefined)
  await platformRemote?.close().catch(() => undefined)
  await platformB?.close().catch(() => undefined)
  await platformA?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

function dataQueryCall(callId: string, plan: DirectSqlQueryPlan): ToolCall {
  return { callId, toolId: 'data_query', arguments: { kind: 'query', mode: 'direct', queryPlan: plan } }
}

const EQUIVALENT_PLAN = directPlan(
  'SELECT id, customer, amount FROM sales.orders WHERE amount >= $1 ORDER BY id',
  [20],
  declared('sales.orders'),
)

const CONTRACT_PLAN = directPlan(
  'SELECT id, amount FROM sales.orders WHERE amount >= $1 ORDER BY id',
  [10],
  declared('sales.orders'),
)

function budgetPlan(id: number): DirectSqlQueryPlan {
  return directPlan('SELECT id FROM sales.orders WHERE id <= $1 ORDER BY id', [id], declared('sales.orders'))
}

describe('one real data_query is cross-verified on the local and stdio paths', () => {
  it('produces equal results, coverage, schema and logical evidence digest', async () => {
    const plan = EQUIVALENT_PLAN
    const local = await platformA.gateway.invoke(dataQueryCall(randomUUID(), plan), platformA.context)
    const remote = await clientA.invoke(dataQueryCall(randomUUID(), plan), platformA.context)
    expect(local.status).toBe('ok')
    expect(remote.status).toBe('ok')
    expect(remote.inlineData).toEqual(local.inlineData)
    expect(remote.coverage).toEqual(local.coverage)
    expect(remote.schemaRef).toEqual(local.schemaRef)
    expect(remote.domainStatus).toEqual(local.domainStatus)
    expect(remote.sourceSnapshots).toHaveLength(1)
    expect(remote.sourceSnapshots[0]?.resultDigest).toBe(local.sourceSnapshots[0]?.resultDigest)
    expect(logicalEvidenceDigest(remote)).toBe(logicalEvidenceDigest(local))
    // Distinct runs and execution ids are expected; only the logical evidence must match.
    expect(remote.callId).not.toBe(local.callId)
  })

  it('runs the remaining tools through the same adapter contract on both paths', async () => {
    const calls: readonly { readonly label: string; readonly call: (id: string) => ToolCall }[] = [
      {
        label: 'ontology_lookup',
        call: (callId) => ({
          callId,
          toolId: 'ontology_lookup',
          arguments: { scopeRef: SCOPE, intent: 'relations' },
        }),
      },
      {
        label: 'data_query',
        call: (callId) => dataQueryCall(callId, CONTRACT_PLAN),
      },
      {
        label: 'document_search',
        call: (callId) => ({
          callId,
          toolId: 'document_search',
          arguments: { query: 'backup', allowedCollectionRefs: ['home-energy/manuals'], mode: 'keyword' },
        }),
      },
      {
        label: 'web_search',
        call: (callId) => ({
          callId,
          toolId: 'web_search',
          arguments: { query: 'backup power', allowedDomains: ['example.com'] },
        }),
      },
    ]
    for (const { label, call } of calls) {
      const local = await platformA.gateway.invoke(call(randomUUID()), platformA.context)
      const remote = await clientA.invoke(call(randomUUID()), platformA.context)
      expect(remote.status, label).toBe(local.status)
      expect(remote.error, label).toBeUndefined()
      expect(logicalEvidenceDigest(remote), label).toBe(logicalEvidenceDigest(local))
    }
  })

  it('agrees on permission decisions', async () => {
    const forbidden = directPlan(
      'SELECT id FROM sales.orders',
      [],
      [{ sourceRef: { namespace: 'other', sourceId: 'unapproved' }, objectPath: 'sales.orders' }],
    )
    const local = await platformA.gateway.invoke(dataQueryCall(randomUUID(), forbidden), platformA.context)
    const remote = await clientA.invoke(dataQueryCall(randomUUID(), forbidden), platformA.context)
    expect(local.status).toBe('error')
    expect(local.error?.code).toBe('FORBIDDEN')
    expect(remote.status).toBe('error')
    expect(remote.error?.code).toBe(local.error?.code)
  })

  it('agrees on error semantics', async () => {
    const malformed = {
      callId: randomUUID(),
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'direct', queryPlan: { mode: 'direct', sql: 42 } },
    } satisfies ToolCall
    const local = await platformA.gateway.invoke(malformed, platformA.context)
    const remote = await clientA.invoke({ ...malformed, callId: randomUUID() }, platformA.context)
    expect(local.status).toBe('error')
    expect(remote.status).toBe('error')
    expect(remote.error?.code).toBe(local.error?.code)
  })
})

describe('inbound identity comes from the trusted launcher', () => {
  it('uses the launcher tenant and refuses a client-supplied scope', async () => {
    const trusted = await clientA.invoke(
      {
        callId: randomUUID(),
        toolId: 'ontology_lookup',
        arguments: { scopeRef: SCOPE, intent: 'definitions' },
      },
      platformA.context,
    )
    expect(trusted.status).toBe('ok')
    const payload = trusted.inlineData as Record<string, unknown>
    expect(payload.trustedTenant).toBe(TENANT)
    expect(payload.trustedSpace).toBe(SPACE)

    const spoofedScope = await clientA.invoke(
      {
        callId: randomUUID(),
        toolId: 'ontology_lookup',
        arguments: { scopeRef: { tenantId: VICTIM_TENANT, spaceId: VICTIM_SPACE }, intent: 'definitions' },
      },
      platformA.context,
    )
    expect(spoofedScope.status).toBe('error')
    expect(spoofedScope.error?.code).toBe('FORBIDDEN')
    expect(spoofedScope.inlineData).toBeUndefined()

    const spoofedField = await clientA.invoke(
      {
        callId: randomUUID(),
        toolId: 'ontology_lookup',
        arguments: { tenantId: VICTIM_TENANT, scopeRef: SCOPE, intent: 'definitions' },
      },
      platformA.context,
    )
    expect(spoofedField.status).toBe('error')
    expect(spoofedField.error?.code).toBe('INVALID_ARGUMENT')
  })
})

describe('cross-transport retries draw on the same budget', () => {
  it('denies the third call once the shared ledger is exhausted', async () => {
    const first = await platformB.gateway.invoke(dataQueryCall(randomUUID(), budgetPlan(4)), platformB.context)
    expect(first.status).toBe('ok')
    const clientB = await connectPlatformChild(RUN_B, LEDGER_B)
    try {
      const second = await clientB.invoke(dataQueryCall(randomUUID(), budgetPlan(3)), platformB.context)
      expect(second.status).toBe('ok')
      const third = await platformB.gateway.invoke(dataQueryCall(randomUUID(), budgetPlan(2)), platformB.context)
      expect(third.status).toBe('error')
      expect(third.error?.code).toBe('BUDGET_EXHAUSTED')
    } finally {
      await clientB.close().catch(() => undefined)
    }
  }, 60_000)
})

describe('a possibly-billed remote failure settles as usage_unknown', () => {
  it('maps a dropped stdio connection to a remote-state-unknown failure', async () => {
    const result = await platformRemote.gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
      platformRemote.context,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.error?.remoteStateUnknown).toBe(true)
    const row = await budgetRow(LEDGER_R)
    expect(row?.usage_unknown).toBe(true)
  })
})

describe('outbound protocol failures are explicit', () => {
  it('never treats an isError result as data', async () => {
    const client = await connectFixtureChild('is_error')
    try {
      const result = await client.invoke(
        { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
        platformA.context,
      )
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('INTERNAL_ERROR')
      expect(result.inlineData).toBeUndefined()
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  it('maps a JSON-RPC error onto the platform taxonomy', async () => {
    const client = await connectFixtureChild('jsonrpc_error')
    try {
      const result = await client.invoke(
        { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
        platformA.context,
      )
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('INTERNAL_ERROR')
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  it('rejects schema-violating structuredContent', async () => {
    const client = await connectFixtureChild('illegal_structured')
    try {
      const result = await client.invoke(
        { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
        platformA.context,
      )
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('INVALID_SCHEMA')
      expect(result.inlineData).toBeUndefined()
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  it('does not widen the allowlist on list_changed', async () => {
    const client = await connectFixtureChild('list_changed_widen')
    try {
      expect(client.tools.map((tool) => tool.toolId).sort()).toEqual(['data_query', 'ontology_lookup'])
      const before = client.changeCount
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(client.changeCount).toBeGreaterThan(before)
      expect(client.tools.map((tool) => tool.toolId).sort()).toEqual(['data_query', 'ontology_lookup'])
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  it('quarantines a late result after a best-effort cancellation', async () => {
    const client = await connectFixtureChild('late_cancel')
    try {
      const callId = randomUUID()
      const pending = client.invoke(
        { callId, toolId: 'data_query', arguments: { kind: 'describe' } },
        platformA.context,
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      const cancel = await client.cancel(callId, 'user cancelled', platformA.context)
      expect(cancel.state).toBe('unsupported')
      const result = await pending
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
      expect(result.warnings.some((warning) => warning.code === 'ATTEMPT_ABANDONED')).toBe(true)
      expect(result.inlineData).toBeUndefined()
    } finally {
      await client.close().catch(() => undefined)
    }
  })
})

describe('real stdio processes', () => {
  it('ran against a real containerised PostgreSQL and real child processes', async () => {
    const version = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(version.rows[0]?.version).toContain('PostgreSQL')
    expect(clientA.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[mcp-transport] image=${container.image} container=${container.containerName} children=stdio protocol=${MCP_PROTOCOL_VERSION}\n`,
      )
    }
  })
})
