import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createLocalToolRegistration } from '@ontology/adapter-transport-local'
import { createBlobArtifactWriter, createToolGatewayComposition } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type {
  EvidenceRecord,
  EvidenceStorePort,
  ScopeRef,
  ToolCall,
  ToolContext,
  ToolGateway,
  ToolResult,
} from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { createRunToolGateway, resolveEnabledTools, type RunToolBinding } from '@ontology/tool-services'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  RecordingHandler,
  canonicalToolValidator,
  fullProfile,
  observation,
  operationRegistry,
} from '../unit/tool-gateway-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const LEDGER_FAIL = '99999999-9999-4999-8999-999999999999'
const DIGEST = `sha256:${'a'.repeat(64)}`

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(tenantId: string, spaceId: string, runId: string): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'integration-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [{ namespace: 'ha-anker', sourceId: 'warehouse' }],
      collectionRefs: ['home-energy/manuals'],
      domains: ['example.com'],
      maxRows: 1000,
    },
    traceId: 'trace-tool-gateway-postgres',
  })
}

const CONTEXT_A = toolContext(TENANT_A, SPACE_A, RUN_A)
const CONTEXT_B = toolContext(TENANT_B, SPACE_B, RUN_A)

/** A controlled in-process handler: the real platform path is the point of this suite. */
function lookupHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: {
      items: [{ kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: DIGEST } }],
      gaps: [],
      definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST },
      autoPublished: false,
    },
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

/** Fails the evidence write while delegating reads to the real store. */
class FailingEvidenceStore implements EvidenceStorePort {
  constructor(private readonly inner: PostgresEvidenceStore) {}
  record(): Promise<EvidenceRecord> {
    return Promise.reject(new Error('injected evidence persistence failure'))
  }
  get(scopeRef: ScopeRef, evidenceId: string, ctx: ToolContext): Promise<EvidenceRecord | undefined> {
    return this.inner.get(scopeRef, evidenceId, ctx)
  }
  listByRun(scopeRef: ScopeRef, runId: string, ctx: ToolContext): Promise<EvidenceRecord[]> {
    return this.inner.listByRun(scopeRef, runId, ctx)
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let budget: BudgetService
let evidenceStore: PostgresEvidenceStore
let gateway: ToolGateway
let handler: RecordingHandler

function binding(ledgerId = LEDGER_A): RunToolBinding {
  return {
    runId: RUN_A,
    ledgerId,
    resolvedProfile: fullProfile(),
    operations: operationRegistry(),
  }
}

function lookupCall(): ToolCall {
  return {
    callId: randomUUID(),
    toolId: 'ontology_lookup',
    arguments: { scopeRef: SCOPE_A, intent: 'definitions' },
  }
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'gateway-tenant-a'), ($2, 'gateway-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'gateway-space-a'), ($3, $4, 'gateway-space-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) {
    throw new Error('could not build the application-role login statement')
  }
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'tool-gateway-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  handler = lookupHandler()

  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  })
  gateway = composition.forRun(binding())
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('evidence migration 013', () => {
  it('enables RLS and keeps tenant/space in the evidence primary key', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname = 'evidence_records'
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ columns: string[] }>(
      `SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid = 'agent_platform.evidence_records'::regclass
        GROUP BY c.conrelid`,
    )
    expect(keys.rows[0]?.columns).toEqual(['tenant_id', 'space_id', 'evidence_id'])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('013_evidence_records.sql')
  })
})

describe('real end-to-end tool execution against PostgreSQL and blob-local', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string; current_database: string }>(
      'SELECT version() AS version, current_database() AS current_database',
    )
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[tool-gateway] image=${container.image} container=${container.containerName} database=${result.rows[0]?.current_database ?? ''}\n`,
      )
    }
  })

  it('reserves budget, archives the result and the evidence, and settles', async () => {
    await budget.openLedger(
      { ledgerId: LEDGER_A, kind: 'run', runId: RUN_A, overrideLimits: { maxRows: 1000 } },
      CONTEXT_A,
    )
    const result = await gateway.invoke(lookupCall(), CONTEXT_A)

    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.dataRef?.kind).toBe('artifact')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.sourceSnapshots).toHaveLength(1)
    expect(handler.calls).toHaveLength(1)

    // The result bytes are really in the immutable blob store and authorized in scope.
    const blobRef = result.dataRef
    if (blobRef === undefined) throw new Error('the result carried no dataRef')
    const authorized = await blobStore.getAuthorized({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A)
    expect(authorized.integrityVerified).toBe(true)

    // The evidence envelope is durably recorded and readable in scope.
    const evidenceRef = result.evidenceRefs[0]
    if (evidenceRef === undefined) throw new Error('the result carried no evidenceRef')
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, CONTEXT_A)
    expect(record).toBeDefined()
    expect(record?.evidenceRef.kind).toBe('evidence')
    expect(record?.envelopeDigest).toBe(record?.envelope.integrity.digest)
    expect(record?.envelope.payloadRef?.id).toBe(blobRef.id)
    expect(await evidenceStore.listByRun(SCOPE_A, RUN_A, CONTEXT_A)).toHaveLength(1)

    // The budget reservation is settled with the persisted evidence reference.
    const reservation = await adminClient.query<{ status: string; evidence_refs: unknown[] }>(
      `SELECT status, evidence_refs
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_A, SPACE_A, LEDGER_A],
    )
    expect(reservation.rows[0]?.status).toBe('settled')
    expect(reservation.rows[0]?.evidence_refs).toHaveLength(1)

    const ledger = await adminClient.query<{ tool_calls_consumed: number }>(
      `SELECT tool_calls_consumed
         FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_A, SPACE_A, LEDGER_A],
    )
    expect(ledger.rows[0]?.tool_calls_consumed).toBe(1)
  })

  it('records a persisted tool intent before execution', async () => {
    const intents = await adminClient.query<{ tool_id: string; attempt: number }>(
      `SELECT tool_id, attempt
         FROM agent_platform.tool_intents
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3
        ORDER BY recorded_at ASC`,
      [TENANT_A, SPACE_A, LEDGER_A],
    )
    expect(intents.rows.length).toBeGreaterThanOrEqual(1)
    expect(intents.rows[0]?.tool_id).toBe('ontology_lookup')
    expect(intents.rows[0]?.attempt).toBe(1)
  })

  it('hides another tenant evidence row (real RLS)', async () => {
    const anyRecord = await evidenceStore.listByRun(SCOPE_A, RUN_A, CONTEXT_A)
    const evidenceId = anyRecord[0]?.evidenceRef.id
    if (evidenceId === undefined) throw new Error('no evidence recorded')
    expect(await evidenceStore.get(SCOPE_B, evidenceId, CONTEXT_B)).toBeUndefined()
  })

  it('never returns a traceable success when the evidence cannot be persisted', async () => {
    await budget.openLedger({ ledgerId: LEDGER_FAIL, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const failingGateway = createRunToolGateway(
      {
        validator: canonicalToolValidator(),
        budget,
        evidence: new FailingEvidenceStore(evidenceStore),
        artifacts: createBlobArtifactWriter(blobStore),
        handlers: [handler],
      },
      binding(LEDGER_FAIL),
    )

    const result = await failingGateway.invoke(lookupCall(), CONTEXT_A)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('EVIDENCE_PERSIST_FAILED')
    expect(result.evidenceRefs).toEqual([])

    const reservation = await adminClient.query<{ status: string }>(
      `SELECT status
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_A, SPACE_A, LEDGER_FAIL],
    )
    expect(reservation.rows[0]?.status).toBe('failed')

    const evidenceRows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.evidence_records
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [TENANT_A, SPACE_A, RUN_A],
    )
    // Only the successful call from the earlier test is recorded; the failed one added none.
    expect(evidenceRows.rows[0]?.count).toBe('1')
  })
})

describe('local transport registration against the real gateway', () => {
  it('registers the four tools and routes invocation through the restricted closure', async () => {
    await budget.openLedger({ ledgerId: LEDGER_A, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const registration = createLocalToolRegistration({
      tools: resolveEnabledTools(fullProfile()).map((entry) => entry.definition),
      gateway,
    })
    expect(registration.tools).toHaveLength(4)
    expect(Object.keys(registration.dependencies.gateway).sort()).toEqual(['cancel', 'invoke'])

    const result: ToolResult = await registration.dependencies.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'ontology_lookup',
        arguments: { scopeRef: SCOPE_A, intent: 'relations' },
      },
      CONTEXT_A,
    )
    expect(result.status).toBe('ok')
    expect(result.evidenceRefs).toHaveLength(1)
  })
})
