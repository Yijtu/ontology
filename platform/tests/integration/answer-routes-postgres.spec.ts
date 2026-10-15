import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAnswerStore,
  PostgresEvidenceStore,
  PostgresTableArtifactStore,
  PostgresTableVerificationStore,
} from '@ontology/adapter-control-postgres'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  TableArtifactReadService,
  TableHardVerificationService,
  VerifiedResultReadService,
  canonicalJson,
  typedResultManifestContentDigest,
} from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import { createApiServer, createBlobArtifactWriter } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  createToolContext,
  decodeTableReadCursor,
  encodeTableReadCursor,
  sha256OfCanonical,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ImmutableArtifactWriter,
  PublishedAnswer,
  ResourceRef,
  ScopeRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  EvidenceEnvelope,
  ToolContext,
  TypedResultManifest,
  VerifiedTableManifestSource,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * W05 real-database acceptance for the answer result / table read HTTP routes.
 *
 * The two endpoints V03-040's browser client calls — `GET /api/v1/answers/{answerId}/result`
 * and `GET /api/v1/answers/{answerId}/tables/{tableId}` — are exercised through the production
 * Fastify host (`createApiServer`) over real PostgreSQL and the real control/artifact stores.
 * Nothing about the reader or the projection is faked: a 1001-row table is archived page by
 * page, a real `answer-draft@3` is published, and the routes walk it, refuse an unverified
 * table, refuse replayed/backward/gapped cursors and isolate the answer by tenant/space.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const NOW = '2026-09-30T00:00:00Z'
const ROW_TOTAL = 1001
const PAGE_SIZE = 250

const PROFILE = { id: 'answer-routes-demo', version: '1.0.0' }
const OUTPUT_SCHEMA_REF = { id: 'output.schema', version: '1.0.0', digest: DIGEST }

const COLUMNS: readonly TableColumnDescriptor[] = [
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/amount',
    requiredContextPointers: ['unitPointer'],
  },
  { columnRef: 'site', semanticPredicate: 'site.id', valueType: 'entity_ref', schemaPointer: '/site' },
]

let harness: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let artifactWriter: ImmutableArtifactWriter
let objectDirectory = ''
let scope: JobTestScope
let otherScope: JobTestScope
let answerStore: PostgresAnswerStore
let tableStore: PostgresTableArtifactStore
let verificationStore: PostgresTableVerificationStore
let tableReadService: TableArtifactReadService
let resultService: VerifiedResultReadService
let app: ReturnType<typeof createApiServer>

function scopeRefOf(target: JobTestScope): ScopeRef {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

function ctxFor(target: JobTestScope, runId: string): ToolContext {
  return createToolContext({
    principal: { tenantId: target.tenantId, subjectId: 'route-tester', roles: ['business-user'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: NOW, expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `answer-routes:${randomUUID()}`,
  })
}

class FixtureEvidence {
  readonly #store: PostgresEvidenceStore
  constructor(store: PostgresEvidenceStore) { this.#store = store }
  async seed(scopeRef: ScopeRef, ctx: ToolContext, payload: unknown): Promise<{ readonly ref: ResourceRef; readonly digest: string }> {
    const bytes = new TextEncoder().encode(canonicalJson(payload))
    const archived = await artifactWriter.putBytes({ scopeRef, content: bytes, mediaType: 'application/json' }, ctx)
    const evidenceId = randomUUID(), digest = archived.blobRef.digest
    const envelope: EvidenceEnvelope = {
      evidenceId,
      kind: 'observation',
      scopeRef,
      producedBy: { componentRef: { id: 'answer-route-fixture', version: '1.0.0', digest: DIGEST }, runId: ctx.runId },
      observedAt: NOW,
      sourceSnapshots: [{ sourceRef: { namespace: 'fixture', sourceId: 'table-row' }, schemaVersion: '1', readAt: NOW, consistency: 'repeatable_read', resultDigest: digest }],
      resultDigest: digest,
      dependencies: [],
      dataMode: 'synthetic',
      payloadRef: archived.blobRef,
      integrity: { algorithm: 'sha256', digest, verifiedAt: NOW },
    }
    const record = await this.#store.record(scopeRef, envelope, ctx)
    return { ref: record.evidenceRef, digest }
  }
}

let fixtureEvidence: FixtureEvidence
let verificationArtifacts: VerificationArtifactStore
let tableVerifier: TableHardVerificationService

async function pageBody(tableId: string, pageIndex: number, rowKeys: readonly string[], target: JobTestScope, ctx: ToolContext): Promise<TableArtifactPageBody> {
  const rows = await Promise.all(rowKeys.map(async (rowKey, index) => {
    const site = `site-${rowKey}`, amount = String(index)
    const evidence = await fixtureEvidence.seed(scopeRefOf(target), ctx, { amount, site, unit: 'kWh' })
    return {
      rowKey,
      subject: site,
      cells: { amount: { value: amount, unit: 'kWh' }, site },
      bindings: [
        { rowKey, columnRef: 'amount', evidenceRef: evidence.ref, resultDigest: evidence.digest, valuePointer: '/amount', subjectPointer: '/site', unitPointer: '/unit' },
        { rowKey, columnRef: 'site', evidenceRef: evidence.ref, resultDigest: evidence.digest, valuePointer: '/site', subjectPointer: '/site' },
      ],
    }
  }))
  return {
    schemaVersion: 'table-artifact-page@1',
    tableId,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    pageIndex,
    columnRefs: COLUMNS.map((column) => column.columnRef),
    rowKeyOrder: 'ascending',
    rows,
    coverage: { returned: rowKeys.length, truncated: false },
  }
}

async function buildTable(
  tableId: string,
  rowTotal: number,
  target: JobTestScope,
  ctx: ToolContext,
): Promise<{ manifest: TableArtifactManifest; pages: readonly { ref: ResourceRef; body: TableArtifactPageBody }[] }> {
  const pages: { ref: ResourceRef; body: TableArtifactPageBody }[] = []
  for (let pageIndex = 0; pageIndex * PAGE_SIZE < rowTotal; pageIndex += 1) {
    const start = pageIndex * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, rowTotal)
    const rowKeys = Array.from({ length: end - start }, (_value, offset) =>
      `r-${String(start + offset).padStart(5, '0')}`,
    )
    const body = await pageBody(tableId, pageIndex, rowKeys, target, ctx)
    const ref: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: tableArtifactContentDigest(body),
      kind: 'artifact',
    }
    pages.push({ ref, body })
  }
  const manifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    columns: COLUMNS,
    totalRows: rowTotal,
    rowKeyOrder: 'ascending',
    pages: pages.map((page) => ({
      pageIndex: page.body.pageIndex,
      artifactRef: page.ref,
      artifactDigest: page.ref.digest,
      rowCount: page.body.rows.length,
      firstRowKey: page.body.rows[0]?.rowKey ?? '',
      lastRowKey: page.body.rows[page.body.rows.length - 1]?.rowKey ?? '',
      pageCoverageDigest: tablePageCoverageDigest(page.body),
    })),
    coverage: { returned: rowTotal, truncated: false },
    complete: rowTotal > 0,
  }
  return { manifest, pages }
}

async function seedProfile(target: JobTestScope): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'answer-routes-seed')
     ON CONFLICT DO NOTHING`,
    [target.tenantId, target.spaceId, PROFILE.id, PROFILE.version, DIGEST],
  )
  await harness.adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [target.tenantId, target.spaceId, PROFILE.id, PROFILE.version, DIGEST],
  )
}

async function seedRun(target: JobTestScope, runId: string): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.runs
       (tenant_id, space_id, run_id, owner_subject_id, profile_id, profile_version,
        resolved_profile_hash, runtime_ref, question, context, preferences, state, revision,
        idempotency_key, request_digest, created_at, updated_at)
     VALUES ($1, $2, $3, 'route-tester', $4, $5, $6, $7::jsonb, 'answer routes', '{}'::jsonb,
             '{}'::jsonb, 'published', 1, $8, $6, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      target.tenantId,
      target.spaceId,
      runId,
      PROFILE.id,
      PROFILE.version,
      DIGEST,
      JSON.stringify({ id: 'runtime-template', version: '1.0.0', digest: DIGEST }),
      `run-${runId}`,
    ],
  )
}

interface TableSeed {
  readonly tableId: string
  readonly rowTotal: number
  readonly verified: boolean
}

interface SeededAnswer {
  readonly answerId: string
  readonly runId: string
  readonly resultManifestDigest: string
  readonly tables: readonly { readonly tableId: string; readonly manifest: TableArtifactManifest }[]
}

async function seedAnswer(target: JobTestScope, tableSeeds: readonly TableSeed[]): Promise<SeededAnswer> {
  const runId = randomUUID()
  const answerId = randomUUID()
  await seedRun(target, runId)
  const ctx = ctxFor(target, runId)
  const scopeRef = scopeRefOf(target)
  const tables: { tableId: string; manifest: TableArtifactManifest }[] = []

  for (const seed of tableSeeds) {
    const built = await buildTable(seed.tableId, seed.rowTotal, target, ctx)
    for (const page of built.pages) {
      await tableStore.putPage(scopeRef, page.ref, page.body, ctx)
    }
    const manifestBytes = new TextEncoder().encode(canonicalJson(built.manifest))
    const manifestArtifact = await artifactWriter.putBytes({ scopeRef, content: manifestBytes, mediaType: 'application/json' }, ctx)
    expect(manifestArtifact.blobRef.digest).toBe(sha256OfCanonical(built.manifest))
    if (seed.verified) {
      const outcome = await tableVerifier.verifyTable({ resultManifestRef: manifestArtifact.blobRef, resultManifestDigest: manifestArtifact.blobRef.digest, draftHash: sha256OfCanonical({ answerId, tableId: seed.tableId }), tableId: seed.tableId, manifest: built.manifest }, ctx)
      if (outcome.status !== 'pass') throw new Error(`the answer-route fixture did not earn a verification receipt: ${outcome.report.findings.map((finding) => finding.code).join(', ')}`)
      await tableStore.putManifest(scopeRef, answerId, manifestArtifact.blobRef, built.manifest, outcome.receipt.ref, ctx)
    } else {
      await tableStore.putManifest(scopeRef, answerId, manifestArtifact.blobRef, built.manifest, undefined, ctx)
    }
    tables.push({ tableId: seed.tableId, manifest: built.manifest })
  }

  const typedManifest: TypedResultManifest = {
    schemaVersion: 'typed-result-manifest@1',
    executionBindingRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    taskBindingRef: { id: 'task.binding', version: '1.0.0', digest: DIGEST },
    resultKind: 'structured_query',
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    inputSnapshotRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    outputDigest: DIGEST,
    tables: tables.map((entry) => entry.manifest),
    limitations: [],
    coverage: { returned: tables.reduce((total, entry) => total + entry.manifest.totalRows, 0), truncated: false },
    domainStatus: 'known',
    dataMode: 'observed',
  }
  const resultManifestDigest = typedResultManifestContentDigest(typedManifest)
  const archived = await artifactWriter.putBytes(
    { scopeRef, content: new TextEncoder().encode(canonicalJson(typedManifest)), mediaType: 'application/json' },
    ctx,
  )
  expect(archived.blobRef.digest).toBe(resultManifestDigest)

  const answer: PublishedAnswer = {
    answerId,
    runId,
    draftId: randomUUID(),
    verificationId: randomUUID(),
    contentHash: sha256OfCanonical({ content: answerId }),
    evidenceManifestHash: DIGEST,
    scenarioManifestHash: DIGEST,
    publicationKind: 'verified',
    limitations: [],
    v3Body: {
      schemaVersion: 'answer-draft@3',
      resultManifestRef: archived.blobRef,
      resultManifestDigest,
      finalizationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'verification' },
      finalizationReceiptDigest: DIGEST_B,
      executionBindingRef: typedManifest.executionBindingRef,
      blocks: [],
      claims: [],
      assertions: [],
      limitations: [],
    },
    publishedAt: NOW,
  }
  await answerStore.record({ answer, expectedRunState: 'published', expectedRunRevision: '1' }, ctx)
  return { answerId, runId, resultManifestDigest, tables }
}

function get(path: string, scopeTag: 'primary' | 'other' | 'none' = 'primary') {
  return app.inject({ method: 'GET', url: path, headers: { 'x-scope': scopeTag } })
}

function requireCursor(cursor: string | undefined, pageIndex: number): string {
  if (cursor === undefined) throw new Error(`page ${pageIndex} unexpectedly had no next cursor`)
  return cursor
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  scope = await createJobScope(harness.adminClient, 'answer-routes')
  otherScope = await createJobScope(harness.adminClient, 'answer-routes-other')
  await seedProfile(scope)
  await seedProfile(otherScope)

  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-answer-routes-'))
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 4 })
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  artifactWriter = createBlobArtifactWriter(blobStore)
  verificationArtifacts = {
    getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx),
    readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx),
  }

  answerStore = new PostgresAnswerStore(database)
  tableStore = new PostgresTableArtifactStore(database, {
    writer: artifactWriter,
    reader: {
      read: (request, ctx) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('the table page read carried no approved input reference')
        return blobStore.readAuthorized(
          { scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target },
          ctx,
        )
      },
    },
  })
  verificationStore = new PostgresTableVerificationStore(database)
  fixtureEvidence = new FixtureEvidence(new PostgresEvidenceStore(database))
  tableVerifier = new TableHardVerificationService({ pages: tableStore, evidence: new PostgresEvidenceStore(database), artifacts: verificationArtifacts, receipts: verificationStore, progress: verificationStore })
  // Production hardening: a table is only served as verified when the receipt it names exists.
  const verifiedManifests: VerifiedTableManifestSource = {
    resolve: async (scopeRef, answerId, tableId, ctx) => {
      const archived = await tableStore.resolve(scopeRef, answerId, tableId, ctx)
      if (archived === undefined || archived.verificationReceiptRef === undefined) return archived
      const receipt = await verificationStore.getReceipt(scopeRef, archived.verificationReceiptRef, ctx)
      return receipt === undefined ? { ref: archived.ref, manifest: archived.manifest } : archived
    },
  }
  tableReadService = new TableArtifactReadService({
    manifests: verifiedManifests,
    pages: tableStore,
    progress: tableStore,
  })
  resultService = new VerifiedResultReadService({
    answers: answerStore,
    results: {
      getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx),
      readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx),
    },
    tables: verifiedManifests,
  })

  app = createApiServer({
    authenticate: (request): AuthenticatedRequest | undefined => {
      const raw = request.headers['x-scope']
      const tag = Array.isArray(raw) ? raw[0] : raw
      if (tag === 'none') return undefined
      if (tag !== undefined && tag !== 'primary' && tag !== 'other') return undefined
      const target = tag === 'other' ? otherScope : scope
      return {
        principal: { tenantId: target.tenantId, subjectId: 'route-tester', roles: ['business-user'], scopes: [], authEpoch: 1 },
        spaceId: target.spaceId,
      }
    },
    answers: { result: resultService, tables: tableReadService },
  })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await harness?.stop()
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
})

describe('answer result and table read routes over real PostgreSQL', () => {
  it('serves the verified result and walks a 1001-row table across five pages', async () => {
    const seeded = await seedAnswer(scope, [{ tableId: 'table.big', rowTotal: ROW_TOTAL, verified: true }])

    const resultResponse = await get(`/api/v1/answers/${seeded.answerId}/result`)
    expect(resultResponse.statusCode).toBe(200)
    const view = resultResponse.json<{
      data: {
        answerId: string
        runId: string
        resultManifestDigest: string
        tables: { tableId: string; totalRows: number; complete: boolean; verificationReceiptRef?: unknown }[]
      }
    }>().data
    expect(view.answerId).toBe(seeded.answerId)
    expect(view.runId).toBe(seeded.runId)
    expect(view.resultManifestDigest).toBe(seeded.resultManifestDigest)
    expect(view.tables).toHaveLength(1)
    expect(view.tables[0]?.tableId).toBe('table.big')
    expect(view.tables[0]?.totalRows).toBe(ROW_TOTAL)
    expect(view.tables[0]?.complete).toBe(true)
    expect(view.tables[0]?.verificationReceiptRef).toBeDefined()

    const base = `/api/v1/answers/${seeded.answerId}/tables/table.big`
    const rowKeys: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const suffix = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      const pageResponse = await get(`${base}${suffix}`)
      expect(pageResponse.statusCode).toBe(200)
      const page = pageResponse.json<{ data: { pageCount: number; rows: { rowKey: string }[]; cursor?: string } }>().data
      pages += 1
      rowKeys.push(...page.rows.map((row) => row.rowKey))
      expect(page.pageCount).toBe(5)
      if (page.cursor === undefined) break
      cursor = page.cursor
    }
    expect(pages).toBe(5)
    expect(rowKeys).toHaveLength(ROW_TOTAL)
    expect(new Set(rowKeys).size).toBe(ROW_TOTAL)
  }, 240_000)

  it('refuses an unverified table with TABLE_UNVERIFIED', async () => {
    const seeded = await seedAnswer(scope, [{ tableId: 'table.raw', rowTotal: 2, verified: false }])

    const resultResponse = await get(`/api/v1/answers/${seeded.answerId}/result`)
    expect(resultResponse.statusCode).toBe(200)
    const view = resultResponse.json<{ data: { tables: { tableId: string; verificationReceiptRef?: unknown }[] } }>().data
    expect(view.tables[0]?.tableId).toBe('table.raw')
    expect(view.tables[0]?.verificationReceiptRef).toBeUndefined()

    const tableResponse = await get(`/api/v1/answers/${seeded.answerId}/tables/table.raw`)
    expect(tableResponse.statusCode).toBe(422)
    expect(tableResponse.json<{ error: { code: string } }>().error.code).toBe('TABLE_UNVERIFIED')
  }, 240_000)

  it('refuses replayed, backward and gapped cursors', async () => {
    const seeded = await seedAnswer(scope, [{ tableId: 'table.cursor', rowTotal: ROW_TOTAL, verified: true }])
    const base = `/api/v1/answers/${seeded.answerId}/tables/table.cursor`
    const manifest = seeded.tables[0]!.manifest

    const page0 = (await get(base)).json<{ data: { cursor?: string } }>().data
    const cursor0 = requireCursor(page0.cursor, 0)
    const page1 = (await get(`${base}?cursor=${encodeURIComponent(cursor0)}`)).json<{ data: { cursor?: string } }>().data
    const cursor1 = requireCursor(page1.cursor, 1)

    const replay = await get(`${base}?cursor=${encodeURIComponent(cursor0)}`)
    expect(replay.statusCode).toBe(409)
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('CURSOR_REPLAY')

    await get(`${base}?cursor=${encodeURIComponent(cursor1)}`)
    const decoded = decodeTableReadCursor(cursor1)
    const backward = encodeTableReadCursor({
      version: 1,
      answerId: decoded.answerId,
      tableId: decoded.tableId,
      resultManifestRef: decoded.resultManifestRef,
      resultManifestDigest: decoded.resultManifestDigest,
      scopeDigest: decoded.scopeDigest,
      pageIndex: 1,
      lastRowKey: manifest.pages[0]?.lastRowKey ?? '',
    })
    const backwardResponse = await get(`${base}?cursor=${encodeURIComponent(backward)}`)
    expect(backwardResponse.statusCode).toBe(409)
    expect(backwardResponse.json<{ error: { code: string } }>().error.code).toBe('CURSOR_BACKWARD')

    const gapSeed = await seedAnswer(scope, [{ tableId: 'table.gap', rowTotal: ROW_TOTAL, verified: true }])
    const gapBase = `/api/v1/answers/${gapSeed.answerId}/tables/table.gap`
    const gapManifest = gapSeed.tables[0]!.manifest
    const gapPage0 = (await get(gapBase)).json<{ data: { cursor?: string } }>().data
    const gapCursor0 = decodeTableReadCursor(requireCursor(gapPage0.cursor, 0))
    const gapCursor = encodeTableReadCursor({
      version: 1,
      answerId: gapCursor0.answerId,
      tableId: gapCursor0.tableId,
      resultManifestRef: gapCursor0.resultManifestRef,
      resultManifestDigest: gapCursor0.resultManifestDigest,
      scopeDigest: gapCursor0.scopeDigest,
      pageIndex: 2,
      lastRowKey: gapManifest.pages[1]?.lastRowKey ?? '',
    })
    const gapResponse = await get(`${gapBase}?cursor=${encodeURIComponent(gapCursor)}`)
    expect(gapResponse.statusCode).toBe(409)
    expect(gapResponse.json<{ error: { code: string } }>().error.code).toBe('CURSOR_GAP')
  }, 240_000)

  it('isolates the result and table by tenant/space and requires authentication', async () => {
    const seeded = await seedAnswer(scope, [{ tableId: 'table.iso', rowTotal: ROW_TOTAL, verified: true }])

    const foreignResult = await get(`/api/v1/answers/${seeded.answerId}/result`, 'other')
    expect(foreignResult.statusCode).toBe(404)
    expect(foreignResult.json<{ error: { code: string } }>().error.code).toBe('ANSWER_NOT_FOUND')

    const foreignTable = await get(`/api/v1/answers/${seeded.answerId}/tables/table.iso`, 'other')
    expect(foreignTable.statusCode).toBe(404)
    expect(foreignTable.json<{ error: { code: string } }>().error.code).toBe('TABLE_NOT_FOUND')

    const unauthenticated = await get(`/api/v1/answers/${seeded.answerId}/result`, 'none')
    expect(unauthenticated.statusCode).toBe(401)
  }, 240_000)
})
