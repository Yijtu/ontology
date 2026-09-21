import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BlobStoreError,
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
  objectKeyForDigest,
  sha256Digest,
} from '@ontology/adapter-blob-local'
import type {
  ArtifactReferenceView,
  ArtifactRegistry,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolContext } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import { ArtifactProvenanceService, lineageKeyOf } from '@ontology/provenance'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const RUN_B = '44444444-4444-4444-8444-444444444444'
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555'
const DOC_VERSION = '66666666-6666-4666-8666-666666666666'
const DIGEST = `sha256:${'a'.repeat(64)}`

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function toolContext(tenantId: string, spaceId: string, runId = RUN_A): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'integration-test',
      roles: ['platform-admin'],
      scopes: ['artifact:read', 'artifact:write'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId,
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
    traceId: 'trace-artifact-integration',
  })
}

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }
const CONTEXT_A = toolContext(TENANT_A, SPACE_A)
const CONTEXT_B = toolContext(TENANT_B, SPACE_B)

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function captureBlobError(run: () => Promise<unknown>): Promise<BlobStoreError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof BlobStoreError) {
      return error
    }
    throw error
  }
  throw new Error('expected the blob operation to fail')
}

class FaultyRegistry implements ArtifactRegistry {
  failRecordReference = false
  readonly #inner: ArtifactRegistry

  constructor(inner: ArtifactRegistry) {
    this.#inner = inner
  }

  async recordReference(
    input: RecordArtifactReferenceInput,
  ): Promise<RecordArtifactReferenceResult> {
    if (this.failRecordReference) {
      throw new Error('injected registry failure')
    }
    return this.#inner.recordReference(input)
  }

  findReference(scope: ScopeRef, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    return this.#inner.findReference(scope, blobRefId)
  }

  listOrigins(scope: ScopeRef, contentDigest: string): ReturnType<ArtifactRegistry['listOrigins']> {
    return this.#inner.listOrigins(scope, contentDigest)
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let appClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let faultyRegistry: FaultyRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let provenance: ArtifactProvenanceService

async function publishText(
  text: string,
  options?: {
    readonly scopeRef?: ScopeRef
    readonly ctx?: ToolContext
    readonly purpose?: 'document' | 'large_result' | 'checkpoint' | 'artifact'
    readonly runId?: string
  },
): Promise<ResourceRef> {
  const scopeRef = options?.scopeRef ?? SCOPE_A
  const ctx = options?.ctx ?? CONTEXT_A
  const content = bytes(text)
  const staged = await blobStore.stage(content, { scopeRef }, ctx)
  const response = await blobStore.publish(
    {
      scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: options?.purpose ?? 'document',
      ...(options?.runId === undefined ? {} : { runId: options.runId }),
    },
    ctx,
  )
  return response.blobRef
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
     VALUES ($1, 'artifact-tenant-a'), ($2, 'artifact-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'artifact-space-a'), ($3, $4, 'artifact-space-b')
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

  objectDir = await mkdtemp(join(tmpdir(), 'blob-local-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()

  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  faultyRegistry = new FaultyRegistry(registry)
  blobStore = new LocalImmutableBlobStore({ objectStore, registry: faultyRegistry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 2 })
  const controlRepository = new ControlPostgresRepository(controlDatabase)
  provenance = new ArtifactProvenanceService({
    blobs: blobStore,
    control: controlRepository,
    reader: blobStore,
  })
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await appClient?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('artifact registry migration', () => {
  it('enables RLS on the new artifact tables and keeps tenant/space in the keys', async () => {
    const unprotected = await adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname IN ('artifact_blobs', 'artifact_references')
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
          AND c.conrelid::regclass::text IN ('agent_platform.artifact_blobs', 'agent_platform.artifact_references')
        GROUP BY 1`,
    )
    const byTable = new Map(keys.rows.map((row) => [row.table_name, row.columns]))
    expect(byTable.get('agent_platform.artifact_blobs')).toEqual([
      'tenant_id',
      'space_id',
      'content_digest',
    ])
    expect(byTable.get('agent_platform.artifact_references')).toEqual([
      'tenant_id',
      'space_id',
      'blob_ref_id',
    ])
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('005_artifact_registry.sql')
  })
})

describe('immutable blob lifecycle against real PostgreSQL', () => {
  it('stores, authorizes and reads back content', async () => {
    const blobRef = await publishText('integration original document')
    const described = await blobStore.getAuthorized(
      { scopeRef: SCOPE_A, blobRef },
      CONTEXT_A,
    )
    expect(described.contentDigest).toBe(blobRef.digest)
    expect(described.integrityVerified).toBe(true)

    const read = await blobStore.readAuthorized({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A)
    expect(new TextDecoder().decode(read)).toBe('integration original document')

    const stored = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.artifact_blobs
        WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3`,
      [TENANT_A, SPACE_A, blobRef.digest],
    )
    expect(stored.rows[0]?.count).toBe('1')
  })

  it('converges concurrent duplicate uploads onto one lineage', async () => {
    const text = 'concurrent duplicate upload'
    const [first, second] = await Promise.all([
      publishText(text, { scopeRef: SCOPE_A, ctx: CONTEXT_A }),
      publishText(text, { scopeRef: SCOPE_A, ctx: CONTEXT_A }),
    ])
    expect(first.digest).toBe(second.digest)

    const blobRows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.artifact_blobs
        WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3`,
      [TENANT_A, SPACE_A, first.digest],
    )
    expect(blobRows.rows[0]?.count).toBe('1')

    const origins = await blobStore.listOrigins({ scopeRef: SCOPE_A, blobRef: first }, CONTEXT_A)
    expect(origins).toHaveLength(2)
  })

  it('reports a missing object as a typed error', async () => {
    const content = bytes('object that will vanish')
    const staged = await blobStore.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const published = await blobStore.publish(
      {
        scopeRef: SCOPE_A,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      },
      CONTEXT_A,
    )
    await rm(join(objectDir, 'objects', objectKeyForDigest(published.blobRef.digest)), {
      force: true,
    })

    const error = await captureBlobError(() =>
      blobStore.readAuthorized({ scopeRef: SCOPE_A, blobRef: published.blobRef }, CONTEXT_A),
    )
    expect(error.code).toBe('BLOB_OBJECT_MISSING')
  })
})

describe('tenant isolation against real RLS', () => {
  it('does not disclose another tenant artifact and hides rows from RLS', async () => {
    const blobRef = await publishText('tenant-a private document')

    const crossTenant = await captureBlobError(() =>
      blobStore.getAuthorized({ scopeRef: SCOPE_B, blobRef }, CONTEXT_B),
    )
    expect(crossTenant.code).toBe('BLOB_NOT_FOUND')
    expect(crossTenant.message).not.toContain(blobRef.digest)

    const scoped = await withRawScope(TENANT_B, SPACE_B, () =>
      appClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_platform.artifact_references WHERE tenant_id = $1',
        [TENANT_A],
      ),
    )
    expect(scoped.rows[0]?.count).toBe('0')

    const unscoped = await appClient.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_platform.artifact_blobs',
    )
    expect(unscoped.rows[0]?.count).toBe('0')
  })

  it('keeps duplicate lineage inside the customer domain', async () => {
    const text = 'shared bytes across customers'
    const content = bytes(text)
    const contentDigest = sha256Digest(content)

    const firstA = await publishText(text, { scopeRef: SCOPE_A, ctx: CONTEXT_A })
    const secondA = await publishText(text, { scopeRef: SCOPE_A, ctx: CONTEXT_A })
    expect(secondA.digest).toBe(firstA.digest)

    const firstB = await publishText(text, { scopeRef: SCOPE_B, ctx: CONTEXT_B })
    expect(firstB.digest).toBe(firstA.digest)

    const originsA = await blobStore.listOrigins({ scopeRef: SCOPE_A, blobRef: firstA }, CONTEXT_A)
    expect(originsA).toHaveLength(2)

    const blobRows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.artifact_blobs WHERE content_digest = $1`,
      [contentDigest],
    )
    expect(blobRows.rows[0]?.count).toBe('2')

    // Bytes are content-addressed and stored once even though each tenant keeps
    // its own authorization record.
    const objects = await readdir(join(objectDir, 'objects'))
    expect(objects).toContain(objectKeyForDigest(contentDigest))
  })

  it('hides a private checkpoint from another run', async () => {
    const blobRef = await publishText('private checkpoint state', {
      purpose: 'checkpoint',
      runId: RUN_A,
    })
    const sameRun = await blobStore.getAuthorized(
      { scopeRef: SCOPE_A, blobRef },
      toolContext(TENANT_A, SPACE_A, RUN_A),
    )
    expect(sameRun.blobRef.kind).toBe('checkpoint')

    const otherRun = await captureBlobError(() =>
      blobStore.getAuthorized({ scopeRef: SCOPE_A, blobRef }, toolContext(TENANT_A, SPACE_A, RUN_B)),
    )
    expect(otherRun.code).toBe('BLOB_NOT_FOUND')
  })
})

describe('failure recovery between stage and reference publish', () => {
  it('leaves no reference when the registry fails, and recovers on retry', async () => {
    const content = bytes('recoverable against real PostgreSQL')
    const staged = await blobStore.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const request = {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document' as const,
    }

    faultyRegistry.failRecordReference = true
    await expect(blobStore.publish(request, CONTEXT_A)).rejects.toThrow('injected registry failure')
    faultyRegistry.failRecordReference = false

    const references = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.artifact_references
        WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3`,
      [TENANT_A, SPACE_A, staged.contentDigest],
    )
    expect(references.rows[0]?.count).toBe('0')

    const retried = await blobStore.publish(request, CONTEXT_A)
    const read = await blobStore.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: retried.blobRef },
      CONTEXT_A,
    )
    expect(new TextDecoder().decode(read)).toBe('recoverable against real PostgreSQL')
  })
})

describe('source location provenance against real PostgreSQL', () => {
  it('records an idempotent source location for an authorized artifact', async () => {
    const blobRef = await publishText('document for provenance')
    const documentVersionRef: ResourceRef = {
      id: DOC_VERSION,
      version: '1.0.0',
      digest: DIGEST,
      kind: 'document',
    }
    const input = {
      scopeRef: SCOPE_A,
      artifactRef: blobRef,
      documentVersionRef,
      page: 2,
      quoteDigest: DIGEST,
    }

    const first = await provenance.recordSourceLocation(input, CONTEXT_A)
    expect(first.recordedSeq).toBe('1')
    expect(first.lineageKey).toBe(lineageKeyOf(blobRef.digest))

    const replay = await provenance.recordSourceLocation(input, CONTEXT_A)
    expect(replay.recordedSeq).toBe(first.recordedSeq)

    const events = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.semantic_events
        WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3`,
      [TENANT_A, SPACE_A, `source-locations:${DOC_VERSION}`],
    )
    expect(events.rows[0]?.count).toBe('1')

    const bytesRead = await provenance.readAuthorizedArtifact(blobRef, SCOPE_A, CONTEXT_A)
    expect(new TextDecoder().decode(bytesRead)).toBe('document for provenance')
  })

  it('refuses provenance for an artifact outside the caller scope', async () => {
    const blobRef = await publishText('tenant-a artifact for provenance cross-tenant')

    await expect(
      provenance.recordSourceLocation(
        {
          scopeRef: SCOPE_B,
          artifactRef: blobRef,
          documentVersionRef: { id: DOC_VERSION, version: '1.0.0', digest: DIGEST, kind: 'document' },
          page: 1,
          quoteDigest: DIGEST,
        },
        CONTEXT_B,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_AUTHORIZED' })

    await expect(
      provenance.recordSourceLocation(
        {
          scopeRef: SCOPE_B,
          artifactRef: blobRef,
          documentVersionRef: { id: DOC_VERSION, version: '1.0.0', digest: DIGEST, kind: 'document' },
          page: 1,
          quoteDigest: DIGEST,
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})
