import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresResearchDocumentSetStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolContext } from '@ontology/contracts'
import type { ResearchDocumentMember, ToolContext } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE = '99999999-9999-4999-8999-999999999999'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(tenantId: string, spaceId: string): ToolContext {
  return createToolContext({
    principal: { tenantId, subjectId: 'r03-integration', roles: ['platform-admin'], scopes: ['workspace:read'], authEpoch: 1 },
    runId: RUN_A,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: RUN_A,
      grantedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: { tenantId, spaceId, resourceKinds: ['artifact', 'document'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 100 },
    traceId: 'trace-r03-integration',
  })
}

const CTX_A = toolContext(TENANT_A, SPACE_A)
const CTX_B = toolContext(TENANT_B, SPACE_B)

function member(overrides?: Partial<ResearchDocumentMember>): ResearchDocumentMember {
  return {
    schemaVersion: 'research-document-member@1',
    memberId: randomUUID(),
    workspaceId: WORKSPACE,
    runId: RUN_A,
    kind: 'research_archive',
    documentRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    parseId: randomUUID(),
    parserVersion: '1.0.0',
    parseRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' },
    contentDigest: DIGEST,
    fetchedAt: '2026-10-16T00:00:00Z',
    sourceUrl: 'https://docs.example.com/guide',
    staged: true,
    inGroundingCorpus: false,
    recordedAt: '2026-10-16T01:00:00Z',
    ...overrides,
  }
}

let container: PostgresContainer | undefined
let adminClient: Client
let database: ControlPostgresDatabase
let store: PostgresResearchDocumentSetStore

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const adminUrl = provided !== undefined && provided.length > 0 ? provided : (container = await startPostgresContainer()).adminUrl
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  for (const [tenantId, spaceId, slug] of [[TENANT_A, SPACE_A, 'r03-a'], [TENANT_B, SPACE_B, 'r03-b']] as const) {
    await adminClient.query(`INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenantId, slug])
    await adminClient.query(`INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tenantId, spaceId, slug])
    await adminClient.query(
      `INSERT INTO agent_platform.industry_workspaces
         (tenant_id, space_id, workspace_id, namespace, display_name, boundary, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'R03 workspace', '{}'::jsonb, $5, $6, 'r03', now(), now())
       ON CONFLICT DO NOTHING`,
      [tenantId, spaceId, WORKSPACE, slug, `r03-ws-${slug}`, DIGEST],
    )
  }

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [appPassword])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)

  database = new ControlPostgresDatabase({ connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword), maxPoolSize: 4 })
  store = new PostgresResearchDocumentSetStore(database)
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('research staging members against real PostgreSQL (migration 094)', () => {
  it('persists a staged member and reads it back with the staged isolation flags', async () => {
    const record = member()
    const appended = await store.appendMember({ tenantId: TENANT_A, spaceId: SPACE_A }, record, CTX_A)
    expect(appended.created).toBe(true)
    expect(appended.member.staged).toBe(true)
    expect(appended.member.inGroundingCorpus).toBe(false)

    const read = await store.getMember({ tenantId: TENANT_A, spaceId: SPACE_A }, record.memberId, CTX_A)
    expect(read?.memberId).toBe(record.memberId)
    expect(read?.sourceUrl).toBe('https://docs.example.com/guide')
  })

  it('is idempotent per (workspace, run, kind, document digest)', async () => {
    const first = await store.appendMember({ tenantId: TENANT_A, spaceId: SPACE_A }, member(), CTX_A)
    const replayMember = member({ memberId: randomUUID() })
    const replay = await store.appendMember(
      { tenantId: TENANT_A, spaceId: SPACE_A },
      { ...replayMember, documentRef: first.member.documentRef },
      CTX_A,
    )
    expect(replay.created).toBe(false)
    expect(replay.member.memberId).toBe(first.member.memberId)

    const page = await store.listMembers({ tenantId: TENANT_A, spaceId: SPACE_A }, { workspaceId: WORKSPACE, runId: RUN_A, limit: 50 }, CTX_A)
    expect(page.members.filter((entry) => entry.documentRef.digest === DIGEST)).toHaveLength(1)
  })

  it('does not expose a member to another tenant (RLS + explicit scope)', async () => {
    await store.appendMember({ tenantId: TENANT_A, spaceId: SPACE_A }, member(), CTX_A)
    await expect(
      store.listMembers({ tenantId: TENANT_B, spaceId: SPACE_B }, { workspaceId: WORKSPACE, runId: RUN_A, limit: 50 }, CTX_B),
    ).resolves.toEqual({ members: [] })
  })
})
