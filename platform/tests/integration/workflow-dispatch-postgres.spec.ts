import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunService } from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresRunStore,
  PostgresWorkflowDispatchStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import type { ProfileRef, PublishedAnswer, ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { createApiServer } from '@ontology/app-api'
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
  it('rejects publication by an expired attempt in the same transaction that validates the current run and lease', async () => {
    if (adminClient === undefined || database === undefined) throw new Error('PostgreSQL clients were not initialised')
    const setup = await createRun('dispatch-publication-fence')
    await adminClient.query(
      `UPDATE agent_platform.runs SET state = 'verifying', revision = '5'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, setup.runId],
    )
    const dispatch = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'verified-answer' }, setup.ctx)
    const firstLease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)
    expect(firstLease?.dispatchId).toBe(dispatch.dispatchId)
    if (firstLease === undefined) throw new Error('the first owner should receive the lease')
    await adminClient.query(
      `UPDATE agent_platform.workflow_dispatches SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, dispatch.dispatchId],
    )
    const currentLease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)
    if (currentLease === undefined) throw new Error('the second owner should reclaim the expired lease')

    const answer: PublishedAnswer = {
      answerId: randomUUID(),
      runId: setup.runId,
      draftId: randomUUID(),
      verificationId: randomUUID(),
      contentHash: PROFILE_HASH,
      evidenceManifestHash: PROFILE_HASH,
      scenarioManifestHash: PROFILE_HASH,
      publicationKind: 'verified',
      limitations: [],
      body: { schemaVersion: 'answer-draft@2', blocks: [], claims: [], assertions: [] },
      publishedAt: new Date().toISOString(),
    }
    const answerStore = new PostgresAnswerStore(database, { requireWorkflowDispatchFence: true })
    await expect(answerStore.record({
      answer,
      expectedRunState: 'verifying',
      expectedRunRevision: '5',
      workflowDispatchFence: {
        dispatchId: firstLease.dispatchId,
        ownerId: firstLease.leaseOwnerId,
        attempt: firstLease.attempt,
        expectedRevision: firstLease.revision,
      },
    }, setup.ctx)).rejects.toMatchObject({ code: 'RUN_NOT_PUBLISHABLE' })

    await expect(answerStore.record({
      answer,
      expectedRunState: 'verifying',
      expectedRunRevision: '5',
      workflowDispatchFence: {
        dispatchId: currentLease.dispatchId,
        ownerId: currentLease.leaseOwnerId,
        attempt: currentLease.attempt,
        expectedRevision: currentLease.revision,
      },
    }, setup.ctx)).resolves.toMatchObject({ answerId: answer.answerId })
  }, 30_000)

  it('accepts a run over the normal HTTP route only after canonical durable enqueue; retry reuses both rows', async () => {
    const tenantId = randomUUID()
    const spaceId = randomUUID()
    const runId = randomUUID()
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    await adminClient.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [tenantId, `http-${tenantId.slice(0, 8)}`])
    await adminClient.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [tenantId, spaceId, 'http-dispatch-space'])
    await adminClient.query(
      `INSERT INTO agent_platform.profile_versions
         (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'workflow-dispatch-http-test')`,
      [tenantId, spaceId, PROFILE.id, PROFILE.version, PROFILE_HASH],
    )
    await adminClient.query(
      `INSERT INTO agent_platform.resolved_profiles
         (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
          resolved_profile, checked_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())`,
      [tenantId, spaceId, PROFILE.id, PROFILE.version, PROFILE_HASH],
    )
    const principal = {
      tenantId,
      subjectId: 'workflow-dispatch-http-owner',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    }
    const app = createApiServer({
      authenticate: () => ({ principal, spaceId }),
      runs: {
        service: runs,
        dispatch: {
          enqueue: (canonicalRunId, logicalActionId, ctx) =>
            dispatches.enqueue({ runId: canonicalRunId, logicalActionId }, ctx),
          cancelRun: async (canonicalRunId, ctx) => { await dispatches.cancelRun(canonicalRunId, ctx) },
        },
      },
    })
    try {
      const request = {
        method: 'POST' as const,
        url: '/api/v1/runs',
        headers: { 'idempotency-key': `normal-http-${runId}` },
        payload: {
          profileRef: PROFILE,
          question: 'Read the currently published asset condition.',
          context: { timeZone: 'UTC', siteRef: 'synthetic-site' },
          preferences: { route: 'template', allowWeb: false },
        },
      }
      const first = await app.inject(request)
      expect(first.statusCode).toBe(202)
      const firstData = first.json<{ data: { runId: string; state: string } }>().data
      expect(firstData.state).toBe('created')
      const second = await app.inject(request)
      expect(second.statusCode).toBe(202)
      const secondData = second.json<{ data: { runId: string } }>().data
      expect(secondData.runId).toBe(firstData.runId)
      const scopedCtx = toolContext(tenantId, spaceId, ['business-user'], principal.subjectId, firstData.runId)
      const dispatch = await dispatches.enqueue({ runId: firstData.runId, logicalActionId: 'initial-drive' }, scopedCtx)
      expect(dispatch.state).toBe('pending')
      expect(dispatch.payload.runId).toBe(firstData.runId)
      const rows = await database?.withIdentityScope({ tenantId, spaceId }, async (client) => {
        const result = await client.query<{ runs: string; dispatches: string }>(
          `SELECT (SELECT count(*)::text FROM agent_platform.runs WHERE run_id = $1::uuid) AS runs,
                  (SELECT count(*)::text FROM agent_platform.workflow_dispatches WHERE run_id = $1::uuid) AS dispatches`,
          [firstData.runId],
        )
        return result.rows[0]
      }, { readOnly: true })
      expect(rows).toEqual({ runs: '1', dispatches: '1' })
    } finally {
      await app.close()
    }
  }, 30_000)

  it('reconciles a persisted create/clarification gap into a durable action with the stored response', async () => {
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    const initial = await createRun('dispatch-reconcile-create')
    await expect(dispatches.reconcileOpenRuns(initial.ctx)).resolves.toBe(0)
    await adminClient.query(
      `UPDATE agent_platform.runs SET updated_at = clock_timestamp() - interval '10 seconds'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [initial.tenantId, initial.spaceId, initial.runId],
    )
    await expect(dispatches.reconcileOpenRuns(initial.ctx)).resolves.toBe(1)
    const initialLease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, initial.ctx)
    expect(initialLease?.logicalActionId).toBe('initial-drive')

    const clarification = await createRun('dispatch-reconcile-response')
    const clarificationId = randomUUID()
    await adminClient.query(
      `UPDATE agent_platform.runs SET state = 'collecting', revision = 6,
         updated_at = clock_timestamp() - interval '10 seconds'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [clarification.tenantId, clarification.spaceId, clarification.runId],
    )
    await adminClient.query(
      `INSERT INTO agent_platform.run_clarification_responses
         (tenant_id, space_id, run_id, clarification_id, typed_response, responded_at, responded_by, revision)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, now(), $6, 6)`,
      [clarification.tenantId, clarification.spaceId, clarification.runId, clarificationId,
        JSON.stringify({ exception: 'confirmed_false' }), 'workflow-dispatch-test-owner'],
    )
    await expect(dispatches.reconcileOpenRuns(clarification.ctx)).resolves.toBe(1)
    const responseLease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, clarification.ctx)
    expect(responseLease).toMatchObject({
      runId: clarification.runId,
      logicalActionId: `clarification-response:${clarificationId}:6`,
      payload: { runId: clarification.runId },
    })
  }, 30_000)

  it('reconciles a committed resume event using its exact checkpoint handle', async () => {
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    const setup = await createRun('dispatch-reconcile-resume')
    const checkpointId = randomUUID()
    await adminClient.query(
      `UPDATE agent_platform.runs SET state = 'blocked', revision = 5
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, setup.runId],
    )
    await runs.saveRuntimeCheckpoint({
      runId: setup.runId,
      checkpointId,
      runtimeKind: RUNTIME_REF.id,
      runtimeVersion: RUNTIME_REF.version,
      stateDigest: RUNTIME_REF.digest,
      payload: new Uint8Array([1, 2, 3]),
    }, setup.ctx)
    const resumed = await runs.resumeRun({
      runId: setup.runId,
      checkpointId,
      runtimeKind: RUNTIME_REF.id,
      runtimeVersion: RUNTIME_REF.version,
      stateDigest: RUNTIME_REF.digest,
      expectedRevision: '5',
    }, setup.ctx)
    expect(resumed.state).toBe('collecting')
    await adminClient.query(
      `UPDATE agent_platform.runs SET updated_at = clock_timestamp() - interval '10 seconds'
       WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [setup.tenantId, setup.spaceId, setup.runId],
    )

    await expect(dispatches.reconcileOpenRuns(setup.ctx)).resolves.toBe(1)
    const lease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)
    expect(lease?.logicalActionId).toBe(`resume:${checkpointId}:6`)
  }, 30_000)

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

  it('revokes every queued or leased action when an authorized run cancellation succeeds', async () => {
    const setup = await createRun('dispatch-cancel-run')
    const leasedAction = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'active-action' }, setup.ctx)
    const pendingAction = await dispatches.enqueue({ runId: setup.runId, logicalActionId: 'pending-action' }, setup.ctx)
    const lease = await dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx)
    expect(lease?.dispatchId).toBe(leasedAction.dispatchId)
    if (lease === undefined) throw new Error('the first action should be leased')

    await expect(dispatches.cancelRun(setup.runId, setup.ctx)).resolves.toBe(2)
    const cancelledLease = await dispatches.get(leasedAction.dispatchId, setup.ctx)
    expect(cancelledLease).toMatchObject({ state: 'cancelled', revision: '3' })
    expect(cancelledLease).not.toHaveProperty('leaseOwnerId')
    await expect(dispatches.get(pendingAction.dispatchId, setup.ctx)).resolves.toMatchObject({
      state: 'cancelled', revision: '2',
    })
    await expect(dispatches.complete({
      dispatchId: lease.dispatchId,
      ownerId: lease.leaseOwnerId,
      attempt: lease.attempt,
      expectedRevision: lease.revision,
    }, setup.ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(dispatches.claimNext({ ownerId: randomUUID(), leaseDurationMs: 5000 }, setup.ctx))
      .resolves.toBeUndefined()
  }, 30_000)
})
