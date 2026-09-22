import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  PostgresJobStore,
  PostgresMaterializationStore,
  PostgresRunStore,
  PostgresSemanticPublicationStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { BudgetService } from '@ontology/core'
import type { ToolContext } from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { toolContext } from '../unit/component-registry-fixtures'

/**
 * One real environment for the whole load/fault harness: a throwaway PostgreSQL container on a
 * unique name and ephemeral loopback port, the control migrations, a tenant with two spaces,
 * the real PostgreSQL-backed stores and the real content-addressed blob store. The load suite
 * reuses this single environment instead of starting a container per fault case.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

export const LOAD_TENANT = randomUUID()
export const LOAD_SPACE = randomUUID()
export const LOAD_CANCEL_SPACE = randomUUID()
export const LOAD_PROFILE = { id: 'load-harness-demo', version: '1.0.0' } as const
export const LOAD_DIGEST = `sha256:${'a'.repeat(64)}`

export interface LoadEnvironment {
  readonly container: PostgresContainer | undefined
  readonly adminUrl: string
  readonly appUrl: string
  readonly adminClient: Client
  readonly objectDir: string
  readonly database: ControlPostgresDatabase
  readonly blobStore: LocalImmutableBlobStore
  readonly evidence: PostgresEvidenceStore
  readonly budget: BudgetService
  readonly jobStore: PostgresJobStore
  readonly runStore: PostgresRunStore
  readonly answerStore: PostgresAnswerStore
  readonly publication: PostgresSemanticPublicationStore
  readonly materialization: PostgresMaterializationStore
  readonly ctx: ToolContext
  readonly cancelCtx: ToolContext
  readonly adapters: readonly string[]
  stop(): Promise<void>
}

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

export async function startLoadEnvironment(): Promise<LoadEnvironment> {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const container = provided === undefined || provided.length === 0 ? await startPostgresContainer() : undefined
  const adminUrl = container?.adminUrl ?? provided ?? ''

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  const adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'load-tenant') ON CONFLICT DO NOTHING`,
    [LOAD_TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'load-space'), ($1, $3, 'load-cancel-space')
     ON CONFLICT DO NOTHING`,
    [LOAD_TENANT, LOAD_SPACE, LOAD_CANCEL_SPACE],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'load-harness')
     ON CONFLICT DO NOTHING`,
    [LOAD_TENANT, LOAD_SPACE, LOAD_PROFILE.id, LOAD_PROFILE.version, LOAD_DIGEST],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [LOAD_TENANT, LOAD_SPACE, LOAD_PROFILE.id, LOAD_PROFILE.version, LOAD_DIGEST],
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

  const objectDir = await mkdtemp(join(tmpdir(), `load-blob-${randomBytes(3).toString('hex')}-`))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 8 })
  const evidence = new PostgresEvidenceStore(database)
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    newId: () => randomUUID(),
  })
  const jobStore = new PostgresJobStore(database)
  const runStore = new PostgresRunStore(database)
  const answerStore = new PostgresAnswerStore(database)
  const publication = new PostgresSemanticPublicationStore(database)
  const materialization = new PostgresMaterializationStore(database)

  const ctx = toolContext(LOAD_TENANT, LOAD_SPACE, ['business-user', 'data-editor', 'platform-admin'], 'load-owner')
  const cancelCtx = toolContext(
    LOAD_TENANT,
    LOAD_CANCEL_SPACE,
    ['business-user', 'data-editor', 'platform-admin'],
    'load-owner',
  )

  return {
    container,
    adminUrl,
    appUrl,
    adminClient,
    objectDir,
    database,
    blobStore,
    evidence,
    budget,
    jobStore,
    runStore,
    answerStore,
    publication,
    materialization,
    ctx,
    cancelCtx,
    adapters: [
      'adapter-control-postgres',
      'adapter-blob-local',
      'adapter-data-duckdb',
      'adapter-transport-mcp',
      'adapter-runtime-template',
    ],
    stop: async () => {
      await database.close().catch(() => undefined)
      await registry.close().catch(() => undefined)
      await adminClient.end().catch(() => undefined)
      await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
      await container?.stop()
    },
  }
}

export interface LoadScope {
  readonly tenantId: string
  readonly spaceId: string
  readonly scopeRef: { readonly tenantId: string; readonly spaceId: string }
  readonly ctx: ToolContext
}

/**
 * A fresh tenant/space for one fault case. The lease reclaimer deliberately claims any expired
 * job in its scope, so a case that leaves a crashed attempt behind must not share a scope with
 * another case.
 */
export async function createLoadScope(env: LoadEnvironment, prefix: string): Promise<LoadScope> {
  const tenantId = randomUUID()
  const spaceId = randomUUID()
  await env.adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)`,
    [tenantId, `${prefix}-${tenantId.slice(0, 8)}`],
  )
  await env.adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)`,
    [tenantId, spaceId, `${prefix}-space`],
  )
  return {
    tenantId,
    spaceId,
    scopeRef: { tenantId, spaceId },
    ctx: toolContext(tenantId, spaceId, ['business-user', 'data-editor', 'platform-admin'], `${prefix}-owner`),
  }
}
