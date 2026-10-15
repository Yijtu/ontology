import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import { MCP_PROTOCOL_VERSION, connectStdioToolClient } from '@ontology/adapter-transport-mcp'
import type { OutboundMcpToolClient, RemoteToolMapping } from '@ontology/adapter-transport-mcp'
import type {
  BudgetPort,
  PlanArgument,
  PlanSpec,
  PlanStep,
  ResourceRef,
  RuntimeAdapter,
  RuntimeDependencies,
  RuntimeEvent,
  ToolCall,
  ToolContext,
  ToolGateway,
  ToolId,
  ToolResult,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
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
import {
  ScriptedGeneration,
  completedEvent,
  events,
  forbiddenDecision,
  piConfig,
  toolCallDelta,
} from '../unit/pi-runtime-fixtures'
import type { ScriptEntry } from '../unit/pi-runtime-fixtures'
import {
  InMemoryCheckpoints,
  StaticPlanResolver,
  collect,
  forbiddenGeneration,
  publishedPlan,
  runtimeInput,
  runtimeManifest,
} from '../unit/template-runtime-fixtures'
import { compareObservations, observeToolResult } from './conformance'
import type { ConformanceObservation } from './conformance'

/**
 * X-09 — the two runtimes × two transports conformance matrix (V03-044, A.US-015.AC-02).
 *
 * X-01 compares Template and Pi on the local in-process gateway; X-02/X-03 compare the local
 * and real stdio MCP paths through the gateway. Neither crosses the two axes. This suite runs
 * ONE commonly-supported task ({@link data_query} against a real PostgreSQL business table,
 * plus the ontology_lookup identity echo) through all four combinations:
 *
 *     {Template, Pi} × {local in-process gateway, real stdio MCP child}
 *
 * Every cell builds the same real `buildPlatformSession` composition (real gateway, real
 * `DataQueryHandler`, real control-plane budget ledger, real immutable evidence archive) and
 * every call reaches it through `ToolGateway.invoke`; the MCP cells spawn a real
 * `@modelcontextprotocol/sdk` stdio server process (`tests/fixtures/mcp/stdio-server.ts`), not
 * a mock RPC. The only substitute anywhere is the model: the Pi runtime is fed a deterministic
 * `ScriptedGeneration` double, so no model is called (marked here, as required).
 *
 * The comparison reuses the shared contract suite (`observeToolResult`/`compareObservations`)
 * so status, error code, canonical columns/rows, coverage, snapshot consistency and the
 * logical evidence digest must agree across all four cells. A mismatch means a runtime or
 * transport re-implemented a result/authorization/error/evidence rule instead of sharing it.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PLATFORM_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STDIO_SERVER = fileURLToPath(new URL('../fixtures/mcp/stdio-server.ts', import.meta.url))
const READ_ONLY_ROLE = `x09_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VALID_SQL = 'SELECT id, customer, amount FROM sales.orders WHERE amount >= $1 ORDER BY id'

type RuntimeKind = 'template' | 'pi'
type TransportKind = 'local' | 'mcp'

interface TaskCase {
  readonly caseId: string
  readonly toolId: ToolId
  /** The exact top-level `data_query`/`ontology_lookup` arguments object. */
  readonly arguments: Readonly<Record<string, unknown>>
}

interface Cell {
  readonly runtime: RuntimeKind
  readonly transport: TransportKind
  readonly runId: string
  readonly ledgerId: string
  readonly session: PlatformSession
  readonly gateway: ToolGateway
  readonly client: OutboundMcpToolClient | undefined
}

interface CellRun {
  readonly caseId: string
  readonly runtime: RuntimeKind
  readonly transport: TransportKind
  readonly observation: ConformanceObservation
  readonly eventTypes: readonly RuntimeEvent['type'][]
  readonly evidenceCount: number
  readonly completionEvidenceCount: number | undefined
  readonly draftAllowed: boolean | undefined
  readonly budgetConsumed: number
}

const MAPPINGS: readonly RemoteToolMapping[] = [
  { toolId: 'data_query', remoteName: 'data_query', definition: dataQueryDefinition() },
  { toolId: 'ontology_lookup', remoteName: 'ontology_lookup', definition: ontologyLookupDefinition() },
  { toolId: 'document_search', remoteName: 'document_search', definition: documentSearchDefinition() },
  { toolId: 'web_search', remoteName: 'web_search', definition: webSearchDefinition() },
]

/** The single canonical task, expressed once as gateway arguments for every cell. */
function queryArguments(queryPlan: unknown): Readonly<Record<string, unknown>> {
  return { kind: 'query', mode: 'direct', queryPlan }
}

const AUTHORIZED_SQL = {
  mode: 'direct',
  statementKind: 'select',
  sql: VALID_SQL,
  parameters: [20],
  referencedObjects: [{ sourceRef: MCP_SOURCE, objectPath: 'sales.orders' }],
  readOnly: true,
}

const FORBIDDEN_SQL = {
  mode: 'direct',
  statementKind: 'select',
  sql: 'SELECT id FROM sales.orders',
  parameters: [],
  referencedObjects: [
    { sourceRef: { namespace: 'other', sourceId: 'unapproved' }, objectPath: 'sales.orders' },
  ],
  readOnly: true,
}

/**
 * A commonly-supported task set: a real authorized read, a schema-valid but unauthorized read,
 * a malformed envelope and the ontology_lookup identity echo. Every runtime can propose every
 * one of them, so the same task is exercised four times over two axes.
 */
const TASKS: readonly TaskCase[] = [
  {
    caseId: 'data-query-authorized',
    toolId: 'data_query',
    arguments: queryArguments(AUTHORIZED_SQL),
  },
  {
    caseId: 'data-query-forbidden',
    toolId: 'data_query',
    arguments: queryArguments(FORBIDDEN_SQL),
  },
  {
    caseId: 'data-query-malformed',
    toolId: 'data_query',
    arguments: queryArguments({ mode: 'direct', sql: 42 }),
  },
  {
    caseId: 'ontology-lookup-identity',
    toolId: 'ontology_lookup',
    arguments: { scopeRef: { tenantId: TENANT, spaceId: SPACE }, intent: 'definitions' },
  },
]

function taskById(caseId: string): TaskCase {
  const task = TASKS.find((entry) => entry.caseId === caseId)
  if (task === undefined) throw new Error(`the ${caseId} task is missing`)
  return task
}

let container: PostgresContainer | undefined
let adminClient: Client
let appUrl = ''
let businessUrl = ''
let objectDir = ''
let cells: readonly Cell[] = []

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

async function spawnStdioClient(
  runId: string,
  ledgerId: string,
  sessionId: string,
): Promise<OutboundMcpToolClient> {
  return connectStdioToolClient({
    command: process.execPath,
    args: ['--import', 'tsx', STDIO_SERVER],
    cwd: PLATFORM_ROOT,
    env: {
      ...baseEnv(),
      MCP_CONTROL_DATABASE_URL: appUrl,
      MCP_BUSINESS_DATABASE_URL: businessUrl,
      MCP_OBJECT_DIR: objectDir,
      MCP_RUN_ID: runId,
      MCP_LEDGER_ID: ledgerId,
      MCP_TENANT_ID: TENANT,
      MCP_SPACE_ID: SPACE,
      MCP_SESSION_ID: sessionId,
    },
    stderr: 'inherit',
    mappings: MAPPINGS,
    validator: createMcpSchemaValidator(),
  })
}

/** Build one real composition cell. The MCP cells additionally spawn a real stdio server. */
async function buildCell(runtime: RuntimeKind, transport: TransportKind): Promise<Cell> {
  const runId = randomUUID()
  const ledgerId = randomUUID()
  const sessionId = `x09-${runtime}-${transport}-${runId.slice(0, 8)}`
  const session = await buildPlatformSession({
    controlDatabaseUrl: appUrl,
    businessDatabaseUrl: businessUrl,
    objectDir,
    identity: launcherIdentity({ runId, sessionId, tenantId: TENANT, spaceId: SPACE }),
    ledgerId,
  })
  if (transport === 'local') {
    return { runtime, transport, runId, ledgerId, session, gateway: session.gateway, client: undefined }
  }
  const client = await spawnStdioClient(runId, ledgerId, sessionId)
  const gateway: ToolGateway = {
    invoke: (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => client.invoke(call, ctx),
    cancel: (callId, reason, ctx) => client.cancel(callId, reason, ctx),
  }
  return { runtime, transport, runId, ledgerId, session, gateway, client }
}

/** Record every `ToolResult` the runtime observes through the gateway. */
function recordGateway(inner: ToolGateway): { readonly gateway: ToolGateway; readonly results: ToolResult[] } {
  const results: ToolResult[] = []
  return {
    gateway: {
      invoke: async (call, ctx) => {
        const result = await inner.invoke(call, ctx)
        results.push(result)
        return result
      },
      cancel: (callId, reason, ctx) => inner.cancel(callId, reason, ctx),
    },
    results,
  }
}

/** A runtime budget projection that only reads the run's shared ledger, never resets it. */
function runtimeBudget(session: PlatformSession, ledgerId: string): BudgetPort {
  return {
    reserve: () => Promise.reject(new Error('the runtime must not reserve budget directly')),
    settle: () => Promise.reject(new Error('the runtime must not settle budget directly')),
    remaining: async () => (await session.budget.remaining(ledgerId, session.context)).remaining,
  }
}

function templatePlan(task: TaskCase): PlanSpec {
  const args: PlanArgument[] = Object.entries(task.arguments).map(([name, value]) => ({
    name,
    required: true,
    source: { kind: 'literal', value },
  }))
  const step: PlanStep = {
    stepId: task.caseId,
    toolId: task.toolId,
    readOnly: true,
    args,
    dependsOn: [],
    failureBehaviour: 'abort',
  }
  return {
    planRef: {
      id: `plan-x09-${task.caseId}`,
      version: '1.0.0',
      digest: sha256DigestOf(`plan-x09-${task.caseId}`),
      kind: 'plan',
    },
    steps: [step],
  }
}

function piScript(task: TaskCase): readonly ScriptEntry[] {
  return [
    events(toolCallDelta(`pi-${task.caseId}`, task.toolId, task.arguments), completedEvent('tool_calls')),
    events(completedEvent('stop')),
  ]
}

function evidenceOf(runtimeEvents: readonly RuntimeEvent[]): ResourceRef[] {
  return runtimeEvents
    .filter((event): event is Extract<RuntimeEvent, { type: 'evidence_added' }> => event.type === 'evidence_added')
    .flatMap((event) => event.evidenceRefs)
}

function completionOf(runtimeEvents: readonly RuntimeEvent[]): Extract<RuntimeEvent, { type: 'collection_complete' }> | undefined {
  return runtimeEvents.find(
    (event): event is Extract<RuntimeEvent, { type: 'collection_complete' }> =>
      event.type === 'collection_complete',
  )
}

/** Run one task through one cell's runtime over that cell's gateway. */
async function runTask(cell: Cell, task: TaskCase): Promise<CellRun> {
  const recorder = recordGateway(cell.gateway)
  const controller = new AbortController()
  const dependencies: RuntimeDependencies = {
    ctx: cell.session.context,
    gateway: recorder.gateway,
    generation:
      cell.runtime === 'pi'
        ? new ScriptedGeneration(piScript(task), { signal: controller.signal })
        : forbiddenGeneration,
    decision: forbiddenDecision,
    checkpoints: new InMemoryCheckpoints(),
    budget: runtimeBudget(cell.session, cell.ledgerId),
    signal: controller.signal,
  }
  const adapter: RuntimeAdapter =
    cell.runtime === 'template'
      ? new TemplateRuntimeAdapter({
          manifest: runtimeManifest(),
          plans: new StaticPlanResolver(publishedPlan(templatePlan(task))),
        })
      : new PiRuntimeAdapter(piConfig({ toolIds: [task.toolId] }))

  const before = (await cell.session.budget.remaining(cell.ledgerId, cell.session.context)).remaining
    .toolCallsRemaining
  const runtimeEvents = await collect(adapter.start(runtimeInput({ runId: cell.runId }), dependencies))
  const after = (await cell.session.budget.remaining(cell.ledgerId, cell.session.context)).remaining
    .toolCallsRemaining

  const result = recorder.results.at(-1)
  if (result === undefined) {
    throw new Error(`the ${task.caseId} task never reached the gateway on ${cell.runtime}/${cell.transport}`)
  }
  const completion = completionOf(runtimeEvents)
  return {
    caseId: task.caseId,
    runtime: cell.runtime,
    transport: cell.transport,
    observation: observeToolResult(result),
    eventTypes: runtimeEvents.map((event) => event.type),
    evidenceCount: evidenceOf(runtimeEvents).length,
    completionEvidenceCount: completion?.evidenceCount,
    draftAllowed: completion?.draftAllowed,
    budgetConsumed: before - after,
  }
}

async function runEveryCell(task: TaskCase): Promise<readonly CellRun[]> {
  const runs: CellRun[] = []
  for (const cell of cells) runs.push(await runTask(cell, task))
  return runs
}

function assertAllObservationsAgree(runs: readonly CellRun[]): void {
  const base = runs[0]
  if (base === undefined) throw new Error('no cell runs were collected')
  for (const run of runs.slice(1)) {
    expect(
      compareObservations(base.observation, run.observation),
      `${run.runtime}/${run.transport} vs ${base.runtime}/${base.transport} on ${base.caseId}`,
    ).toEqual([])
  }
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) container = await startPostgresContainer()
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')
  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'x09-tenant') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'x09-space') ON CONFLICT DO NOTHING`,
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

  const businessDbName = `x09_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
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

  objectDir = await mkdtemp(join(tmpdir(), 'x09-blob-'))

  cells = [
    await buildCell('template', 'local'),
    await buildCell('pi', 'local'),
    await buildCell('template', 'mcp'),
    await buildCell('pi', 'mcp'),
  ]
}, 300_000)

afterAll(async () => {
  for (const cell of cells) await cell.client?.close().catch(() => undefined)
  for (const cell of cells) await cell.session.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('X-09 — Template and Pi conform across the local and real stdio MCP transports', () => {
  it('reaches the same authorized data result on all four runtime/transport cells', async () => {
    const runs = await runEveryCell(taskById('data-query-authorized'))

    // Exactly four cells, all observing one gateway call.
    expect(runs).toHaveLength(4)
    expect(runs.map((run) => `${run.runtime}-${run.transport}`).sort()).toEqual([
      'pi-local',
      'pi-mcp',
      'template-local',
      'template-mcp',
    ])

    assertAllObservationsAgree(runs)

    const base = runs[0]
    if (base === undefined) throw new Error('no runs')
    // The real PostgreSQL rows are identical everywhere, and evidence is archived on both paths.
    expect(base.observation.status).toBe('ok')
    expect(base.observation.rows?.length).toBe(3)
    expect(base.observation.evidenceCount).toBe(1)
    expect(base.observation.logicalEvidenceDigest.length).toBeGreaterThan(0)

    // Same evidence + completion contract through every runtime/transport, one shared call each.
    for (const run of runs) {
      expect(run.evidenceCount, `${run.runtime}/${run.transport}`).toBe(1)
      expect(run.completionEvidenceCount, `${run.runtime}/${run.transport}`).toBe(1)
      expect(run.draftAllowed, `${run.runtime}/${run.transport}`).toBe(true)
      expect(run.budgetConsumed, `${run.runtime}/${run.transport}`).toBe(1)
      expect(run.eventTypes.at(-1), `${run.runtime}/${run.transport}`).toBe('collection_complete')
      expect(run.eventTypes, `${run.runtime}/${run.transport}`).not.toContain('answer_published')
    }
  })

  it('agrees on the forbidden and malformed error contracts on all four cells', async () => {
    for (const caseId of ['data-query-forbidden', 'data-query-malformed']) {
      const runs = await runEveryCell(taskById(caseId))
      assertAllObservationsAgree(runs)
      for (const run of runs) {
        expect(run.observation.status, `${run.runtime}/${run.transport}`).toBe('error')
        expect(run.observation.errorCode, `${run.runtime}/${run.transport}`).toBeTruthy()
      }
    }

    const forbidden = await runEveryCell(taskById('data-query-forbidden'))
    expect(forbidden[0]?.observation.errorCode).toBe('FORBIDDEN')
  })

  it('echoes the same launcher-minted identity through the local and stdio MCP gateways', async () => {
    const runs = await runEveryCell(taskById('ontology-lookup-identity'))
    assertAllObservationsAgree(runs)

    // The digest covers the inline payload the real ContextEchoHandler returned, so equality
    // at the ontology_lookup boundary proves the launcher (not the client) set tenant/space on
    // both the in-process and the child-process composition.
    const base = runs[0]
    if (base === undefined) throw new Error('no runs')
    expect(base.observation.status).toBe('ok')
    for (const run of runs) {
      expect(run.evidenceCount, `${run.runtime}/${run.transport}`).toBe(1)
      expect(run.budgetConsumed, `${run.runtime}/${run.transport}`).toBe(1)
    }
  })

  it('runs a real MCP SDK stdio child and releases it when the client closes', async () => {
    const runId = randomUUID()
    const ledgerId = randomUUID()
    const client = await spawnStdioClient(runId, ledgerId, `x09-cleanup-${runId.slice(0, 8)}`)
    // A real SDK process negotiated the pinned protocol version, not a mock RPC.
    expect(client.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(client.tools.map((tool) => tool.toolId)).toContain('data_query')

    const ctx = cells[0]?.session.context
    if (ctx === undefined) throw new Error('no trusted context is available')
    await client.close()

    // Once closed the child channel is gone, so a late call fails explicitly instead of hanging.
    const result = await client.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
      ctx,
    )
    expect(result.status).toBe('error')
  })
})
