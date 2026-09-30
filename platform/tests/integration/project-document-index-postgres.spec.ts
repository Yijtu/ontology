import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresProjectDocumentStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import {
  PostgresKeywordIndexStore,
  ProjectDocumentIndexService,
} from '@ontology/adapter-search-bm25'
import type { DocumentParseRecord, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'
import { projectCollectionRef } from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 120_000 })

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function textDocument(label: string): Uint8Array {
  return new TextEncoder().encode(
    [
      `SERVICE TERMS ${label.toUpperCase()}`,
      `1.1 The battery warranty covers five years for ${label}.`,
      `1.2 The solar inverter is maintained by the customer for ${label}.`,
    ].join('\n'),
  )
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let scopedClient: Client
let appUrl = ''
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parseStore: PostgresDocumentParseStore
let indexStore: PostgresKeywordIndexStore
let projectStore: PostgresProjectDocumentStore
let parseService: LocalDocumentExtractionService
let service: ProjectDocumentIndexService
let database: ControlPostgresDatabase

async function publishText(label: string): Promise<DocumentParseRecord> {
  const bytes = textDocument(label)
  const staged = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, CTX_A)
  const published = await blobStore.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    CTX_A,
  )
  return parseService.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, CTX_A)
}

async function createProject(projectId: Uuid, title: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'active', $5, $6, 'integration', now(), now())`,
    [TENANT_A, SPACE_A, projectId, title, `proj-${projectId}`, `sha256:${'a'.repeat(64)}`],
  )
}

async function register(projectId: Uuid, parse: DocumentParseRecord): Promise<void> {
  await service.importDocument(
    projectId,
    {
      documentId: randomUUID(),
      documentRef: parse.originalRef,
      documentDigest: parse.originalRef.digest,
      parseId: parse.parseId,
      parseRef: parse.spanMapRef,
      textDigest: parse.spanMapRef.digest,
      precision: 'exact',
      actor: 'integration',
      recordedAt: new Date().toISOString(),
    },
    CTX_A,
  )
}

async function withAppScope(
  tenantId: string,
  spaceId: string,
  run: () => Promise<void>,
): Promise<void> {
  await scopedClient.query('BEGIN')
  try {
    await scopedClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
      [tenantId, spaceId],
    )
    await run()
    await scopedClient.query('ROLLBACK')
  } catch (error) {
    await scopedClient.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function appScopeCount(table: string, tenantId: string): Promise<number> {
  const result = await scopedClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE tenant_id = $1`,
    [tenantId],
  )
  return Number(result.rows[0]?.count ?? '0')
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
     VALUES ($1, 'project-doc-tenant-a'), ($2, 'project-doc-tenant-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'project-doc-space-a'), ($3, $4, 'project-doc-space-b') ON CONFLICT DO NOTHING`,
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
  appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'project-document-index-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  indexStore = new PostgresKeywordIndexStore({ connectionString: appUrl, maxPoolSize: 4 })
  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  projectStore = new PostgresProjectDocumentStore(database)
  parseService = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => new Date().toISOString(),
  })
  service = new ProjectDocumentIndexService({
    store: projectStore,
    parseStore,
    indexStore,
    spanReader: new DocumentSpanReader({ blobs: blobStore, store: parseStore, now: () => new Date().toISOString() }),
    now: () => new Date().toISOString(),
  })
  scopedClient = new Client({ connectionString: appUrl })
  await scopedClient.connect()
}, 300_000)

afterAll(async () => {
  await scopedClient?.end().catch(() => undefined)
  await indexStore?.close().catch(() => undefined)
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('migration 069', () => {
  it('enables RLS on the project document index tables and keeps tenant/space in the keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN (
            'project_visibility', 'project_document_memberships',
            'project_document_index_receipts', 'keyword_index_generation_counters')
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
            'agent_platform.project_visibility',
            'agent_platform.project_document_memberships')
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.project_visibility')).toEqual([
      'tenant_id',
      'space_id',
      'project_id',
    ])
    expect(byTable.get('agent_platform.project_document_memberships')).toEqual([
      'tenant_id',
      'space_id',
      'project_id',
      'document_id',
      'membership_revision',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('069_project_document_index.sql')
  })
})

describe('project document BM25 index against real PostgreSQL', () => {
  it('imports authorised text, builds the index and searches real fragments of this project', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'battery project')
    const parse = await publishText('alpha')
    await register(projectId, parse)

    expect((await service.getStatus(projectId, CTX_A)).state).toBe('pending')
    const built = await service.buildIndex(projectId, CTX_A)
    expect(built.state).toBe('ready')
    expect(built.generation).toBe('1')
    expect(built.sourceDocumentCount).toBe(1)
    expect(built.indexRef?.id).toBe(projectCollectionRef(projectId))

    const result = await service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(result.state).toBe('ready')
    expect(result.fragments.length).toBeGreaterThan(0)
    const fragment = result.fragments[0]
    if (fragment === undefined) throw new Error('expected a fragment')
    expect(fragment.text.toLowerCase()).toContain('battery warranty')
    expect(fragment.revision).toBe('1')
    expect(result.scoreKind).toBe('bm25')
  })

  it('moves index visibility on retraction and never serves the withdrawn fragment from a stale index', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'retraction project')
    const parse = await publishText('beta')
    await register(projectId, parse)
    await service.buildIndex(projectId, CTX_A)
    expect((await service.search({ projectId, query: 'battery warranty' }, CTX_A)).fragments.length).toBeGreaterThan(0)

    const page = await projectStore.listDocuments(SCOPE_A, projectId, { limit: 10 }, CTX_A)
    const documentId = page.memberships[0]?.documentId
    if (documentId === undefined) throw new Error('expected a membership')
    const revised = await service.reviseDocument(
      projectId,
      { documentId, op: 'retract', reason: 'withdrawn', actor: 'integration', recordedAt: new Date().toISOString() },
      CTX_A,
    )
    expect(revised.state).toBe('stale')
    const stale = await service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(stale.state).toBe('stale')
    expect(stale.fragments).toHaveLength(0)

    const rebuilt = await service.buildIndex(projectId, CTX_A)
    expect(rebuilt.state).toBe('ready')
    expect(rebuilt.sourceDocumentCount).toBe(0)
  })

  it('does not surface another project or another tenant corpus', async () => {
    const projectA = randomUUID()
    const projectB = randomUUID()
    await createProject(projectA, 'isolated A')
    await createProject(projectB, 'isolated B')
    const parse = await publishText('gamma')
    await register(projectA, parse)
    await service.buildIndex(projectA, CTX_A)

    expect((await service.search({ projectId: projectB, query: 'battery warranty' }, CTX_A)).fragments).toHaveLength(0)
    expect((await service.search({ projectId: projectA, query: 'battery warranty' }, CTX_B)).fragments).toHaveLength(0)

    await withAppScope(TENANT_B, SPACE_B, async () => {
      expect(await appScopeCount('project_document_memberships', TENANT_A)).toBe(0)
      expect(await appScopeCount('project_document_index_receipts', TENANT_A)).toBe(0)
    })
    await withAppScope(TENANT_A, SPACE_A, async () => {
      expect(await appScopeCount('project_document_memberships', TENANT_A)).toBeGreaterThan(0)
    })
  })

  it('refuses to activate a receipt built under an older visibility epoch', async () => {
    const projectId = randomUUID()
    await createProject(projectId, 'cas project')
    const parse = await publishText('delta')
    await register(projectId, parse)
    const visibility = await projectStore.getVisibility(SCOPE_A, projectId, CTX_A)
    if (visibility === undefined) throw new Error('expected visibility')

    // A receipt carrying a stale epoch is refused, so a late build cannot reactivate.
    const refused = await projectStore.recordIndexReceipt(
      SCOPE_A,
      projectId,
      {
        collectionRef: projectCollectionRef(projectId),
        generation: '99',
        visibilityEpoch: (BigInt(visibility.epoch) - 1n).toString(),
        membershipRevision: visibility.membershipRevision,
        targetDigest: `sha256:${'b'.repeat(64)}`,
        indexRef: { id: projectCollectionRef(projectId), version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
        documentCount: 1,
        sourceDocumentCount: 1,
        completeness: 'complete',
        recordedAt: new Date().toISOString(),
      },
      CTX_A,
    )
    expect(refused.activated).toBe(false)
    expect(await projectStore.getIndexReceipt(SCOPE_A, projectId, '99', CTX_A)).toBeUndefined()
  })
})
