import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
  sha256DigestOfBytes,
} from '@ontology/adapter-extraction-document'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import type { ToolContext } from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PDF_FIXTURE = new URL('../fixtures/documents/service-terms.pdf', import.meta.url)

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SCOPE_A = { tenantId: TENANT_A, spaceId: SPACE_A } as const
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parseStore: PostgresDocumentParseStore
let service: LocalDocumentExtractionService
let reader: DocumentSpanReader
let pdfBytes: Uint8Array

async function publishOriginal(
  bytes: Uint8Array,
  mediaType: string,
  ctx: ToolContext,
): Promise<ReturnType<typeof blobStore.publish>> {
  const staged = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, ctx)
  return blobStore.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctx,
  )
}

/** Unique bytes per test so content-addressed state does not leak between tests. */
function textDocument(label: string): Uint8Array {
  const tag = label.toUpperCase()
  return new TextEncoder().encode(
    [
      `SERVICE TERMS ${tag}`,
      `1.1 The service is provided on a best-effort basis (${tag}).`,
      `Condition: only when the customer account is active (${tag}).`,
      `Table 1: Rate schedule ${tag}`,
      'Tier A | 0.10 | 100',
    ].join('\n'),
  )
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
     VALUES ($1, 'parse-tenant-a'), ($2, 'parse-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'parse-space-a'), ($3, $4, 'parse-space-b')
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

  objectDir = await mkdtemp(join(tmpdir(), 'document-parse-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()

  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 2 })
  service = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => '2026-09-21T00:00:00Z',
  })
  reader = new DocumentSpanReader({
    blobs: blobStore,
    store: parseStore,
    now: () => '2026-09-21T00:00:01Z',
  })
  pdfBytes = new Uint8Array(readFileSync(PDF_FIXTURE))
}, 300_000)

afterAll(async () => {
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await appClient?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('document parse migration', () => {
  it('enables RLS and keeps tenant/space in the keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('document_parse_runs', 'document_chunks')
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
          AND c.conrelid::regclass::text IN
              ('agent_platform.document_parse_runs', 'agent_platform.document_chunks')
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.document_parse_runs')).toEqual([
      'tenant_id',
      'space_id',
      'parse_id',
    ])
    expect(byTable.get('agent_platform.document_chunks')).toEqual([
      'tenant_id',
      'space_id',
      'parse_id',
      'chunk_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('014_document_parse_spans.sql')
  })
})

describe('document parsing against real PostgreSQL and blob-local', () => {
  it('persists a real PDF parse, its chunks and its span round-trip', async () => {
    const original = await publishOriginal(pdfBytes, 'application/pdf', CTX_A)
    const parsed = await service.parse({ scopeRef: SCOPE_A, originalRef: original.blobRef }, CTX_A)

    expect(parsed.mediaKind).toBe('pdf')
    expect(parsed.coverage.status).toBe('complete')
    expect(parsed.chunks.length).toBeGreaterThan(0)

    const runs = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
        WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3`,
      [TENANT_A, SPACE_A, parsed.parseId],
    )
    expect(runs.rows[0]?.count).toBe('1')
    const chunks = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.document_chunks
        WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3`,
      [TENANT_A, SPACE_A, parsed.parseId],
    )
    expect(Number(chunks.rows[0]?.count)).toBe(parsed.chunks.length)

    const clause = parsed.chunks.find((chunk) => chunk.chunkKind === 'clause')
    expect(clause).toBeDefined()
    if (clause === undefined) return
    const read = await reader.readSpan({ documentRef: parsed.originalRef, locator: clause.locator }, CTX_A)
    expect(read.text).toBe(clause.text)

    // The original bytes are never rewritten by parsing.
    const readBack = await blobStore.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: parsed.originalRef },
      CTX_A,
    )
    expect(sha256DigestOfBytes(readBack)).toBe(parsed.originalRef.digest)
    expect(readBack.byteLength).toBe(pdfBytes.byteLength)
  })

  it('deduplicates a duplicate upload onto one lineage and one parse', async () => {
    const bytes = textDocument('dedup')
    const first = await publishOriginal(bytes, 'text/plain', CTX_A)
    const second = await publishOriginal(bytes, 'text/plain', CTX_A)
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(second.deduplicated).toBe(true)

    const firstParse = await service.parse({ scopeRef: SCOPE_A, originalRef: first.blobRef }, CTX_A)
    const secondParse = await service.parse({ scopeRef: SCOPE_A, originalRef: second.blobRef }, CTX_A)
    expect(secondParse.reused).toBe(true)
    expect(secondParse.parseId).toBe(firstParse.parseId)

    const blobRows = await adminClient.query<{ count: string; lineage_id: string }>(
      `SELECT count(*)::text AS count, min(lineage_id::text) AS lineage_id
         FROM agent_platform.artifact_blobs
        WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3`,
      [TENANT_A, SPACE_A, first.contentDigest],
    )
    expect(blobRows.rows[0]?.count).toBe('1')

    const references = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.artifact_references
        WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3 AND purpose = 'document'`,
      [TENANT_A, SPACE_A, first.contentDigest],
    )
    expect(references.rows[0]?.count).toBe('2')

    const runRows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
        WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3`,
      [TENANT_A, SPACE_A, first.contentDigest],
    )
    expect(runRows.rows[0]?.count).toBe('1')
  })

  it('keeps chunks queryable for a later indexer within the scope', async () => {
    const original = await publishOriginal(textDocument('indexer'), 'text/plain', CTX_A)
    const parsed = await service.parse({ scopeRef: SCOPE_A, originalRef: original.blobRef }, CTX_A)

    const stored = await parseStore.listChunks(SCOPE_A, parsed.parseId, CTX_A)
    expect(stored).toHaveLength(parsed.chunks.length)
    expect(stored.some((chunk) => chunk.chunkKind === 'table' && chunk.caption !== undefined)).toBe(
      true,
    )
    expect(stored.every((chunk) => chunk.conditions.length >= 0)).toBe(true)

    const byScope = await parseStore.listChunksByScope(SCOPE_A, 500, CTX_A)
    const firstChunkId = parsed.chunks[0]?.chunkId
    expect(firstChunkId).toBeDefined()
    expect(byScope.some((chunk) => chunk.chunkId === firstChunkId)).toBe(true)
  })

  it('does not disclose another tenant parse and hides rows under RLS', async () => {
    const original = await publishOriginal(textDocument('cross-tenant'), 'text/plain', CTX_A)
    const parsed = await service.parse({ scopeRef: SCOPE_A, originalRef: original.blobRef }, CTX_A)
    const clause = parsed.chunks[0]
    expect(clause).toBeDefined()
    if (clause === undefined) return

    await expect(
      reader.readSpan({ documentRef: parsed.originalRef, locator: clause.locator }, CTX_B),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_PARSED' })

    const hiddenRuns = await withRawScope(TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_platform.document_parse_runs WHERE tenant_id = $1',
        [TENANT_A],
      ),
    )
    expect(hiddenRuns.rows[0]?.count).toBe('0')

    const hiddenChunks = await withRawScope(TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_platform.document_chunks WHERE tenant_id = $1',
        [TENANT_A],
      ),
    )
    expect(hiddenChunks.rows[0]?.count).toBe('0')
  })
})
