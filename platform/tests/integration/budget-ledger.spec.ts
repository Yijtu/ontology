import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { BudgetService } from '@ontology/core'
import type {
  AtomicReserveOutcome,
  BudgetReservationRecord,
  ResourceRef,
  ToolContext,
} from '@ontology/contracts'
import { RUN_B } from '../unit/component-registry-fixtures'
import { RUN_A, SCOPE_A, SCOPE_B, toolContext } from '../unit/profile-resolver-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const INTEGRATION_NOW = '2026-09-21T00:00:00Z'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let database: ControlPostgresDatabase
let service: BudgetService

const CONTEXT_A: ToolContext = toolContext(
  SCOPE_A.tenantId,
  SCOPE_A.spaceId,
  ['business-user'],
  'owner-a',
  RUN_A,
)
const CONTEXT_B: ToolContext = toolContext(
  SCOPE_B.tenantId,
  SCOPE_B.spaceId,
  ['business-user'],
  'owner-b',
  RUN_B,
)

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const databaseName = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${databaseName}`
}

function requireReservation(outcome: AtomicReserveOutcome): BudgetReservationRecord {
  if (outcome.reservation === undefined) throw new Error('the reservation was not granted')
  return outcome.reservation
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
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
     VALUES ($1, 'budget-tenant-a'), ($2, 'budget-tenant-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_B.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'budget-space-a'), ($3, $4, 'budget-space-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, SCOPE_B.tenantId, SCOPE_B.spaceId],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 32 })
  const store = new PostgresBudgetLedgerStore(database)
  const control = new ControlPostgresRepository(database)
  service = new BudgetService({
    store,
    control,
    now: () => INTEGRATION_NOW,
    newId: () => randomUUID(),
  })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('budget migration 011', () => {
  it('enables RLS and keeps tenant/space in every primary key', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('budget_ledgers', 'budget_reservations', 'tool_intents')
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const keys = await adminClient.query<{ table_name: string; columns: string[] }>(
      `SELECT c.conrelid::regclass::text AS table_name,
              array_agg(a.attname ORDER BY k.ord)::text[] AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.connamespace = 'agent_platform'::regnamespace
          AND c.contype = 'p'
          AND c.conrelid::regclass::text IN (
            'agent_platform.budget_ledgers',
            'agent_platform.budget_reservations',
            'agent_platform.tool_intents'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.budget_ledgers')).toEqual(['tenant_id', 'space_id', 'ledger_id'])
    expect(byTable.get('agent_platform.budget_reservations')).toEqual([
      'tenant_id',
      'space_id',
      'ledger_id',
      'reservation_id',
    ])
    expect(byTable.get('agent_platform.tool_intents')).toEqual([
      'tenant_id',
      'space_id',
      'ledger_id',
      'intent_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('011_budget_ledger.sql')
  })

  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string; current_database: string }>(
      'SELECT version() AS version, current_database() AS current_database',
    )
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[budget-ledger] image=${container.image} container=${container.containerName} database=${result.rows[0]?.current_database ?? ''}\n`,
      )
    }
  })
})

describe('real-PostgreSQL reservation contention', () => {
  it('grants exactly the allowance when 24 parallel reservations contend for 8 slots', async () => {
    const ledgerId = randomUUID()
    await service.openLedger(
      { ledgerId, kind: 'run', overrideLimits: { maxToolCalls: 8 }, runId: RUN_A },
      CONTEXT_A,
    )

    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        service.reserve({ ledgerId, idempotencyKey: `pg-contend-${String(index).padStart(4, '0')}` }, CONTEXT_A),
      ),
    )
    const granted = outcomes.filter((outcome) => outcome.granted)
    const denied = outcomes.filter((outcome) => !outcome.granted)
    expect(granted).toHaveLength(8)
    expect(denied).toHaveLength(16)
    expect(denied.every((outcome) => outcome.denial?.code === 'BUDGET_EXHAUSTED')).toBe(true)

    const ledgerRow = await adminClient.query<{ tool_calls_consumed: number }>(
      `SELECT tool_calls_consumed
         FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId],
    )
    expect(ledgerRow.rows[0]?.tool_calls_consumed).toBe(8)

    const reservations = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId],
    )
    expect(reservations.rows[0]?.count).toBe('8')
    expect((await service.remaining(ledgerId, CONTEXT_A)).remaining.toolCallsRemaining).toBe(0)
  })

  it('never oversubscribes the parallel-tool limit under concurrency', async () => {
    const ledgerId = randomUUID()
    await service.openLedger(
      { ledgerId, kind: 'run', overrideLimits: { maxParallelTools: 2 }, runId: RUN_A },
      CONTEXT_A,
    )
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.reserve(
          {
            ledgerId,
            idempotencyKey: `pg-parallel-${String(index).padStart(4, '0')}`,
            parallel: true,
          },
          CONTEXT_A,
        ),
      ),
    )
    const granted = outcomes.filter((outcome) => outcome.granted)
    expect(granted).toHaveLength(2)
    expect(
      outcomes.filter((outcome) => !outcome.granted).every((outcome) => outcome.denial?.code === 'RATE_LIMITED'),
    ).toBe(true)
  })
})

describe('real-PostgreSQL settlement semantics', () => {
  it('settles a reservation idempotently without double counting', async () => {
    const ledgerId = randomUUID()
    await service.openLedger(
      { ledgerId, kind: 'run', overrideLimits: { maxRows: 1_000 }, runId: RUN_A },
      CONTEXT_A,
    )
    const reservation = requireReservation(
      await service.reserve({ ledgerId, idempotencyKey: 'pg-settle-dup-0001', rows: 300 }, CONTEXT_A),
    )
    const settlement = {
      ledgerId,
      reservationId: reservation.reservationId,
      status: 'completed' as const,
      usage: { durationMs: 5, rows: 120 },
      evidenceRefs: [evidenceRef()],
    }
    expect((await service.settle(settlement, CONTEXT_A)).applied).toBe(true)
    expect((await service.settle(settlement, CONTEXT_A)).applied).toBe(false)

    const rows = await adminClient.query<{ rows_consumed: string }>(
      `SELECT rows_consumed
         FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId],
    )
    expect(rows.rows[0]?.rows_consumed).toBe('120')
    expect((await service.remaining(ledgerId, CONTEXT_A)).rowsRemaining).toBe(880)
  })

  it('holds a possibly billed call as usage_unknown and never frees it', async () => {
    const ledgerId = randomUUID()
    await service.openLedger(
      { ledgerId, kind: 'run', overrideLimits: { maxRows: 1_000 }, runId: RUN_A },
      CONTEXT_A,
    )
    const reservation = requireReservation(
      await service.reserve({ ledgerId, idempotencyKey: 'pg-unknown-0001', rows: 500 }, CONTEXT_A),
    )
    await service.settle(
      {
        ledgerId,
        reservationId: reservation.reservationId,
        status: 'usage_unknown',
        usage: { durationMs: 200, usageUnknown: true },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )

    const row = await adminClient.query<{
      reserved_rows: string
      actual_rows: string | null
      usage_unknown: boolean
      status: string
    }>(
      `SELECT reserved_rows, actual_rows, usage_unknown, status
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3 AND reservation_id = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId, reservation.reservationId],
    )
    expect(row.rows[0]?.reserved_rows).toBe('500')
    // usage_unknown holds the full estimate as the charged amount instead of
    // releasing it as free allowance.
    expect(row.rows[0]?.actual_rows).toBe('500')
    expect(row.rows[0]?.usage_unknown).toBe(true)
    expect(row.rows[0]?.status).toBe('usage_unknown')

    const over = await service.reserve(
      { ledgerId, idempotencyKey: 'pg-unknown-0002', rows: 600 },
      CONTEXT_A,
    )
    expect(over.granted).toBe(false)
    expect(over.denial?.code).toBe('BUDGET_EXHAUSTED')

    await service.settle(
      {
        ledgerId,
        reservationId: reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 200, rows: 20 },
        evidenceRefs: [evidenceRef()],
      },
      CONTEXT_A,
    )
    expect((await service.remaining(ledgerId, CONTEXT_A)).rowsRemaining).toBe(980)
  })

  it('detects a duplicate tool intent as NO_PROGRESS in the database', async () => {
    const ledgerId = randomUUID()
    await service.openLedger({ ledgerId, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const digest = `sha256:${'d'.repeat(64)}`
    const first = requireReservation(
      await service.reserve(
        { ledgerId, idempotencyKey: 'pg-dedupe-0001', requiresIntent: true },
        CONTEXT_A,
      ),
    )
    await service.recordIntent(
      {
        ledgerId,
        reservationId: first.reservationId,
        intentId: randomUUID(),
        descriptor: { callId: randomUUID(), toolId: 'data_query', argumentsDigest: digest, attempt: 1 },
      },
      CONTEXT_A,
    )
    const second = requireReservation(
      await service.reserve(
        { ledgerId, idempotencyKey: 'pg-dedupe-0002', requiresIntent: true },
        CONTEXT_A,
      ),
    )
    await expect(
      service.recordIntent(
        {
          ledgerId,
          reservationId: second.reservationId,
          intentId: randomUUID(),
          descriptor: { callId: randomUUID(), toolId: 'data_query', argumentsDigest: digest, attempt: 1 },
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'NO_PROGRESS' })
  })

  it('requires a persisted intent before settling a tool reservation', async () => {
    const ledgerId = randomUUID()
    await service.openLedger({ ledgerId, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reservation = requireReservation(
      await service.reserve(
        { ledgerId, idempotencyKey: 'pg-intent-0001', requiresIntent: true },
        CONTEXT_A,
      ),
    )
    await expect(
      service.settle(
        {
          ledgerId,
          reservationId: reservation.reservationId,
          status: 'failed',
          usage: { durationMs: 1 },
          evidenceRefs: [],
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_RECORDED' })

    await service.recordIntent(
      {
        ledgerId,
        reservationId: reservation.reservationId,
        intentId: randomUUID(),
        descriptor: {
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDigest: `sha256:${'c'.repeat(64)}`,
          attempt: 1,
        },
      },
      CONTEXT_A,
    )
    const settled = await service.settle(
      {
        ledgerId,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 1 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    expect(settled.reservation.status).toBe('failed')
  })
})

describe('real-PostgreSQL quota separation and isolation', () => {
  it('keeps background and online quotas separate', async () => {
    const backgroundId = randomUUID()
    const onlineId = randomUUID()
    await service.openLedger(
      { ledgerId: backgroundId, kind: 'background', overrideLimits: { maxToolCalls: 2 } },
      CONTEXT_A,
    )
    await service.openLedger({ ledgerId: onlineId, kind: 'run', runId: RUN_A }, CONTEXT_A)

    await service.reserve({ ledgerId: backgroundId, idempotencyKey: 'pg-bg-0001' }, CONTEXT_A)
    await service.reserve({ ledgerId: backgroundId, idempotencyKey: 'pg-bg-0002' }, CONTEXT_A)
    const denied = await service.reserve(
      { ledgerId: backgroundId, idempotencyKey: 'pg-bg-0003' },
      CONTEXT_A,
    )
    expect(denied.granted).toBe(false)

    const online = await service.reserve(
      { ledgerId: onlineId, idempotencyKey: 'pg-online-0001' },
      CONTEXT_A,
    )
    expect(online.granted).toBe(true)
    expect((await service.remaining(onlineId, CONTEXT_A)).remaining.toolCallsRemaining).toBe(7)
  })

  it('hides a ledger from another tenant/space', async () => {
    const ledgerId = randomUUID()
    await service.openLedger({ ledgerId, kind: 'run', runId: RUN_A }, CONTEXT_A)
    await expect(
      service.reserve({ ledgerId, idempotencyKey: 'pg-cross-scope-0001' }, CONTEXT_B),
    ).rejects.toMatchObject({ code: 'LEDGER_NOT_FOUND' })
  })

  it('persists the propagated child deadline and the audit stream', async () => {
    const ledgerId = randomUUID()
    await service.openLedger({ ledgerId, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const ledger = await service.remaining(ledgerId, CONTEXT_A)
    const reservation = requireReservation(
      await service.reserve(
        {
          ledgerId,
          idempotencyKey: 'pg-deadline-0001',
          requestedDeadline: '2030-01-01T00:00:00Z',
        },
        CONTEXT_A,
      ),
    )
    expect(reservation.deadline).toBe(ledger.deadline)

    const row = await adminClient.query<{ deadline: Date; expires_at: Date }>(
      `SELECT deadline, expires_at
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3 AND reservation_id = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId, reservation.reservationId],
    )
    expect(row.rows[0]?.deadline.toISOString()).toBe(ledger.deadline)
    expect(row.rows[0]?.expires_at.toISOString()).toBe(ledger.deadline)

    await service.settle(
      {
        ledgerId,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 1 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    const events = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.semantic_events
        WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, `budget:${ledgerId}`],
    )
    expect(events.rows[0]?.count).toBe('2')
  })
})
