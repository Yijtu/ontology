import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { startWebHost } from './web-host'
import type { WebHost } from './web-host'

/** A normal Core App, with owned PostgreSQL and original bytes; no business outcomes seeded. */
export async function startCoreBrowserHost() {
  let postgres: PostgresContainer | undefined
  let admin: Client | undefined
  let composition: CoreLocalComposition | undefined
  let api: ReturnType<typeof createCoreApi> | undefined
  let web: WebHost | undefined
  const diagnostics: unknown[] = []
  const directory = await mkdtemp(join(tmpdir(), 'ontology-gap22-workspace-'))
  const close = async () => {
    const errors: unknown[] = []
    const stop = async (action: (() => Promise<unknown>) | undefined) => {
      if (action === undefined) return
      try { await action() } catch (error) { errors.push(error) }
    }
    await stop(web === undefined ? undefined : async () => web?.close())
    await stop(api === undefined ? undefined : async () => api?.close())
    await stop(composition === undefined ? undefined : async () => composition?.close())
    await stop(admin === undefined ? undefined : async () => admin?.end())
    await stop(postgres === undefined ? undefined : async () => postgres?.stop())
    await stop(async () => {
      if (!resolve(directory).startsWith(resolve(tmpdir(), 'ontology-gap22-workspace-'))) throw new Error('temporary directory is outside the owned Core host')
      await rm(directory, { recursive: true, force: true })
    })
    if (diagnostics.length > 0 || errors.length > 0) throw new AggregateError([...diagnostics, ...errors], 'Core browser host worker or cleanup failed')
  }
  try {
    postgres = await startPostgresContainer()
    await runControlMigrations({ connectionString: postgres.adminUrl, migrationsDir: fileURLToPath(new URL('../../migrations/control', import.meta.url)) })
    admin = new Client({ connectionString: postgres.adminUrl })
    await admin.connect()
    const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
    await admin.query('INSERT INTO agent_platform.tenants (tenant_id,slug) VALUES ($1,$2)', [scopeRef.tenantId, `workspace-${scopeRef.tenantId}`])
    await admin.query('INSERT INTO agent_platform.spaces (tenant_id,space_id,name) VALUES ($1,$2,$3)', [scopeRef.tenantId, scopeRef.spaceId, 'Browser workspace acceptance'])
    const password = randomUUID().replaceAll('-', '')
    const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [password])
    if (statement.rows[0] === undefined) throw new Error('the owned application role could not be configured')
    await admin.query(statement.rows[0].statement)
    const appUrl = new URL(postgres.adminUrl)
    appUrl.username = 'ontology_app'
    appUrl.password = password
    composition = await createCoreLocalComposition({ databaseUrl: appUrl.toString(), objectDirectory: join(directory, 'objects'), scopeRef,
      examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true, modelsEnabled: false, jevEnabled: false,
      onWorkerError: (error) => diagnostics.push(error) })
    api = createCoreApi(composition.dependencies)
    const origin = await api.listen({ host: '127.0.0.1', port: 0 })
    web = await startWebHost(origin, { bindDefaultProfile: false })
    return { origin: web.origin, close }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Core browser host startup and cleanup failed') }
    throw error
  }
}
