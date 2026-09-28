import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunService } from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresDecisionStateReferenceStore,
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  createToolContext,
} from '@ontology/contracts'
import type {
  DecisionStateReferenceRecord,
  ProfileRef,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`
const OTHER_PROFILE_HASH: Sha256Digest = `sha256:${'b'.repeat(64)}`
const RUNTIME_REF: VersionRef = {
  id: 'runtime-template',
  version: '1.0.0',
  digest: `sha256:${'c'.repeat(64)}`,
}
const FIXED_NOW = '2026-09-28T00:00:00Z'

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

interface CanonicalRun {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
  readonly runId: Uuid
  readonly profileRef: ProfileRef
  readonly ctx: ToolContext
}

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const databaseName = base.pathname.replace(/^\//u, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${databaseName}`
}

function contextFor(input: {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
  readonly runId: Uuid
  readonly subjectId: string
  readonly resolvedProfileHash?: Sha256Digest
}): ToolContext {
  return createToolContext({
    principal: {
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      roles: ['business-user', 'platform-admin'],
      scopes: ['control:read', 'control:write', 'tool:invoke'],
      authEpoch: 1,
    },
    runId: input.runId,
    resolvedProfileHash: input.resolvedProfileHash ?? PROFILE_HASH,
    policyVersion: '1.0.0',
    deadline: '2099-12-31T23:59:59Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: input.runId,
      grantedAt: FIXED_NOW,
      expiresAt: '2099-12-31T23:59:59Z',
    },
    allowedResources: {
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      resourceKinds: ['run', 'artifact'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: `trace-decision-state-${input.runId}`,
  })
}

function scopeOf(run: CanonicalRun): ScopeRef {
  return { tenantId: run.tenantId, spaceId: run.spaceId }
}

function stateArtifactRef(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return {
    id: randomUUID(),
    version: '1.0.0',
    digest: `sha256:${'d'.repeat(64)}`,
    kind: 'artifact',
    ...overrides,
  }
}

function registrationOf(run: CanonicalRun, stateRef: ResourceRef): DecisionStateReferenceRecord {
  return {
    runId: run.runId,
    resolvedProfileHash: PROFILE_HASH,
    stateRef,
    registeredAt: FIXED_NOW,
  }
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let database: ControlPostgresDatabase | undefined
let runs: RunService
let stateReferences: PostgresDecisionStateReferenceStore

async function createCanonicalRun(prefix: string): Promise<CanonicalRun> {
  if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
  const tenantId = randomUUID()
  const spaceId = randomUUID()
  const runId = randomUUID()
  const profileRef: ProfileRef = { id: `${prefix}-profile`, version: '1.0.0' }
  await adminClient.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [
    tenantId,
    `${prefix}-${tenantId.slice(0, 8)}`,
  ])
  await adminClient.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [
    tenantId,
    spaceId,
    `${prefix}-space`,
  ])
  // These immutable binding rows are fixture setup; the run itself is always created
  // through RunService so its canonical ID and locked profile are produced normally.
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'decision-state-reference-test')`,
    [tenantId, spaceId, profileRef.id, profileRef.version, PROFILE_HASH],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())`,
    [tenantId, spaceId, profileRef.id, profileRef.version, PROFILE_HASH],
  )

  const ctx = contextFor({ tenantId, spaceId, runId, subjectId: `${prefix}-owner` })
  const created = await runs.createRun({
    runId,
    profileRef,
    question: `synthetic decision-state test ${prefix}`,
    context: { timeZone: 'UTC', siteRef: 'synthetic-demo-site' },
    preferences: { route: 'template', allowWeb: false },
    idempotencyKey: `decision-state-${prefix}-${runId}`,
  }, ctx)
  expect(created.runId).toBe(runId)
  expect(created.reused).toBe(false)
  expect(created.resolvedProfileHash).toBe(PROFILE_HASH)
  const view = await runs.getRun(runId, ctx)
  expect(view.profileRef).toEqual(profileRef)
  expect(view.resolvedProfileHash).toBe(PROFILE_HASH)
  return { tenantId, spaceId, runId, profileRef, ctx }
}

beforeAll(async () => {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  adminClient = new Client({ connectionString: container.adminUrl })
  await adminClient.connect()
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const alter = await adminClient.query<{ readonly statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const statement = alter.rows[0]?.statement
  if (statement === undefined) throw new Error('could not configure the application login')
  await adminClient.query(statement)
  database = new ControlPostgresDatabase({
    connectionString: connectionStringFor(container.adminUrl, 'ontology_app', appPassword),
    maxPoolSize: 6,
  })
  const control = new ControlPostgresRepository(database)
  runs = new RunService({ store: new PostgresRunStore(database), control, profiles: new TestProfileBinder() })
  stateReferences = new PostgresDecisionStateReferenceStore(database)
}, 120_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('PostgresDecisionStateReferenceStore (migration 056)', () => {
  it('binds the exact ref to a canonical run/profile, replays identical content and enforces RLS', async () => {
    if (adminClient === undefined || database === undefined) throw new Error('PostgreSQL clients were not initialised')
    const role = await adminClient.query<{ readonly rol_super: boolean; readonly rol_bypassrls: boolean }>(
      `SELECT rolsuper AS rol_super, rolbypassrls AS rol_bypassrls
         FROM pg_roles WHERE rolname = 'ontology_app'`,
    )
    expect(role.rows[0]).toEqual({ rol_super: false, rol_bypassrls: false })

    const owner = await createCanonicalRun('decision-state-owner')
    const otherTenant = await createCanonicalRun('decision-state-other')
    const stateRef = stateArtifactRef()
    const original = registrationOf(owner, stateRef)
    const registered = await stateReferences.register(scopeOf(owner), original, owner.ctx)
    expect(registered).toMatchObject({
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef,
      registeredAt: `${FIXED_NOW.slice(0, -1)}.000Z`,
    })
    await expect(stateReferences.register(scopeOf(owner), {
      ...original,
      runId: randomUUID(),
    }, owner.ctx)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })

    const replay = await stateReferences.register(
      scopeOf(owner),
      { ...original, registeredAt: '2026-09-28T00:00:05Z' },
      owner.ctx,
    )
    expect(replay).toEqual(registered)
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef,
    }, owner.ctx)).resolves.toBe(true)

    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef: { ...stateRef, version: '1.0.1' },
    }, owner.ctx)).resolves.toBe(false)
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef: { ...stateRef, digest: `sha256:${'e'.repeat(64)}` },
    }, owner.ctx)).resolves.toBe(false)
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef: { ...stateRef, kind: 'document' },
    }, owner.ctx)).resolves.toBe(false)

    const otherContextRef = await stateReferences.isApproved(scopeOf(otherTenant), {
      runId: otherTenant.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef,
    }, otherTenant.ctx)
    expect(otherContextRef).toBe(false)
    const rlsRows = await database.withIdentityScope(scopeOf(otherTenant), (client) =>
      client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM agent_platform.decision_state_refs WHERE state_ref_id = $1::uuid`,
        [stateRef.id],
      ),
    )
    expect(rlsRows.rows[0]?.count).toBe('0')
    const unscopedRows = await database.queryUnscoped<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.decision_state_refs WHERE state_ref_id = $1::uuid`,
      [stateRef.id],
    )
    expect(unscopedRows.rows[0]?.count).toBe('0')

    const conflictRef = { ...stateRef, digest: `sha256:${'f'.repeat(64)}` }
    await expect(stateReferences.register(scopeOf(owner), registrationOf(owner, conflictRef), owner.ctx))
      .rejects.toMatchObject({ code: 'STATE_REFERENCE_CONFLICT' })
    const wrongProfileCtx = contextFor({
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      runId: owner.runId,
      subjectId: owner.ctx.principal.subjectId,
      resolvedProfileHash: OTHER_PROFILE_HASH,
    })
    await expect(stateReferences.register(scopeOf(owner), {
      ...registrationOf(owner, stateArtifactRef()),
      resolvedProfileHash: OTHER_PROFILE_HASH,
    }, wrongProfileCtx)).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' })
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: OTHER_PROFILE_HASH,
      stateRef,
    }, wrongProfileCtx)).resolves.toBe(false)

    const counts = await adminClient.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.decision_state_refs
        WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [owner.tenantId, owner.spaceId, owner.runId],
    )
    expect(counts.rows[0]?.count).toBe('1')
  }, 30_000)

  it('rejects registration and approval after RunService cancels the canonical run', async () => {
    const owner = await createCanonicalRun('decision-state-cancelled')
    const stateRef = stateArtifactRef()
    await stateReferences.register(scopeOf(owner), registrationOf(owner, stateRef), owner.ctx)
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef,
    }, owner.ctx)).resolves.toBe(true)

    const current = await runs.getRun(owner.runId, owner.ctx)
    const cancelled = await runs.cancelRun({
      runId: owner.runId,
      reason: 'integration cancellation fence',
      expectedRevision: current.revision,
    }, owner.ctx)
    expect(cancelled.state).toBe('cancelled')

    await expect(stateReferences.register(scopeOf(owner), registrationOf(owner, stateArtifactRef()), owner.ctx))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(stateReferences.isApproved(scopeOf(owner), {
      runId: owner.runId,
      resolvedProfileHash: PROFILE_HASH,
      stateRef,
    }, owner.ctx)).resolves.toBe(false)
  }, 30_000)

  it('rejects an empty JSON ref with SQLSTATE 23514 instead of accepting CHECK UNKNOWN', async () => {
    if (adminClient === undefined) throw new Error('admin PostgreSQL client was not initialised')
    const owner = await createCanonicalRun('decision-state-check-null')
    const ref = stateArtifactRef()
    await expect(adminClient.query(
      `INSERT INTO agent_platform.decision_state_refs
         (tenant_id, space_id, run_id, resolved_profile_hash, state_ref_id, state_ref_version,
          state_ref_digest, state_ref_kind, state_ref, registered_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, 'artifact', '{}'::jsonb, $8::timestamptz)`,
      [owner.tenantId, owner.spaceId, owner.runId, PROFILE_HASH, ref.id, ref.version, ref.digest, FIXED_NOW],
    )).rejects.toMatchObject({ code: '23514', constraint: 'decision_state_refs_ref_shape' })
  }, 30_000)
})
