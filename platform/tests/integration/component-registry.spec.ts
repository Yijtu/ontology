import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ComponentRegistry, ComponentRegistryError } from '@ontology/application'
import type { ComponentVersionRecord } from '@ontology/application'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
  sha256Digest,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolContext } from '@ontology/contracts'
import type {
  ComponentManifest,
  ModuleLifecycleState,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  DIGEST_A,
  RESERVATION_ID,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  canonicalManifestValidator,
  fixedClock,
  sampleManifest,
} from '../unit/component-registry-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const RUN_A = '33333333-3333-4333-8333-333333333333'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }

function toolContext(
  tenantId: string,
  spaceId: string,
  roles: readonly string[],
  subjectId: string,
): ToolContext {
  return createToolContext({
    principal: { tenantId, subjectId, roles: [...roles], scopes: [], authEpoch: 1 },
    runId: RUN_A,
    resolvedProfileHash: DIGEST_A,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId: RUN_A,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-component-registry-integration',
  })
}

const ADMIN_A = toolContext(TENANT_A, SPACE_A, ['platform-admin'], 'integration-admin')
const ADMIN_B = toolContext(TENANT_B, SPACE_B, ['platform-admin'], 'integration-admin-b')
const RUN_CONTROLLER = toolContext(TENANT_A, SPACE_A, ['run-controller'], 'integration-runner')

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appClient: Client
let objectDir = ''
let controlDatabase: ControlPostgresDatabase
let registry: ComponentRegistry
let blobStore: LocalImmutableBlobStore
let artifactRegistry: PostgresArtifactRegistry

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function withRawScope<T>(
  tenantId: string,
  spaceId: string,
  run: () => Promise<T>,
): Promise<T> {
  await appClient.query('BEGIN')
  try {
    await appClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
      [tenantId, spaceId],
    )
    const result = await run()
    await appClient.query('ROLLBACK')
    return result
  } catch (error) {
    await appClient.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function captureError(run: () => Promise<unknown>): Promise<ComponentRegistryError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ComponentRegistryError) return error
    throw error
  }
  throw new Error('expected the registry call to fail')
}

async function publishArtifact(
  text: string,
  scopeRef: ScopeRef,
  ctx: ToolContext,
): Promise<{ artifactRef: ResourceRef; digest: Sha256Digest }> {
  const content = new TextEncoder().encode(text)
  const digest = sha256Digest(content)
  const staged = await blobStore.stage(content, { scopeRef }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'application/octet-stream',
      byteSize: staged.byteSize,
      purpose: 'artifact',
    },
    ctx,
  )
  return { artifactRef: published.blobRef, digest }
}

interface RegisterOptions {
  readonly content: string
  readonly id?: string
  readonly version?: string
  readonly kind?: ComponentManifest['kind']
  readonly trustStatus?: ComponentManifest['trustStatus']
}

let componentSequence = 0

function nextComponentId(): string {
  componentSequence += 1
  return `component-${componentSequence}`
}

async function registerComponent(
  options: RegisterOptions,
  scopeRef: ScopeRef = SCOPE_A,
  ctx: ToolContext = ADMIN_A,
): Promise<{ record: ComponentVersionRecord; ref: VersionRef; artifactRef: ResourceRef }> {
  const { artifactRef, digest } = await publishArtifact(options.content, scopeRef, ctx)
  const manifest = sampleManifest({
    id: options.id ?? nextComponentId(),
    version: options.version ?? '1.0.0',
    kind: options.kind ?? 'data_backend',
    digest,
    ...(options.trustStatus === undefined ? {} : { trustStatus: options.trustStatus }),
  })
  const record = await registry.register(
    { scopeRef, manifest, artifactRef, source: 'operator' },
    ctx,
  )
  return { record, ref: record.manifestRef, artifactRef }
}

async function advanceTo(
  ref: VersionRef,
  target: ModuleLifecycleState,
  scopeRef: ScopeRef = SCOPE_A,
  ctx: ToolContext = ADMIN_A,
): Promise<void> {
  const order: ModuleLifecycleState[] = ['validated', 'active', 'deprecated', 'retired']
  for (const state of order) {
    await registry.transition({ scopeRef, kind: 'data_backend', ref, to: state }, ctx)
    if (state === target) return
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
     VALUES ($1, 'component-tenant-a'), ($2, 'component-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'component-space-a'), ($3, $4, 'component-space-b')
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

  appClient = new Client({ connectionString: appUrl })
  await appClient.connect()

  objectDir = await mkdtemp(join(tmpdir(), 'component-registry-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  artifactRegistry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry: artifactRegistry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const controlRepository = new ControlPostgresRepository(controlDatabase)
  registry = new ComponentRegistry({
    control: controlRepository,
    store: new PostgresComponentRegistryStore(controlDatabase),
    artifacts: blobStore,
    validator: canonicalManifestValidator(),
    now: fixedClock(),
  })
}, 300_000)

afterAll(async () => {
  await artifactRegistry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await appClient?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('component registry migration', () => {
  it('enables RLS and keeps tenant/space in the primary keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('component_versions', 'component_active_references', 'component_lifecycle_events')
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
            'agent_platform.component_versions',
            'agent_platform.component_active_references',
            'agent_platform.component_lifecycle_events'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.component_versions')).toEqual([
      'tenant_id',
      'space_id',
      'kind',
      'component_id',
      'version',
    ])
    expect(byTable.get('agent_platform.component_active_references')).toEqual([
      'tenant_id',
      'space_id',
      'kind',
      'component_id',
      'version',
      'run_id',
    ])
    expect(byTable.get('agent_platform.component_lifecycle_events')).toEqual([
      'tenant_id',
      'space_id',
      'kind',
      'component_id',
      'version',
      'seq',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('006_component_registry.sql')
  })
})

describe('component registry against real PostgreSQL', () => {
  it('registers a version, reconstructs the lifecycle and appends to the ledger', async () => {
    const { ref } = await registerComponent({ content: 'lifecycle component' })

    const trail = await registry.getAuditTrail({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)
    expect(trail.map((event) => event.toState)).toEqual(['registered'])
    expect(trail[0]?.fromState).toBeNull()
    expect(trail[0]?.actor).toBe('integration-admin')

    await advanceTo(ref, 'retired')
    const fullTrail = await registry.getAuditTrail(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref },
      ADMIN_A,
    )
    expect(fullTrail.map((event) => event.toState)).toEqual([
      'registered',
      'validated',
      'active',
      'deprecated',
      'retired',
    ])

    const ledger = await adminClient.query<{
      recorded_seq: string
      idempotency_key: string
      payload_digest: string
    }>(
      `SELECT recorded_seq, idempotency_key, payload_digest
         FROM agent_platform.semantic_events
        WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3
        ORDER BY recorded_seq`,
      [TENANT_A, SPACE_A, `component:data_backend:${ref.id}@${ref.version}`],
    )
    expect(ledger.rows.map((row) => row.idempotency_key)).toEqual(
      fullTrail.map((event) => event.idempotencyKey),
    )
    expect(ledger.rows.map((row) => row.payload_digest)).toEqual(
      fullTrail.map((event) => event.payloadDigest),
    )
    const sequences = ledger.rows.map((row) => Number(row.recorded_seq))
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('rejects the same id+version with a different digest and never overwrites it', async () => {
    const { ref } = await registerComponent({ content: 'frozen component' })
    const { artifactRef, digest } = await publishArtifact('different content', SCOPE_A, ADMIN_A)
    expect(digest).not.toBe(ref.digest)

    const conflicting = sampleManifest({ id: ref.id, version: ref.version, digest })
    const error = await captureError(() =>
      registry.register(
        { scopeRef: SCOPE_A, manifest: conflicting, artifactRef, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('VERSION_CONFLICT')

    const stored = await registry.getComponent({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)
    expect(stored.manifestRef.digest).toBe(ref.digest)
    const trail = await registry.getAuditTrail({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)
    expect(trail).toHaveLength(1)

    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.component_versions
        WHERE tenant_id = $1 AND space_id = $2 AND kind = 'data_backend' AND component_id = $3 AND version = $4`,
      [TENANT_A, SPACE_A, ref.id, ref.version],
    )
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('treats an identical re-registration as idempotent', async () => {
    const { ref, artifactRef } = await registerComponent({ content: 'idempotent component' })
    const manifest = sampleManifest({ id: ref.id, version: ref.version, digest: ref.digest })
    const replayed = await registry.register(
      { scopeRef: SCOPE_A, manifest, artifactRef, source: 'operator' },
      ADMIN_A,
    )
    expect(replayed.registeredAt).toBe(
      (await registry.getComponent({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)).registeredAt,
    )
    const trail = await registry.getAuditTrail({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)
    expect(trail).toHaveLength(1)
  })

  it('refuses to retire a version referenced by an active run', async () => {
    const { ref } = await registerComponent({ content: 'referenced component' })
    await advanceTo(ref, 'deprecated')

    await registry.acquireActiveReference(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref, runId: RUN_A },
      RUN_CONTROLLER,
    )
    const error = await captureError(() =>
      registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref, to: 'retired' }, ADMIN_A),
    )
    expect(error.code).toBe('ACTIVE_REFERENCE_EXISTS')

    const stillDeprecated = await registry.getComponent(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref },
      ADMIN_A,
    )
    expect(stillDeprecated.lifecycleState).toBe('deprecated')

    await registry.releaseActiveReference(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref, runId: RUN_A },
      RUN_CONTROLLER,
    )
    const retired = await registry.transition(
      { scopeRef: SCOPE_A, kind: 'data_backend', ref, to: 'retired' },
      ADMIN_A,
    )
    expect(retired.lifecycleState).toBe('retired')
  })

  it('rejects illegal transitions and cannot resurrect a retired version', async () => {
    const { ref } = await registerComponent({ content: 'illegal transition component' })
    const skip = await captureError(() =>
      registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref, to: 'active' }, ADMIN_A),
    )
    expect(skip.code).toBe('ILLEGAL_TRANSITION')

    await advanceTo(ref, 'retired')
    const resurrect = await captureError(() =>
      registry.transition({ scopeRef: SCOPE_A, kind: 'data_backend', ref, to: 'active' }, ADMIN_A),
    )
    expect(resurrect.code).toBe('ILLEGAL_TRANSITION')

    const stored = await registry.getComponent({ scopeRef: SCOPE_A, kind: 'data_backend', ref }, ADMIN_A)
    expect(stored.lifecycleState).toBe('retired')
  })

  it('reports an invalid manifest and never persists it', async () => {
    const { artifactRef, digest } = await publishArtifact('invalid manifest artifact', SCOPE_A, ADMIN_A)
    const invalid = sampleManifest({ digest, contractRange: { min: '2.0.0', max: '1.0.0' } })
    const error = await captureError(() =>
      registry.register(
        { scopeRef: SCOPE_A, manifest: invalid, artifactRef, source: 'operator' },
        ADMIN_A,
      ),
    )
    expect(error.code).toBe('INVALID_MANIFEST')
    expect(error.fieldErrors?.some((field) => field.pointer === '/contractRange')).toBe(true)

    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.component_versions
        WHERE tenant_id = $1 AND space_id = $2 AND component_id = $3`,
      [TENANT_A, SPACE_A, invalid.id],
    )
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('refuses to install from an MCP discovery or model output', async () => {
    const { artifactRef, digest } = await publishArtifact('dynamic install artifact', SCOPE_A, ADMIN_A)
    for (const source of ['mcp_discovery', 'model_output'] as const) {
      const manifest = sampleManifest({ id: `dynamic-${source}`, digest })
      const error = await captureError(() =>
        registry.register({ scopeRef: SCOPE_A, manifest, artifactRef, source }, ADMIN_A),
      )
      expect(error.code).toBe('DYNAMIC_INSTALL_FORBIDDEN')
    }
    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.component_versions
        WHERE tenant_id = $1 AND space_id = $2 AND component_id LIKE 'dynamic-%'`,
      [TENANT_A, SPACE_A],
    )
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('keeps registered versions inside the tenant/space boundary', async () => {
    const { ref } = await registerComponent({ content: 'tenant-scoped component' })

    expect(await registry.listComponents(SCOPE_B, {}, ADMIN_B)).toEqual([])
    const crossScope = await captureError(() =>
      registry.getComponent({ scopeRef: SCOPE_B, kind: 'data_backend', ref }, ADMIN_B),
    )
    expect(crossScope.code).toBe('VERSION_NOT_FOUND')

    const hidden = await withRawScope(TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_platform.component_versions WHERE tenant_id = $1',
        [TENANT_A],
      ),
    )
    expect(hidden.rows[0]?.count).toBe('0')

    const unscoped = await appClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.component_versions',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })

  it('refuses registration from a non-admin principal', async () => {
    const { artifactRef, digest } = await publishArtifact('forbidden artifact', SCOPE_A, ADMIN_A)
    const manifest = sampleManifest({ id: 'forbidden-component', digest })
    const error = await captureError(() =>
      registry.register(
        { scopeRef: SCOPE_A, manifest, artifactRef, source: 'operator' },
        RUN_CONTROLLER,
      ),
    )
    expect(error.code).toBe('FORBIDDEN')
  })
})
