import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, runControlMigrations } from '@ontology/adapter-control-postgres'
import {
  LegacyResearchInFlightError,
  assertLegacyResearchDrained,
  createCoreLocalComposition,
  emptyCoreExamples,
  inspectLegacyResearchDrain,
} from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * S11 acceptance: before the retired-chain build accepts traffic, the drain check must prove no
 * request-carrying research job is still in flight. It covers a queued/running job, an effective
 * lease, a recoverable checkpoint and unreconciled usage, while a historical record that has already
 * collected its material and is waiting for a human is preserved (and never blocks the upgrade).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `drain_${randomUUID().replaceAll('-', '')}`
const COUNTS = '{"total":1,"processed":0,"failed":0,"skipped":0}'

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let database: ControlPostgresDatabase | undefined
const tempDirs: string[] = []

async function insertScope(name: string): Promise<ScopeRef> {
  const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin!.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `${name}-${scopeRef.tenantId.slice(0, 8)}`])
  await admin!.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, name])
  return scopeRef
}

interface JobInput {
  readonly scope: ScopeRef
  readonly version?: string
  readonly stage?: string
  readonly seed?: string
}

async function insertJob(input: JobInput): Promise<string> {
  const jobId = randomUUID()
  const version = input.version ?? '1.0.0'
  const stage = input.stage ?? 'received'
  const digest = `sha256:${(input.seed ?? randomUUID()).replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`
  await admin!.query(
    `INSERT INTO agent_platform.jobs
       (tenant_id, space_id, job_id, kind, source_ref, dataset_ref, pipeline_version, stage,
        idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'research', 'workbench.research', $4, $5, $6,
        $7, $8, 1, $9::jsonb, now(), now(), 'drain-test', now())`,
    [input.scope.tenantId, input.scope.spaceId, jobId, `drain-job:${jobId}`, version, stage,
      `drain-idem-${jobId.replaceAll('-', '')}`, digest, COUNTS],
  )
  return jobId
}

async function insertLease(scope: ScopeRef, jobId: string): Promise<void> {
  await admin!.query(
    `INSERT INTO agent_platform.job_attempts
       (tenant_id, space_id, job_id, attempt_id, attempt_number, state, stage, lease_expires_at, created_at)
     VALUES ($1, $2, $3, $4, 1, 'leased', 'received', now() + interval '1 hour', now())`,
    [scope.tenantId, scope.spaceId, jobId, randomUUID()],
  )
}

async function insertCheckpoint(scope: ScopeRef, jobId: string): Promise<void> {
  await admin!.query(
    `INSERT INTO agent_platform.job_stage_checkpoints
       (tenant_id, space_id, job_id, stage, attempt_id, counts, created_at)
     VALUES ($1, $2, $3, 'received', $4, '{}'::jsonb, now())`,
    [scope.tenantId, scope.spaceId, jobId, randomUUID()],
  )
}

async function insertUnreconciledUsage(scope: ScopeRef, jobId: string): Promise<void> {
  const reservationId = randomUUID()
  await admin!.query(
    `INSERT INTO agent_platform.budget_ledgers
       (tenant_id, space_id, ledger_id, kind, limits, deadline, created_at, updated_at)
     VALUES ($1, $2, $3, 'background', '{}'::jsonb, now() + interval '1 hour', now(), now())`,
    [scope.tenantId, scope.spaceId, jobId],
  )
  await admin!.query(
    `INSERT INTO agent_platform.budget_reservations
       (tenant_id, space_id, ledger_id, reservation_id, idempotency_key, status, deadline, granted_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'reserved', now() + interval '1 hour', now(), now() + interval '1 hour')`,
    [scope.tenantId, scope.spaceId, jobId, reservationId, `drain-res-${reservationId.replaceAll('-', '')}`],
  )
}

function reasonsOf(report: { readonly findings: readonly { readonly reason: string }[] }): readonly string[] {
  return [...new Set(report.findings.map((finding) => finding.reason))]
}

beforeAll(async () => {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 2 })
}, 240_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('legacy research drain check (real PostgreSQL)', () => {
  it('reports a still-queued request-carrying job and blocks host startup', async () => {
    const scope = await insertScope('drain-queued')
    const jobId = await insertJob({ scope })

    const report = await inspectLegacyResearchDrain(database!, scope)
    expect(report.drained).toBe(false)
    expect(reasonsOf(report)).toContain('queued_or_running_job')
    expect(report.findings.every((finding) => finding.jobId === jobId)).toBe(true)

    await expect(assertLegacyResearchDrained(database!, scope)).rejects.toMatchObject({ code: 'LEGACY_RESEARCH_IN_FLIGHT' })

    const objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-drain-'))
    tempDirs.push(objectDirectory)
    await expect(createCoreLocalComposition({
      databaseUrl: appUrl,
      objectDirectory,
      scopeRef: scope,
      examples: emptyCoreExamples(),
    })).rejects.toBeInstanceOf(LegacyResearchInFlightError)

    // Drained: the job reaches a stop stage, so it is no longer in flight. A later start succeeds.
    await admin!.query("UPDATE agent_platform.jobs SET stage = 'awaiting_review' WHERE job_id = $1::uuid", [jobId])
    const drained = await inspectLegacyResearchDrain(database!, scope)
    expect(drained.drained).toBe(true)
    const composition = await createCoreLocalComposition({
      databaseUrl: appUrl,
      objectDirectory,
      scopeRef: scope,
      examples: emptyCoreExamples(),
    })
    await composition.close()
  }, 180_000)

  it('detects an effective lease, a recoverable checkpoint and unreconciled usage', async () => {
    const scope = await insertScope('drain-signals')
    const jobId = await insertJob({ scope, version: '1.1.0' })
    await insertLease(scope, jobId)
    await insertCheckpoint(scope, jobId)
    await insertUnreconciledUsage(scope, jobId)

    const report = await inspectLegacyResearchDrain(database!, scope)
    expect(report.drained).toBe(false)
    expect(reasonsOf(report)).toEqual(expect.arrayContaining([
      'queued_or_running_job', 'effective_lease', 'recoverable_checkpoint', 'unreconciled_usage',
    ]))
  }, 120_000)

  it('does not treat an already-collected, waiting-for-human record as in flight', async () => {
    const scope = await insertScope('drain-waiting')
    const jobId = await insertJob({ scope, stage: 'awaiting_review', version: '1.0.0' })
    await insertCheckpoint(scope, jobId)
    // A settled reservation is reconciled, not held.
    const reservationId = randomUUID()
    await admin!.query(
      `INSERT INTO agent_platform.budget_ledgers
         (tenant_id, space_id, ledger_id, kind, limits, deadline, created_at, updated_at)
       VALUES ($1, $2, $3, 'background', '{}'::jsonb, now() + interval '1 hour', now(), now())`,
      [scope.tenantId, scope.spaceId, jobId],
    )
    await admin!.query(
      `INSERT INTO agent_platform.budget_reservations
         (tenant_id, space_id, ledger_id, reservation_id, idempotency_key, status, deadline, granted_at, expires_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, 'settled', now() + interval '1 hour', now(), now() + interval '1 hour', now())`,
      [scope.tenantId, scope.spaceId, jobId, reservationId, `drain-res-${reservationId.replaceAll('-', '')}`],
    )

    const report = await inspectLegacyResearchDrain(database!, scope)
    expect(report.drained).toBe(true)
    await expect(assertLegacyResearchDrained(database!, scope)).resolves.toBeUndefined()
  }, 120_000)
})
