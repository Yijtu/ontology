import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

export const JOB_TENANT_A = '33333333-3333-4333-8333-333333333333'
export const JOB_SPACE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const JOB_TENANT_B = '44444444-4444-4444-8444-444444444444'
export const JOB_SPACE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

export interface JobTestScope {
  readonly tenantId: string
  readonly spaceId: string
  readonly scopeRef: { readonly tenantId: string; readonly spaceId: string }
}

/**
 * A fresh tenant/space for one test. Because the lease reclaimer deliberately claims *any*
 * expired job in its scope, tests that leave a crashed attempt behind must not share a scope
 * with other tests.
 */
export async function createJobScope(adminClient: Client, prefix: string): Promise<JobTestScope> {
  const tenantId = randomUUID()
  const spaceId = randomUUID()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)`,
    [tenantId, `${prefix}-${tenantId.slice(0, 8)}`],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)`,
    [tenantId, spaceId, `${prefix}-space`],
  )
  return { tenantId, spaceId, scopeRef: { tenantId, spaceId } }
}

export interface JobDbHarness {
  readonly container: PostgresContainer | undefined
  readonly adminUrl: string
  readonly appUrl: string
  readonly adminClient: Client
  stop(): Promise<void>
}

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

/**
 * Start a throwaway PostgreSQL database (a unique container unless
 * `CONTROL_TEST_DATABASE_URL` is supplied), apply the control migrations and seed the two
 * job test tenants/spaces. The application role `ontology_app` gets a throwaway password so
 * every store call runs through RLS as a non-owner.
 */
export async function startJobDatabase(): Promise<JobDbHarness> {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  let container: PostgresContainer | undefined
  let adminUrl: string
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  const adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'jobs-tenant-a'), ($2, 'jobs-tenant-b')
     ON CONFLICT DO NOTHING`,
    [JOB_TENANT_A, JOB_TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'jobs-space-a'), ($3, $4, 'jobs-space-b')
     ON CONFLICT DO NOTHING`,
    [JOB_TENANT_A, JOB_SPACE_A, JOB_TENANT_B, JOB_SPACE_B],
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

  return {
    container,
    adminUrl,
    appUrl: connectionStringFor(adminUrl, 'ontology_app', appPassword),
    adminClient,
    stop: async () => {
      await adminClient.end().catch(() => undefined)
      await container?.stop()
    },
  }
}
