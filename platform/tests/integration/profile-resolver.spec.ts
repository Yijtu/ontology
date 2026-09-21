import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
  PostgresProfileStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { InMemoryIndustryManifestSource, ProfileResolver, ProfileResolverError } from '@ontology/application'
import type {
  ComponentKey,
  ComponentLifecycleAudit,
  ComponentVersionRecord,
  ModuleLifecycleState,
  PreflightResult,
  ProfileRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  INDUSTRY_REF,
  SCOPE_A,
  SCOPE_B,
  canonicalProfileValidator,
  fixedClock,
  componentRecord,
  homeEnergyIndustryManifest,
  registeredComponents,
  sampleProfileSpec,
  seedComponents,
  toolContext,
} from '../unit/profile-resolver-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let controlDatabase: ControlPostgresDatabase
let resolver: ProfileResolver
let registryStore: PostgresComponentRegistryStore
let profileStore: PostgresProfileStore

const ADMIN_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'pg-editor-a')
const ADMIN_B: ToolContext = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['profile-editor'], 'pg-editor-b')

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function capture(run: () => Promise<unknown>): Promise<ProfileResolverError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProfileResolverError) return error
    throw error
  }
  throw new Error('expected the profile call to fail')
}

function requireResolved(result: PreflightResult): NonNullable<PreflightResult['resolvedProfile']> {
  if (result.resolvedProfile === undefined) throw new Error('expected a resolved profile')
  return result.resolvedProfile
}

async function requireVersion(key: ComponentKey, scopeRef: ScopeRef, ctx: ToolContext): Promise<ComponentVersionRecord> {
  const record = await registryStore.findVersion(key, scopeRef, ctx)
  if (record === undefined) throw new Error(`component ${key.id}@${key.version} is missing`)
  return record
}

async function transitionComponent(
  scopeRef: ScopeRef,
  key: ComponentKey,
  record: ComponentVersionRecord,
  to: ModuleLifecycleState,
  ctx: ToolContext,
): Promise<void> {
  const audit: ComponentLifecycleAudit = {
    fromState: record.lifecycleState,
    toState: to,
    digest: record.manifestRef.digest,
    payloadDigest: `sha256:${'0'.repeat(64)}`,
    idempotencyKey: `transition:${key.id}:${key.version}:${to}`,
    occurredAt: '2026-09-21T00:05:00Z',
    actor: ctx.principal.subjectId,
  }
  await registryStore.applyTransition(
    scopeRef,
    key,
    record.lifecycleState,
    { ...record, lifecycleState: to },
    audit,
    ctx,
  )
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
     VALUES ($1, 'profile-tenant-a'), ($2, 'profile-tenant-b')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_B.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'profile-space-a'), ($3, $4, 'profile-space-b')
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

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  registryStore = new PostgresComponentRegistryStore(controlDatabase)
  profileStore = new PostgresProfileStore(controlDatabase)

  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())

  resolver = new ProfileResolver({
    control: new ControlPostgresRepository(controlDatabase),
    store: profileStore,
    registry: registryStore,
    industry,
    validator: canonicalProfileValidator(),
    now: fixedClock(),
  })

  // Scope A gets every capability; scope B deliberately omits the telemetry backend so a
  // required-capability gap can be observed against the real database.
  await seedComponents(registryStore, registeredComponents(), SCOPE_A, ADMIN_A)
  await seedComponents(
    registryStore,
    registeredComponents().filter((record) => record.manifestRef.id !== 'data-duckdb'),
    SCOPE_B,
    ADMIN_B,
  )
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('profile composition migration (008)', () => {
  it('enables RLS and keeps tenant/space in the primary keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('profile_versions', 'resolved_profiles', 'active_profiles')
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
            'agent_platform.profile_versions',
            'agent_platform.resolved_profiles',
            'agent_platform.active_profiles'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.profile_versions')).toEqual([
      'tenant_id',
      'space_id',
      'profile_id',
      'version',
    ])
    expect(byTable.get('agent_platform.resolved_profiles')).toEqual([
      'tenant_id',
      'space_id',
      'profile_id',
      'version',
      'snapshot_hash',
    ])
    expect(byTable.get('agent_platform.active_profiles')).toEqual([
      'tenant_id',
      'space_id',
      'profile_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('008_profile_composition.sql')
  })
})

describe('profile resolution against real PostgreSQL', () => {
  it('publishes, resolves every required capability and stores a refs-only manifest', async () => {
    const published = await resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
      ADMIN_A,
    )
    expect(published.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const result = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    expect(result.status).toBe('resolved')
    const resolved = requireResolved(result)
    expect(resolved.resolvedCapabilities.map((capability) => capability.name).sort()).toEqual([
      'compute.home-energy.plan',
      'document_search',
      'structured_query',
      'telemetry_read',
    ])
    expect(resolved.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const stored = await resolver.getResolvedProfile(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: resolved.snapshotHash },
      ADMIN_A,
    )
    expect(stored.resolved.snapshotHash).toBe(resolved.snapshotHash)

    const body = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, resolved.snapshotHash],
    )
    const text = body.rows[0]?.body
    if (text === undefined) throw new Error('the resolved manifest row was not persisted')
    expect(text).not.toContain(SCOPE_A.tenantId)
    expect(text).not.toContain(SCOPE_A.spaceId)
    expect(text).not.toContain('://')
  })

  it('reports a missing required capability per item from the real registry', async () => {
    await resolver.publish(
      { scopeRef: SCOPE_B, profileRef: PROFILE_REF, spec: sampleProfileSpec(), environment: 'local_dev' },
      ADMIN_B,
    )
    const result = await resolver.preflight({ scopeRef: SCOPE_B, profileRef: PROFILE_REF }, ADMIN_B)
    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name)).toEqual(['telemetry_read'])
    expect(result.resolvedProfile).toBeUndefined()
  })

  it('activates with compare-and-set and appends the audit event', async () => {
    const result = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    const snapshotHash = requireResolved(result).snapshotHash

    const missingHeader = await capture(() =>
      resolver.activate({ scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash }, ADMIN_A),
    )
    expect(missingHeader.code).toBe('REVISION_REQUIRED')
    expect(missingHeader.httpStatus).toBe(428)

    const first = await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
      ADMIN_A,
    )
    expect(first.revision).toBe('1')

    const stale = await capture(() =>
      resolver.activate(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: null },
        ADMIN_A,
      ),
    )
    expect(stale.code).toBe('VERSION_CONFLICT')
    expect(stale.httpStatus).toBe(409)

    const second = await resolver.activate(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash, expectedRevision: '1' },
      ADMIN_A,
    )
    expect(second.revision).toBe('2')

    const active = await resolver.getActiveProfile(SCOPE_A, PROFILE_REF.id, ADMIN_A)
    expect(active?.revision).toBe('2')
    expect(active?.snapshotHash).toBe(snapshotHash)

    const events = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.semantic_events
        WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, `profile:${PROFILE_REF.id}`],
    )
    expect(events.rows[0]?.count).toBe('3')
  })

  it('leaves an earlier resolved manifest byte-identical after a newer component version', async () => {
    const before = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    const firstHash = requireResolved(before).snapshotHash
    const beforeRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, firstHash],
    )
    const beforeText = beforeRow.rows[0]?.body
    if (beforeText === undefined) throw new Error('the earlier manifest is missing')

    await seedComponents(
      registryStore,
      [
        componentRecord({
          kind: 'data_backend',
          id: 'data-postgres',
          version: '1.1.0',
          digest: `sha256:${'1'.repeat(64)}`,
          provides: [{ name: 'structured_query', version: '1.1.0' }],
        }),
      ],
      SCOPE_A,
      ADMIN_A,
    )
    const key: ComponentKey = { kind: 'data_backend', id: 'data-postgres', version: '1.0.0' }
    const previous = await requireVersion(key, SCOPE_A, ADMIN_A)
    await transitionComponent(SCOPE_A, key, previous, 'deprecated', ADMIN_A)

    const after = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_A)
    expect(requireResolved(after).snapshotHash).not.toBe(firstHash)

    const afterRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body
         FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, firstHash],
    )
    expect(afterRow.rows[0]?.body).toBe(beforeText)
  })

  it('keeps published versions inside the tenant/space boundary', async () => {
    expect(await resolver.listProfileVersions(SCOPE_B, {}, ADMIN_B)).toHaveLength(1)
    const crossScope = await capture(() =>
      resolver.getProfileVersion({ scopeRef: SCOPE_A, profileRef: PROFILE_REF }, ADMIN_B),
    )
    expect(crossScope.code).toBe('SCOPE_MISMATCH')

    // With no session scope set, RLS hides every tenant row from the application role.
    const unscoped = await controlDatabase.queryUnscoped<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.profile_versions',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })
})
