import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresSemanticDefinitionStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import type { ScopeRef } from '@ontology/contracts'
import { SemanticDefinitionError, SemanticDefinitionService } from '@ontology/semantic-engine'
import {
  DATA_REF_ID,
  NAMESPACE,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  dataRef,
  fixedClock,
  sampleCoreDraft,
  sampleExtensionDraft,
  toolContext,
} from '../unit/semantic-definition-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appClient: Client
let controlDatabase: ControlPostgresDatabase
let service: SemanticDefinitionService

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function withRawScope<T>(tenantId: string, spaceId: string, run: () => Promise<T>): Promise<T> {
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

async function captureError(run: () => Promise<unknown>): Promise<SemanticDefinitionError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SemanticDefinitionError) return error
    throw error
  }
  throw new Error('expected the definition call to fail')
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
     VALUES ($1, 'semantic-tenant-a'), ($2, 'semantic-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'semantic-space-a'), ($3, $4, 'semantic-space-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
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

  appClient = new Client({ connectionString: appUrl })
  await appClient.connect()

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const controlRepository = new ControlPostgresRepository(controlDatabase)
  service = new SemanticDefinitionService({
    control: controlRepository,
    store: new PostgresSemanticDefinitionStore(controlDatabase),
    now: fixedClock(),
  })
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await appClient?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

const ADMIN_A = toolContext(TENANT_A, SPACE_A, ['platform-admin'], 'semantic-admin')
const ADMIN_B = toolContext(TENANT_B, SPACE_B, ['platform-admin'], 'semantic-admin-b')

describe('semantic definition migration', () => {
  it('enables RLS and keeps tenant/space in the primary keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN (
            'semantic_definition_versions',
            'semantic_definition_events',
            'semantic_definition_bindings'
          )
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
            'agent_platform.semantic_definition_versions',
            'agent_platform.semantic_definition_events',
            'agent_platform.semantic_definition_bindings'
          )
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.semantic_definition_versions')).toEqual([
      'tenant_id',
      'space_id',
      'namespace',
      'definition_id',
      'version',
    ])
    expect(byTable.get('agent_platform.semantic_definition_events')).toEqual([
      'tenant_id',
      'space_id',
      'namespace',
      'definition_id',
      'version',
      'seq',
    ])
    expect(byTable.get('agent_platform.semantic_definition_bindings')).toEqual([
      'tenant_id',
      'space_id',
      'data_ref_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('007_semantic_definitions.sql')
  })
})

describe('semantic definitions against real PostgreSQL', () => {
  it('publishes a valid version, resolves it and appends the ledger event', async () => {
    const draft = sampleCoreDraft({ definitionId: 'home-energy.pg-valid', version: '1.0.0' })
    const published = await service.publish(draft, ADMIN_A)
    expect(published.ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const stored = await service.getVersion(
      { scopeRef: SCOPE_A, namespace: NAMESPACE, definitionId: 'home-energy.pg-valid', version: '1.0.0' },
      ADMIN_A,
    )
    expect(stored.ref.digest).toBe(published.ref.digest)
    expect(stored.attributes).toHaveLength(6)

    const trail = await service.getAuditTrail(SCOPE_A, 'home-energy.pg-valid', ADMIN_A)
    expect(trail.map((event) => event.seq)).toEqual([1])
    expect(trail[0]?.actor).toBe('semantic-admin')

    const ledger = await adminClient.query<{ recorded_seq: string; payload_digest: string }>(
      `SELECT recorded_seq, payload_digest
         FROM agent_platform.semantic_events
        WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3
        ORDER BY recorded_seq`,
      [TENANT_A, SPACE_A, `definition:${NAMESPACE}:home-energy.pg-valid@1.0.0`],
    )
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]?.payload_digest).toBe(trail[0]?.payloadDigest)
  })

  it('stores no tenant id, URL, credential or SDK field in the declaration body', async () => {
    const draft = sampleCoreDraft({ definitionId: 'home-energy.pg-purity', version: '1.0.0' })
    await service.publish(draft, ADMIN_A)

    const row = await adminClient.query<{ definition: string }>(
      `SELECT definition::text AS definition
         FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = 'home-energy.pg-purity'`,
      [TENANT_A, SPACE_A],
    )
    const body = row.rows[0]?.definition
    if (body === undefined) throw new Error('the definition row was not persisted')
    expect(body).not.toContain(TENANT_A)
    expect(body).not.toContain(SPACE_A)
    expect(body).not.toContain('://')
    expect(body.toLowerCase()).not.toContain('connectionstring')
    expect(body.toLowerCase()).not.toContain('sdk')
  })

  it('refuses an illegal reference and persists nothing', async () => {
    const invalid = sampleCoreDraft({
      definitionId: 'home-energy.pg-invalid',
      version: '1.0.0',
      ruleConstraints: [
        {
          kind: 'rule_constraint',
          id: 'dangling',
          namespace: NAMESPACE,
          objectId: 'device',
          severity: 'hard',
          expression: { op: 'compare', attributeId: 'missing_attribute', operator: 'eq', value: 1 },
          standardProvenance: [
            {
              standardRef: { id: 'iec-61851-1', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
              provenanceKind: 'international_standard',
            },
          ],
        },
      ],
    })
    const error = await captureError(() => service.publish(invalid, ADMIN_A))
    expect(error.code).toBe('INVALID_DEFINITION')
    expect(error.issues?.some((issue) => issue.code === 'RULE_REFERENCE_UNKNOWN')).toBe(true)

    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = 'home-energy.pg-invalid'`,
      [TENANT_A, SPACE_A],
    )
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('keeps data bound to v1 after v2 is published', async () => {
    const v1 = await service.publish(
      sampleCoreDraft({ definitionId: 'home-energy.pg-versioned', version: '1.0.0' }),
      ADMIN_A,
    )
    await service.bindData(
      { scopeRef: SCOPE_A, dataRef: dataRef(), namespace: NAMESPACE, definitionRef: v1.ref },
      ADMIN_A,
    )

    const power = sampleCoreDraft().attributes.find((attribute) => attribute.id === 'rated_power')
    if (power === undefined) throw new Error('fixture is missing rated_power')
    const v2 = await service.publish(
      sampleCoreDraft({
        definitionId: 'home-energy.pg-versioned',
        version: '2.0.0',
        baseRef: v1.ref,
        attributes: sampleCoreDraft().attributes.map((attribute) =>
          attribute.id === 'rated_power' ? { ...attribute, unit: { unitCode: 'W', dimension: 'power' } } : attribute,
        ),
      }),
      ADMIN_A,
    )
    expect(v2.ref.digest).not.toBe(v1.ref.digest)

    const resolved = await service.resolveDataDefinition({ scopeRef: SCOPE_A, dataRefId: DATA_REF_ID }, ADMIN_A)
    expect(resolved.version.ref).toEqual(v1.ref)
    expect(
      resolved.version.attributes.find((attribute) => attribute.id === 'rated_power')?.unit?.unitCode,
    ).toBe('kW')

    const rebind = await captureError(() =>
      service.bindData(
        { scopeRef: SCOPE_A, dataRef: dataRef(), namespace: NAMESPACE, definitionRef: v2.ref },
        ADMIN_A,
      ),
    )
    expect(rebind.code).toBe('BINDING_CONFLICT')
  })

  it('isolates a customer extension from the industry core it builds on', async () => {
    const core = await service.publish(
      sampleCoreDraft({ definitionId: 'home-energy.pg-core', version: '1.0.0' }),
      ADMIN_A,
    )
    const extension = await service.publish(sampleExtensionDraft(core.ref), ADMIN_A)
    expect(extension.baseRef).toEqual(core.ref)
    expect(extension.layer).toBe('customer_extension')

    const shadow = await captureError(() =>
      service.publish(
        sampleCoreDraft({
          definitionId: 'home-energy.pg-shadow',
          layer: 'customer_extension',
          baseRef: core.ref,
          objects: [],
          attributes: [
            {
              kind: 'attribute',
              id: 'rated_power',
              namespace: NAMESPACE,
              objectId: 'device',
              valueType: 'quantity',
              cardinality: { min: 0, max: 1 },
              unit: { unitCode: 'W', dimension: 'power' },
              standardProvenance: sampleCoreDraft().standardProvenance,
            },
          ],
          relations: [],
          identityScopes: [],
          ruleConstraints: [],
        }),
        ADMIN_A,
      ),
    )
    expect(shadow.issues?.some((issue) => issue.code === 'CORE_SHADOWING_FORBIDDEN')).toBe(true)

    const rows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = 'home-energy.pg-shadow'`,
      [TENANT_A, SPACE_A],
    )
    expect(rows.rows[0]?.count).toBe('0')
  })

  it('keeps published versions inside the tenant/space boundary', async () => {
    await service.publish(
      sampleCoreDraft({ definitionId: 'home-energy.pg-scoped', version: '1.0.0' }),
      ADMIN_A,
    )

    expect(await service.listVersions(SCOPE_B, {}, ADMIN_B)).toEqual([])
    const crossScope = await captureError(() =>
      service.getVersion(
        { scopeRef: SCOPE_B, namespace: NAMESPACE, definitionId: 'home-energy.pg-scoped', version: '1.0.0' },
        ADMIN_B,
      ),
    )
    expect(crossScope.code).toBe('DEFINITION_NOT_FOUND')

    const hidden = await withRawScope(TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions
          WHERE tenant_id = $1 AND definition_id = 'home-energy.pg-scoped'`,
        [TENANT_A],
      ),
    )
    expect(hidden.rows[0]?.count).toBe('0')

    const unscoped = await appClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })

  it('refuses publication from a non-publisher principal', async () => {
    const runner = toolContext(TENANT_A, SPACE_A, ['run-controller'], 'pg-runner')
    const error = await captureError(() =>
      service.publish(sampleCoreDraft({ definitionId: 'home-energy.pg-forbidden' }), runner),
    )
    expect(error.code).toBe('FORBIDDEN')
  })
})
