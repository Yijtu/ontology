import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { runControlMigrations } from '@ontology/adapter-control-postgres'

const controlUrl = process.env['CONTROL_DATABASE_URL']
if (!controlUrl) throw new Error('Set CONTROL_DATABASE_URL to a local PostgreSQL owner connection')
const password = process.env['ONTOLOGY_APP_PASSWORD'] ?? randomBytes(24).toString('base64url')
const tenantId = process.env['ONTOLOGY_TENANT_ID'] ?? '10000000-0000-4000-8000-000000000001'
const spaceId = process.env['ONTOLOGY_SPACE_ID'] ?? '20000000-0000-4000-8000-000000000001'
const migrationsDir = fileURLToPath(new URL('../migrations/control/', import.meta.url))
const READY_TIMEOUT_MS = 30_000

function isStartupConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? error.code : undefined
  return (
    code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
    code === '57P03' || code === '08001' || code === '08006' ||
    /Connection terminated unexpectedly|Connection terminated|the database system is starting up/i.test(error.message)
  )
}

/** First-run init briefly starts and stops PostgreSQL; probe the published TCP endpoint. */
async function waitForControlDatabase(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let waiting = false
  while (true) {
    const probe = new Client({ connectionString: controlUrl, connectionTimeoutMillis: 2_000 })
    try {
      await probe.connect()
      await probe.query('SELECT 1')
      return
    } catch (error) {
      if (!isStartupConnectionError(error)) throw error
      if (Date.now() >= deadline) {
        throw new Error('Local PostgreSQL did not become reachable within 30 seconds. Check docker compose ps/logs and CONTROL_DATABASE_URL.', { cause: error })
      }
      if (!waiting) {
        process.stderr.write('Waiting for local PostgreSQL to finish initialization...\n')
        waiting = true
      }
      await delay(500)
    } finally {
      await probe.end().catch(() => undefined)
    }
  }
}

await waitForControlDatabase()
await runControlMigrations({ connectionString: controlUrl, migrationsDir })

const admin = new Client({ connectionString: controlUrl })
await admin.connect()
try {
  const role = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [password])
  const statement = role.rows[0]?.statement
  if (statement === undefined) throw new Error('could not configure the local application role')
  await admin.query(statement)
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id,slug) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, 'ontology-local-demo'])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id,space_id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,space_id) DO NOTHING', [tenantId, spaceId, 'local-demo'])
} finally {
  await admin.end()
}
const parsed = new URL(controlUrl)
parsed.username = 'ontology_app'
parsed.password = password
const localEnv = resolve('.env.local')
await writeFile(localEnv, `DATABASE_URL=${parsed.toString()}\nONTOLOGY_TENANT_ID=${tenantId}\nONTOLOGY_SPACE_ID=${spaceId}\n`, { mode: 0o600 })
process.stdout.write(`Local PostgreSQL is migrated and scoped. Credentials are stored in ${localEnv}.\n`)
