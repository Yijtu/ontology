import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunService } from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresRunStore,
  PostgresWorkflowDispatchStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import type { ProfileRef, ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE: ProfileRef = { id: 'dispatch-test-profile', version: '1.0.0' }
const PROFILE_HASH = `sha256:${'a'.repeat(64)}`
const RUNTIME_REF: VersionRef = {
  id: 'runtime-template',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
}

class TestProfileBinder implements RunProfileBinder {
  bindProfileForRun(profileRef: ProfileRef): Promise<RunProfileBinding> {
    return Promise.resolve({
      profileRef,
      resolvedProfileHash: PROFILE_HASH,
      resolvedProfileRef: { ...profileRef, snapshotHash: PROFILE_HASH },
      runtimeRef: RUNTIME_REF,
    })
  }
}

interface DispatchRun {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
  readonly runId: Uuid
  readonly ctx: ToolContext
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let database: ControlPostgresDatabase | undefined
let runs: RunService
let dispatches: PostgresWorkflowDispatchStore

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const databaseName = base.pathname.replace(/^\//u, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${databaseName}`
}

async function createRun(prefix: string): Promise<DispatchRun> {
  if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
  const tenantId = randomUUID()
  const spaceId = randomUUID()
  const runId = randomUUID()
  await adminClient.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [
    tenantId,
    `${prefix}-${tenantId.slice(0, 8)}`,
  ])
  await adminClient.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [
    tenantId,
    spaceId,
    `${prefix}-space`,
  ])
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'workflow-dispatch-test')`,
    [tenantId, spaceId, PROFILE.id, PROFILE.version, PROFILE_HASH],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())`,
    [tenantId, spaceId, PROFILE.id, PROFILE.version, PROFILE_HASH],
  )

  const ctx = toolContext(tenantId, spaceId, ['operator'], 'workflow-dispatch-test-owner', runId)
  const created = await runs.createRun(
    {
      runId,
      profileRef: PROFILE,
      question: `dispatch integration run ${prefix}`,
      context: { timeZone: 'UTC', siteRef: 'dispatch-test-site' },
      preferences: { route: 'template', allowWeb: false },
      idempotencyKey: `dispatch-test-${runId}`,
    },
    ctx,
  )
  expect(created.runId).toBe(runId)
  expect(created.reused).toBe(false)
  return { tenantId, spaceId, runId, ctx }
}

beforeAll(async () => {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  adminClient = new Client({ connectionString: container.adminUrl })
  await adminClient.connect()
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not configure the application login')
  await adminClient.query(alterStatement)
  database = new ControlPostgresDatabase({
    connectionString: connectionStringFor(container.adminUrl, 'ontology_app', appPassword),
    maxPoolSize: 6,
  })
  const control = new ControlPostgresRepository(database)
  runs = new RunService({ store: new PostgresRunStore(database), control, profiles: new TestProfileBinder() })
  dispatches = new PostgresWorkflowDispatchStore(database)
}, 120_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('PostgresWorkflowDispatchStore (migration 054, scoped durable leases)', () => {
  it('persists the actual run reference, deduplicates a logical drive, and allows a later logical action', async () => {
    const setup = await createRun('dispatch-idempotency')
    const logicalActionId = 'initial-drive'
    const beforeLedgers = await database?.withIdentityScope(
      { tenantId: setup.tenantId, spaceId: setup.spaceId },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM agent_platform.budget_ledgers WHERE run_id = $1::uuid',
          [setup.runId],
        )
        return result.rows[0]?.count
      },
      { readOnly: true },
    )
    const first = await dispatches.enqueue({ runId: setup.runId, logicalActionId }, setup.ctx)
    const repeated = await dispatches.enqueue({ runId: setup.runId, logicalActionId }, setup.ctx)
    const resumed = await dispatches.enqueue(
      { runId: setup.runId, logicalActionId: 'clarification-response-1' },
      setup.ctx,
    )

    expect(first).toMatchObject({
      runId: setup.runId,
      actionKind: 'drive_run',
      logicalActionId,
      payload: { runId: setup.runId },
      state: 'pending',
      attempt: '0',
      revision: '1',
    })
    expect(first.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(first.payloadDigest).toBe(`sha256:${createHash('sha256')
      .update(JSON.stringify({ runId: setup.runId.toLowerCase() }), 'utf8')
      .digest('hex')}`)
    expect(repeated.dispatchId).toBe(first.dispatchId)
    expect(repeated.createdAt).toBe(first.createdAt)
    expect(resumed.dispatchId).not.toBe(first.dispatchId)
    await expect(dispatches.get(first.dispatchId, setup.ctx)).resolves.toEqual(first)

    const otherScope = toolContext(randomUUID(), randomUUID(), ['operator'], 'other-tenant', randomUUID())
    await expect(dispatches.get(first.dispatchId, otherScope)).resolves.toBeUndefined()
    const unscoped = await database?.queryUnscoped<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.workflow_dispatches',
    )
    expect(unscoped?.rows[0]?.count).toBe('0')

    const afterLedgers = await database?.withIdentityScope(
      { tenantId: setup.tenantId, spaceId: setup.spaceId },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM agent_platform.budget_ledgers WHERE run_id = $1::uuid',
          [setup.runId],
        )
        return result.rows[0]?.count
      },
      { readOnly: true },
    )
    expect(afterLedgers).toBe(beforeLedgers)
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    await adminClient.query(
      `UPDATE agent_platform.workflow_dispatches
       SET payload_digest = $4
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, first.dispatchId, `sha256:${'c'.repeat(64)}`],
    )
    await expect(dispatches.get(first.dispatchId, setup.ctx)).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  }, 30_000)

  it('claims with SKIP LOCKED and fences renew, completion, and host cancellation by revision', async () => {
    const setup = await createRun('dispatch-competition')
    const first = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'drive-a' }, setup.ctx)
    const second = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'drive-b' }, setup.ctx)
    const ownerA = randomUUID()
    const ownerB = randomUUID()
    const [leaseA, leaseB] = await Promise.all([
      dispatches.claimNext({ ownerId: ownerA, leaseDurationMs: 5000 }, setup.ctx),
      dispatches.claimNext({ ownerId: ownerB, leaseDurationMs: 5000 }, setup.ctx),
    ])

    expect(leaseA).toBeDefined()
    expect(leaseB).toBeDefined()
    if (leaseA === undefined || leaseB === undefined) throw new Error('both owners should claim one dispatch')
    expect(new Set([leaseA.dispatchId, leaseB.dispatchId])).toEqual(new Set([first.dispatchId, second.dispatchId]))
    expect(leaseA.attempt).toBe('1')
    expect(leaseA.revision).toBe('2')

    const renewed = await dispatches.renew({
      dispatchId: leaseA.dispatchId,
      ownerId: leaseA.leaseOwnerId,
      attempt: leaseA.attempt,
      expectedRevision: leaseA.revision,
      leaseDurationMs: 5000,
    }, setup.ctx)
    await expect(dispatches.complete({
      dispatchId: leaseA.dispatchId,
      ownerId: leaseA.leaseOwnerId,
      attempt: leaseA.attempt,
      expectedRevision: leaseA.revision,
    }, setup.ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const completed = await dispatches.complete({
      dispatchId: renewed.dispatchId,
      ownerId: renewed.leaseOwnerId,
      attempt: renewed.attempt,
      expectedRevision: renewed.revision,
    }, setup.ctx)
    expect(completed.state).toBe('completed')
    expect(completed.revision).toBe('4')

    const cancelLease = leaseA.dispatchId === first.dispatchId ? leaseB : leaseA
    const cancelled = await dispatches.cancel({
      dispatchId: cancelLease.dispatchId,
      expectedRevision: cancelLease.revision,
    }, setup.ctx)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.leaseOwnerId).toBeUndefined()
    await expect(dispatches.complete({
      dispatchId: cancelLease.dispatchId,
      ownerId: cancelLease.leaseOwnerId,
      attempt: cancelLease.attempt,
      expectedRevision: cancelLease.revision,
    }, setup.ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)).resolves.toBeUndefined()
  }, 30_000)

  it('reclaims an expired lease as a new attempt and rejects the previous fence', async () => {
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    const setup = await createRun('dispatch-expiry')
    const pending = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'expiring-drive' }, setup.ctx)
    const ownerA = randomUUID()
    const ownerB = randomUUID()
    const oldLease = await dispatches.claimNext({ ownerId: ownerA, leaseDurationMs: 5000 }, setup.ctx)
    expect(oldLease?.dispatchId).toBe(pending.dispatchId)
    if (oldLease === undefined) throw new Error('first owner should claim the dispatch')
    await adminClient.query(
      `UPDATE agent_platform.workflow_dispatches
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, pending.dispatchId],
    )
    await expect(dispatches.renew({
      dispatchId: oldLease.dispatchId,
      ownerId: oldLease.leaseOwnerId,
      attempt: oldLease.attempt,
      expectedRevision: oldLease.revision,
      leaseDurationMs: 5000,
    }, setup.ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' })

    const newLease = await dispatches.claimNext({ ownerId: ownerB, leaseDurationMs: 5000 }, setup.ctx)
    expect(newLease).toMatchObject({ dispatchId: pending.dispatchId, attempt: '2', revision: '3' })
    if (newLease === undefined) throw new Error('second owner should reclaim the expired dispatch')
    await expect(dispatches.complete({
      dispatchId: oldLease.dispatchId,
      ownerId: oldLease.leaseOwnerId,
      attempt: oldLease.attempt,
      expectedRevision: oldLease.revision,
    }, setup.ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const failed = await dispatches.fail({
      dispatchId: newLease.dispatchId,
      ownerId: newLease.leaseOwnerId,
      attempt: newLease.attempt,
      expectedRevision: newLease.revision,
      failureCode: 'runtime_failed',
    }, setup.ctx)
    expect(failed).toMatchObject({ state: 'failed', failureCode: 'runtime_failed', revision: '4' })
    await expect(dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)).resolves.toBeUndefined()
  }, 30_000)

  it('cancels pending work and keeps invalid failed rows out of the durable state machine', async () => {
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    const setup = await createRun('dispatch-cancel')
    const pending = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'cancel-before-claim' }, setup.ctx)
    const cancelled = await dispatches.cancel({ dispatchId: pending.dispatchId, expectedRevision: pending.revision }, setup.ctx)
    expect(cancelled).toMatchObject({ state: 'cancelled', revision: '2' })
    await expect(dispatches.cancel({ dispatchId: pending.dispatchId, expectedRevision: pending.revision }, setup.ctx))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)).resolves.toBeUndefined()

    await expect(adminClient.query(
      `UPDATE agent_platform.workflow_dispatches SET state = 'failed'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, pending.dispatchId],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(dispatches.enqueue({ runId: randomUUID(), logicalActionId: 'missing-run' }, setup.ctx))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 999 }, setup.ctx))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }, 30_000)
})
